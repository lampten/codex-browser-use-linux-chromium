# Architecture

The official Browser Use skill expects a `node_repl` MCP server. In the
supported desktop setup that server is bundled inside the Codex app and exposes
helpers such as `nodeRepl`, `display`, and a privileged native pipe bridge.

On Linux remote hosts, Codex Desktop can still send a `RefreshMcpServers`
operation that points to the desktop app's local `node_repl` path. That path
does not exist on the Linux host, so MCP startup fails before the model ever
sees `mcp__node_repl__js`.

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
`CODEX_NODE_REPL_JS_TIMEOUT_MS` and defaults to 120000 ms. When a JavaScript
call times out, the MCP server returns an error and exits shortly afterward so
the app-server can start a clean process instead of keeping a blocked queue.

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
