# Changelog

All notable changes to the Integrated Browser MCP extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-04-27

### Added
- `browser_screenshot` now accepts `fullPage: true` to capture the entire scrollable page (maps to CDP's `captureBeyondViewport`). The integrated browser pane is usually narrow, so viewport-only screenshots lose everything below the fold — full-page is what most agent workflows actually want.
- `browser_screenshot` now accepts `waitMs` to sleep before the capture. Handles the CSS-transition race where `className` changes synchronously (e.g. theme flip) but painted pixels lag by the transition duration; 400–600ms covers most Tailwind `transition-colors` defaults.
- New `browser_emulate` tool for viewport, DPR, mobile-flag, and User-Agent overrides. Pass `reset: true` to clear. Setting `mobile: true` also enables touch emulation so `(hover: none)` / `(pointer: coarse)` media queries fire — without that, mobile sites render their desktop fallback even at iPhone dimensions.
  - Uses the *deprecated* `Page.setDeviceMetricsOverride` rather than the modern `Emulation.setDeviceMetricsOverride`. In a normal Chrome process they're equivalent, but VS Code's `BrowserTab` surface silently drops the Emulation call's width/height/deviceScaleFactor (only the mobile flag sticks). The Page.* path isn't filtered and is the only way to get real viewport + DPR overrides inside the editor pane.
- New `browser_screenshot_slice` tool: captures one viewport-height slice of a long page plus metadata (`totalSlices`, `scrollHeight`, `viewportHeight`). Designed for AI consumers of tall pages where Chromium's single-PNG axis cap (~16,384 px) makes full-page capture fail, and where compressing 60k-px-tall content to a thumbnail loses the detail a vision model needs. Agents call once with no `slice` to learn the page shape, then request specific indices — `slice: 0` for the header, `slice: -1` for the footer (negative indices count from the end). Pairs naturally with `browser_emulate` (set the viewport, then slice through it).
- New `browser_markdown` tool: extracts page content as markdown via a pure-JS DOM walker injected into the page (~80 lines, no Readability/Turndown, no deps). Optional `selector` param scopes extraction (defaults to `main`, falls back to `body`). Headings, links, code, pre-blocks, lists, blockquotes, and images are all preserved. Two non-obvious refinements forced by real-world docs sites (Apple Developer in particular): (1) link text is trimmed before bracketing so `<a> View </a>` becomes `[View](...)` rather than `[ View ](...)`; (2) adjacent inline siblings with no source-side whitespace get a synthetic separator so platform-availability runs like `<span>iOS 13.0+</span><span>iPadOS 13.0+</span>` don't render as `iOS 13.0+iPadOS 13.0+`. Optional `outputPath` (absolute or workspace-relative) writes the markdown to disk and returns only `Saved N bytes to <path>` — built for bulk archival where the body would otherwise flow through the agent's context. Paths are scoped to the open workspace folder; outside-workspace paths are rejected. Symlinks inside the workspace are not followed.

## [0.4.1] — 2026-04-24

### Added
- MCP server now sends a top-level `instructions` field on connect describing the integration (browser lives inside VS Code, numbered tabs, which tool is cheap vs expensive). Clients that honour the MCP spec's instructions field surface this to the model automatically.
- Tool descriptions rewritten with concrete intra-MCP guidance. `browser_eval` is explicitly positioned as the preferred read path; `browser_dom` and `browser_screenshot` are flagged as heavier alternatives.
- README gains a "Briefing an AI agent" section with a CLAUDE.md snippet users can paste into their project — the place for prescriptive user preferences like "prefer this MCP over the system browser".

### Fixed
- Title-oscillation-and-crash on reload: when a VS Code window hosting browser tabs was reloaded, the freshly-activated 0.4.0 bridge installed its own title-prefix observer while the **previous extension version's observer was still alive in the page's JavaScript context** (the CDP session was torn down on reload, but the observer was injected via `Runtime.evaluate` and lives independently). The two observers fought — stripping and re-prepending each other's marker — until the page thread eventually crashed.
  - The new title script detects the pattern: if it sets the title more than 10 times within a second, it disconnects its own observer and backs off. The losing tab keeps whatever prefix the rival observer sets; the page stays responsive. Freshly-opened tabs (post-upgrade) are unaffected.
  - Also adds a per-process ownership marker (`window.__bridgeOwner`) used atomically at adopt time, as defence-in-depth for any future scenario where two 0.4.1+ instances could race on the same page. The marker is released on disconnect so a reloaded window cleanly reclaims its tabs.

## [0.4.0] — 2026-04-24

### Added
- **Multi-tab support** (proposed-API path only — requires `--enable-proposed-api=thimo.integrated-browser-mcp`).
  - New MCP tools: `browser_tab_open`, `browser_tab_close`, `browser_tab_list`, `browser_tab_activate`.
  - All existing interaction tools (`browser_navigate`, `browser_eval`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_snapshot`, `browser_dom`, `browser_url`, `browser_console`, `browser_network`, `browser_network_clear`) now accept an optional `tabId` parameter. Omit to target the active tab.
  - `browser_console` and `browser_network` aggregate across all tabs by default. Each entry carries its originating `tabId`. Pass `tabId` to filter to one tab.
  - The bridge tracks tabs opened via MCP, via the VS Code UI, or at startup (`window.browserTabs`). Active-tab changes in the VS Code UI sync to our internal default.
  - New HTTP endpoints: `POST /tab/open`, `POST /tab/close/:tabId`, `POST /tab/activate/:tabId`; `GET /tabs` now returns `[{ tabId, number, url, title, active, state, transport }]`.
  - Each tab gets a **stable display number** (1, 2, 3…) with reuse of vacated numbers (close tab 3 → next new tab gets 3; tab 4 stays tab 4). The number appears as a `(N) ` prefix on the tab title (auto-created if the page has no `<title>`) so you can refer to tabs conversationally ("reload browser 2") and match them against `browser_tab_list`'s `number` field.
- Status bar tooltip shows active tab URL and tab count when multiple tabs are open; label shows `Browser MCP (N)` when N > 1.

### Changed
- Internal refactor: `CDPConnection` split into `CDPTab` (per-tab state + CDP protocol) and `CDPManager` (multi-tab orchestration). No changes for existing single-tab callers.
- On the debug-session fallback path (no proposed API), the bridge exposes a single synthetic `tab-main`. `browser_tab_open` returns an error directing users to the proposed-API mode; other tools behave exactly as in 0.3.0.

### Removed
- `POST /tabs/:id/activate` legacy endpoint (used CDP target ids that weren't stable across restarts). Replaced by `POST /tab/activate/:tabId` with our tab ids.

## [0.3.0] — 2026-04-23

### Added
- Optional support for VS Code's proposed `browser` API ([microsoft/vscode#300319](https://github.com/microsoft/vscode/issues/300319)). When the extension is launched with `--enable-proposed-api=thimo.integrated-browser-mcp`, the bridge uses `vscode.window.openBrowserTab` + `BrowserTab.startCDPSession` instead of a debug session, bypassing `vscode-js-debug`'s CDP proxy. This makes web worker and service worker events (console + network) flow into `/console` and `/network`, tagged with `target: "worker"` / `"service_worker"`. No debug toolbar or Run & Debug badge in this mode.
- Feature-detects the proposal at startup. Without the flag, the bridge falls back to the existing debug-session path and works exactly like 0.2.0.
- `/status` exposes `transport`: `"browserTab"` when using the proposed API, `"websocket"` on the fallback path, `null` when idle.
- Status bar tooltip shows the active transport (`Browser MCP: Connected (proposed)` vs `(debug-session)`).

### Changed
- Status bar no longer shows the warning background on first startup when the bridge is simply idle (no browser requested yet). The warning style is reserved for unexpected disconnects after a connection was established.
- Tab-title marker changed from `🔴 ` (emoji-sized red dot) to `◉ ` (text-sized fisheye).

### Fixed
- Handshake-only CDP sessions (browser + primary page) are no longer reported as child sessions in `/status.children`, and their events no longer get a `target` field. Only true child sessions (workers, iframes) are tagged.

## [0.2.0] — 2026-04-23

### Fixed
- Console and network buffers were silently empty. vscode-js-debug's CDP proxy only forwards events the client has explicitly subscribed to; the bridge never subscribed. Now calls `JsDebug.subscribe` for `Runtime.*`, `Network.*`, `Target.*`, and `Page.*` on connect.

### Added
- Iframe console and network events are now captured via the primary page session.
- On VS Code 1.117+ with the [new browserView CDP multiplexer](https://github.com/microsoft/vscode/pull/311049), web worker and service worker targets auto-attach and appear in `/status.children`. Their own `Runtime`/`Network` events are **not** yet forwarded — js-debug's CDP proxy `subscribe` only dispatches events for the main session, so worker-originated logs and requests don't reach the buffers. Full worker event capture needs a migration to VS Code's proposed `browser` API (planned).
- Optional `target` field on `/console` and `/network` entries, set when events do originate in a tracked child session (currently: iframes on same-session, nothing else in practice).
- `/status` exposes diagnostic fields: `pageSessionId`, `children`, `consoleBufferSize`, `networkBufferSize`, and per-method `events` counters. Useful for troubleshooting event flow.
- CDP bootstrap performs an explicit `Target.attachToBrowserTarget` + `Target.attachToTarget` handshake to obtain a page session id, matching the protocol required by VS Code 1.117's integrated browser CDP proxy. Backwards-compatible with 1.112-1.116.

### Changed
- Minimum VS Code version bumped from 1.110 to 1.112, where [`editor-browser` became a first-class stable debug type](https://github.com/microsoft/vscode-js-debug/pull/2329) with supported `launch` + `attach`.

## [0.1.0] — 2026-04-10

Initial public release.

### Added
- Bridge from VS Code's integrated browser (`editor-browser` debug session) to external agents via the Chrome DevTools Protocol.
- Local HTTP API on `127.0.0.1:3788` with endpoints for navigation, JavaScript evaluation, clicking, typing, scrolling, screenshots, accessibility snapshots, DOM access, console buffering, network buffering, tab management, and status.
- Bundled MCP stdio server exposing the HTTP API as tools (`browser_navigate`, `browser_eval`, `browser_click`, `browser_type`, `browser_scroll`, `browser_screenshot`, `browser_snapshot`, `browser_dom`, `browser_console`, `browser_network`, `browser_url`, `browser_status`).
- Auto-configuration of the MCP server in `~/.claude.json` on activation so Claude Code picks it up without manual setup.
- Multi-window support: each VS Code window registers its port under `~/.integrated-browser-mcp/instances/`, and the MCP server routes requests to the window whose workspace best matches Claude Code's working directory. `BROWSER_BRIDGE_PORT` can override the routing.
- Circular buffers (200 entries) for `Runtime.consoleAPICalled` and network events to power `/console` and `/network`.
- Status bar item showing connection state, with a visible warning background when disconnected.
- `🔴` prefix on the automated browser tab title so it is easy to tell which tab is driven by the bridge.
- Optional external Chrome mode (`browserBridge.browserType: "chrome"`) for situations where the integrated browser's CDP behaviour is unreliable.
- Commands: `Browser Bridge: Start`, `Browser Bridge: Stop`, `Browser Bridge: Show Status`.
- Settings: `browserBridge.httpPort`, `browserBridge.autoStart`, `browserBridge.browserType`.
