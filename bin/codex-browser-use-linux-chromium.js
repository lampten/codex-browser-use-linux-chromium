#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const APP_NAME = "codex-browser-use-linux-chromium";
const DEFAULT_EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const DEFAULT_NATIVE_HOST_NAME = "com.openai.codexextension";
const DEFAULT_SOCKET_DIR = "/tmp/codex-browser-use";
const BACKUP_SUFFIX = ".codex-browser-use-linux-chromium.bak.";
const TOOL_SEARCH_DEFER_FEATURE = "tool_search_always_defer_mcp_tools";
const DESKTOP_SHIM_DIRS = [
  "/Applications/Codex.app/Contents/Resources",
  "/Applications/Codex (Beta).app/Contents/Resources",
];
const WINDOWS_DESKTOP_APP_DIRS = [
  "Codex",
  "Codex Beta",
  "Codex (Beta)",
  "OpenAI Codex",
  "OpenAI Codex Beta",
];
const WINDOWS_NODE_REPL_NAMES = ["node_repl.exe", "node_repl"];

function usage() {
  console.log(`Usage:
  node bin/codex-browser-use-linux-chromium.js install [options]
  node bin/codex-browser-use-linux-chromium.js doctor [options]
  node bin/codex-browser-use-linux-chromium.js patch-plugin [options]
  node bin/codex-browser-use-linux-chromium.js restore-plugin [options]

Options:
  --codex-home PATH          Codex home directory. Default: ~/.codex
  --install-root PATH        Runtime install root. Default: ~/.local/share/${APP_NAME}
  --browser-config-root PATH Browser config root. Default: ~/.config
  --plugin-root PATH         Patch this plugin root. Can be repeated.
  --extension-id ID          Chrome extension ID. Default: ${DEFAULT_EXTENSION_ID}
  --native-host-name NAME    Native host name. Default: ${DEFAULT_NATIVE_HOST_NAME}
  --system-native-host       Also install system Chromium/Chrome native host manifests.
  --desktop-shims            Install macOS Codex Desktop remote path shims.
  --windows-shims            Install Windows Codex Desktop remote path shims.
  --windows-username NAME    Windows username for generated shims. Can be repeated.
  --windows-node-repl-path PATH
                              Exact Windows node_repl command/path to shim. Can be repeated.
  --skip-feature-config      Do not update Codex feature flags in config.toml.
  --write-codex-config       Add or update a known node_repl MCP block in config.toml.
  --allow-non-linux          Allow writes on non-Linux hosts. Intended for tests.
  --dry-run                  Print actions without writing.
  --json                     JSON output for doctor.
  --help                     Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    command: argv[0] || "doctor",
    pluginRoots: [],
    desktopShims: false,
    windowsShims: false,
    windowsUsernames: [],
    windowsNodeReplPaths: [],
    systemNativeHost: false,
    writeCodexConfig: false,
    dryRun: false,
    json: false,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--codex-home") args.codexHome = next();
    else if (arg === "--install-root") args.installRoot = next();
    else if (arg === "--browser-config-root") args.browserConfigRoot = next();
    else if (arg === "--plugin-root") args.pluginRoots.push(next());
    else if (arg === "--extension-id") args.extensionId = next();
    else if (arg === "--native-host-name") args.nativeHostName = next();
    else if (arg === "--system-native-host") args.systemNativeHost = true;
    else if (arg === "--desktop-shims") args.desktopShims = true;
    else if (arg === "--windows-shims") args.windowsShims = true;
    else if (arg === "--windows-username") args.windowsUsernames.push(next());
    else if (arg === "--windows-node-repl-path") args.windowsNodeReplPaths.push(next());
    else if (arg === "--skip-feature-config") args.skipFeatureConfig = true;
    else if (arg === "--write-codex-config") args.writeCodexConfig = true;
    else if (arg === "--allow-non-linux") args.allowNonLinux = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  const home = os.homedir();
  args.codexHome = path.resolve(expandHome(args.codexHome || path.join(home, ".codex")));
  args.installRoot = path.resolve(
    expandHome(args.installRoot || path.join(home, ".local", "share", APP_NAME))
  );
  args.browserConfigRoot = path.resolve(expandHome(args.browserConfigRoot || path.join(home, ".config")));
  args.extensionId = args.extensionId || DEFAULT_EXTENSION_ID;
  args.nativeHostName = args.nativeHostName || DEFAULT_NATIVE_HOST_NAME;
  args.pluginRoots = args.pluginRoots.map((root) => path.resolve(expandHome(root)));
  args.windowsUsernames = defaultWindowsUsernames(args.windowsUsernames);
  args.windowsNodeReplPaths = uniqueStrings(args.windowsNodeReplPaths.map(expandHome));
  return args;
}

function defaultWindowsUsernames(usernames) {
  const localUser = os.userInfo().username || "";
  const values = [...usernames, process.env.CODEX_WINDOWS_USERNAME || "", process.env.USERNAME || ""];
  if (localUser) {
    values.push(localUser);
    values.push(localUser.charAt(0).toUpperCase() + localUser.slice(1));
  }
  return uniqueStrings(values.filter(Boolean));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value)).filter(Boolean))];
}

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function logAction(args, message) {
  if (!args.json) console.log(message);
}

function mkdirp(dir, args) {
  if (args.dryRun) {
    logAction(args, `mkdir -p ${dir}`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, contents, mode, args) {
  if (args.dryRun) {
    logAction(args, `write ${filePath}`);
    return;
  }
  mkdirp(path.dirname(filePath), args);
  fs.writeFileSync(filePath, contents);
  if (mode != null) fs.chmodSync(filePath, mode);
}

function copyFile(src, dest, mode, args) {
  if (args.dryRun) {
    logAction(args, `copy ${src} -> ${dest}`);
    return;
  }
  mkdirp(path.dirname(dest), args);
  fs.copyFileSync(src, dest);
  if (mode != null) fs.chmodSync(dest, mode);
}

function commandPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    return childProcess
      .execFileSync(probe, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .find(Boolean) || null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function browserUseSocketStatus(socketDir = DEFAULT_SOCKET_DIR) {
  if (!fs.existsSync(socketDir)) return [];
  return fs
    .readdirSync(socketDir)
    .filter((entry) => /^chromium-\d+\.sock$/.test(entry))
    .sort()
    .map((entry) => {
      const socketPath = path.join(socketDir, entry);
      const pid = Number(entry.match(/^chromium-(\d+)\.sock$/)[1]);
      let isSocket = false;
      try {
        isSocket = fs.statSync(socketPath).isSocket();
      } catch {
        // Treat races as non-socket entries; doctor is advisory.
      }
      const ownerProcessAlive = processExists(pid);
      return {
        path: socketPath,
        pid,
        isSocket,
        ownerProcessAlive,
        stale: isSocket && !ownerProcessAlive,
      };
    });
}

function runtimePaths(args) {
  return {
    nativeHostBridge: path.join(args.installRoot, "native-host", "codex-native-host-bridge.js"),
    nodeReplMcp: path.join(args.installRoot, "node-repl", "codex-node-repl-mcp.js"),
  };
}

function resolveCodexPath() {
  return (
    process.env.CODEX_CLI_PATH ||
    commandPath("codex") ||
    existingPath(path.join(os.homedir(), ".npm-global", "bin", "codex")) ||
    existingPath(path.join(os.homedir(), ".local", "bin", "codex")) ||
    null
  );
}

function installRuntime(args) {
  const paths = runtimePaths(args);
  copyFile(
    path.join(PROJECT_ROOT, "src", "native-host", "codex-native-host-bridge.js"),
    paths.nativeHostBridge,
    0o755,
    args
  );
  copyFile(
    path.join(PROJECT_ROOT, "src", "node-repl", "codex-node-repl-mcp.js"),
    paths.nodeReplMcp,
    0o755,
    args
  );
  return paths;
}

function userNativeManifestPaths(args) {
  return [
    path.join(args.browserConfigRoot, "chromium", "NativeMessagingHosts", `${args.nativeHostName}.json`),
    path.join(
      args.browserConfigRoot,
      "google-chrome",
      "NativeMessagingHosts",
      `${args.nativeHostName}.json`
    ),
  ];
}

function systemNativeManifestPaths(args) {
  return [
    path.join("/etc", "chromium", "native-messaging-hosts", `${args.nativeHostName}.json`),
    path.join("/etc", "opt", "chrome", "native-messaging-hosts", `${args.nativeHostName}.json`),
  ];
}

function installNativeHostManifests(args, paths) {
  const manifest = {
    name: args.nativeHostName,
    description: "Codex Browser Use Linux Chromium native host bridge",
    path: paths.nativeHostBridge,
    type: "stdio",
    allowed_origins: [`chrome-extension://${args.extensionId}/`],
  };
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;

  for (const manifestPath of userNativeManifestPaths(args)) {
    writeFile(manifestPath, manifestContents, 0o644, args);
  }
  if (args.systemNativeHost) {
    for (const manifestPath of systemNativeManifestPaths(args)) {
      writePrivilegedFile(manifestPath, manifestContents, "0644", args);
    }
  }
}

function detectPluginRoots(args) {
  const roots = new Set();
  for (const root of args.pluginRoots) {
    assertPluginRoot(root, "explicit");
    roots.add(root);
  }

  const cacheRoot = path.join(args.codexHome, "plugins", "cache");
  for (const marketplace of ["openai-bundled", "openai-bundled-beta"]) {
    for (const pluginName of ["chrome", "browser-use"]) {
      const pluginRoot = path.join(cacheRoot, marketplace, pluginName);
      if (!fs.existsSync(pluginRoot)) continue;

      for (const entry of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(pluginRoot, entry.name);
        if (fs.existsSync(path.join(candidate, "scripts", "browser-client.mjs"))) roots.add(candidate);
      }
    }
  }

  const stagedBundledRoot = path.join(args.codexHome, ".tmp", "bundled-marketplaces");
  for (const marketplace of ["openai-bundled", "openai-bundled-beta"]) {
    for (const pluginName of ["chrome", "browser-use"]) {
      const candidate = path.join(stagedBundledRoot, marketplace, "plugins", pluginName);
      if (fs.existsSync(path.join(candidate, "scripts", "browser-client.mjs"))) {
        roots.add(candidate);
      }
    }
  }
  return [...roots].sort();
}

function assertPluginRoot(root, kind = "plugin") {
  const browserClient = path.join(root, "scripts", "browser-client.mjs");
  if (!fs.existsSync(browserClient)) {
    throw new Error(`${kind} plugin root is not a Browser Use/Chrome plugin root: ${root}`);
  }
}

function pluginRootKind(root) {
  if (
    fs.existsSync(path.join(root, "skills", "chrome", "SKILL.md")) ||
    fs.existsSync(path.join(root, "scripts", "installed-browsers.js"))
  ) {
    return "chrome";
  }
  return "browser-use";
}

function backupFile(filePath, args) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const backupPath = `${filePath}${BACKUP_SUFFIX}${stamp}`;
  if (args.dryRun) {
    logAction(args, `backup ${filePath} -> ${backupPath}`);
    return backupPath;
  }
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function planTextPatch(filePath, patcher) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required plugin file is missing: ${filePath}`);
  }
  const before = fs.readFileSync(filePath, "utf8");
  const after = patcher(before);
  return { filePath, before, after, changed: after !== before };
}

function planOptionalJsonPatch(filePath, patcher) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const before = fs.readFileSync(filePath, "utf8");
  const after = patcher(before);
  return { filePath, before, after, changed: after !== before, exists: true };
}

function planGeneratedJsonPatch(filePath, patcher) {
  const exists = fs.existsSync(filePath);
  const before = exists ? fs.readFileSync(filePath, "utf8") : "{}\n";
  const after = patcher(before);
  return { filePath, before, after, changed: !exists || after !== before, exists };
}

function replaceRequired(text, from, to, label) {
  if (text.includes(to)) return text;
  if (!text.includes(from)) {
    throw new Error(`Could not find patch point for ${label}`);
  }
  return text.replace(from, to);
}

function patchBrowserClient(text) {
  if (!text.includes("import.meta.__codexNativePipe") && !text.includes("globalThis.__codexNativePipe")) {
    throw new Error("Could not find import.meta.__codexNativePipe");
  }

  let output = text.replace(
    /\(import\.meta\.__codexNativePipe\?\?globalThis\.__codexNativePipe\)UnavailableMessage/g,
    "import.meta.__codexNativePipeUnavailableMessage"
  );
  output = output.replace(
    /\(\(import\.meta\.__codexNativePipe\?\?globalThis\.__codexNativePipe\)\?\?globalThis\.__codexNativePipe\)/g,
    "(import.meta.__codexNativePipe??globalThis.__codexNativePipe)"
  );
  output = output.replace(
    /\(import\.meta\.__codexNativePipe\?\?globalThis\.__codexNativePipe\)\?\?globalThis\.__codexNativePipe/g,
    "(import.meta.__codexNativePipe??globalThis.__codexNativePipe)"
  );
  output = output.replace(
    /import\.meta\.__codexNativePipe(?![A-Za-z0-9_$]|\?\?globalThis\.__codexNativePipe)/g,
    "(import.meta.__codexNativePipe??globalThis.__codexNativePipe)"
  );
  if (!/\?\?globalThis\.__codexNativePipe/.test(output)) {
    throw new Error("Could not apply native pipe fallback patch");
  }
  if (
    /\(import\.meta\.__codexNativePipe\?\?globalThis\.__codexNativePipe\)UnavailableMessage/.test(
      output
    )
  ) {
    throw new Error("Native pipe fallback patch produced malformed UnavailableMessage access");
  }
  output = patchBrowserClientPageCommandTimeouts(output);
  output = patchBrowserClientCdpCallTimeouts(output);
  output = patchBrowserClientFastVisibleScreenshots(output);
  return output;
}

const BROWSER_CLIENT_PAGE_TIMEOUT_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-client-page-command-timeouts";

function replaceRegexRequired(text, pattern, replacement, label) {
  if (typeof replacement === "string" && text.includes(replacement)) return text;
  const output = text.replace(pattern, replacement);
  if (output === text) throw new Error(`Could not find patch point for ${label}`);
  return output;
}

function patchBrowserClientPageCommandTimeouts(text) {
  if (text.includes(BROWSER_CLIENT_PAGE_TIMEOUT_PATCH_MARKER)) return text;

  let output = text;
  output = replaceRegexRequired(
    output,
    /function re\(t\)\{let e=typeof t\.timeout_ms=="number"\?t\.timeout_ms:3e3;return Math\.min\(Math\.max\(0,e\),t\.max\|\|3e3\)\}/,
    'function re(t){let e=typeof t.timeout_ms=="number"?t.timeout_ms:typeof t.client_timeout_ms=="number"?t.client_timeout_ms:3e3;return Math.min(Math.max(0,e),t.max||3e3)}',
    "Browser client client_timeout_ms fallback"
  );
  output = replaceRegexRequired(
    output,
    /e\.cdp\.call\(t,"Runtime\.evaluate",\{expression:"window\.devicePixelRatio",returnByValue:!0\}\)/,
    'e.cdp.call(t,"Runtime.evaluate",{expression:"window.devicePixelRatio",returnByValue:!0},{timeoutMs:3e3})',
    "Browser client device pixel ratio CDP timeout"
  );
  output = output.replace(
    /e\.cdp\.call\(r,"Page\.getLayoutMetrics"\)/g,
    'e.cdp.call(r,"Page.getLayoutMetrics",void 0,{timeoutMs:re({...t,timeout_ms:t.timeout_ms??1e4,max:3e4})})'
  );
  output = replaceRegexRequired(
    output,
    /e\.cdp\.call\(r,"Page\.captureScreenshot",n\)/,
    'e.cdp.call(r,"Page.captureScreenshot",n,{timeoutMs:re({...t,timeout_ms:t.timeout_ms??1e4,max:3e4})})',
    "Browser client Playwright screenshot CDP timeout"
  );
  output = replaceRegexRequired(
    output,
    /e\.cdp\.call\(r,"Page\.captureScreenshot",\{format:"jpeg",quality:80,clip:i\}\)/,
    'e.cdp.call(r,"Page.captureScreenshot",{format:"jpeg",quality:80,clip:i},{timeoutMs:1e4})',
    "Browser client CUA screenshot CDP timeout"
  );
  output = replaceRegexRequired(
    output,
    /async screenshot\(e=\{\}\)\{let r=\{browser_id:this\.#e,tab_id:this\.#t,fullPage:e\.fullPage\};([\s\S]*?)let n=await this\.#r\.send\(\{command:([A-Za-z_$][A-Za-z0-9_$]*)\.create\(r\)\}\);return new ot\(n\.data\)\}/,
    (_match, body, commandName) =>
      `async screenshot(e={}){let r={browser_id:this.#e,tab_id:this.#t,fullPage:e.fullPage};${body}let c=e.timeoutMs??1e4;r.timeout_ms=c;let n=await this.#r.send({command:${commandName}.create(r),timeoutMs:c});return new ot(n.data)}`,
    "Browser client screenshot timeout option"
  );
  output = replaceRegexRequired(
    output,
    /async domSnapshot\(\)\{return\(await this\.#r\.send\(\{command:([A-Za-z_$][A-Za-z0-9_$]*)\.create\(\{browser_id:this\.#e,tab_id:this\.#t\}\)\}\)\)\.dom_snapshot\}/,
    (_match, commandName) =>
      `async domSnapshot(e={}){let r=e.timeoutMs??1e4;return(await this.#r.send({command:${commandName}.create({browser_id:this.#e,tab_id:this.#t,timeout_ms:r}),timeoutMs:r})).dom_snapshot}`,
    "Browser client domSnapshot timeout option"
  );
  output = replaceRegexRequired(
    output,
    /(cropHeight:l\.number\(\)\.optional\(\))\}\),([A-Za-z_$][A-Za-z0-9_$]*)=l\.object\(\{data:l\.string\(\)\}\),([A-Za-z_$][A-Za-z0-9_$]*)="playwright_screenshot"/,
    '$1,timeout_ms:l.number().optional()}),$2=l.object({data:l.string()}),$3="playwright_screenshot"',
    "Browser client screenshot timeout schema"
  );
  output = replaceRegexRequired(
    output,
    /(var [A-Za-z_$][A-Za-z0-9_$]*=l\.object\(\{browser_id:l\.string\(\),tab_id:l\.string\(\))\}\),([A-Za-z_$][A-Za-z0-9_$]*=l\.object\(\{dom_snapshot:l\.string\(\)\}\),[A-Za-z_$][A-Za-z0-9_$]*="playwright_dom_snapshot")/,
    "$1,timeout_ms:l.number().optional()}),$2",
    "Browser client domSnapshot timeout schema"
  );
  output = replaceRegexRequired(
    output,
    /mode:"ai",track:"browser-client-dom-snapshot"\}\)\.full:""\}\);return\{dom_snapshot:/,
    'mode:"ai",track:"browser-client-dom-snapshot"}).full:""},{timeoutMs:re({...t,timeout_ms:t.timeout_ms??1e4,max:3e4})});return{dom_snapshot:',
    "Browser client domSnapshot page-evaluation timeout"
  );
  output = replaceRegexRequired(
    output,
    /async evaluateOnPlaywrightPage\(e,r,n=\{\}\)\{let o=r\.toString\(\),i=([A-Za-z_$][A-Za-z0-9_$]*)\(n\.arg\);return await this\.evaluateWithPlaywrightInjected\(e,`\(async \(\) => \{\n          const injected = window\.\$\{t\.injectedConstant\};\n          return await \(\$\{o\}\)\(injected, \$\{i\}\);\n        \}\)\(\)`\)\}/,
    (_match, stringifyArgName) =>
      `async evaluateOnPlaywrightPage(e,r,n={}){let o=r.toString(),i=${stringifyArgName}(n.arg);return await this.evaluateWithPlaywrightInjected(e,\`(async () => {\n          const injected = window.\${t.injectedConstant};\n          return await (\${o})(injected, \${i});\n        })()\`,{timeoutMs:n.timeoutMs})}`,
    "Browser client evaluateOnPlaywrightPage timeout forwarding"
  );

  return `/* ${BROWSER_CLIENT_PAGE_TIMEOUT_PATCH_MARKER} */\n${output}`;
}

const BROWSER_CLIENT_CDP_CALL_TIMEOUT_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-client-cdp-call-timeouts";

function patchBrowserClientCdpCallTimeouts(text) {
  if (text.includes(BROWSER_CLIENT_CDP_CALL_TIMEOUT_PATCH_MARKER)) return text;

  const output = replaceRegexRequired(
    text,
    /async call\(r,n,o,i=\{\}\)\{let s=Number\(r\);if\(!Number\.isFinite\(s\)\)throw new Error\("callCdp requires numeric tab_id"\);await this\.ensureAttachedTab\(s\);try\{return await this\.api\.executeCdp\(\{target:\{tabId:s\},method:n,commandParams:o\?\?\{\},timeoutMs:i\.timeoutMs\}\)\}catch\(a\)\{if\(a==="Debugger unattached"\|\|typeof a=="string"&&a\.includes\("Debugger is not attached"\)\)return this\.forgetAttachedTab\(s\),this\.call\(r,n,o,i\);throw a\}\}/,
    'async call(r,n,o,i={}){let s=Number(r);if(!Number.isFinite(s))throw new Error("callCdp requires numeric tab_id");await this.ensureAttachedTab(s);try{let a=this.api.executeCdp({target:{tabId:s},method:n,commandParams:o??{},timeoutMs:i.timeoutMs});if(typeof i.timeoutMs=="number"&&i.timeoutMs>0){let u;try{return await Promise.race([a,new Promise((c,d)=>{u=setTimeout(()=>d(new Error(`Timed out after ${i.timeoutMs}ms waiting for CDP command ${n}.`)),i.timeoutMs)})])}finally{clearTimeout(u)}}return await a}catch(a){if(a==="Debugger unattached"||typeof a=="string"&&a.includes("Debugger is not attached"))return this.forgetAttachedTab(s),this.call(r,n,o,i);throw a}}',
    "Browser client CDP call Promise timeout"
  );

  return `/* ${BROWSER_CLIENT_CDP_CALL_TIMEOUT_PATCH_MARKER} */\n${output}`;
}

const BROWSER_CLIENT_FAST_VISIBLE_SCREENSHOT_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-client-fast-visible-screenshots";

function patchBrowserClientFastVisibleScreenshots(text) {
  if (text.includes(BROWSER_CLIENT_FAST_VISIBLE_SCREENSHOT_PATCH_MARKER)) return text;

  let output = text;
  output = output.replace(
    /let c=e\.timeoutMs\?\?1e4;r\.timeout_ms=c;/g,
    "let c=e.timeoutMs??2e4;r.timeout_ms=c;"
  );
  output = replaceRegexRequired(
    output,
    /var ([A-Za-z_$][A-Za-z0-9_$]*)=x\("cua_get_visible_screenshot",async\(t,e\)=>\{let r=([A-Za-z_$][A-Za-z0-9_$]*)\(t\.tab_id\),\{cssVisualViewport:([A-Za-z_$][A-Za-z0-9_$]*)\}=await e\.cdp\.call\(r,"Page\.getLayoutMetrics",void 0,\{timeoutMs:re\(\{\.\.\.t,timeout_ms:t\.timeout_ms\?\?1e4,max:3e4\}\)\}\),([A-Za-z_$][A-Za-z0-9_$]*)=await ([A-Za-z_$][A-Za-z0-9_$]*)\(r,e\),([A-Za-z_$][A-Za-z0-9_$]*)=\{x:\3\.pageX,y:\3\.pageY,width:\3\.clientWidth,height:\3\.clientHeight,scale:\4\},([A-Za-z_$][A-Za-z0-9_$]*)=await e\.cdp\.call\(r,"Page\.captureScreenshot",\{format:"jpeg",quality:80,clip:\6\},\{timeoutMs:1e4\}\);/,
    'var $1=x("cua_get_visible_screenshot",async(t,e)=>{let r=$2(t.tab_id),$7=await e.cdp.call(r,"Page.captureScreenshot",{format:"jpeg",quality:80,optimizeForSpeed:!0},{timeoutMs:re({...t,timeout_ms:t.timeout_ms??2e4,max:3e4})});',
    "Browser client CUA visible screenshot fast path"
  );
  output = replaceRegexRequired(
    output,
    /else\{let\{cssVisualViewport:([A-Za-z_$][A-Za-z0-9_$]*)\}=await e\.cdp\.call\(r,"Page\.getLayoutMetrics",void 0,\{timeoutMs:re\(\{\.\.\.t,timeout_ms:t\.timeout_ms\?\?1e4,max:3e4\}\)\}\);n\.clip=\{x:\1\.pageX,y:\1\.pageY,width:\1\.clientWidth,height:\1\.clientHeight,scale:i\}\}let ([A-Za-z_$][A-Za-z0-9_$]*)=await e\.cdp\.call\(r,"Page\.captureScreenshot",n,\{timeoutMs:re\(\{\.\.\.t,timeout_ms:t\.timeout_ms\?\?1e4,max:3e4\}\)\}\);/,
    'else n.optimizeForSpeed=!0;let $2=await e.cdp.call(r,"Page.captureScreenshot",n,{timeoutMs:re({...t,timeout_ms:t.timeout_ms??2e4,max:3e4})});',
    "Browser client Playwright visible screenshot fast path"
  );

  return `/* ${BROWSER_CLIENT_FAST_VISIBLE_SCREENSHOT_PATCH_MARKER} */\n${output}`;
}

const BROWSER_USE_IAB_CHROME_ROUTING_MARKER =
  "codex-browser-use-linux-chromium: browser-use-iab-routes-to-chrome";

function patchBrowserUseClient(text) {
  let output = patchBrowserClient(text);
  if (
    !output.includes('extension:"iab"') ||
    !output.includes('case"extension":return"iab"')
  ) {
    const backendAliasPattern =
      /var ([A-Za-z_$][A-Za-z0-9_$]*)=\{cdp:"cdp",extension:"chrome",iab:"iab"\};/;
    if (!backendAliasPattern.test(output)) {
      throw new Error("Could not find patch point for Browser Use extension backend allowlist alias");
    }
    output = output.replace(
      backendAliasPattern,
      'var $1={cdp:"cdp",extension:"iab",iab:"iab"};'
    );
    output = replaceRequired(
      output,
      'case"extension":return"extension";',
      'case"extension":return"iab";',
      "Browser Use extension backend browser type alias"
    );
  }
  if (!output.includes(BROWSER_USE_IAB_CHROME_ROUTING_MARKER)) {
    output = `/* ${BROWSER_USE_IAB_CHROME_ROUTING_MARKER} */\n${output}`;
  }
  return output;
}

function patchInstalledBrowsers(text) {
  if (text.includes('name: "Chromium"')) return text;
  const match = text.match(/(\{\s*name:\s*"Google Chrome"[\s\S]*?windowsExecutable:\s*"chrome\.exe",\s*\},)/);
  if (!match) throw new Error("Could not find Google Chrome browser entry");
  return text.replace(
    match[1],
    `${match[1]}
  {
    name: "Chromium",
    bundleIds: ["org.chromium.Chromium"],
    appNames: ["Chromium.app"],
    commands: ["chromium", "chromium-browser"],
    windowsExecutable: null,
  },`
  );
}

function patchChromeIsRunning(text) {
  if (text.includes('"chromium"')) return text;
  if (text.includes('linux: new Set(["chrome", "google-chrome"]),')) {
    return text.replace(
      'linux: new Set(["chrome", "google-chrome"]),',
      'linux: new Set(["chrome", "google-chrome", "chromium", "chromium-browser"]),'
    );
  }
  return replaceRequired(
    text,
    '  win32: new Set(["chrome.exe"]),',
    '  win32: new Set(["chrome.exe"]),\n  linux: new Set(["chrome", "google-chrome", "chromium", "chromium-browser"]),',
    "Linux Chrome process names"
  );
}

function patchLinuxUserDataDirectory(text) {
  if (text.includes('".config", "chromium"')) return text;
  return replaceRequired(
    text,
    'return path.join(os.homedir(), ".config", "google-chrome");',
    `const chromiumDirectory = path.join(os.homedir(), ".config", "chromium");
  if (fs.existsSync(chromiumDirectory)) return chromiumDirectory;

  return path.join(os.homedir(), ".config", "google-chrome");`,
    "Linux Chromium user data directory"
  );
}

function patchCheckNativeHostManifest(text) {
  let output = text;
  if (!output.includes("resolveLinuxNativeHostManifestPath")) {
    const unsupportedPlatformBlock =
      /  throw new Error\(\r?\n    `Unsupported platform for native host manifest check: \$\{process\.platform\}\. This script supports macOS and Windows\.`,\r?\n  \);\r?\n}/;
    if (!unsupportedPlatformBlock.test(output)) {
      throw new Error("Could not find patch point for Linux native host manifest path");
    }
    output = output.replace(
      unsupportedPlatformBlock,
      `  if (process.platform === "linux") {
    return {
      manifestPath: resolveLinuxNativeHostManifestPath(),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }

  throw new Error(
    \`Unsupported platform for native host manifest check: \${process.platform}. This script supports macOS, Linux, and Windows.\`,
  );
}

function resolveLinuxNativeHostManifestPath() {
  const candidates = [
    path.join(os.homedir(), ".config", "chromium", "NativeMessagingHosts", \`\${expectedHostName}.json\`),
    path.join("/etc", "chromium", "native-messaging-hosts", \`\${expectedHostName}.json\`),
    path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts", \`\${expectedHostName}.json\`),
    path.join("/etc", "opt", "chrome", "native-messaging-hosts", \`\${expectedHostName}.json\`),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}`,
    );
  }
  return output;
}

function patchOpenChromeWindow(text) {
  let output = patchLinuxUserDataDirectory(text);
  if (output.includes('commandPath("chromium")')) return output;
  const linuxLaunchBlock = /  return \{\r?\n    command: "google-chrome",\r?\n    args: chromeArgs,\r?\n  \};/;
  if (!linuxLaunchBlock.test(output)) {
    throw new Error("Could not find patch point for Linux Chromium launch command");
  }
  return output.replace(
    linuxLaunchBlock,
    `  const linuxChromeCommand =
    commandPath("chromium") ||
    commandPath("chromium-browser") ||
    commandPath("google-chrome") ||
    "google-chrome";
  return {
    command: linuxChromeCommand,
    args: chromeArgs,
  };`
  );
}

const SCREENSHOT_OUTPUT_PATCH_MARKER =
  "codex-browser-use-linux-chromium: screenshot-output-compatibility";
const BROWSER_SKILL_ROUTING_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-skill-routes-iab-to-chrome";
const BROWSER_SKILL_NODE_REPL_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-node-repl-discovery";
const BROWSER_SKILL_TIMEOUT_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-timeout-recovery";
const BROWSER_SKILL_COMMAND_SCOPING_PATCH_MARKER =
  "codex-browser-use-linux-chromium: browser-command-scoping";
const CHROME_SKILL_NODE_REPL_PATCH_MARKER =
  "codex-browser-use-linux-chromium: chrome-node-repl-discovery";
const CHROME_SKILL_TIMEOUT_PATCH_MARKER =
  "codex-browser-use-linux-chromium: chrome-timeout-recovery";
const CHROME_SKILL_COMMAND_SCOPING_PATCH_MARKER =
  "codex-browser-use-linux-chromium: chrome-command-scoping";

function patchBrowserSkill(text) {
  if (
    text.includes(BROWSER_SKILL_ROUTING_PATCH_MARKER) &&
    text.includes(BROWSER_SKILL_NODE_REPL_PATCH_MARKER) &&
    text.includes(BROWSER_SKILL_TIMEOUT_PATCH_MARKER) &&
    text.includes(BROWSER_SKILL_COMMAND_SCOPING_PATCH_MARKER) &&
    text.includes("do not silently replace a requested screenshot with text-only output")
  ) {
    return text;
  }
  let output = text.replace(
    new RegExp(
      `\\r?\\n## Linux Chromium Compatibility\\r?\\n\\r?\\n<!-- ${escapeRegExp(
        BROWSER_SKILL_ROUTING_PATCH_MARKER
      )} -->[\\s\\S]*?(?=\\r?\\n## Bootstrap)`
    ),
    ""
  );
  const bootstrapHeader = /\r?\n## Bootstrap/;
  if (!bootstrapHeader.test(output)) {
    throw new Error("Could not find patch point for Browser skill Linux Chromium routing instructions");
  }
  const section = `
## Linux Chromium Compatibility

<!-- ${BROWSER_SKILL_ROUTING_PATCH_MARKER} -->
<!-- ${BROWSER_SKILL_NODE_REPL_PATCH_MARKER} -->
<!-- ${BROWSER_SKILL_TIMEOUT_PATCH_MARKER} -->
<!-- ${BROWSER_SKILL_COMMAND_SCOPING_PATCH_MARKER} -->

On Linux remote hosts patched by \`codex-browser-use-linux-chromium\`, keep using the normal \`iab\` Browser workflow. The local runtime maps \`iab\` to the Chromium-backed Codex Chrome Extension because Linux remote hosts do not have a Codex Desktop in-app browser. Do not fall back to shell Playwright solely because there is no desktop app browser surface on Linux.

For Browser plugin tasks, the Linux compatibility MCP server may appear as \`browser_node_repl\` instead of \`node_repl\` to avoid colliding with the Chrome plugin's official \`node_repl\` server. If \`node_repl/js\` is not visible, search for \`browser_node_repl js\` and use \`mcp__browser_node_repl__js\`.

Screenshots and \`domSnapshot()\` are supported Browser capabilities on Linux Chromium. Use them when the task needs visual evidence or a full accessibility snapshot; do not silently replace a requested screenshot with text-only output.

Keep each browser bridge call short and single-purpose on Linux Chromium. Do not combine click, fill, keyboard input, or navigation with \`domSnapshot()\`, screenshot capture, dev logs, or extraction loops in the same \`js\` call. Run one interaction, then verify in a fresh follow-up call. For data extraction that does not need the full tree, a targeted locator/evaluate check is usually cheaper than \`tab.playwright.domSnapshot()\`, but the full snapshot remains valid when it is the right evidence.

For page extraction, return compact data with one page-side expression such as \`locator(...).evaluateAll(...)\` or \`page.evaluate(...)\`. Avoid \`locator(...).all()\` followed by many awaited per-element calls inside one bridge call; if one element query hangs, the whole MCP call times out and can leave stale browser commands behind.

If a call fails with \`native pipe is closed\` or \`Detached while handling command\`, run \`js_reset\`, re-bootstrap the Browser runtime, reacquire the tab, and continue with single-purpose calls. Do not reuse old \`browser\` or \`tab\` objects after that error.

If lightweight calls such as \`browser.tabs.list()\`, \`browser.tabs.get(...)\`, \`tab.url()\`, or \`tab.title()\` succeed but page-level calls such as \`tab.playwright.domSnapshot()\`, \`tab.playwright.screenshot()\`, \`tab.cua.get_visible_screenshot()\`, fill, click, or keyboard input time out repeatedly, treat it as a page-level browser bridge hang rather than missing MCP discovery. Run \`js_reset\`, re-bootstrap, reacquire the tab, and retry the requested evidence in a fresh call. If it still fails, report the page-level blocker; do not claim the screenshot or DOM feature is unavailable.

`;
  return output.replace(bootstrapHeader, `${section}## Bootstrap`);
}

function patchChromeSkill(text) {
  if (
    text.includes(CHROME_SKILL_NODE_REPL_PATCH_MARKER) &&
    text.includes(CHROME_SKILL_TIMEOUT_PATCH_MARKER) &&
    text.includes(CHROME_SKILL_COMMAND_SCOPING_PATCH_MARKER) &&
    text.includes(SCREENSHOT_OUTPUT_PATCH_MARKER) &&
    text.includes("final answer must include the Markdown image link") &&
    text.includes("do not silently replace a requested screenshot with text-only output")
  ) {
    return text;
  }
  let output = text.replace(
    new RegExp(
      `\\r?\\n## Screenshot Output Compatibility\\r?\\n\\r?\\n<!-- ${escapeRegExp(
        SCREENSHOT_OUTPUT_PATCH_MARKER
      )} -->[\\s\\S]*?(?=\\r?\\n## Tab Cleanup)`
    ),
    ""
  );
  output = output.replace(
    new RegExp(
      `\\r?\\n## Linux Chromium Node REPL Compatibility\\r?\\n\\r?\\n<!-- ${escapeRegExp(
        CHROME_SKILL_NODE_REPL_PATCH_MARKER
      )} -->[\\s\\S]*?(?=\\r?\\n## (Screenshot Output Compatibility|Tab Cleanup))`
    ),
    ""
  );
  output = output.replace(
    new RegExp(
      `\\r?\\n## Timeout Recovery Compatibility\\r?\\n\\r?\\n<!-- ${escapeRegExp(
        CHROME_SKILL_TIMEOUT_PATCH_MARKER
      )} -->[\\s\\S]*?(?=\\r?\\n## (Screenshot Output Compatibility|Tab Cleanup))`
    ),
    ""
  );
  const tabCleanupHeader = /\r?\n## Tab Cleanup/;
  if (!tabCleanupHeader.test(output)) {
    throw new Error("Could not find patch point for Chrome skill screenshot output instructions");
  }
  const section = `
## Linux Chromium Node REPL Compatibility

<!-- ${CHROME_SKILL_NODE_REPL_PATCH_MARKER} -->

On Linux remote hosts patched by \`codex-browser-use-linux-chromium\`, Chrome plugin tasks must use the Chrome plugin's \`node_repl\` MCP server. Search for \`node_repl js\` and call \`mcp__node_repl__js\`.

Do not use \`browser_node_repl\` for Chrome plugin tasks. \`browser_node_repl\` is reserved for Browser / in-app browser compatibility and can cause Chrome tasks to follow Browser-specific routing instructions.

## Screenshot Output Compatibility

<!-- ${SCREENSHOT_OUTPUT_PATCH_MARKER} -->

- When a screenshot is the requested deliverable, save it to an absolute file path under \`nodeRepl.cwd\`, emit it, and make the final answer include the Markdown image link for that saved path.
- Preferred pattern:

\`\`\`js
const image = await tab.playwright.screenshot({ fullPage: false });
const imagePath = await nodeRepl.emitImage(image, { fileName: "google-screenshot.png" });
await browser.tabs.finalize({ keep: [{ tab, status: "deliverable" }] });
nodeRepl.write(\`Markdown image: ![Google screenshot](\${imagePath})\\n\`);
\`\`\`

- The final answer must include the Markdown image link, for example \`![Google screenshot](/absolute/path/google-screenshot.png)\`. Do not only say that the screenshot is "shown above".
- Do not reference \`attachment://...\` image URLs in the final response. Prior tool-output images are not exposed under those attachment URIs in this compatibility runtime.

## Timeout Recovery Compatibility

<!-- ${CHROME_SKILL_TIMEOUT_PATCH_MARKER} -->
<!-- ${CHROME_SKILL_COMMAND_SCOPING_PATCH_MARKER} -->

Screenshots and \`domSnapshot()\` are supported Chrome capabilities on Linux Chromium. Use them when the task needs visual evidence or a full accessibility snapshot; do not silently replace a requested screenshot with text-only output.

Keep each Chromium bridge call short and single-purpose. Do not combine click, fill, keyboard input, or navigation with \`domSnapshot()\`, screenshot capture, dev logs, or extraction loops in the same \`js\` call. Run one interaction, then verify in a fresh follow-up call. For data extraction that does not need the full tree, a targeted locator/evaluate check is usually cheaper than \`tab.playwright.domSnapshot()\`, but the full snapshot remains valid when it is the right evidence.

For extraction, return compact data with one page-side expression such as \`locator(...).evaluateAll(...)\` or \`page.evaluate(...)\`. Avoid \`locator(...).all()\` followed by many awaited per-element calls inside one bridge call; if one element query hangs, the whole MCP call times out and can leave stale browser commands behind.

If a call fails with \`native pipe is closed\` or \`Detached while handling command\`, run \`js_reset\`, re-bootstrap the Chrome runtime, reacquire the tab, and continue with single-purpose calls. Do not reuse old \`browser\` or \`tab\` objects after that error.

If lightweight calls such as \`browser.tabs.list()\`, \`browser.tabs.get(...)\`, \`tab.url()\`, or \`tab.title()\` succeed but page-level calls such as \`tab.playwright.domSnapshot()\`, \`tab.playwright.screenshot()\`, \`tab.cua.get_visible_screenshot()\`, fill, click, or keyboard input time out repeatedly, treat it as a page-level browser bridge hang rather than missing MCP discovery. Run \`js_reset\`, re-bootstrap, reacquire the tab, and retry the requested evidence in a fresh call. If it still fails, report the page-level blocker; do not claim the screenshot or DOM feature is unavailable.

`;
  return output.replace(tabCleanupHeader, `${section}## Tab Cleanup`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolvePluginMcpConfigPath(root) {
  const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) return null;
  let manifest;
  try {
    manifest = readJsonFile(manifestPath);
  } catch {
    return null;
  }
  const mcpServers = manifest.mcpServers;
  if (typeof mcpServers !== "string" || !mcpServers.startsWith("./")) return null;
  const relativePath = mcpServers.slice(2);
  if (!relativePath || relativePath.split(/[\\/]/).some((part) => part === ".." || part === "")) {
    return null;
  }
  return path.join(root, relativePath);
}

function pluginMcpServerName(kind) {
  return kind === "chrome" ? "node_repl" : "browser_node_repl";
}

function pluginMcpLegacyServerName(kind) {
  return kind === "chrome" ? "browser_node_repl" : "node_repl";
}

function patchPluginMcpConfig(text, paths, kind) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse plugin MCP config: ${error.message}`);
  }
  const mcpServers =
    config?.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  const serverName = pluginMcpServerName(kind);
  const legacyServerName = pluginMcpLegacyServerName(kind);
  const nodeRepl = mcpServers[serverName];
  if (nodeRepl && typeof nodeRepl !== "object") {
    throw new Error(`plugin MCP config ${serverName} entry is not an object`);
  }

  const nextMcpServers = { ...mcpServers };
  delete nextMcpServers[legacyServerName];
  nextMcpServers[serverName] = {
    ...(nodeRepl || {}),
    command: commandPath("node") || process.execPath,
    args: [paths.nodeReplMcp],
  };

  const nextConfig = {
    ...config,
    mcpServers: nextMcpServers,
  };
  return `${JSON.stringify(nextConfig, null, 2)}\n`;
}

function patchPluginJsonMcpServers(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse plugin.json: ${error.message}`);
  }
  if (manifest.mcpServers && manifest.mcpServers !== "./.mcp.json") {
    throw new Error(
      `plugin.json already has unsupported mcpServers value: ${manifest.mcpServers}`
    );
  }
  const nextManifest = {
    ...manifest,
    mcpServers: "./.mcp.json",
  };
  return `${JSON.stringify(nextManifest, null, 2)}\n`;
}

const BROWSER_USE_PLUGIN_PATCHES = [
  [".codex-plugin/plugin.json", patchPluginJsonMcpServers],
  ["scripts/browser-client.mjs", patchBrowserUseClient],
  ["skills/browser/SKILL.md", patchBrowserSkill],
];

const CHROME_PLUGIN_PATCHES = [
  [".codex-plugin/plugin.json", patchPluginJsonMcpServers],
  ["scripts/browser-client.mjs", patchBrowserClient],
  ["scripts/installed-browsers.js", patchInstalledBrowsers],
  ["scripts/chrome-is-running.js", patchChromeIsRunning],
  ["scripts/check-extension-installed.js", patchLinuxUserDataDirectory],
  ["scripts/check-native-host-manifest.js", patchCheckNativeHostManifest],
  ["scripts/open-chrome-window.js", patchOpenChromeWindow],
  ["skills/chrome/SKILL.md", patchChromeSkill],
];

function patchSetForRoot(root) {
  return pluginRootKind(root) === "chrome" ? CHROME_PLUGIN_PATCHES : BROWSER_USE_PLUGIN_PATCHES;
}

function planPluginRootPatch(root, paths) {
  assertPluginRoot(root);
  const kind = pluginRootKind(root);
  const results = [];
  for (const [relativePath, patcher] of patchSetForRoot(root)) {
    const filePath = path.join(root, relativePath);
    results.push(planTextPatch(filePath, patcher));
  }
  const mcpConfigPath = resolvePluginMcpConfigPath(root) || path.join(root, ".mcp.json");
  const mcpPatch = planGeneratedJsonPatch(mcpConfigPath, (text) =>
    patchPluginMcpConfig(text, paths, kind)
  );
  if (mcpPatch) results.push(mcpPatch);
  return { root, kind, results };
}

function planPluginPatches(args, paths = runtimePaths(args)) {
  const roots = detectPluginRoots(args);
  if (roots.length === 0) {
    return [];
  }
  return roots.map((root) => planPluginRootPatch(root, paths));
}

function commitPluginPatchPlans(plans, args) {
  if (plans.length === 0) {
    logAction(args, "No Browser Use/Chrome plugin roots found.");
    return [];
  }

  for (const plan of plans) {
    for (const file of plan.results) {
      if (!file.changed) continue;
      if (file.exists !== false && fs.existsSync(file.filePath)) backupFile(file.filePath, args);
      writeFile(file.filePath, file.after, null, args);
    }
  }

  for (const plan of plans) {
    logAction(args, `patched ${plan.kind} plugin root: ${plan.root}`);
    for (const file of plan.results) {
      logAction(args, `  ${file.changed ? "changed" : "ok"} ${path.relative(plan.root, file.filePath)}`);
    }
  }
  return plans;
}

function patchPlugins(args) {
  return commitPluginPatchPlans(planPluginPatches(args), args);
}

function sudoExec(argsList) {
  childProcess.execFileSync("sudo", ["-n", ...argsList], { stdio: "inherit" });
}

function writePrivilegedShim(targetFile, contents, args) {
  writePrivilegedFile(targetFile, contents, "0755", args);
}

function writePrivilegedFile(targetFile, contents, mode, args) {
  if (args.dryRun) {
    logAction(args, `sudo install -m ${mode} ${targetFile}`);
    return;
  }
  const tempFile = path.join(os.tmpdir(), `${APP_NAME}-${process.pid}-${path.basename(targetFile)}`);
  fs.writeFileSync(tempFile, contents, { mode: Number.parseInt(mode, 8) });
  try {
    sudoExec(["mkdir", "-p", path.dirname(targetFile)]);
    sudoExec(["install", "-m", mode, tempFile, targetFile]);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

function nodeReplShimContents(args, paths) {
  const nodePath = commandPath("node") || process.execPath;
  const codexPath = resolveCodexPath() || "";
  const codexExport = codexPath ? `export CODEX_CLI_PATH="${codexPath}"\n` : "unset CODEX_CLI_PATH\n";
  return `#!/bin/sh
set -eu
export CODEX_HOME="${args.codexHome}"
${codexExport}export NODE_REPL_NODE_PATH="${nodePath}"
exec "${nodePath}" "${paths.nodeReplMcp}" "$@"
`;
}

function installDesktopShims(args, paths) {
  const nodePath = commandPath("node") || process.execPath;
  const codexPath = resolveCodexPath() || "";
  const shim = nodeReplShimContents(args, paths);
  for (const dir of DESKTOP_SHIM_DIRS) {
    writePrivilegedShim(path.join(dir, "node_repl"), shim, args);
    if (!args.dryRun) {
      sudoExec(["ln", "-sfn", nodePath, path.join(dir, "node")]);
      if (codexPath) sudoExec(["ln", "-sfn", codexPath, path.join(dir, "codex")]);
    } else {
      logAction(args, `sudo ln -sfn ${nodePath} ${path.join(dir, "node")}`);
      if (codexPath) logAction(args, `sudo ln -sfn ${codexPath} ${path.join(dir, "codex")}`);
    }
  }
}

function windowsNodeReplCommands(args) {
  const commands = [...args.windowsNodeReplPaths];
  for (const username of args.windowsUsernames) {
    for (const appDir of WINDOWS_DESKTOP_APP_DIRS) {
      for (const replName of WINDOWS_NODE_REPL_NAMES) {
        commands.push(`C:\\Users\\${username}\\AppData\\Local\\Programs\\${appDir}\\resources\\${replName}`);
        commands.push(`C:/Users/${username}/AppData/Local/Programs/${appDir}/resources/${replName}`);
      }
    }
  }
  return uniqueStrings(commands);
}

function userPathShimDirs() {
  return uniqueStrings([
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".npm-global", "bin"),
  ]);
}

function windowsShimTargetsForCommand(command) {
  if (/^[A-Za-z]:[\\/]/.test(command)) {
    if (command.includes("/")) {
      return [path.join(os.homedir(), command)];
    }
    return userPathShimDirs().map((dir) => path.join(dir, command));
  }
  if (path.isAbsolute(command)) {
    return [command];
  }
  if (command.includes("/")) {
    return [path.join(os.homedir(), command)];
  }
  return userPathShimDirs().map((dir) => path.join(dir, command));
}

function windowsDesktopShimTargets(args) {
  return windowsNodeReplCommands(args).flatMap((command) =>
    windowsShimTargetsForCommand(command).map((targetPath) => ({
      command,
      path: targetPath,
    }))
  );
}

function installWindowsDesktopShims(args, paths) {
  const shim = nodeReplShimContents(args, paths);
  for (const target of windowsDesktopShimTargets(args)) {
    writeFile(target.path, shim, 0o755, args);
    logAction(args, `windows desktop shim: ${target.command} -> ${target.path}`);
  }
}

function existingPath(filePath) {
  return fs.existsSync(filePath) ? filePath : null;
}

function writeCodexFeatureConfig(args) {
  const configPath = path.join(args.codexHome, "config.toml");
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const updated = ensureTomlFeatureFlag(existing, TOOL_SEARCH_DEFER_FEATURE, true);
  if (updated === existing) {
    logAction(args, `config.toml ${TOOL_SEARCH_DEFER_FEATURE} already enabled`);
    return false;
  }
  if (args.dryRun) {
    logAction(args, `enable ${TOOL_SEARCH_DEFER_FEATURE} in ${configPath}`);
    return true;
  }
  mkdirp(path.dirname(configPath), args);
  fs.writeFileSync(configPath, updated);
  return true;
}

function ensureTomlFeatureFlag(text, key, enabled) {
  const value = enabled ? "true" : "false";
  const keyLine = `${key} = ${value}`;
  const existingLine = new RegExp(`(^|\\r?\\n)(\\s*${escapeRegExp(key)}\\s*=\\s*)(true|false)(\\s*(?:#.*)?)(?=\\r?\\n|$)`);
  if (existingLine.test(text)) {
    return text.replace(existingLine, (_match, prefix, assignment, _oldValue, suffix) => {
      return `${prefix}${assignment}${value}${suffix}`;
    });
  }

  const features = findTomlTable(text, "features");
  if (features) {
    const insertAt = features.start + "[features]".length;
    const newline = text.slice(insertAt, insertAt + 2) === "\r\n" ? "\r\n" : "\n";
    return `${text.slice(0, insertAt)}${newline}${keyLine}${text.slice(insertAt)}`;
  }

  const prefix = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${prefix}[features]\n${keyLine}\n`;
}

function codexFeatureFlagStatus(text, key) {
  const line = new RegExp(`(^|\\r?\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?(?=\\r?\\n|$)`).exec(
    text
  );
  return {
    exists: Boolean(line),
    enabled: line ? line[2] === "true" : false,
  };
}

function writeCodexConfig(args, paths) {
  const configPath = path.join(args.codexHome, "config.toml");
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const table = nodeReplConfigTable(args, paths);
  const existingBlock = findTomlTable(existing, "mcp_servers.node_repl");

  if (existingBlock) {
    const status = nodeReplConfigBlockStatus(existingBlock.block, paths);
    if (status.pathMatches) {
      logAction(args, "config.toml node_repl MCP block already points at this runtime");
      return false;
    }
    if (!status.knownCodexNodeRepl) {
      logAction(args, "config.toml contains a custom [mcp_servers.node_repl] block; leaving it unchanged");
      return false;
    }
    if (args.dryRun) {
      logAction(args, `update node_repl MCP block in ${configPath}`);
      return true;
    }
    const updated =
      existing.slice(0, existingBlock.start) + table + existing.slice(existingBlock.end);
    mkdirp(path.dirname(configPath), args);
    fs.writeFileSync(configPath, updated);
    return true;
  }

  if (args.dryRun) {
    logAction(args, `append node_repl MCP block to ${configPath}`);
    return true;
  }
  mkdirp(path.dirname(configPath), args);
  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  fs.appendFileSync(configPath, `${prefix}${table}`);
  return true;
}

function nodeReplConfigTable(args, paths) {
  const nodePath = commandPath("node") || process.execPath;
  return `# Added by ${APP_NAME}
[mcp_servers.node_repl]
command = "${escapeTomlString(nodePath)}"
args = ["${escapeTomlString(paths.nodeReplMcp)}"]
`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTomlTable(text, dottedName) {
  const tableStart = new RegExp(`(^|\\r?\\n)\\[${escapeRegExp(dottedName)}\\]\\r?\\n`);
  const match = tableStart.exec(text);
  if (!match) return null;
  const start = match.index + (match[1] ? match[1].length : 0);
  const headerEnd = match.index + match[0].length;
  const rest = text.slice(headerEnd);
  const nextMatch = /\r?\n\[[^\]]+\]/.exec(rest);
  const end = nextMatch ? headerEnd + nextMatch.index : text.length;
  return { start, end, block: text.slice(start, end) };
}

function nodeReplConfigBlockStatus(block, paths) {
  return {
    exists: Boolean(block),
    pathMatches:
      typeof block === "string" &&
      block.includes(paths.nodeReplMcp.replace(/\\/g, "\\\\")),
    knownCodexNodeRepl:
      typeof block === "string" &&
      /codex-(browser-use-linux-chromium|chrome-extension)[\s\S]*codex-node-repl-mcp\.js/.test(
        block
      ),
  };
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function install(args) {
  requireLinuxWrites(args);
  preflightInstall(args);
  const paths = runtimePaths(args);
  const pluginPatchPlans = planPluginPatches(args, paths);
  installRuntime(args);
  installNativeHostManifests(args, paths);
  commitPluginPatchPlans(pluginPatchPlans, args);
  if (!args.skipFeatureConfig) writeCodexFeatureConfig(args);
  if (args.writeCodexConfig) writeCodexConfig(args, paths);
  if (args.desktopShims) installDesktopShims(args, paths);
  if (args.windowsShims) installWindowsDesktopShims(args, paths);
  logAction(args, "install complete");
}

function preflightInstall(args) {
  if ((!args.desktopShims && !args.systemNativeHost) || args.dryRun) return;
  if (!commandPath("sudo")) {
    throw new Error("Requested privileged install paths require sudo, but sudo is not available");
  }
  try {
    childProcess.execFileSync("sudo", ["-n", "true"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    throw new Error("Requested privileged install paths require passwordless sudo. Run with sudo configured, or omit --desktop-shims/--system-native-host and create those files manually.");
  }
}

function requireLinuxWrites(args) {
  if (process.platform === "linux" || args.dryRun || args.allowNonLinux) return;
  throw new Error("Refusing to write on a non-Linux host. Run on the Linux remote host, use --dry-run, or pass --allow-non-linux for tests.");
}

function pluginMcpNodeReplStatus(root, paths) {
  const kind = pluginRootKind(root);
  const serverName = pluginMcpServerName(kind);
  const mcpConfigPath = resolvePluginMcpConfigPath(root);
  const status = {
    path: mcpConfigPath,
    serverName,
    exists: Boolean(mcpConfigPath && fs.existsSync(mcpConfigPath)),
    nodeReplExists: false,
    actualNodeReplPath: null,
    pathMatches: true,
  };
  if (!status.exists) return status;

  try {
    const config = readJsonFile(mcpConfigPath);
    const nodeRepl = config?.mcpServers?.[serverName];
    status.nodeReplExists = Boolean(nodeRepl);
    const firstArg = Array.isArray(nodeRepl?.args) ? nodeRepl.args[0] : null;
    status.actualNodeReplPath = typeof firstArg === "string" ? firstArg : null;
    status.pathMatches =
      !status.nodeReplExists ||
      (status.actualNodeReplPath != null &&
        path.resolve(status.actualNodeReplPath) === path.resolve(paths.nodeReplMcp));
  } catch (error) {
    status.error = error.message;
    status.pathMatches = false;
  }
  return status;
}

function patchStatusForRoot(root, paths) {
  const read = (relativePath) => {
    const filePath = path.join(root, relativePath);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  };
  const kind = pluginRootKind(root);
  const browserClient = read("scripts/browser-client.mjs");
  const status = {
    root,
    kind,
    pluginMcpNodeRepl: pluginMcpNodeReplStatus(root, paths),
    browserClientNativePipeFallback: /\?\?globalThis\.__codexNativePipe/.test(browserClient),
    browserClientNativePipeFallbackSyntax:
      !/\(import\.meta\.__codexNativePipe\?\?globalThis\.__codexNativePipe\)UnavailableMessage/.test(
        browserClient
      ),
  };
  if (kind !== "chrome") {
    const browserSkill = read("skills/browser/SKILL.md");
    const pluginJson = read(".codex-plugin/plugin.json");
    return {
      ...status,
      browserUseIabRoutesToChrome:
        browserClient.includes(BROWSER_USE_IAB_CHROME_ROUTING_MARKER) &&
        browserClient.includes('extension:"iab"') &&
        browserClient.includes('case"extension":return"iab"'),
      browserSkillRoutesIabToChrome: browserSkill.includes(BROWSER_SKILL_ROUTING_PATCH_MARKER),
      browserSkillMentionsBrowserNodeRepl: browserSkill.includes(BROWSER_SKILL_NODE_REPL_PATCH_MARKER),
      browserSkillTimeoutRecovery: browserSkill.includes(BROWSER_SKILL_TIMEOUT_PATCH_MARKER),
      browserSkillCommandScoping: browserSkill.includes(BROWSER_SKILL_COMMAND_SCOPING_PATCH_MARKER),
      browserUsePluginDeclaresMcpServers: pluginJson.includes('"mcpServers": "./.mcp.json"'),
    };
  }

  const installedBrowsers = read("scripts/installed-browsers.js");
  const chromeIsRunning = read("scripts/chrome-is-running.js");
  const extensionInstalled = read("scripts/check-extension-installed.js");
  const nativeHostManifest = read("scripts/check-native-host-manifest.js");
  const openWindow = read("scripts/open-chrome-window.js");
  const chromeSkill = read("skills/chrome/SKILL.md");
  const pluginJson = read(".codex-plugin/plugin.json");
  return {
    ...status,
    chromePluginDeclaresMcpServers: pluginJson.includes('"mcpServers": "./.mcp.json"'),
    installedBrowsersChromium:
      /name:\s*"Chromium"[\s\S]*commands:\s*\[[^\]]*"chromium"[^\]]*"chromium-browser"/.test(
        installedBrowsers
      ),
    chromeIsRunningChromium:
      /linux:\s*new Set\(\[[^\)]*"chromium"[^\)]*"chromium-browser"[^\)]*\]\)/.test(
        chromeIsRunning
      ),
    extensionCheckChromiumProfile:
      /path\.join\(os\.homedir\(\),\s*"\.config",\s*"chromium"\)/.test(extensionInstalled),
    nativeHostManifestLinux:
      /process\.platform\s*===\s*"linux"[\s\S]*resolveLinuxNativeHostManifestPath/.test(
        nativeHostManifest
      ),
    openWindowChromium:
      /commandPath\("chromium"\)[\s\S]*command:\s*linuxChromeCommand/.test(openWindow),
    chromeSkillNodeReplDiscovery: chromeSkill.includes(CHROME_SKILL_NODE_REPL_PATCH_MARKER),
    chromeSkillScreenshotOutput:
      chromeSkill.includes(SCREENSHOT_OUTPUT_PATCH_MARKER) &&
      chromeSkill.includes("final answer must include the Markdown image link"),
    chromeSkillTimeoutRecovery: chromeSkill.includes(CHROME_SKILL_TIMEOUT_PATCH_MARKER),
    chromeSkillCommandScoping: chromeSkill.includes(CHROME_SKILL_COMMAND_SCOPING_PATCH_MARKER),
  };
}

function nativeManifestStatus(manifestPath, expectedNativeHostPath) {
  const status = {
    path: manifestPath,
    exists: fs.existsSync(manifestPath),
    actualNativeHostPath: null,
    pathMatches: false,
  };
  if (!status.exists) return status;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    status.actualNativeHostPath = typeof manifest.path === "string" ? manifest.path : null;
    status.pathMatches =
      status.actualNativeHostPath != null &&
      path.resolve(status.actualNativeHostPath) === path.resolve(expectedNativeHostPath);
  } catch (error) {
    status.error = error.message;
  }
  return status;
}

function doctor(args) {
  const paths = runtimePaths(args);
  const pluginRoots = detectPluginRoots(args);
  const configPath = path.join(args.codexHome, "config.toml");
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const nodeReplConfig = findTomlTable(configText, "mcp_servers.node_repl");
  const report = {
    platform: process.platform,
    arch: process.arch,
    node: {
      execPath: process.execPath,
      version: process.version,
    },
    commands: {
      chromium: commandPath("chromium"),
      chromiumBrowser: commandPath("chromium-browser"),
      googleChrome: commandPath("google-chrome"),
      codex: resolveCodexPath(),
    },
    codexHome: args.codexHome,
    installRoot: args.installRoot,
    browserConfigRoot: args.browserConfigRoot,
    codexConfig: {
      path: configPath,
      toolSearchAlwaysDeferMcpTools: codexFeatureFlagStatus(configText, TOOL_SEARCH_DEFER_FEATURE),
      nodeReplMcp: nodeReplConfigBlockStatus(nodeReplConfig?.block || "", paths),
    },
    runtime: {
      nativeHostBridge: { path: paths.nativeHostBridge, exists: fs.existsSync(paths.nativeHostBridge) },
      nodeReplMcp: { path: paths.nodeReplMcp, exists: fs.existsSync(paths.nodeReplMcp) },
    },
    nativeHostManifests: userNativeManifestPaths(args).map((manifestPath) =>
      nativeManifestStatus(manifestPath, paths.nativeHostBridge)
    ),
    systemNativeHostManifests: systemNativeManifestPaths(args).map((manifestPath) =>
      nativeManifestStatus(manifestPath, paths.nativeHostBridge)
    ),
    browserUseSockets: browserUseSocketStatus(),
    desktopShims: [
      path.join(DESKTOP_SHIM_DIRS[0], "node_repl"),
      path.join(DESKTOP_SHIM_DIRS[1], "node_repl"),
    ].map((shimPath) => ({ path: shimPath, exists: fs.existsSync(shimPath) })),
    windowsDesktopShims: windowsDesktopShimTargets(args).map((shim) => ({
      command: shim.command,
      path: shim.path,
      exists: fs.existsSync(shim.path),
    })),
    pluginRoots: pluginRoots.map((root) => patchStatusForRoot(root, paths)),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`${APP_NAME} doctor`);
  console.log(`platform: ${report.platform} ${report.arch}`);
  console.log(`node: ${report.node.version} ${report.node.execPath}`);
  console.log(`chromium: ${report.commands.chromium || report.commands.chromiumBrowser || "not found"}`);
  console.log(`codex: ${report.commands.codex || "not found"}`);
  console.log(`install root: ${report.installRoot}`);
  console.log(`browser config root: ${report.browserConfigRoot}`);
  console.log(
    `config ${TOOL_SEARCH_DEFER_FEATURE}: ${
      report.codexConfig.toolSearchAlwaysDeferMcpTools.enabled ? "ok" : "missing/disabled"
    } ${report.codexConfig.path}`
  );
  console.log(
    `config node_repl: ${
      report.codexConfig.nodeReplMcp.pathMatches
        ? "ok"
        : report.codexConfig.nodeReplMcp.exists
          ? "mismatch"
          : "missing"
    } ${report.codexConfig.path}`
  );
  console.log(`native host bridge: ${report.runtime.nativeHostBridge.exists ? "ok" : "missing"}`);
  console.log(`node_repl MCP: ${report.runtime.nodeReplMcp.exists ? "ok" : "missing"}`);
  for (const manifest of report.nativeHostManifests) {
    console.log(
      `manifest: ${manifest.pathMatches ? "ok" : manifest.exists ? "mismatch" : "missing"} ${manifest.path}`
    );
  }
  for (const manifest of report.systemNativeHostManifests) {
    console.log(
      `system manifest: ${manifest.pathMatches ? "ok" : manifest.exists ? "mismatch" : "missing"} ${manifest.path}`
    );
  }
  for (const shim of report.desktopShims) {
    console.log(`desktop shim: ${shim.exists ? "ok" : "missing"} ${shim.path}`);
  }
  const installedWindowsShims = report.windowsDesktopShims.filter((shim) => shim.exists);
  console.log(`windows desktop shims: ${installedWindowsShims.length}/${report.windowsDesktopShims.length} installed`);
  const displayedWindowsShims = installedWindowsShims.slice(0, 8);
  for (const shim of displayedWindowsShims) {
    console.log(
      `  windows desktop shim: ok ${shim.command} -> ${shim.path}`
    );
  }
  if (installedWindowsShims.length > displayedWindowsShims.length) {
    console.log(`  ... ${installedWindowsShims.length - displayedWindowsShims.length} more installed Windows shims`);
  }
  for (const socket of report.browserUseSockets) {
    console.log(
      `socket: ${socket.stale ? "stale" : "ok"} ${socket.path} pid=${socket.pid} alive=${socket.ownerProcessAlive}`
    );
  }
  for (const root of report.pluginRoots) {
    const ok = Object.entries(root)
      .filter(([key]) => !["root", "kind"].includes(key))
      .every(([key, value]) => {
        if (typeof value === "boolean") return value === true;
        if (key === "pluginMcpNodeRepl") return value.pathMatches === true;
        return true;
      });
    console.log(`plugin: ${ok ? "ok" : "needs patch"} ${root.kind} ${root.root}`);
    if (root.pluginMcpNodeRepl.exists && root.pluginMcpNodeRepl.nodeReplExists) {
      console.log(
        `  plugin mcp ${root.pluginMcpNodeRepl.serverName}: ${
          root.pluginMcpNodeRepl.pathMatches ? "ok" : "mismatch"
        } ${root.pluginMcpNodeRepl.path}`
      );
    }
  }
}

function restorePlugin(args) {
  requireLinuxWrites(args);
  const roots = detectPluginRoots(args);
  for (const root of roots) {
    restoreBackupsInDirectory(path.join(root, "scripts"), args);
    restoreBackupsInDirectory(path.join(root, "skills", "chrome"), args);
  }
}

function restoreBackupsInDirectory(dir, args) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.includes(BACKUP_SUFFIX)) continue;
    const backupPath = path.join(dir, entry);
    const targetPath = path.join(dir, entry.split(BACKUP_SUFFIX)[0]);
    const allBackups = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${path.basename(targetPath)}${BACKUP_SUFFIX}`))
      .sort();
    if (entry !== allBackups.at(-1)) continue;
    copyFile(backupPath, targetPath, null, args);
    logAction(args, `restored ${targetPath} from ${backupPath}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      usage();
      return;
    }
    if (args.command === "install") install(args);
    else if (args.command === "doctor") doctor(args);
    else if (args.command === "patch-plugin") {
      requireLinuxWrites(args);
      patchPlugins(args);
    }
    else if (args.command === "restore-plugin") restorePlugin(args);
    else {
      usage();
      throw new Error(`Unknown command: ${args.command}`);
    }
  } catch (error) {
    if (args?.json) console.log(JSON.stringify({ error: error.message }, null, 2));
    else console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
