# integrated-browser-mcp

A VS Code extension that exposes VS Code's **integrated browser** to external agents (Claude Code, scripts, curl) via a local HTTP API and MCP server. This gives Claude Code the same browser automation capabilities that GitHub Copilot has natively — but agent-agnostic.

## Why this exists

VS Code 1.112+ ships with a stable `editor-browser` debug type backed by a built-in integrated browser (Chromium, full DevTools). Microsoft added browser tools for agents, but locked them to GitHub Copilot only. Claude Code and other external agents have no way to control this browser.

Every existing solution (Browser MCP, Playwright MCP, chrome-devtools-mcp) targets an **external** Chrome process. This extension is different: it bridges the browser **already open in VS Code** — with your session cookies, your localhost dev server, your DevTools — to any agent that can speak HTTP or MCP.

## Architecture

```
Claude Code (CLI / VS Code extension)
    │
    │  stdio MCP  (auto-configured on extension activation)
    ▼
MCP Server (Node.js, bundled inside this extension)
    │
    │  HTTP  localhost:3788
    ▼
VS Code Extension Host (TypeScript)
    │
    │  vscode.debug.activeDebugSession
    │  .customRequest('requestCDPProxy')
    ▼
editor-browser debug session  (auto-launched by extension)
    │
    │  WebSocket CDP
    ▼
VS Code Integrated Browser
(real session: cookies, localStorage, localhost routing, DevTools)
```

## Key technical facts

### Entry point into the integrated browser
`vscode-js-debug` exposes a CDP proxy via a custom DAP request:
```typescript
const session = vscode.debug.activeDebugSession; // type === 'editor-browser'
const { host, port } = await session.customRequest('requestCDPProxy');
// ws://host:port → full Chrome DevTools Protocol access
```
The `editor-browser` debug type became first-class in VS Code 1.112 (vscode-js-debug PR #2329). It gives raw WebSocket CDP — navigate, eval, screenshot, click, DOM, network interception, everything.

On VS Code 1.118+ (vscode PR #311049), the CDP proxy multiplexes sessions for iframes / web workers / service workers via `Target.setAutoAttach({ flatten: true })`. Messages carry a top-level `sessionId` field; our `CDPConnection.send()` accepts an optional `sessionId` to route commands to specific targets.

### Auto-attach flow
The extension must:
1. On activation, check for an existing `editor-browser` debug session
2. If none exists, programmatically launch one:
```typescript
await vscode.debug.startDebugging(undefined, {
  type: 'editor-browser',
  request: 'launch',
  name: 'Browser Bridge',
  url: 'about:blank'
});
```
3. Call `requestCDPProxy` to get the WebSocket endpoint
4. Maintain a persistent CDP WebSocket connection (reconnect on drop)
5. Start the HTTP server and MCP server

### HTTP API (localhost:3788)
Follows the same pattern as `jhamama/cdp-bridge` (study that extension).
All responses: `{ ok: true, data: ... }` or `{ ok: false, error: "..." }`

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/navigate` | `{ url }` | Navigate to URL |
| POST | `/eval` | `{ expression }` | Run JS, returns result |
| POST | `/click` | `{ selector }` | Click by CSS selector |
| POST | `/type` | `{ selector, text }` | Type into element |
| POST | `/scroll` | `{ deltaX, deltaY, selector? }` | Scroll |
| GET  | `/screenshot` | — | Base64 PNG |
| GET  | `/snapshot` | — | Accessibility tree (for agent navigation) |
| GET  | `/dom` | — | Full page outer HTML |
| GET  | `/console` | `?limit=N` | Buffered console output |
| GET  | `/network` | `?limit=N&filter=x` | Buffered network requests |
| POST | `/network/clear` | — | Clear network log |
| GET  | `/url` | — | Current page URL |
| GET  | `/tabs` | — | List open browser tabs |
| POST | `/tabs/:id/activate` | — | Switch tab |
| GET  | `/status` | — | Bridge health |

### MCP Server
Wraps the HTTP API as MCP tools so Claude Code can use it natively without curl.
Follows the pattern from `andrewmkhoury/vscode-claude-code-bridge`:
- MCP server is a Node.js stdio process bundled into the extension
- Extension auto-writes MCP config to `~/.claude.json` on activation
- Uses `@modelcontextprotocol/sdk` for the MCP implementation

MCP tools to expose (map 1:1 to HTTP endpoints):
- `browser_navigate`, `browser_eval`, `browser_click`, `browser_type`
- `browser_screenshot`, `browser_snapshot`, `browser_dom`
- `browser_console`, `browser_network`, `browser_url`, `browser_status`

### Event buffering
The extension must buffer CDP events from the moment the connection opens:
- `Runtime.consoleAPICalled` → circular buffer (last 200 entries)
- `Network.requestWillBeSent` + `Network.responseReceived` → circular buffer (last 200 entries)

These feed the `/console` and `/network` endpoints.

## Reference projects to study

| Project | What to learn from it |
|---------|----------------------|
| `jhamama/cdp-bridge` | HTTP API design, CDP connection management, status bar, Express setup |
| `andrewmkhoury/vscode-claude-code-bridge` | MCP server bundling pattern, auto-config of `~/.claude/settings.json`, HTTP bridge between extension host and MCP stdio process |
| `microsoft/vscode-cdp-proxy` | How `requestCDPProxy` works, DAP custom request pattern |
| `microsoft/vscode-js-debug` | Source of truth for the CDP proxy implementation |

## File structure
```
integrated-browser-mcp/
├── src/
│   ├── extension.ts        # Activation, debug session management, wires everything together
│   ├── cdp.ts              # CDP WebSocket connection, requestCDPProxy, event buffering
│   ├── http-server.ts      # Express HTTP API on localhost:3788
│   ├── mcp-server.ts       # MCP stdio server (bundled, spawned as child process)
│   └── status-bar.ts       # Status bar item showing connection state
├── package.json
├── tsconfig.json
├── esbuild.js              # Build script
└── CLAUDE.md               # This file
```

## Extension activation events
```json
"activationEvents": ["onStartupFinished"]
```
Start immediately when VS Code opens — don't wait for a command.

## package.json contributions
- Status bar item
- Commands: `browserBridge.start`, `browserBridge.stop`, `browserBridge.status`
- Settings: `browserBridge.httpPort` (default 3788), `browserBridge.autoStart` (default true)

## Security
- HTTP server binds to `127.0.0.1` only — never exposed to network
- No authentication (same as cdp-bridge — localhost only)
- Document clearly: `/eval` executes arbitrary JS in whatever page is open

## Development workflow
- `npm run watch` — esbuild watch mode
- F5 in VS Code → launches Extension Development Host with the extension active
- Test with curl against localhost:3788

## Publishing target
VS Code Marketplace under publisher `thimo`.
Extension ID: `thimo.integrated-browser-mcp`
