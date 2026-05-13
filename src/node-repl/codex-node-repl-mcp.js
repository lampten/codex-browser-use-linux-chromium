#!/usr/bin/env node
/*
 * Minimal local replacement for Codex's removed js_repl/node_repl runtime.
 *
 * It intentionally implements just enough of the Node REPL MCP surface for the
 * Chrome browser-client bootstrap to run on linux/arm64:
 *   - tool: js
 *   - tool: js_reset
 *   - globalThis.nodeRepl request metadata/helpers
 *   - globalThis.__codexNativePipe.createConnection(path)
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const realProcess = require("node:process");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const STDIN = realProcess.stdin;
const ORIGINAL_STDOUT_WRITE = realProcess.stdout.write.bind(realProcess.stdout);
const LOG_PATH = realProcess.env.CODEX_NODE_REPL_MCP_LOG || "/tmp/codex-node-repl-mcp.log";
const DEFAULT_CWD = realProcess.env.CODEX_NODE_REPL_CWD || realProcess.cwd();
const TMP_DIR = realProcess.env.CODEX_NODE_REPL_TMPDIR || path.join(os.tmpdir(), "codex-node-repl-mcp");
const ARTIFACT_DIR = realProcess.env.CODEX_NODE_REPL_ARTIFACT_DIR || DEFAULT_CWD;
const SESSION_ID =
  realProcess.env.CODEX_NODE_REPL_SESSION_ID ||
  `node-repl-mcp-${os.hostname()}-${realProcess.pid}-${randomUUID()}`;
const TURN_ID = realProcess.env.CODEX_NODE_REPL_TURN_ID || `${SESSION_ID}-turn`;
const JS_TIMEOUT_MS = parseNonNegativeInt(realProcess.env.CODEX_NODE_REPL_JS_TIMEOUT_MS, 100000);
const EXIT_ON_TIMEOUT = /^(1|true|yes)$/i.test(
  realProcess.env.CODEX_NODE_REPL_EXIT_ON_TIMEOUT || ""
);
const RESET_ON_TIMEOUT = !/^(0|false|no)$/i.test(
  realProcess.env.CODEX_NODE_REPL_RESET_ON_TIMEOUT || ""
);
const RESET_ON_BROWSER_BRIDGE_ERROR = !/^(0|false|no)$/i.test(
  realProcess.env.CODEX_NODE_REPL_RESET_ON_BROWSER_BRIDGE_ERROR || ""
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let context = null;
let lastEmittedImages = [];
let imageCounter = 0;
let queue = Promise.resolve();
let endRequested = false;
let timeoutExitRequested = false;
let consecutiveJsTimeouts = 0;

function log(message, extra) {
  try {
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${message}${extra ? ` ${extra}` : ""}\n`
    );
  } catch {
    // stdout is reserved for MCP JSON-RPC.
  }
}

function normalizeOutputChunk(chunk) {
  let text;
  if (Buffer.isBuffer(chunk)) text = chunk.toString("utf8");
  else if (chunk instanceof Uint8Array) text = Buffer.from(chunk).toString("utf8");
  else text = String(chunk);

  if (text.length > 4000) return `${text.slice(0, 4000)}...[truncated ${text.length} chars]`;
  return text;
}

function captureProcessOutput(kind, chunk, encoding, callback) {
  const cb = typeof encoding === "function" ? encoding : callback;
  const text = normalizeOutputChunk(chunk).replace(/\s+$/g, "");
  if (text) {
    if (context?.__logs) context.__logs.push(`[${kind}] ${text}`);
    else log(`captured ${kind}`, JSON.stringify(text));
  }
  if (typeof cb === "function") queueMicrotask(cb);
  return true;
}

function parseNonNegativeInt(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

// MCP uses stdout for JSON-RPC framing. Any user code or imported module that
// writes to process stdout corrupts the transport, so keep the original writer
// private for protocol replies and capture all other process output.
realProcess.stdout.write = function guardedStdoutWrite(chunk, encoding, callback) {
  return captureProcessOutput("stdout", chunk, encoding, callback);
};

realProcess.stderr.write = function guardedStderrWrite(chunk, encoding, callback) {
  return captureProcessOutput("stderr", chunk, encoding, callback);
};

function makeRequestMeta() {
  return {
    "x-codex-turn-metadata": {
      session_id: SESSION_ID,
      turn_id: TURN_ID,
    },
    "x-codex-browser-use-security-mode": "disabled-for-local-testing",
    "x-codex-browser-use-disable-ambient-network": true,
  };
}

function makeNativePipe(nativeConnections) {
  return {
    createConnection(socketPath) {
      if (typeof socketPath !== "string" || socketPath.length === 0) {
        throw new Error("createConnection requires a Unix socket path");
      }
      const socket = net.createConnection(socketPath);
      nativeConnections.add(socket);
      socket.once("close", () => nativeConnections.delete(socket));
      socket.on("error", (error) => log("native pipe socket error", error.message));
      return socket;
    },
  };
}

async function importFromCwd(specifier, cwd = DEFAULT_CWD) {
  if (typeof specifier === "string" && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    return import(pathToFileURL(path.resolve(cwd, specifier)).href);
  }
  return import(specifier);
}

function parseImage(imageLike) {
  if (typeof imageLike === "string") {
    const match = imageLike.match(/^data:([^;,]+);base64,(.*)$/s);
    if (match) return { mimeType: match[1], data: match[2].replace(/\s/g, "") };
  }

  if (Buffer.isBuffer(imageLike)) {
    return { mimeType: "image/png", data: imageLike.toString("base64") };
  }

  if (
    imageLike &&
    typeof imageLike === "object" &&
    typeof imageLike.toBase64 === "function"
  ) {
    return { mimeType: "image/png", data: String(imageLike.toBase64()).replace(/\s/g, "") };
  }

  if (
    imageLike &&
    typeof imageLike === "object" &&
    Buffer.isBuffer(imageLike.bytes) &&
    typeof imageLike.mimeType === "string"
  ) {
    return { mimeType: imageLike.mimeType, data: imageLike.bytes.toString("base64") };
  }

  throw new Error("emitImage requires a data URL, Buffer, or { bytes, mimeType }");
}

function extensionForMimeType(mimeType) {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function sanitizeFileName(fileName) {
  const safe = String(fileName || "")
    .replace(/[\\/:\0]/g, "-")
    .replace(/^\.+$/g, "")
    .trim();
  return safe || null;
}

function defaultImageFileName(mimeType) {
  imageCounter += 1;
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `browser-screenshot-${stamp}-${String(imageCounter).padStart(2, "0")}.${extensionForMimeType(
    mimeType
  )}`;
}

function normalizeSaveImageOptions(optionsOrFileName) {
  if (typeof optionsOrFileName === "string") return { fileName: optionsOrFileName };
  if (optionsOrFileName && typeof optionsOrFileName === "object") return optionsOrFileName;
  return {};
}

function saveParsedImage(image, optionsOrFileName) {
  const options = normalizeSaveImageOptions(optionsOrFileName);
  const fileName =
    sanitizeFileName(options.fileName || options.filename || options.name) ||
    defaultImageFileName(image.mimeType);
  const targetPath = path.isAbsolute(fileName)
    ? fileName
    : path.resolve(options.dir || ARTIFACT_DIR, fileName);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(image.data, "base64"));
  return targetPath;
}

function disposeContextResources(targetContext = context, reason = "reset") {
  const nativeConnections = targetContext?.__nativeConnections;
  if (!nativeConnections || nativeConnections.size === 0) return;

  const count = nativeConnections.size;
  for (const socket of [...nativeConnections]) {
    try {
      socket.destroy();
    } catch {
      // Best effort cleanup for timed-out browser calls.
    }
  }
  nativeConnections.clear();
  log("disposed context resources", `reason=${reason} native_connections=${count}`);
}

function resetContext() {
  disposeContextResources(context, "reset");
  fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 });
  lastEmittedImages = [];

  const emittedImages = [];
  const savedImagePaths = [];
  const logs = [];
  const writes = [];
  const nativeConnections = new Set();
  const nativePipe = makeNativePipe(nativeConnections);
  const state = { responseMeta: {} };

  globalThis.__codexNativePipe = nativePipe;

  const nodeRepl = {
    cwd: DEFAULT_CWD,
    homeDir: os.homedir(),
    tmpDir: TMP_DIR,
    artifactDir: ARTIFACT_DIR,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    requestMeta: makeRequestMeta(),
    fetch: globalThis.fetch?.bind(globalThis),
    import(specifier) {
      return importFromCwd(specifier, this.cwd);
    },
    write(text) {
      writes.push(String(text));
    },
    setResponseMeta(meta) {
      state.responseMeta = { ...state.responseMeta, ...(meta || {}) };
    },
    saveImage(imageLike, options) {
      const image = parseImage(imageLike);
      const savedPath = saveParsedImage(image, options);
      savedImagePaths.push(savedPath);
      this.lastImagePath = savedPath;
      return savedPath;
    },
    async emitImage(imageLike, options) {
      const image = parseImage(imageLike);
      emittedImages.push(image);
      const savedPath = saveParsedImage(image, options);
      savedImagePaths.push(savedPath);
      this.lastImagePath = savedPath;
      writes.push(`Saved image: ${savedPath}\nMarkdown image: ![screenshot](${savedPath})\n`);
      return savedPath;
    },
    async createElicitation() {
      return { action: "accept", allowed: true };
    },
  };
  globalThis.nodeRepl = nodeRepl;

  const replConsole = {
    log(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
    warn(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
    error(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
  };

  context = {
    Buffer,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    process: {
      ...realProcess,
      env: realProcess.env,
      cwd: () => DEFAULT_CWD,
      stdout: undefined,
      stderr: undefined,
      stdin: undefined,
    },
    console: replConsole,
    fetch: globalThis.fetch?.bind(globalThis),
    nodeRepl,
    __codexNativePipe: nativePipe,
    __dynamicImport: (specifier) => importFromCwd(specifier, nodeRepl.cwd),
    require,
    savedImagePaths,
    __nativeConnections: nativeConnections,
    __state: state,
  };
  context.globalThis = context;
  context.global = context;
  context.emittedImages = emittedImages;
  context.__logs = logs;
  context.__writes = writes;
}

function formatValue(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function runJs(code) {
  if (context == null) resetContext();
  if (typeof code !== "string") throw new Error("js requires a string code argument");

  const runContext = context;
  runContext.nodeRepl.requestMeta = makeRequestMeta();
  globalThis.nodeRepl = runContext.nodeRepl;
  globalThis.__codexNativePipe = runContext.__codexNativePipe;
  runContext.__state.responseMeta = {};
  runContext.__logs.length = 0;
  runContext.__writes.length = 0;
  runContext.emittedImages.length = 0;

  const fn = new AsyncFunction(
    "globalThis",
    "__dynamicImport",
    `
with (globalThis) {
  return await (async () => {
${code}
  })();
}
`
  );

  const result = await fn(runContext, (specifier) => importFromCwd(specifier, runContext.nodeRepl.cwd));
  const content = [];
  const text = [];
  const images = runContext.emittedImages.slice();
  if (images.length > 0) {
    lastEmittedImages = images;
  } else if (shouldReplayLastImagesAfterCleanup(code, result)) {
    images.push(...lastEmittedImages);
  }

  if (runContext.__writes.length > 0) text.push(runContext.__writes.join(""));
  if (runContext.__logs.length > 0) text.push(runContext.__logs.join("\n"));
  if (result !== undefined) text.push(formatValue(result));
  if (Object.keys(runContext.__state.responseMeta).length > 0) {
    text.push(`responseMeta: ${JSON.stringify(runContext.__state.responseMeta)}`);
  }
  if (text.length > 0) content.push({ type: "text", text: text.join("\n") });
  if (content.length === 0 && images.length === 0) {
    content.push({ type: "text", text: "" });
  }
  for (const image of images) {
    content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }

  return { content };
}

function shouldReplayLastImagesAfterCleanup(code, result) {
  return (
    lastEmittedImages.length > 0 &&
    result === undefined &&
    /browser\.tabs\.finalize\s*\(/.test(code) &&
    !/\b(display|emitImage)\s*\(/.test(code)
  );
}

class JsTimeoutError extends Error {
  constructor(timeoutMs, consecutiveTimeouts = 1) {
    super(
      `js tool timed out after ${timeoutMs}ms; node_repl MCP transport remains open for follow-up calls; consecutive_js_timeouts=${consecutiveTimeouts}. If lightweight browser calls still work but tab.playwright/tab.cua/fill/click/keyboard calls keep timing out, run js_reset and stop retrying the same page-level operation.`
    );
    this.name = "JsTimeoutError";
  }
}

async function withTimeoutMs(promise, timeoutMs, onTimeout, createTimeoutError) {
  if (!timeoutMs) return promise;

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch (error) {
            log("timeout cleanup failed", error.stack || error.message);
          }
          reject(createTimeoutError ? createTimeoutError() : new JsTimeoutError(timeoutMs));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function jsTimeoutFromArgs(args = {}) {
  const perCallTimeout = args.timeout_ms ?? args.timeoutMs;
  return parseNonNegativeInt(perCallTimeout, JS_TIMEOUT_MS);
}

function summarizeJsArgs(args = {}) {
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "untitled";
  const code = typeof args.code === "string" ? args.code.replace(/\s+/g, " ").trim() : "";
  const codePrefix = code.length > 160 ? `${code.slice(0, 160)}...` : code;
  return `title=${JSON.stringify(title)} code=${JSON.stringify(codePrefix)}`;
}

function scheduleTimeoutExit() {
  if (timeoutExitRequested) return;
  timeoutExitRequested = true;
  endRequested = true;
  log("timeout exit scheduled", `pid=${realProcess.pid}`);
  setTimeout(() => {
    log("timeout exit now", `pid=${realProcess.pid}`);
    realProcess.exit(124);
  }, 100);
}

function exitCodeForEnd() {
  return timeoutExitRequested ? 124 : 0;
}

const tools = [
  {
    name: "js",
    description:
      "Execute JavaScript in a persistent Node.js REPL with top-level await. Pass { code: string }.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string" },
        title: { type: "string" },
        timeout_ms: { type: "number" },
        timeoutMs: { type: "number" },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "js_reset",
    description: "Reset the persistent Node.js REPL context.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function writeMessage(message) {
  ORIGINAL_STDOUT_WRITE(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, error) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: errorMessage(error),
    },
  });
}

function errorMessage(error) {
  const message = error && error.message ? error.message : String(error);
  if (!isBrowserBridgeStaleError(error)) return message;
  if (/js_reset|re-bootstrap/i.test(message)) return message;
  return `${message}. Browser bridge state was reset; run js_reset, re-bootstrap the runtime, and reacquire the tab before retrying.`;
}

function isBrowserBridgeStaleError(error) {
  const message = error && error.message ? error.message : String(error);
  return /native pipe is closed|native pipe closed before response|Detached while handling command/i.test(
    message
  );
}

async function callTool(name, args = {}) {
  if (name === "js") {
    const timeoutMs = jsTimeoutFromArgs(args);
    const startedAt = Date.now();
    log("js call started", `timeout_ms=${timeoutMs} ${summarizeJsArgs(args)}`);
    try {
      const result = await withTimeoutMs(
        runJs(args.code),
        timeoutMs,
        () => {
          log("js timeout cleanup", `timeout_ms=${timeoutMs} ${summarizeJsArgs(args)}`);
          if (RESET_ON_TIMEOUT) {
            disposeContextResources(context, "timeout");
            context = null;
          }
        },
        () => new JsTimeoutError(timeoutMs, consecutiveJsTimeouts + 1)
      );
      consecutiveJsTimeouts = 0;
      return result;
    } catch (error) {
      if (error instanceof JsTimeoutError) consecutiveJsTimeouts += 1;
      else if (RESET_ON_BROWSER_BRIDGE_ERROR && isBrowserBridgeStaleError(error)) {
        log("browser bridge error cleanup", error.message || String(error));
        disposeContextResources(context, "browser-bridge-error");
        context = null;
      }
      throw error;
    } finally {
      log("js call finished", `duration_ms=${Date.now() - startedAt} ${summarizeJsArgs(args)}`);
    }
  }
  if (name === "js_reset") {
    consecutiveJsTimeouts = 0;
    resetContext();
    return { content: [{ type: "text", text: "reset" }] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;

  try {
    switch (message.method) {
      case "initialize":
        sendResult(message.id, {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "node_repl", version: "0.1.0" },
        });
        break;
      case "tools/list":
        sendResult(message.id, { tools });
        break;
      case "tools/call":
        sendResult(
          message.id,
          await callTool(message.params?.name, message.params?.arguments || {})
        );
        break;
      default:
        sendError(message.id, new Error(`Unsupported MCP method: ${message.method}`));
    }
  } catch (error) {
    log("request failed", `${message.method || "unknown"} ${error.stack || error.message}`);
    if (error?.name === "JsTimeoutError" && EXIT_ON_TIMEOUT) scheduleTimeoutExit();
    try {
      sendError(message.id, error);
    } catch (writeError) {
      log("failed to send error", writeError.stack || writeError.message);
    }
  }
}

let input = "";
STDIN.setEncoding("utf8");
STDIN.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      queue = queue
        .then(() => handleMessage(message))
        .catch((error) => log("queued request failed", error.stack || error.message))
        .finally(() => {
          if (endRequested) realProcess.exit(exitCodeForEnd());
        });
    } catch (error) {
      log("parse failed", error.stack || error.message);
    }
  }
});

STDIN.on("end", () => {
  endRequested = true;
  queue.finally(() => realProcess.exit(exitCodeForEnd()));
});
realProcess.on("uncaughtException", (error) => {
  log("uncaught exception", error.stack || error.message);
  realProcess.exit(1);
});

resetContext();
log(
  "started",
  `pid=${realProcess.pid} session_id=${SESSION_ID} turn_id=${TURN_ID} js_timeout_ms=${JS_TIMEOUT_MS}`
);
