# Architecture

The official Browser Use skill expects a `node_repl` MCP server. In the
supported desktop setup that server is bundled inside the Codex app and exposes
helpers such as `nodeRepl`, `display`, and a privileged native pipe bridge.

On Linux remote hosts, Codex Desktop can still send a `RefreshMcpServers`
operation that points to the desktop app's local `node_repl` path. That path
does not exist on the Linux host, so MCP startup fails before the model ever
sees `mcp__node_repl__js`.

The exact missing path depends on the desktop client. macOS usually sends
`/Applications/Codex.app/Contents/Resources/node_repl` or the Beta app variant.
Windows can send a path such as
`C:\Users\Josh\AppData\Local\Programs\Codex Beta\resources\node_repl.exe`.
The installer can create Linux-side shims for both families.

This project fills the Linux side:

1. Chromium loads the official Codex Chrome extension.
2. Chromium starts this project's native-messaging bridge.
3. The bridge exposes a Unix socket under `/tmp/codex-browser-use`.
4. Codex starts this project's `node_repl` MCP server.
5. The MCP server provides `globalThis.__codexNativePipe.createConnection`.
6. The official `browser-client.mjs` connects to the Unix socket and controls
   Chromium through the official extension protocol.

The project intentionally does not implement browser automation as a separate
replacement API. It only recreates enough of the official Node REPL runtime for
the official Browser Use client code to run.

## Codex 0.130 Tool Discovery

Codex 0.130 changed MCP tool exposure so small sets of non-app MCP tools can be
registered directly instead of being listed in `tool_search`. That is valid for
normal MCP usage, but it is brittle for this compatibility layer because the
official Chrome and Browser skills first discover `node_repl/js` through the
searchable tool surface.

The installer therefore enables:

```toml
[features]
tool_search_always_defer_mcp_tools = true
```

With that flag, `node_repl/js` and `node_repl/js_reset` stay discoverable
through `tool_search` in new turns. `doctor` reports the flag separately from
native-host and plugin-cache status so a missing JS tool is not misdiagnosed as
a Chromium path problem.

Codex 0.130 also de-duplicates plugin MCP server names while loading plugin
metadata. The official Chrome and Browser Use caches can both point at a server
called `node_repl`; when that happens, the first loaded plugin owns the name and
the later plugin is skipped. On remote desktop clients this can make `@Chrome`
load the Chrome skill while still failing to discover `node_repl/js`.

This compatibility layer keeps the Chrome plugin on the official `node_repl`
server name and rewrites the Browser Use plugin's local MCP entry to
`browser_node_repl`. The Browser skill patch documents that fallback name. The
two plugin surfaces still point to the same Linux runtime, but they no longer
collide in Codex's plugin MCP registry.

The Chrome skill patch explicitly tells agents not to use `browser_node_repl`
for Chrome tasks. `browser_node_repl` exists only to keep the Browser /
in-app-browser skill discoverable after Codex's duplicate MCP server-name
de-duplication.

There are two plugin roots to consider on Codex 0.130 remote hosts. The normal
installed cache lives under `~/.codex/plugins/cache/...`, while Desktop remote
turns may also load a staged bundled-marketplace copy under
`~/.codex/.tmp/bundled-marketplaces/<marketplace>/plugins/...`. Both copies
need the same MCP metadata and skill patches; otherwise a restarted app-server
can still build a turn from the unpatched staged copy.

## Browser vs Chrome Routing

Codex currently ships two related browser plugin surfaces:

- `Chrome`, which targets the user's Chrome browser through the official Codex
  Chrome extension.
- `Browser` / `browser-use`, which targets the Codex Desktop in-app browser
  backend named `iab`.

On a Linux remote host there is no Codex Desktop app and therefore no real
`iab` browser. The installer patches the local `browser-use` plugin cache so
that `iab` is treated as an alias for the Chromium extension backend. This lets
official Browser skill code such as `agent.browsers.get("iab")` continue to
work while using Chromium behind the scenes.

This routing patch is intentionally Linux-local. It does not make the host show
up as a first-class Codex Desktop in-app browser, and it does not change the
closed-source app UI. It only makes the plugin runtime on the remote CLI host
resolve Browser requests to the available Chromium-backed extension transport.

## Approval Boundaries

The official desktop provider has an app-level approval layer for opening
websites, reading browser history, downloads, uploads, and allowed or blocked
domains. That layer belongs to Codex Desktop's `Computer use > Google Chrome`
provider.

This project does not register as that provider. It is a Linux-side
compatibility runtime started as `node_repl`, so it cannot read or enforce the
desktop app's approval dropdowns or domain lists without patching the desktop
app itself.

To keep the official Browser Use client functional on Linux Chromium, the
runtime defaults to trusted local mode: it advertises
`x-codex-browser-use-security-mode: disabled-for-local-testing` and its
elicitation helper auto-accepts approval requests. In practice, that means the
default policy is allow, not deny.

Any stricter policy would need to be implemented as a separate local policy
layer in this project. That would be useful for defense in depth, but it would
not be the same as the closed-source Codex Desktop approval UI.

## Session Isolation

The official Browser Use client sends `session_id` and `turn_id` to the browser
extension with each command. This compatibility layer generates a unique
`session_id` per MCP process and keeps a stable `turn_id` inside that process.
Reusing a constant session across processes can make separate Codex
conversations share browser-session state. Changing `turn_id` between adjacent
`js` calls in the same assistant turn can also make a tab created by one call
look detached to the next call.

The `js` tool also has a process-level timeout controlled by
`CODEX_NODE_REPL_JS_TIMEOUT_MS` and defaults to 100000 ms. When a JavaScript
call times out, the MCP server returns an error but keeps its stdio transport
open so the same Codex turn can still run recovery calls such as `js_reset`.
After a timeout, the compatibility runtime destroys native browser pipe sockets
and resets the JS context by default; this prevents the timed-out Browser Use
promise from continuing to occupy the extension channel while later calls run.
Set `CODEX_NODE_REPL_RESET_ON_TIMEOUT=0` to preserve the old behavior, or
`CODEX_NODE_REPL_EXIT_ON_TIMEOUT=1` to restore exit-on-timeout behavior.

Timeout errors include a `consecutive_js_timeouts` counter and a short recovery
hint. Screenshots and `domSnapshot()` remain normal supported Browser/Chrome
features on Linux Chromium. The patched Browser and Chrome skills tell agents
to keep those calls single-purpose, reset after stale-pipe errors, and retry the
requested evidence from a fresh tab object instead of silently avoiding the
feature. Repeated `tab.playwright`, `tab.cua`, fill, click, or keyboard
timeouts while lightweight tab listing and URL/title reads still work are a
page-level bridge hang, not an MCP discovery failure.

The installer also patches the Browser client CDP wrapper so `timeoutMs` is
enforced in JavaScript with a local `Promise.race`, not only passed through to
the extension. This matters when Chromium or the extension stops honoring the
requested timeout for page-level CDP calls such as `Page.captureScreenshot`.
Those failures now return as bounded browser errors that can be reset and
retried instead of waiting for the outer MCP transport to close.

The native host bridge also serializes writes to Chromium stdout and waits for
Node's `drain` event when the Chrome native-messaging pipe reports backpressure.
This is important for screenshot-heavy or retry-heavy browser tasks: without
write-side flow control, commands can pile up behind Chromium and appear as
frequent per-call `js` timeouts even though the MCP transport itself remains
open.

If a client disconnects while the bridge still has a pending request for that
client, the bridge exits by default. This usually means the REPL timed out and
destroyed its socket while Chromium was still processing a page-level command
such as `domSnapshot` or screenshot. Keeping the native host alive in that state
can leave an orphaned extension/CDP command that later fails as `Detached while
handling command`; restarting the bridge forces Chromium to establish a clean
native-messaging pipe. Set `CODEX_NATIVE_HOST_EXIT_ON_ORPHANED_PENDING=0` to
disable this recovery behavior.

## Install Safety

The installer plans all plugin script edits for a plugin root before writing any
of them. If an official plugin update changes one required patch point, the
plugin root is left untouched instead of being half patched. Desktop path shims
and optional system native host manifests also have a sudo preflight before
install writes begin.

## Socket Cleanup

The native host bridge names its Unix socket `chromium-<pid>.sock`. On startup
it removes stale sockets whose owner process no longer exists, while leaving
live bridge sockets alone.
