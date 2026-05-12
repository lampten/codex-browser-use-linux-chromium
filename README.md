# codex-browser-use-linux-chromium

Unofficial compatibility layer for using Codex Browser Use / Chrome skill with
Chromium on Linux remote hosts.

This project does not redistribute the official Codex desktop app, official
Chrome extension, or official Browser Use plugin. It only installs Linux-side
compatibility files and small local patches so a Linux Chromium host can satisfy
the runtime shape expected by the official Codex Chrome/Browser Use skill.

![Chromium Browser Use sample](assets/chromium-sample.png)

## What It Does

- Installs a Linux native-messaging bridge for the official Codex Chrome
  extension.
- Installs a minimal `node_repl` MCP server exposing `js` and `js_reset`.
- Exposes `nodeRepl` and `__codexNativePipe` so the official
  `browser-client.mjs` can connect to Chromium through the native host.
- Provides `nodeRepl.import()` and `__dynamicImport()` for relative imports
  resolved from the REPL cwd.
- Saves emitted browser images to absolute files under the current workspace
  and prints a Markdown image link, so Codex Desktop can render screenshot
  deliverables as visible file artifacts.
- Accepts the official Node REPL `js` call shape, including optional `title`
  and per-call `timeout_ms`/`timeoutMs` fields.
- Cleans up native browser sockets after a `js` timeout, so a timed-out browser
  command is less likely to poison follow-up tool calls in the same MCP process.
- Gives each MCP process a unique Browser Use `session_id` and stable
  process-scoped `turn_id`, matching the isolation the official desktop runtime
  normally provides for browser-session state.
- Patches locally cached Codex Browser Use / Chrome plugin scripts so they
  recognize Chromium on Linux.
- Patches plugin-local `mcpServers` metadata for both Chrome and Browser Use,
  so Codex CLI 0.130+ plugin caches expose `node_repl` from the selected plugin
  version directory instead of depending on a global or stale MCP entry.
- On Linux, hard-routes the official `Browser` / `browser-use` `iab` backend
  to the Chromium-backed extension backend. Linux remote hosts do not have the
  Codex Desktop in-app browser, so `@browser` and frontend-testing skills need
  this compatibility alias to use Chromium instead of failing before browser
  setup.
- Optionally installs macOS Desktop remote path shims under `/Applications/...`
  on the Linux host. This is needed when Codex Desktop on macOS remotely
  connects to the Linux host and sends its own `node_repl` path through
  `RefreshMcpServers`.

## Security and Approval Model

This compatibility layer runs in trusted local mode by default. Browser Use
approval is effectively `allow`: navigation, browser history access, downloads,
and uploads are not connected to the Codex Desktop approval prompts.

The Linux `node_repl` runtime intentionally sets:

```text
x-codex-browser-use-security-mode: disabled-for-local-testing
```

and its `createElicitation()` helper currently auto-accepts approval requests.
This matches the practical behavior of "Always allow", but it is not the same
as integrating with the Codex Desktop settings page under
`Computer use > Google Chrome`.

The Codex Desktop approval UI, allowed/blocked domain lists, and per-feature
history/download/upload settings are owned by the closed-source desktop app and
are not exposed to this Linux remote runtime. Use this project only on hosts,
browser profiles, and network environments you trust. A future local policy file
could add project-owned allow/deny checks, but it would not be synchronized with
the official desktop approval UI.

## Requirements

- Linux host with Node.js 20+.
- Chromium installed as `chromium` or `chromium-browser`.
- The official Codex Chrome extension already installed or loaded in Chromium.
- Codex CLI/app-server already set up on the Linux host.
- A cached official Codex Chrome plugin under `~/.codex/plugins/cache/...`.

The default extension ID used by this installer is:

```text
hehggadaopoacecdllhhajmbjkdcmajg
```

Override it with `--extension-id` if your extension ID differs.

## Install

From the project directory on the Linux host:

```bash
node bin/codex-browser-use-linux-chromium.js install --desktop-shims
node bin/codex-browser-use-linux-chromium.js doctor
```

`install` performs these steps:

- Copies runtime files into
  `~/.local/share/codex-browser-use-linux-chromium`.
- Writes user-level Chromium and Google Chrome native host manifests.
  Use `--system-native-host` when Chromium already has a system manifest under
  `/etc/chromium/native-messaging-hosts` or Chrome has one under
  `/etc/opt/chrome/native-messaging-hosts`.
- Patches discovered official Browser Use / Chrome plugin caches. Plugin
  patching is planned transactionally per plugin root: if any required patch
  point is missing, that plugin root is left untouched.
- Updates or creates plugin-local `.mcp.json` `node_repl` entries pointing to
  the installed runtime. The installer also adds `mcpServers` metadata to
  Chrome and Browser Use plugin manifests when the official cache does not ship
  it.
- With `--desktop-shims`, creates Linux shims for macOS Codex Desktop remote
  paths:
  - `/Applications/Codex.app/Contents/Resources/node_repl`
  - `/Applications/Codex (Beta).app/Contents/Resources/node_repl`
- With `--system-native-host`, writes system native host manifests:
  - `/etc/chromium/native-messaging-hosts/com.openai.codexextension.json`
  - `/etc/opt/chrome/native-messaging-hosts/com.openai.codexextension.json`

The `/Applications` shims and system native host manifests require root
permissions. The installer preflights passwordless `sudo -n` before making
changes when either privileged option is requested.

For tests or custom Chromium profile locations, override the manifest root:

```bash
node bin/codex-browser-use-linux-chromium.js install --browser-config-root /tmp/browser-config
```

The installer refuses real writes on non-Linux hosts unless
`--allow-non-linux` is passed. Use that only for local tests with temporary
directories.

## Optional Codex CLI Config

For direct Codex CLI usage, add:

```bash
node bin/codex-browser-use-linux-chromium.js install --write-codex-config
```

This appends a marked `node_repl` MCP block to `~/.codex/config.toml` if no
`[mcp_servers.node_repl]` block exists. If the block already points at a known
older `codex-chrome-extension` or `codex-browser-use-linux-chromium` REPL path,
the installer updates it to the current runtime path. Custom `node_repl`
entries are left unchanged.

Codex Desktop remote sessions may still override MCP config via
`RefreshMcpServers`; the desktop path shims are what handle that case.

## Windows Desktop Clients

Windows Codex Desktop may send a Windows-local `node_repl` command path through
`RefreshMcpServers`, for example a path under `AppData\\Local\\Programs`.
That path varies by Windows username and install channel.

This project ships macOS path shims by default because those paths are stable:

```text
/Applications/Codex.app/Contents/Resources/node_repl
/Applications/Codex (Beta).app/Contents/Resources/node_repl
```

For Windows clients, inspect the Linux host app-server log for the exact
`RefreshMcpServers` `node_repl.command` value, then create a matching shim or
alias that execs:

```text
~/.local/share/codex-browser-use-linux-chromium/node-repl/codex-node-repl-mcp.js
```

## Restore Plugin Patches

Plugin patches are backed up next to each patched file with a
`.codex-browser-use-linux-chromium.bak.<timestamp>` suffix.

Restore the latest adjacent backups with:

```bash
node bin/codex-browser-use-linux-chromium.js restore-plugin
```

## Debugging

Useful logs on the Linux host:

```text
/tmp/codex-native-host-bridge.log
/tmp/codex-node-repl-mcp.log
~/.codex/logs_2.sqlite
```

If a fresh Codex Desktop conversation cannot see `mcp__node_repl__js`, search
`logs_2.sqlite` for `RefreshMcpServers` and verify the exact `node_repl.command`
exists on the Linux host.

If `mcp__node_repl__js` appears to hang, check for old
`codex-node-repl-mcp.js` processes and open connections in
`/tmp/codex-native-host-bridge.log`. Each MCP process should log a distinct
`session_id` and a stable `turn_id` in `/tmp/codex-node-repl-mcp.log`. The
JavaScript tool has a default 120 second timeout; override it with
`CODEX_NODE_REPL_JS_TIMEOUT_MS=0` to disable the timeout or another millisecond
value to tune it. The `js` tool also accepts per-call `timeout_ms`/`timeoutMs`
values, matching the official runtime's call shape. A timeout returns an MCP
error but keeps the stdio transport open, so follow-up calls such as `js_reset`
can still recover the session. By default the runtime destroys native browser
pipe connections and resets the JS context after a timeout; set
`CODEX_NODE_REPL_RESET_ON_TIMEOUT=0` only if you need to preserve in-memory JS
state across timeouts. Set `CODEX_NODE_REPL_EXIT_ON_TIMEOUT=1` only if you
explicitly want timeout errors to terminate the MCP process.

If `/tmp/codex-native-host-bridge.log` contains repeated `stdout backpressure`
lines, the native host is sending commands to Chromium faster than Chromium is
reading them. This version serializes native-host stdout writes and waits for
`drain` before sending more frames. You can lower the fail-fast queue cap with
`CODEX_NATIVE_HOST_MAX_CHROME_QUEUE_BYTES`; the default is 64 MiB.

If a screenshot task says it succeeded but no image appears in the final
assistant message, check whether the final message references
`attachment://response_0.png`. The screenshot usually did arrive as a previous
tool-output image; that attachment URI is not stable in this compatibility
runtime. The installer patches the Chrome skill to keep the screenshot image in
the latest browser tool output, save it to a workspace file, and avoid synthetic
attachment links. The REPL also replays the most recent emitted image when a
follow-up `js` call only finalizes browser tabs, covering the common
cleanup-after-screenshot ordering mistake.

`doctor` also reports Browser Use sockets under `/tmp/codex-browser-use`.
Sockets whose owner process is gone are stale; the native bridge removes stale
`chromium-<pid>.sock` files on startup.

See [docs/architecture.md](docs/architecture.md) for the runtime flow.
