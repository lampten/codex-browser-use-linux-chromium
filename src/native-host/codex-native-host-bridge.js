#!/usr/bin/env node
/*
 * Linux Chromium native-messaging bridge for the Codex browser extension.
 *
 * Chromium talks to native hosts over stdin/stdout with 4-byte length-prefixed
 * JSON messages. Codex browser tooling expects a Unix socket under
 * /tmp/codex-browser-use using the same framing. The official extension-host
 * does not ship for linux/arm64, so this shim only bridges the transport.
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SOCKET_DIR = process.env.CODEX_BROWSER_USE_SOCKET_DIR || "/tmp/codex-browser-use";
const SOCKET_PATH = path.join(SOCKET_DIR, `chromium-${process.pid}.sock`);
const LOG_PATH = process.env.CODEX_NATIVE_HOST_BRIDGE_LOG || "/tmp/codex-native-host-bridge.log";
const IS_LE = os.endianness() === "LE";

let nextClientId = 1;
const clients = new Set();
const pendingRequests = new Map();
const chromeWriteQueue = [];
let chromeWriteQueueBytes = 0;
let chromeWriteDraining = false;
let stdoutBackpressureEvents = 0;
let lastStdoutBackpressureLogAt = 0;
const MAX_CHROME_WRITE_QUEUE_BYTES = parseIntEnv(
  "CODEX_NATIVE_HOST_MAX_CHROME_QUEUE_BYTES",
  64 * 1024 * 1024
);
const EXIT_ON_ORPHANED_PENDING = !/^(0|false|no)$/i.test(
  process.env.CODEX_NATIVE_HOST_EXIT_ON_ORPHANED_PENDING || ""
);

function log(message, extra) {
  const line = `${new Date().toISOString()} ${message}${extra ? ` ${extra}` : ""}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // Native-host stdout is protocol only. If file logging fails, stay quiet.
  }
}

function readLength(buffer, offset = 0) {
  return IS_LE ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function writeLength(buffer, value, offset = 0) {
  return IS_LE ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
}

function parseIntEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function encodeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  writeLength(header, payload.length);
  return Buffer.concat([header, payload]);
}

function makeFrameParser(onMessage, onError) {
  let buffer = Buffer.alloc(0);

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = readLength(buffer);
      if (length > 64 * 1024 * 1024) {
        onError(new Error(`message too large: ${length}`));
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < 4 + length) return;

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      try {
        onMessage(JSON.parse(payload.toString("utf8")));
      } catch (error) {
        onError(error);
      }
    }
  };
}

function hasId(message) {
  return message && Object.prototype.hasOwnProperty.call(message, "id");
}

function logStdoutBackpressure() {
  stdoutBackpressureEvents += 1;
  const now = Date.now();
  if (now - lastStdoutBackpressureLogAt < 1000) return;
  lastStdoutBackpressureLogAt = now;
  const suppressed = stdoutBackpressureEvents - 1;
  stdoutBackpressureEvents = 0;
  log(
    "stdout backpressure",
    `queue=${chromeWriteQueue.length} bytes=${chromeWriteQueueBytes}${
      suppressed > 0 ? ` suppressed=${suppressed}` : ""
    }`
  );
}

function enqueueChromeWrite(message, ownerClient = null, pendingId = null) {
  const frame = encodeMessage(message);
  chromeWriteQueue.push({ frame, ownerClient, pendingId });
  chromeWriteQueueBytes += frame.length;

  if (chromeWriteQueueBytes > MAX_CHROME_WRITE_QUEUE_BYTES) {
    log(
      "chrome write queue limit exceeded",
      `bytes=${chromeWriteQueueBytes} limit=${MAX_CHROME_WRITE_QUEUE_BYTES}`
    );
    if (ownerClient) ownerClient.socket.destroy(new Error("native host chrome write queue overflow"));
    else shutdown(1);
    return;
  }

  drainChromeWrites();
}

function drainChromeWrites() {
  if (chromeWriteDraining) return;
  chromeWriteDraining = true;

  for (;;) {
    const entry = chromeWriteQueue.shift();
    if (!entry) {
      chromeWriteDraining = false;
      return;
    }

    chromeWriteQueueBytes -= entry.frame.length;
    if (entry.ownerClient && !clients.has(entry.ownerClient)) {
      if (entry.pendingId) pendingRequests.delete(entry.pendingId);
      continue;
    }

    if (!process.stdout.write(entry.frame)) {
      logStdoutBackpressure();
      process.stdout.once("drain", () => {
        chromeWriteDraining = false;
        drainChromeWrites();
      });
      return;
    }
  }
}

function sendToClient(client, message) {
  if (client.socket.destroyed) return;
  client.socket.write(encodeMessage(message));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function cleanupStaleSockets() {
  if (!fs.existsSync(SOCKET_DIR)) return;

  for (const entry of fs.readdirSync(SOCKET_DIR)) {
    const match = entry.match(/^chromium-(\d+)\.sock$/);
    if (!match) continue;

    const pid = Number(match[1]);
    if (pid === process.pid || processExists(pid)) continue;

    const socketPath = path.join(SOCKET_DIR, entry);
    try {
      const stat = fs.statSync(socketPath);
      if (!stat.isSocket()) continue;
      fs.rmSync(socketPath, { force: true });
      log("removed stale socket", socketPath);
    } catch (error) {
      log("stale socket cleanup failed", `${socketPath} ${error.message}`);
    }
  }
}

function forwardClientMessage(client, message) {
  if (hasId(message)) {
    const bridgeId = `codex-bridge:${client.id}:${String(message.id)}`;
    pendingRequests.set(bridgeId, { client, originalId: message.id });
    enqueueChromeWrite({ ...message, id: bridgeId }, client, bridgeId);
    return;
  }

  enqueueChromeWrite(message, client);
}

function forwardChromeMessage(message) {
  if (hasId(message)) {
    const key = String(message.id);
    const pending = pendingRequests.get(key);
    if (pending) {
      pendingRequests.delete(key);
      sendToClient(pending.client, { ...message, id: pending.originalId });
      return;
    }
  }

  for (const client of clients) {
    sendToClient(client, message);
  }
}

function removePendingForClient(client) {
  let removed = 0;
  for (const [id, pending] of pendingRequests) {
    if (pending.client === client) {
      pendingRequests.delete(id);
      removed += 1;
    }
  }
  return removed;
}

function ensureSocketDirectory() {
  const stat = fs.existsSync(SOCKET_DIR) ? fs.statSync(SOCKET_DIR) : null;
  if (stat && !stat.isDirectory()) {
    throw new Error(`${SOCKET_DIR} exists but is not a directory`);
  }
  if (!stat) fs.mkdirSync(SOCKET_DIR, { mode: 0o700, recursive: true });
  cleanupStaleSockets();
  try {
    fs.chmodSync(SOCKET_DIR, 0o700);
  } catch (error) {
    log("chmod socket directory failed", error.message);
  }
  try {
    fs.rmSync(SOCKET_PATH, { force: true });
  } catch {
    // Best effort; listen() will report a real conflict if it remains.
  }
}

function shutdown(code = 0) {
  log("shutdown", `code=${code}`);
  for (const client of clients) {
    client.socket.destroy();
  }
  try {
    server.close();
  } catch {
    // Ignore shutdown races.
  }
  try {
    fs.rmSync(SOCKET_PATH, { force: true });
  } catch {
    // Ignore cleanup races.
  }
  process.exit(code);
}

ensureSocketDirectory();

const server = net.createServer((socket) => {
  const client = { id: nextClientId++, socket };
  clients.add(client);
  log("client connected", `id=${client.id}`);

  const parse = makeFrameParser(
    (message) => forwardClientMessage(client, message),
    (error) => {
      log("client parse error", `id=${client.id} ${error.message}`);
      socket.destroy();
    }
  );

  socket.on("data", parse);
  socket.on("error", (error) => log("client socket error", `id=${client.id} ${error.message}`));
  socket.on("close", () => {
    clients.delete(client);
    const orphanedPending = removePendingForClient(client);
    log(
      "client disconnected",
      `id=${client.id}${orphanedPending > 0 ? ` orphaned_pending=${orphanedPending}` : ""}`
    );
    if (orphanedPending > 0 && EXIT_ON_ORPHANED_PENDING) {
      log(
        "orphaned pending request",
        `id=${client.id} restarting native host bridge to clear in-flight browser command`
      );
      setImmediate(() => shutdown(0));
    }
  });
});

server.on("error", (error) => {
  log("server error", error.stack || error.message);
  shutdown(1);
});

server.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch (error) {
    log("chmod socket failed", error.message);
  }
  log("listening", SOCKET_PATH);
});

const parseChrome = makeFrameParser(
  forwardChromeMessage,
  (error) => log("chrome parse error", error.stack || error.message)
);

process.stdin.on("data", parseChrome);
process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", (error) => {
  log("stdin error", error.stack || error.message);
  shutdown(1);
});
process.stdout.on("error", (error) => {
  log("stdout error", error.stack || error.message);
  shutdown(1);
});

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (error) => {
  log("uncaught exception", error.stack || error.message);
  shutdown(1);
});

log("started", `pid=${process.pid} socket=${SOCKET_PATH}`);
