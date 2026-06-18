#!/usr/bin/env node
/*
 * Minimal local replacement for Codex's removed js_repl/node_repl runtime.
 *
 * It intentionally implements just enough of the Node REPL MCP surface for the
 * Chrome browser-client bootstrap to run on linux/arm64:
 *   - tool: js
 *   - tool: js_reset
 *   - tool: browser_cleanup
 *   - globalThis.nodeRepl request metadata/helpers
 *   - globalThis.__codexNativePipe.createConnection(path)
 */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const realProcess = require("node:process");
const childProcess = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const STDIN = realProcess.stdin;
const ORIGINAL_STDOUT_WRITE = realProcess.stdout.write.bind(realProcess.stdout);
const LOG_PATH = realProcess.env.CODEX_NODE_REPL_MCP_LOG || "/tmp/codex-node-repl-mcp.log";
const DEFAULT_CWD = realProcess.env.CODEX_NODE_REPL_CWD || realProcess.cwd();
const TMP_DIR = realProcess.env.CODEX_NODE_REPL_TMPDIR || path.join(os.tmpdir(), "codex-node-repl-mcp");
const ARTIFACT_DIR = realProcess.env.CODEX_NODE_REPL_ARTIFACT_DIR || DEFAULT_CWD;
const NODE_REPL_CHROMIUM_AUTOSTART_MARKER =
  "codex-browser-use-linux-chromium: node-repl-chromium-extension-autostart";
const NODE_REPL_CHROMIUM_FOREGROUND_SOCKET_MARKER =
  "codex-browser-use-linux-chromium: node-repl-chromium-foreground-socket-selection";
const NODE_REPL_CHROMIUM_NAVIGATION_PREFLIGHT_MARKER =
  "codex-browser-use-linux-chromium: node-repl-chromium-http-navigation-preflight";
const NODE_REPL_IDLE_BROWSER_CLEANUP_MARKER =
  "codex-browser-use-linux-chromium: node-repl-idle-browser-cleanup";
const NODE_REPL_CHROMIUM_PASSWORD_STORE_MARKER =
  "codex-browser-use-linux-chromium: node-repl-chromium-password-store-basic";
const BROWSER_USE_SOCKET_DIR =
  realProcess.env.CODEX_BROWSER_USE_SOCKET_DIR || path.join(os.tmpdir(), "codex-browser-use");
const CHROMIUM_SOCKET_SELECTION = (
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_SOCKET_SELECTION || "prefer-default-profile"
).toLowerCase();
const CHROMIUM_USER_DATA_DIR =
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_USER_DATA_DIR ||
  path.join(os.homedir(), ".config", "chromium");
const CHROMIUM_PROFILE_DIRECTORY = realProcess.env.CODEX_BROWSER_USE_CHROMIUM_PROFILE || "";
const CHROMIUM_EXTENSION_READY_TIMEOUT_MS = parseNonNegativeInt(
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_READY_TIMEOUT_MS,
  6000
);
const CHROMIUM_EXTENSION_READY_POLL_MS = parseNonNegativeInt(
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_READY_POLL_MS,
  250
);
const CHROMIUM_EXTENSION_AUTOSTART = !/^(0|false|no)$/i.test(
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_AUTOSTART || ""
);
const CHROMIUM_NAVIGATION_PREFLIGHT = !/^(0|false|no)$/i.test(
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_NAVIGATION_PREFLIGHT || ""
);
const CHROMIUM_NAVIGATION_PREFLIGHT_TIMEOUT_MS = parseNonNegativeInt(
  realProcess.env.CODEX_BROWSER_USE_CHROMIUM_NAVIGATION_PREFLIGHT_TIMEOUT_MS,
  7000
);
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
const CLEANUP_TABS_ON_RESET = !/^(0|false|no)$/i.test(
  realProcess.env.CODEX_NODE_REPL_CLEANUP_TABS_ON_RESET || ""
);
const CLEANUP_TABS_ON_EXIT = !/^(0|false|no)$/i.test(
  realProcess.env.CODEX_NODE_REPL_CLEANUP_TABS_ON_EXIT || ""
);
const BROWSER_CLEANUP_TIMEOUT_MS = parseNonNegativeInt(
  realProcess.env.CODEX_NODE_REPL_BROWSER_CLEANUP_TIMEOUT_MS,
  3000
);
const IDLE_BROWSER_CLEANUP_MS = parseNonNegativeInt(
  realProcess.env.CODEX_NODE_REPL_IDLE_BROWSER_CLEANUP_MS,
  10 * 60 * 1000
);
const SIGNAL_CLEANUP_EXIT_TIMEOUT_MS = parseNonNegativeInt(
  realProcess.env.CODEX_NODE_REPL_SIGNAL_CLEANUP_EXIT_TIMEOUT_MS,
  5000
);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

let context = null;
let lastEmittedImages = [];
let imageCounter = 0;
let queue = Promise.resolve();
let endRequested = false;
let shutdownStarted = false;
let timeoutExitRequested = false;
let consecutiveJsTimeouts = 0;
let lastContextResetReason = null;
let idleBrowserCleanupTimer = null;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandPath(command) {
  const pathValue = realProcess.env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

function readJsonFileIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function userSystemdEnvironment() {
  const env = {};
  try {
    const result = childProcess.spawnSync("systemctl", ["--user", "show-environment"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    if (result.status === 0) {
      for (const line of String(result.stdout || "").split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        if (
          [
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
            "DBUS_SESSION_BUS_ADDRESS",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_TYPE",
          ].includes(match[1])
        ) {
          env[match[1]] = match[2];
        }
      }
    }
  } catch {
    // Fall through to filesystem-derived defaults below.
  }

  const uid = typeof realProcess.getuid === "function" ? realProcess.getuid() : os.userInfo().uid;
  const runtimeDir = env.XDG_RUNTIME_DIR || (uid != null ? `/run/user/${uid}` : "");
  if (runtimeDir && fs.existsSync(runtimeDir)) {
    env.XDG_RUNTIME_DIR = runtimeDir;
    if (!env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(path.join(runtimeDir, "bus"))) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtimeDir, "bus")}`;
    }
    if (!env.WAYLAND_DISPLAY && fs.existsSync(path.join(runtimeDir, "wayland-0"))) {
      env.WAYLAND_DISPLAY = "wayland-0";
      env.XDG_SESSION_TYPE = env.XDG_SESSION_TYPE || "wayland";
    }
  }
  if (!env.DISPLAY && fs.existsSync("/tmp/.X11-unix/X0")) env.DISPLAY = ":0";
  return env;
}

function processState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2);
    return afterCommand.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

function processParentPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2);
    const fields = afterCommand.split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

function processCommandArgs(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function processExists(pid) {
  try {
    realProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function processIsLiveNonZombie(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return false;
  return processState(pid) !== "Z";
}

function chromiumDefaultProfilePid() {
  const lockPath = path.join(CHROMIUM_USER_DATA_DIR, "SingletonLock");
  if (!fs.existsSync(lockPath)) return null;

  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return null;
  }

  const pid = chromiumSingletonPidFromTarget(target);
  return processIsLiveNonZombie(pid) ? pid : null;
}

function chromiumSingletonPidFromTarget(target) {
  const match = String(target || "").match(/-(\d+)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function chromiumProfileDirectoryExists(profileDirectory) {
  return fs.existsSync(path.join(CHROMIUM_USER_DATA_DIR, profileDirectory, "Preferences"));
}

function resolveChromiumProfileDirectory() {
  if (CHROMIUM_PROFILE_DIRECTORY && chromiumProfileDirectoryExists(CHROMIUM_PROFILE_DIRECTORY)) {
    return CHROMIUM_PROFILE_DIRECTORY;
  }

  const localState = readJsonFileIfPresent(path.join(CHROMIUM_USER_DATA_DIR, "Local State"));
  const lastUsed = localState?.profile?.last_used;
  if (typeof lastUsed === "string" && chromiumProfileDirectoryExists(lastUsed)) return lastUsed;

  const activeProfiles = localState?.profile?.last_active_profiles;
  if (Array.isArray(activeProfiles)) {
    const usable = activeProfiles.filter(
      (profile) => typeof profile === "string" && chromiumProfileDirectoryExists(profile)
    );
    if (usable.length > 0) return usable.at(-1);
  }

  if (chromiumProfileDirectoryExists("Default")) return "Default";
  return "Default";
}

function liveBrowserUseSockets() {
  return rankedBrowserUseSockets();
}

function socketPidFromPath(socketPath) {
  const match = path.basename(String(socketPath || "")).match(/^chromium-(\d+)\.sock$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function socketSelectionEnabled() {
  return !/^(0|false|no|off|all|disabled)$/.test(CHROMIUM_SOCKET_SELECTION);
}

function socketPathInBrowserUseDir(socketPath) {
  const resolved = path.resolve(socketPath);
  const resolvedDir = path.resolve(BROWSER_USE_SOCKET_DIR);
  return resolved === resolvedDir || resolved.startsWith(`${resolvedDir}${path.sep}`);
}

function userDataDirFromCommandArgs(args) {
  const match = commandLineText(args).match(/(?:^|\s)--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match ? match[1] || match[2] || match[3] || null : null;
}

function commandLineText(args) {
  return args.join(" ");
}

function commandLineHasFlag(args, flag) {
  const text = ` ${commandLineText(args)} `;
  return text.includes(` ${flag} `) || text.includes(` ${flag}=`);
}

function isTemporaryUserDataDir(userDataDir) {
  if (!userDataDir) return false;
  const resolved = path.resolve(userDataDir);
  const tmp = path.resolve(os.tmpdir());
  return resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`);
}

function browserUseSocketCandidate(socketPath, defaultProfilePid = chromiumDefaultProfilePid()) {
  const pid = socketPidFromPath(socketPath);
  let isSocket = false;
  try {
    isSocket = fs.statSync(socketPath).isSocket();
  } catch {
    // Ignore races while Chromium or the native host starts/exits.
  }

  const ownerProcessAlive = processIsLiveNonZombie(pid);
  const browserPid = ownerProcessAlive ? processParentPid(pid) : null;
  const browserProcessAlive = processIsLiveNonZombie(browserPid);
  const browserArgs = browserProcessAlive ? processCommandArgs(browserPid) : [];
  const userDataDir = userDataDirFromCommandArgs(browserArgs);
  const browserCommandLine = commandLineText(browserArgs);
  const headless =
    commandLineHasFlag(browserArgs, "--headless") ||
    browserCommandLine.includes("--ozone-platform=headless");
  const incognito = commandLineHasFlag(browserArgs, "--incognito");
  const temporaryProfile = isTemporaryUserDataDir(userDataDir);
  const defaultProfile =
    browserPid != null &&
    (browserPid === defaultProfilePid ||
      (userDataDir != null && path.resolve(userDataDir) === path.resolve(CHROMIUM_USER_DATA_DIR)) ||
      (userDataDir == null && !headless));

  let score = 0;
  const reasons = [];
  if (ownerProcessAlive) score += 100;
  if (browserProcessAlive) score += 100;
  if (defaultProfilePid != null && browserPid === defaultProfilePid) {
    score += 1000;
    reasons.push("default-profile-singleton");
  } else if (defaultProfile) {
    score += 600;
    reasons.push("default-profile");
  }
  if (browserCommandLine.includes("--load-extension=")) {
    score += 50;
    reasons.push("codex-extension-loaded");
  }
  if (headless) {
    score -= 800;
    reasons.push("headless");
  }
  if (temporaryProfile) {
    score -= 700;
    reasons.push("temporary-profile");
  }
  if (incognito) {
    score -= 300;
    reasons.push("incognito");
  }

  return {
    path: socketPath,
    pid,
    isSocket,
    ownerProcessAlive,
    browserPid,
    browserProcessAlive,
    userDataDir,
    defaultProfile,
    headless,
    temporaryProfile,
    incognito,
    score,
    reasons,
  };
}

function rankedBrowserUseSockets() {
  if (!fs.existsSync(BROWSER_USE_SOCKET_DIR)) return [];
  const defaultProfilePid = chromiumDefaultProfilePid();
  return fs
    .readdirSync(BROWSER_USE_SOCKET_DIR)
    .filter((entry) => /^chromium-\d+\.sock$/.test(entry))
    .map((entry) =>
      browserUseSocketCandidate(path.join(BROWSER_USE_SOCKET_DIR, entry), defaultProfilePid)
    )
    .filter((socket) => socket.isSocket && socket.ownerProcessAlive)
    .sort((left, right) => right.score - left.score || right.pid - left.pid);
}

function browserUseSocketConnectionDecision(socketPath) {
  if (!socketSelectionEnabled() || !socketPathInBrowserUseDir(socketPath)) {
    return { allow: true, reason: "selection-disabled-or-non-browser-use-socket" };
  }

  const resolved = path.resolve(socketPath);
  const candidates = rankedBrowserUseSockets();
  if (candidates.length <= 1) return { allow: true, reason: "single-candidate" };

  const current = candidates.find((candidate) => path.resolve(candidate.path) === resolved);
  if (!current) return { allow: true, reason: "unknown-candidate" };

  const preferred = candidates[0];
  if (preferred.score > current.score) {
    return {
      allow: false,
      reason: "lower-priority-chromium-backend",
      current,
      preferred,
    };
  }
  return { allow: true, reason: "preferred-candidate", current, preferred };
}

function cleanupStaleChromiumProfileLocks() {
  const lockPath = path.join(CHROMIUM_USER_DATA_DIR, "SingletonLock");
  if (!fs.existsSync(lockPath)) return [];

  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch {
    return [];
  }

  const pid = chromiumSingletonPidFromTarget(target);
  if (pid != null && processIsLiveNonZombie(pid)) return [];

  const removed = [];
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const filePath = path.join(CHROMIUM_USER_DATA_DIR, name);
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        removed.push(filePath);
      }
    } catch (error) {
      log("chromium stale profile lock cleanup failed", `${filePath} ${error.message}`);
    }
  }

  if (removed.length > 0) {
    log("chromium stale profile locks removed", `pid=${pid || "unknown"} files=${removed.length}`);
  }
  return removed;
}

function launchChromiumForExtension() {
  const command =
    realProcess.env.CODEX_BROWSER_USE_CHROMIUM_COMMAND ||
    commandPath("chromium") ||
    commandPath("chromium-browser");
  if (!command) throw new Error("Could not find chromium or chromium-browser on PATH");

  const profileDirectory = resolveChromiumProfileDirectory();
  const args = [
    `--profile-directory=${profileDirectory}`,
    "--password-store=basic",
    "--new-window",
    "about:blank",
  ];
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...realProcess.env, ...userSystemdEnvironment() },
  });
  child.unref();
  log("chromium launch requested", `pid=${child.pid || "unknown"} command=${command} profile=${profileDirectory}`);
  return { command, args, pid: child.pid || null, profileDirectory };
}

async function waitForBrowserUseSocket(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const sockets = liveBrowserUseSockets();
    if (sockets.length > 0) return sockets;
    if (Date.now() >= deadline) return [];
    await sleep(CHROMIUM_EXTENSION_READY_POLL_MS);
  }
}

async function ensureChromiumExtensionReady(options = {}) {
  const existingSockets = liveBrowserUseSockets();
  if (existingSockets.length > 0) {
    return { status: "ready", launched: false, sockets: existingSockets };
  }

  if (!CHROMIUM_EXTENSION_AUTOSTART && options.force !== true) {
    return { status: "disabled", launched: false, sockets: [] };
  }

  const removedProfileLocks = cleanupStaleChromiumProfileLocks();
  let launch;
  try {
    launch = launchChromiumForExtension();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log("chromium launch failed", message);
    return {
      status: "launch-failed",
      launched: false,
      error: message,
      removedProfileLocks,
      sockets: [],
    };
  }

  const timeoutMs = parseNonNegativeInt(options.timeoutMs, CHROMIUM_EXTENSION_READY_TIMEOUT_MS);
  const sockets = await waitForBrowserUseSocket(timeoutMs);
  return {
    status: sockets.length > 0 ? "ready" : "not-ready",
    launched: true,
    launch,
    removedProfileLocks,
    sockets,
  };
}

async function createNavigationProbeServer() {
  const token = randomUUID();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, at: new Date().toISOString() });
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-codex-navigation-probe": token,
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>codex navigation probe</title><body data-codex-navigation-probe="${token}">ok ${token}</body>`
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address !== "object") {
    await closeNavigationProbeServer(server);
    throw new Error("Navigation probe server did not expose a TCP address");
  }

  return {
    server,
    token,
    requests,
    url: `http://127.0.0.1:${address.port}/codex-navigation-probe-${token}.html`,
  };
}

function closeNavigationProbeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function navigationPreflightFailureMessage(result) {
  const requests = Array.isArray(result?.requests) ? result.requests.length : 0;
  const phase = result?.phase || "unknown";
  const detail = result?.error ? ` error=${result.error}` : "";
  return `Chromium extension backend navigation preflight failed during ${phase}: minimal local HTTP page did not commit through the Browser extension backend within ${result?.timeoutMs || "unknown"}ms; requests_seen=${requests}; url=${result?.url || "unknown"}.${detail} Stop using the Linux Browser QA path for this task and use a known-good browser runtime instead.`;
}

async function checkChromiumNavigationReady(options = {}) {
  if (!CHROMIUM_NAVIGATION_PREFLIGHT && options.force !== true) {
    return { status: "disabled", reason: "CODEX_BROWSER_USE_CHROMIUM_NAVIGATION_PREFLIGHT=0" };
  }

  const browser = options.browser;
  if (!browser || !browser.tabs || typeof browser.tabs.new !== "function") {
    return { status: "unavailable", phase: "browser", error: "browser.tabs.new is unavailable" };
  }

  const timeoutMs = parseNonNegativeInt(
    options.timeoutMs,
    CHROMIUM_NAVIGATION_PREFLIGHT_TIMEOUT_MS
  );
  const closeTimeoutMs = Math.min(1000, Math.max(250, timeoutMs));
  const startedAt = Date.now();
  const probe = await createNavigationProbeServer();
  let tab = null;
  let phase = "create-tab";

  try {
    tab = await withTimeoutMs(
      browser.tabs.new(),
      timeoutMs,
      () => log("chromium navigation preflight tab creation timed out", `timeout_ms=${timeoutMs}`),
      () => new Error(`timed out creating Browser tab after ${timeoutMs}ms`)
    );

    phase = "navigate";
    await withTimeoutMs(
      tab.goto(probe.url),
      timeoutMs,
      () => {
        disposeContextResources(context, "chromium-navigation-preflight-timeout");
        log(
          "chromium navigation preflight navigate timed out",
          `timeout_ms=${timeoutMs} url=${probe.url} requests=${probe.requests.length}`
        );
      },
      () => new Error(`timed out waiting for minimal HTTP navigation to commit after ${timeoutMs}ms`)
    );

    phase = "url";
    const currentUrl = await withTimeoutMs(
      tab.url(),
      Math.min(2000, timeoutMs),
      () => log("chromium navigation preflight url check timed out", `url=${probe.url}`),
      () => new Error("timed out reading Browser tab URL after navigation")
    );

    const result = {
      status: "ok",
      phase: "complete",
      url: probe.url,
      currentUrl,
      requests: probe.requests.slice(),
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
    };
    log("chromium navigation preflight ok", JSON.stringify(result));
    return result;
  } catch (error) {
    const result = {
      status: "failed",
      phase,
      url: probe.url,
      requests: probe.requests.slice(),
      elapsedMs: Date.now() - startedAt,
      timeoutMs,
      error: error && error.message ? error.message : String(error),
    };
    log("chromium navigation preflight failed", JSON.stringify(result));
    return result;
  } finally {
    if (tab && typeof tab.close === "function") {
      await withTimeoutMs(
        tab.close(),
        closeTimeoutMs,
        () => log("chromium navigation preflight tab close timed out", `timeout_ms=${closeTimeoutMs}`),
        () => new Error("timed out closing navigation preflight tab")
      ).catch((error) =>
        log(
          "chromium navigation preflight tab close failed",
          error && error.message ? error.message : String(error)
        )
      );
    }
    await closeNavigationProbeServer(probe.server);
  }
}

async function assertChromiumNavigationReady(options = {}) {
  const result = await checkChromiumNavigationReady(options);
  if (result.status !== "ok" && result.status !== "disabled") {
    throw new Error(navigationPreflightFailureMessage(result));
  }
  return result;
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
      const decision = browserUseSocketConnectionDecision(socketPath);
      if (!decision.allow) {
        const message = `Skipping lower-priority Chromium extension backend ${socketPath}; preferred ${decision.preferred.path} (${decision.preferred.reasons.join(",") || "score"}). Set CODEX_BROWSER_USE_CHROMIUM_SOCKET_SELECTION=all to disable this filter.`;
        log("browser-use socket skipped", message);
        throw new Error(message);
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

async function cleanupBrowserTabs(targetContext = context, reason = "cleanup") {
  if (!targetContext) return { status: "skipped", reason: "no context" };
  if (targetContext.__browserTabsFinalized) {
    return { status: "skipped", reason: "browser tabs already finalized" };
  }

  const tabs = targetContext.browser?.tabs;
  if (!tabs || typeof tabs.finalize !== "function") {
    return { status: "skipped", reason: "browser.tabs.finalize unavailable" };
  }

  try {
    await tabs.finalize.call(tabs, { keep: [] });
    targetContext.__browserTabsFinalized = true;
    log("browser tabs finalized", `reason=${reason}`);
    return { status: "ok", reason };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log("browser tab cleanup failed", `reason=${reason} error=${JSON.stringify(message)}`);
    return { status: "error", error: message };
  }
}

async function cleanupBrowserTabsWithTimeout(targetContext = context, reason = "cleanup") {
  try {
    return await withTimeoutMs(
      cleanupBrowserTabs(targetContext, reason),
      BROWSER_CLEANUP_TIMEOUT_MS,
      () => log("browser tab cleanup timed out", `reason=${reason}`),
      () =>
        new Error(
          `browser cleanup timed out after ${BROWSER_CLEANUP_TIMEOUT_MS}ms while finalizing session tabs`
        )
    );
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log("browser tab cleanup failed", `reason=${reason} error=${JSON.stringify(message)}`);
    return { status: "error", error: message };
  }
}

function clearIdleBrowserCleanupTimer() {
  if (!idleBrowserCleanupTimer) return;
  clearTimeout(idleBrowserCleanupTimer);
  idleBrowserCleanupTimer = null;
}

function scheduleIdleBrowserCleanup(reason = "idle") {
  clearIdleBrowserCleanupTimer();
  if (!IDLE_BROWSER_CLEANUP_MS || !context || context.__browserTabsFinalized) return;

  idleBrowserCleanupTimer = setTimeout(() => {
    idleBrowserCleanupTimer = null;
    void runIdleBrowserCleanup(reason);
  }, IDLE_BROWSER_CLEANUP_MS);
  idleBrowserCleanupTimer.unref?.();
}

async function runIdleBrowserCleanup(reason = "idle") {
  if (!context || context.__browserTabsFinalized || shutdownStarted) return;

  const cleanupResult = await cleanupBrowserTabsWithTimeout(context, reason);
  if (cleanupResult.status === "ok") {
    disposeContextResources(context, reason);
    context = null;
    lastContextResetReason = reason;
  }
}

function resetContext() {
  clearIdleBrowserCleanupTimer();
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
    async ensureChromiumExtensionReady(options) {
      const result = await ensureChromiumExtensionReady(options);
      this.lastChromiumExtensionReady = result;
      return result;
    },
    async openChromiumWithExtension(options) {
      return this.ensureChromiumExtensionReady(options);
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
    __browserTabsFinalized: false,
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
  if (codeRequestsBrowserFinalize(code)) runContext.__browserTabsFinalized = true;
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

function codeRequestsBrowserFinalize(code) {
  return /browser\.tabs\.finalize\s*\(/.test(code);
}

class JsTimeoutError extends Error {
  constructor(timeoutMs, consecutiveTimeouts = 1) {
    const recovery = RESET_ON_TIMEOUT
      ? "The Browser JS context was reset after this timeout; `tab`, `browser`, and `agent` handles from earlier calls are no longer defined. Next run js_reset or the full Browser bootstrap, create a new tab, navigate to the target URL again, and only then retry. Do not call tab.url(), tab.title(), or other tab.* methods as a lightweight check before re-bootstrap."
      : "Run js_reset, re-bootstrap the Browser runtime, create a new tab, navigate to the target URL again, and only then retry. Do not call tab.url(), tab.title(), or other tab.* methods as a lightweight check after this timeout.";
    super(
      `js tool timed out after ${timeoutMs}ms; node_repl MCP transport remains open for follow-up calls; consecutive_js_timeouts=${consecutiveTimeouts}. ${recovery}`
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

async function shutdown(reason = "stdin-end", exitCode = exitCodeForEnd()) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  clearIdleBrowserCleanupTimer();
  if (CLEANUP_TABS_ON_EXIT) {
    await cleanupBrowserTabsWithTimeout(context, reason);
  }
  disposeContextResources(context, reason);
  realProcess.exit(exitCode);
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
    description:
      "Reset the persistent Node.js REPL context. Also best-effort closes current Browser session tabs unless disabled.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_cleanup",
    description:
      "Best-effort close/finalize tabs created by the current Browser Use session. Does not close arbitrary user tabs.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

function writeMessage(message, framing = "newline") {
  const body = JSON.stringify(message);
  if (message?.id !== undefined && (message.result?.tools || message.result?.serverInfo)) {
    log("mcp response", `id=${message.id} framing=${framing} bytes=${Buffer.byteLength(body, "utf8")}`);
  }
  if (framing === "content-length") {
    ORIGINAL_STDOUT_WRITE(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    return;
  }
  ORIGINAL_STDOUT_WRITE(`${body}\n`);
}

function sendResult(id, result, framing) {
  writeMessage({ jsonrpc: "2.0", id, result }, framing);
}

function sendError(id, error, framing) {
  writeMessage(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: errorMessage(error),
      },
    },
    framing
  );
}

function toolErrorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: errorMessage(error) }],
  };
}

function errorMessage(error) {
  const message = error && error.message ? error.message : String(error);
  if (isMissingBrowserTabError(error)) return browserTabMissingMessage(message);
  if (isBrowserApiShapeError(error)) return browserApiShapeMessage(message);
  if (!isBrowserBridgeStaleError(error)) return message;
  if (/js_reset|re-bootstrap/i.test(message)) return message;
  return `${message}. Browser bridge state was reset; run js_reset, re-bootstrap the runtime, create a new tab, and navigate to the target URL again before retrying. Do not reuse an existing tab with the same URL after this error.`;
}

function isMissingBrowserTabError(error) {
  const message = error && error.message ? error.message : String(error);
  return /\btab is not defined\b/i.test(message);
}

function browserTabMissingMessage(message) {
  const resetContext = lastContextResetReason
    ? ` The previous Browser JS context was reset after ${lastContextResetReason}.`
    : "";
  return `${message}.${resetContext} Re-run the full Browser bootstrap, assign globalThis.browser, create a fresh globalThis.tab, and navigate to the target URL before using tab.* again. Do not use tab.url() or tab.title() as a lightweight check until a new tab binding exists.`;
}

function isBrowserApiShapeError(error) {
  const message = error && error.message ? error.message : String(error);
  return /agent\.browsers\.(map|filter|forEach|find) is not a function|agent\.browsers is not iterable/i.test(
    message
  );
}

function browserApiShapeMessage(message) {
  return `${message}. \`agent.browsers\` is a Browser registry object, not an array. Use \`const browsers = await agent.browsers.list();\` before array operations such as map/filter/find, or use \`await agent.browsers.get("extension")\` to select Chromium directly.`;
}

function isBrowserBridgeStaleError(error) {
  const message = error && error.message ? error.message : String(error);
  return /native pipe is closed|native pipe closed before response|Detached while handling command|Timed out after \d+ms waiting for CDP command/i.test(
    message
  );
}

function formatBrowserCleanupResult(result) {
  if (result.status === "ok") return "browser tabs finalized";
  if (result.status === "skipped") return `browser cleanup skipped: ${result.reason}`;
  return `browser cleanup failed: ${result.error}`;
}

async function callTool(name, args = {}) {
  if (name === "js") {
    clearIdleBrowserCleanupTimer();
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
            lastContextResetReason = "timeout";
          }
        },
        () => new JsTimeoutError(timeoutMs, consecutiveJsTimeouts + 1)
      );
      consecutiveJsTimeouts = 0;
      return result;
    } catch (error) {
      if (error instanceof JsTimeoutError) {
        consecutiveJsTimeouts += 1;
        if (EXIT_ON_TIMEOUT) scheduleTimeoutExit();
        return toolErrorResult(error);
      }
      if (RESET_ON_BROWSER_BRIDGE_ERROR && isBrowserBridgeStaleError(error)) {
        log("browser bridge error cleanup", error.message || String(error));
        disposeContextResources(context, "browser-bridge-error");
        context = null;
        lastContextResetReason = "browser bridge error";
        return toolErrorResult(error);
      }
      if (isBrowserApiShapeError(error)) return toolErrorResult(error);
      if (isMissingBrowserTabError(error)) return toolErrorResult(error);
      throw error;
    } finally {
      log("js call finished", `duration_ms=${Date.now() - startedAt} ${summarizeJsArgs(args)}`);
      scheduleIdleBrowserCleanup("idle");
    }
  }
  if (name === "js_reset") {
    clearIdleBrowserCleanupTimer();
    consecutiveJsTimeouts = 0;
    lastContextResetReason = "js_reset";
    const cleanupResult = CLEANUP_TABS_ON_RESET
      ? await cleanupBrowserTabsWithTimeout(context, "js_reset")
      : { status: "skipped", reason: "disabled" };
    resetContext();
    return {
      content: [{ type: "text", text: `reset; ${formatBrowserCleanupResult(cleanupResult)}` }],
    };
  }
  if (name === "browser_cleanup") {
    clearIdleBrowserCleanupTimer();
    const cleanupResult = await cleanupBrowserTabsWithTimeout(context, "browser_cleanup");
    return { content: [{ type: "text", text: formatBrowserCleanupResult(cleanupResult) }] };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMessage(message, framing = "newline") {
  if (!message || typeof message !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  if (message.method === "initialize" || message.method === "tools/list") {
    log("mcp request", `method=${message.method} id=${message.id} framing=${framing}`);
  }

  try {
    switch (message.method) {
      case "initialize":
        sendResult(
          message.id,
          {
            protocolVersion: message.params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "node_repl", version: "0.1.0" },
          },
          framing
        );
        break;
      case "tools/list":
        sendResult(message.id, { tools }, framing);
        break;
      case "tools/call":
        sendResult(
          message.id,
          await callTool(message.params?.name, message.params?.arguments || {}),
          framing
        );
        break;
      default:
        sendError(message.id, new Error(`Unsupported MCP method: ${message.method}`), framing);
    }
  } catch (error) {
    log("request failed", `${message.method || "unknown"} ${error.stack || error.message}`);
    if (error?.name === "JsTimeoutError" && EXIT_ON_TIMEOUT) scheduleTimeoutExit();
    try {
      sendError(message.id, error, framing);
    } catch (writeError) {
      log("failed to send error", writeError.stack || writeError.message);
    }
  }
}

let input = Buffer.alloc(0);

function enqueueMessage(message, framing) {
  queue = queue
    .then(() => handleMessage(message, framing))
    .catch((error) => log("queued request failed", error.stack || error.message))
    .finally(() => {
      if (endRequested) queueMicrotask(() => shutdown());
    });
}

function trimLeadingTransportWhitespace(buffer) {
  let offset = 0;
  while (
    offset < buffer.length &&
    (buffer[offset] === 0x20 || buffer[offset] === 0x09 || buffer[offset] === 0x0d || buffer[offset] === 0x0a)
  ) {
    offset += 1;
  }
  return offset === 0 ? buffer : buffer.slice(offset);
}

function startsWithJsonMessage(buffer) {
  return buffer[0] === 0x7b || buffer[0] === 0x5b;
}

function headerEnd(buffer) {
  const crlf = buffer.indexOf(Buffer.from("\r\n\r\n", "ascii"));
  if (crlf !== -1) return { index: crlf, length: 4 };
  const lf = buffer.indexOf(Buffer.from("\n\n", "ascii"));
  if (lf !== -1) return { index: lf, length: 2 };
  return null;
}

function parseContentLengthMessage(buffer) {
  const end = headerEnd(buffer);
  if (!end) return null;

  const header = buffer.slice(0, end.index).toString("ascii");
  const match = header.match(/(?:^|\r?\n)content-length:\s*(\d+)\s*(?:\r?\n|$)/i);
  if (!match) throw new Error(`Missing Content-Length header: ${header}`);

  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`Invalid Content-Length: ${match[1]}`);
  }

  const bodyStart = end.index + end.length;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return null;

  return {
    message: JSON.parse(buffer.slice(bodyStart, bodyEnd).toString("utf8")),
    framing: "content-length",
    rest: buffer.slice(bodyEnd),
  };
}

function parseNewlineMessage(buffer) {
  const newline = buffer.indexOf(0x0a);
  if (newline === -1) return null;

  const line = buffer.slice(0, newline).toString("utf8").trim();
  return {
    message: line ? JSON.parse(line) : null,
    framing: "newline",
    rest: buffer.slice(newline + 1),
  };
}

function drainInputBuffer() {
  for (;;) {
    input = trimLeadingTransportWhitespace(input);
    if (input.length === 0) return;

    try {
      const parsed = startsWithJsonMessage(input)
        ? parseNewlineMessage(input)
        : parseContentLengthMessage(input);
      if (!parsed) return;
      input = parsed.rest;
      if (parsed.message) enqueueMessage(parsed.message, parsed.framing);
    } catch (error) {
      log("parse failed", error.stack || error.message);
      input = Buffer.alloc(0);
      return;
    }
  }
}

STDIN.on("data", (chunk) => {
  input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  drainInputBuffer();
});

STDIN.on("end", () => {
  endRequested = true;
  queue.finally(() => shutdown("stdin-end"));
});

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  return 128 + (numbers[signal] || 0);
}

function requestSignalShutdown(signal) {
  if (shutdownStarted) return;
  endRequested = true;
  const forcedExit = setTimeout(() => {
    log("signal cleanup timed out", `signal=${signal}`);
    realProcess.exit(signalExitCode(signal));
  }, SIGNAL_CLEANUP_EXIT_TIMEOUT_MS);
  forcedExit.unref?.();
  queue.finally(async () => {
    clearTimeout(forcedExit);
    await shutdown(`signal:${signal}`, signalExitCode(signal));
  });
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  realProcess.on(signal, () => requestSignalShutdown(signal));
}

realProcess.on("uncaughtException", (error) => {
  log("uncaught exception", error.stack || error.message);
  realProcess.exit(1);
});

resetContext();
log(
  "started",
  `pid=${realProcess.pid} session_id=${SESSION_ID} turn_id=${TURN_ID} js_timeout_ms=${JS_TIMEOUT_MS} browser_cleanup_timeout_ms=${BROWSER_CLEANUP_TIMEOUT_MS} idle_browser_cleanup_ms=${IDLE_BROWSER_CLEANUP_MS}`
);
