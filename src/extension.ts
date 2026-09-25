import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';
import * as crypto from 'crypto';
import { CDPManager, hasProposedBrowserApi } from './cdp';
import { BridgeServer } from './http-server';
import { StatusBar } from './status-bar';
import { registerLanguageModelTools } from './lm-tools';

const MCP_KEY = 'integrated-browser-mcp';
const STABLE_DIR = path.join(os.homedir(), '.integrated-browser-mcp');
const STABLE_SERVER = path.join(STABLE_DIR, 'mcp-server.mjs');
const INSTANCES_DIR = path.join(STABLE_DIR, 'instances');
const SOCKETS_DIR = path.join(STABLE_DIR, 'sockets');

let log: vscode.OutputChannel;
let cdp: CDPManager;
let httpServer: BridgeServer;
let statusBar: StatusBar;
let running = false;
let instanceFile: string | null = null;
let actualEndpoint: { socketPath?: string; port?: number } = {};
let browserLaunching = false;
// Subscriptions created per start (the browser-tab lifecycle listeners).
// Disposed by stopBridge so a stopped bridge stops firing handlers that deref
// the now-null `cdp`, and so start->stop->start does not accumulate duplicates.
let startDisposables: vscode.Disposable[] = [];
// Fired after the bundled MCP server file is synced, so the VS Code MCP provider
// (registered at activation) re-resolves once the file exists.
let mcpDidChange: vscode.EventEmitter<void> | null = null;

function isBrowserSession(session: vscode.DebugSession): boolean {
	return session.type === 'pwa-editor-browser'
		|| session.type === 'editor-browser'
		|| session.type === 'pwa-chrome'
		|| session.type === 'chrome';
}

function getWorkspacePath(): string {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function instanceId(workspacePath: string): string {
	// Include the pid so two windows on the SAME workspace get distinct socket
	// paths and instance files. Without it they collide: the second window can't
	// bind the shared socket, falls back to TCP, and its instance file overwrites
	// the first's, stranding it. Discovery matches on the `workspace` field
	// inside the file (not the id), so per-pid ids don't break it.
	const key = `${workspacePath || 'no-workspace'}:${process.pid}`;
	return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

/**
 * Read a setting under the current `integratedBrowserMcp.*` namespace, falling
 * back to an explicitly-set legacy `browserBridge.*` value. Only the three
 * settings that shipped under the old name (httpPort, autoStart, browserType)
 * need this; the legacy keys stay defined-and-deprecated in package.json so a
 * user's existing settings.json keeps taking effect after the rename.
 */
function migratedGet<T>(key: string, def: T): T {
	const c = vscode.workspace.getConfiguration();
	const neu = c.inspect<T>(`integratedBrowserMcp.${key}`);
	const explicitNew = neu?.workspaceFolderValue ?? neu?.workspaceValue ?? neu?.globalValue;
	if (explicitNew !== undefined) return explicitNew;
	const old = c.inspect<T>(`browserBridge.${key}`);
	const explicitOld = old?.workspaceFolderValue ?? old?.workspaceValue ?? old?.globalValue;
	if (explicitOld !== undefined) return explicitOld;
	return def;
}

/**
 * Adopt every browser tab VS Code currently has open. Used at startup and
 * whenever access is widened; `adoptBrowserTab` is idempotent, so tabs already
 * tracked are left alone.
 */
function adoptOpenBrowserTabs(): void {
	if (!cdp || !hasProposedBrowserApi()) return;
	for (const tab of vscode.window.browserTabs) {
		cdp.adoptBrowserTab(tab, tab === vscode.window.activeBrowserTab).catch(err => {
			log.appendLine(`[Bridge] adoptBrowserTab failed: ${err}`);
		});
	}
}

/**
 * Fallback-path counterpart of {@link adoptOpenBrowserTabs}: pick up the browser
 * debug session that is already running once access is widened. Without this,
 * enabling `allowAllExistingTabs` would do nothing on a build without the
 * proposed API, because that session was refused at start and nothing re-offers
 * it. `adoptDebugSession` re-checks the setting and returns null if it is off.
 */
function adoptExistingDebugSession(): void {
	const session = vscode.debug.activeDebugSession;
	if (!cdp || cdp.tabCount > 0 || !session || !isBrowserSession(session)) return;
	cdp.adoptDebugSession(session, false).catch(err => {
		log.appendLine(`[Bridge] adoptDebugSession failed: ${err}`);
	});
}

/** True when something is actively accepting on this socket path (don't unlink a live one). */
function socketIsLive(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = net.connect(socketPath);
		const timer = setTimeout(() => done(false), 300);
		const done = (live: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(live); };
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

export function activate(context: vscode.ExtensionContext) {
	log = vscode.window.createOutputChannel('Integrated Browser MCP');
	statusBar = new StatusBar();

	// Commands moved to the integratedBrowserMcp.* namespace; the old
	// browserBridge.* ids stay registered as aliases so existing keybindings
	// keep working.
	const registerCmd = (name: string, handler: (...args: unknown[]) => unknown): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand(`integratedBrowserMcp.${name}`, handler),
			vscode.commands.registerCommand(`browserBridge.${name}`, handler),
		);
	};
	registerCmd('start', () => startBridge(context));
	registerCmd('stop', stopBridge);
	registerCmd('status', showStatus);
	registerCmd('openInBrowser', (uri?: unknown) => openInBrowser(uri as vscode.Uri | undefined));

	context.subscriptions.push(
		log,
		statusBar,
		vscode.debug.onDidStartDebugSession(session => {
			// Auto-connect to externally launched browser child sessions on the
			// fallback (websocket) path. Skip root sessions (no CDP), skip if
			// launchBrowser() is handling it, and skip if we already have tabs.
			// Not bridge-owned: this is a session someone else started, so it is
			// only adopted when the user allows their own tabs to be driven.
			if (isBrowserSession(session) && session.parentSession && cdp && cdp.tabCount === 0 && !browserLaunching) {
				cdp.adoptDebugSession(session, false).catch(err => {
					log.appendLine(`[Bridge] Auto-connect failed: ${err}`);
				});
			}
		}),
		vscode.debug.onDidTerminateDebugSession(session => {
			// On the fallback path, a single debug session drives the single tab.
			// When that session terminates, close the tab so state matches reality.
			if (!cdp || cdp.transport !== 'websocket') return;
			const tab = cdp.getTab('tab-main');
			if (tab?.sessionId === session.id) {
				cdp.closeTab('tab-main').catch(err => {
					log.appendLine(`[Bridge] Close on debug terminate failed: ${err}`);
				});
			}
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			// Re-apply or clear indicators immediately. Without this, switching
			// the setting off would leave every already-marked page carrying a
			// modified title until it happened to be reopened.
			if (event.affectsConfiguration('integratedBrowserMcp.tabIndicator')
				|| event.affectsConfiguration('integratedBrowserMcp.tabIndicatorMarker')) {
				cdp?.refreshIndicators().catch(err => log.appendLine(`[Bridge] Indicator refresh failed: ${err}`));
			}
			// Turning access off takes effect on its own — enforcement runs before
			// every call. Turning it ON needed a window reload: the tabs were
			// already revoked and disposed, and nothing re-adopts them. Adopt the
			// window's tabs again so the setting is symmetric.
			if (event.affectsConfiguration('integratedBrowserMcp.allowAllExistingTabs')) {
				adoptOpenBrowserTabs();
				adoptExistingDebugSession();
			}
		}),
	);

	// Contribute the buffer tools VS Code's own browser toolset lacks. Done at
	// activation (not per-start) so they exist regardless of bridge state; each
	// reports cleanly when the bridge is stopped.
	registerLanguageModelTools(context, () => cdp, log);

	// Offer the bundled MCP server to VS Code-hosted MCP clients. Registered at
	// activation per the API contract (contributes.mcpServerDefinitionProviders +
	// this call), and once for the extension lifetime so stop/start can't
	// double-register the same id.
	registerMcpProvider(context);

	if (migratedGet('autoStart', true)) {
		startBridge(context);
	}
}

/**
 * Where the bridge's control socket lives. A unix socket on POSIX, a named
 * pipe on Windows. Keyed by workspace so multiple VS Code windows coexist
 * without the port-scanning dance TCP required.
 */
function socketPathFor(id: string): string {
	if (process.platform === 'win32') {
		// Named pipes are not filesystem objects; the namespace is not
		// world-writable and there is no directory to protect.
		return `\\\\.\\pipe\\integrated-browser-mcp-${id}`;
	}
	// Deliberately not os.tmpdir(): it is world-writable with a predictable
	// name, so another local user could pre-create the path (denial of
	// service, or worse if they create it as a socket and accept on it).
	// SOCKETS_DIR is created 0700 before any bind, which also closes the
	// window between listen() and chmod where the socket sat at default
	// permissions.
	return path.join(SOCKETS_DIR, `${id}.sock`);
}

/** Create the socket directory owner-only before anything binds inside it. */
async function ensureSocketsDir(): Promise<void> {
	if (process.platform === 'win32') return;
	await fs.promises.mkdir(SOCKETS_DIR, { recursive: true, mode: 0o700 });
	// mkdir's mode is masked by umask, and the directory may predate this
	// version, so assert the mode rather than assume it.
	await fs.promises.chmod(SOCKETS_DIR, 0o700).catch(() => undefined);
}

/**
 * Prefer a socket/pipe (no listening port at all); fall back to TCP when it
 * cannot be created, or when the user pins `integratedBrowserMcp.transport` to tcp.
 * TCP is still needed when the MCP client cannot reach the extension host's
 * filesystem — though instance discovery already assumes it can.
 */
async function listenBest(
	server: BridgeServer,
	config: vscode.WorkspaceConfiguration,
	preferredPort: number,
): Promise<{ socketPath?: string; port?: number }> {
	const mode = config.get<string>('transport', 'auto');
	if (mode !== 'tcp') {
		try {
			await ensureSocketsDir();
			const socketPath = await server.startOnSocket(socketPathFor(instanceId(getWorkspacePath())));
			return { socketPath };
		} catch (err) {
			if (mode === 'socket') throw err;
			log.appendLine(`[Bridge] Socket transport unavailable (${err}); falling back to TCP`);
		}
	}
	return { port: await server.start(preferredPort) };
}

async function startBridge(context: vscode.ExtensionContext): Promise<void> {
	if (running) {
		vscode.window.showInformationMessage('Integrated Browser MCP is already running.');
		return;
	}

	const config = vscode.workspace.getConfiguration('integratedBrowserMcp');
	const preferredPort = migratedGet('httpPort', 3788);

	try {
		// 0. Publish the current MCP server first. A client (e.g. Claude Code)
		// starting alongside VS Code spawns whatever build is on disk at that
		// instant; syncing before the bridge comes up shrinks the window in
		// which it picks up the previous one — which matters now that the
		// transport can change between builds.
		await syncMcpServer(context);
		// The server file now exists; tell VS Code's MCP provider to re-resolve
		// (it was registered at activation, possibly before this sync).
		mcpDidChange?.fire();

		// 1. Clean up stale instance files from dead processes
		await cleanStaleInstances();

		// 2. CDP manager
		cdp = new CDPManager(log);
		cdp.onStateChange(state => statusBar.update(state, running, cdp.transport, summarizeTabs()));

		// 3. HTTP server (socket-first, TCP fallback)
		httpServer = new BridgeServer(cdp, log, getWorkspacePath());
		httpServer.setEnsureBrowser((url, clientId) => ensureBrowser(url, clientId));
		actualEndpoint = await listenBest(httpServer, config, preferredPort);
		running = true;
		statusBar.update(cdp.state, true, cdp.transport, summarizeTabs());

		// 4. Wire BrowserTab lifecycle events when the proposed API is available.
		//    Any failure here is downgraded to the fallback path rather than
		//    failing startup: the bridge is fully functional without the
		//    proposal (single tab, no worker events), so a proposal that is
		//    declared but not granted must not take the whole bridge down.
		let proposedApiWired = false;
		if (hasProposedBrowserApi()) {
			try {
				// Per-start subscriptions: each guards on `cdp` because stopBridge
				// nulls it, and a browser-tab event can still fire between the null
				// and dispose() completing. Tracked in startDisposables so stop
				// removes them (no leak, no post-stop TypeError).
				startDisposables.push(
					vscode.window.onDidOpenBrowserTab(tab => {
						if (!cdp) return;
						// Ignore tabs we're about to open ourselves; adoptBrowserTab is idempotent.
						cdp.adoptBrowserTab(tab).catch(err => {
							log.appendLine(`[Bridge] adoptBrowserTab failed: ${err}`);
						});
					}),
					vscode.window.onDidCloseBrowserTab(tab => {
						if (!cdp) return;
						cdp.untrackBrowserTab(tab);
						statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
					}),
					vscode.window.onDidChangeActiveBrowserTab(tab => {
						if (!cdp) return;
						cdp.syncActive(tab);
						statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
					}),
					// url/title/icon changes arrive as a push, so navigation
					// settling needs no polling and no extra CDP round-trip.
					vscode.window.onDidChangeBrowserTabState(tab => {
						if (!cdp) return;
						cdp.notifyBrowserTabState(tab);
						statusBar.update(cdp.state, running, cdp.transport, summarizeTabs());
					}),
				);
				// Adopt any tabs already open at startup.
				adoptOpenBrowserTabs();
				proposedApiWired = true;
			} catch (err) {
				log.appendLine(`[Bridge] Proposed browser API declared but not granted, falling back: ${err}`);
			}
		}

		if (!proposedApiWired) {
			// Fallback: if a browser debug session is already active, adopt it.
			const existingSession = vscode.debug.activeDebugSession && isBrowserSession(vscode.debug.activeDebugSession)
				? vscode.debug.activeDebugSession
				: undefined;
			if (existingSession) {
				await cdp.adoptDebugSession(existingSession, false);
			}
			// Otherwise, browser will be launched lazily on first request.
		}

		// 5. Register this instance for MCP discovery
		await registerInstance(actualEndpoint);
		// The endpoint is known now; re-resolve so the VS Code MCP definition
		// carries the pin instead of the empty env it was registered with.
		mcpDidChange?.fire();

		// 6. Configure Claude (server already synced above). The VS Code MCP
		//    provider is registered once at activation, not here.
		await configureClaude();

		log.appendLine(`[Bridge] Started successfully on ${actualEndpoint.socketPath ?? `port ${actualEndpoint.port}`}`);
	} catch (err) {
		log.appendLine(`[Bridge] Failed to start: ${err}`);
		vscode.window.showErrorMessage(`Integrated Browser MCP failed to start: ${err}`);
		await stopBridge();
	}
}

/**
 * Ensure at least one tab exists and is connected. Called by `/navigate` and
 * other interaction endpoints on first use. When `url` is provided and the
 * proposed API is available, open the tab directly to that URL to avoid an
 * about:blank flash.
 */
async function ensureBrowser(url?: string, clientId?: string): Promise<void> {
	if (cdp?.state === 'connected') return;
	if (browserLaunching || cdp?.state === 'connecting') {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				disposable.dispose();
				reject(new Error('Timed out waiting for browser connection'));
			}, 45000);
			const disposable = cdp.onStateChange(state => {
				if (state === 'connected') {
					clearTimeout(timeout);
					disposable.dispose();
					resolve();
				} else if (state === 'disconnected' && !browserLaunching && cdp.tabCount === 0) {
					// Only fail when there's nothing attached at all. Tabs in
					// mid-adoption can transiently emit 'disconnected' during
					// bootstrap — those aren't hard failures, they'll flip to
					// 'connected' once enableDomains finishes. Falling through
					// to the outer timeout is safer than rejecting eagerly.
					clearTimeout(timeout);
					disposable.dispose();
					reject(new Error('Browser connection failed'));
				}
			});
			if (cdp?.state === 'connected') {
				clearTimeout(timeout);
				disposable.dispose();
				resolve();
			}
		});
		return;
	}
	browserLaunching = true;
	try {
		await launchBrowser(url, clientId);
	} finally {
		browserLaunching = false;
	}
}

function summarizeTabs(): { count: number; activeUrl?: string } {
	const active = cdp?.activeTabId ? cdp.getTab(cdp.activeTabId) : undefined;
	return { count: cdp?.tabCount ?? 0, activeUrl: active?.url };
}

async function stopBridge(): Promise<void> {
	running = false;
	actualEndpoint = {};
	// Drop the endpoint pin from the MCP definition; the next start fires again.
	mcpDidChange?.fire();
	// Dispose per-start subscriptions first: they deref `cdp`, so they must stop
	// firing before it is torn down and nulled.
	for (const d of startDisposables) {
		try { d.dispose(); } catch { /* already disposed */ }
	}
	startDisposables = [];
	// Stop accepting requests before tearing down CDP, so no request runs against
	// a half-disposed manager. Guard each await so a failure in one step can't
	// leave the other resource un-torn-down (and cdp non-null).
	try { await httpServer?.stop(); } catch (err) { log?.appendLine(`[Bridge] httpServer.stop failed: ${err}`); }
	try { await cdp?.dispose(); } catch (err) { log?.appendLine(`[Bridge] cdp.dispose failed: ${err}`); }
	// Null it out: the contributed LM tools hold a getter for this and would
	// otherwise keep reading a disposed CDPManager after a stop.
	cdp = undefined as unknown as CDPManager;
	await unregisterInstance().catch(() => undefined);
	statusBar?.update('disconnected', false, null, { count: 0 });
	log?.appendLine('[Bridge] Stopped');
}

async function launchBrowserViaProposedApi(clientId?: string): Promise<boolean> {
	try {
		log.appendLine('[Bridge] Launching via proposed browser API (openBrowserTab: about:blank)');
		// Always open about:blank; the caller (e.g. /navigate handler) does the
		// real navigation once the tab is connected. The lazily-launching
		// client owns the result, same as any other tab it opens.
		await cdp.openTab('about:blank', true, false, clientId);
		return true;
	} catch (err) {
		log.appendLine(`[Bridge] Proposed API launch failed: ${err}`);
		return false;
	}
}

async function launchBrowser(_lazyUrl?: string, clientId?: string): Promise<void> {
	// The URL hint is currently unused for the proposed-API path (we always
	// open about:blank and let the caller navigate). The debug-session path
	// bakes it into the launch config so the very first page load is the
	// target — one fewer navigation round-trip.
	const initialUrl = _lazyUrl ?? 'about:blank';

	// Prefer VS Code's proposed `browser` API when available — it bypasses
	// vscode-js-debug entirely, eliminating the event-forwarding limitations
	// that prevent worker/service-worker events from reaching us.
	if (hasProposedBrowserApi()) {
		const ok = await launchBrowserViaProposedApi(clientId);
		if (ok) return;
		log.appendLine('[Bridge] Falling back to debug-session launch');
	}

	// Fallback: launch an editor-browser debug session and bridge via requestCDPProxy.
	// vscode-js-debug creates a root session (the launcher) and a child session
	// for each page target. requestCDPProxy only works on the child session
	// which has the actual CDP connection.
	let disposed = false;
	let timeout: ReturnType<typeof setTimeout>;
	let disposable: vscode.Disposable;

	const childPromise = new Promise<vscode.DebugSession | null>((resolve) => {
		timeout = setTimeout(() => {
			disposable.dispose();
			log.appendLine('[Bridge] Timed out waiting for child browser session');
			resolve(null);
		}, 15000);
		disposable = vscode.debug.onDidStartDebugSession(session => {
			if (isBrowserSession(session) && session.parentSession) {
				log.appendLine(`[Bridge] Child session started: ${session.name} (parent: ${session.parentSession.name})`);
				disposed = true;
				clearTimeout(timeout);
				disposable.dispose();
				resolve(session);
			}
		});
	});

	const browserType = migratedGet('browserType', 'editor-browser');

	const launched = await vscode.debug.startDebugging(undefined, {
		type: browserType,
		request: 'launch',
		name: 'Integrated Browser MCP',
		url: initialUrl,
		internalConsoleOptions: 'neverOpen',
	}, {
		noDebug: true,
		suppressDebugToolbar: true,
		suppressDebugView: true,
		suppressDebugStatusbar: true,
	} as vscode.DebugSessionOptions);
	if (!launched) {
		if (!disposed) {
			clearTimeout(timeout!);
			disposable!.dispose();
		}
		log.appendLine('[Bridge] Failed to launch browser session');
		return;
	}

	const session = await childPromise;
	if (!session) {
		log.appendLine('[Bridge] No child browser session started');
		return;
	}

	try {
		await cdp.adoptDebugSession(session, true, clientId);
	} catch (err) {
		log.appendLine(`[Bridge] CDP connect error: ${err}`);
	}
}

/**
 * Publish the bundled MCP server through VS Code's own registry.
 *
 * Complements — does not replace — the `~/.claude.json` write, which the
 * Claude Code CLI still needs. Clients hosted inside VS Code can discover the
 * bridge from here instead, so we reach into fewer files we do not own.
 * Feature-detected: the API is stable in 1.101+ but this extension supports
 * older builds.
 */
/**
 * The endpoint pin handed to a VS Code-hosted MCP client. Empty while the bridge
 * is stopped — the server then discovers as before, which is the best it can do.
 */
function endpointEnv(): Record<string, string> {
	if (actualEndpoint.socketPath) return { BROWSER_BRIDGE_SOCKET: actualEndpoint.socketPath };
	if (actualEndpoint.port) return { BROWSER_BRIDGE_PORT: String(actualEndpoint.port) };
	return {};
}

function registerMcpProvider(context: vscode.ExtensionContext): void {
	const lm = vscode.lm as unknown as { registerMcpServerDefinitionProvider?: unknown };
	if (typeof lm.registerMcpServerDefinitionProvider !== 'function') return;
	try {
		// Registered at activation, but STABLE_SERVER is written by syncMcpServer
		// during startBridge (which may run later, or not at all with
		// autoStart:false). Fire this after the sync so VS Code re-resolves the
		// definition once the server file actually exists, instead of caching a
		// missing path.
		mcpDidChange = new vscode.EventEmitter<void>();
		// Requires the matching contributes.mcpServerDefinitionProviders entry in
		// package.json (id 'integratedBrowserMcp'); without it this call throws.
		context.subscriptions.push(
			mcpDidChange,
			vscode.lm.registerMcpServerDefinitionProvider('integratedBrowserMcp', {
				onDidChangeMcpServerDefinitions: mcpDidChange.event,
				provideMcpServerDefinitions: () => [
					// Pin the server to *this* window's bridge. Without the env it
					// falls back to discovery, which matches on cwd — and the
					// extension host's cwd is not the workspace, so the match fails
					// and the newest instance wins. With several windows open that
					// silently drives another window's browser, and scopes download
					// paths against that window's workspace.
					new vscode.McpStdioServerDefinition('Integrated Browser', 'node', [STABLE_SERVER], endpointEnv()),
				],
			}),
		);
		log.appendLine('[MCP] Registered server definition with VS Code');
	} catch (err) {
		log.appendLine(`[MCP] Server definition provider unavailable: ${err}`);
	}
}

async function cleanStaleInstances(): Promise<void> {
	// Socket paths still referenced by a LIVE instance file — never sweep these.
	const liveSockets = new Set<string>();
	try {
		await fs.promises.mkdir(INSTANCES_DIR, { recursive: true });
		const files = await fs.promises.readdir(INSTANCES_DIR);
		for (const file of files) {
			if (!file.endsWith('.json')) continue;
			const filePath = path.join(INSTANCES_DIR, file);
			try {
				const data = JSON.parse(await fs.promises.readFile(filePath, 'utf-8'));
				let alive = true;
				try { process.kill(data.pid, 0); } catch { alive = false; } // signal 0 = existence check
				if (alive) {
					if (typeof data.socketPath === 'string') liveSockets.add(data.socketPath);
				} else {
					// Process is dead: remove the file and its socket.
					await fs.promises.unlink(filePath).catch(() => undefined);
					if (typeof data.socketPath === 'string') await fs.promises.unlink(data.socketPath).catch(() => undefined);
					log.appendLine(`[Bridge] Cleaned stale instance: ${file}`);
				}
			} catch {
				await fs.promises.unlink(filePath).catch(() => undefined); // corrupt file
			}
		}
	} catch {
		// Instances dir doesn't exist yet
	}

	// Sweep orphan sockets: a crashed process (Node only unlinks on graceful
	// close) or a clobbered instance file can leave a `.sock` with no live owner.
	// Probe before unlinking so a just-bound socket whose instance file isn't
	// written yet (startup race with another window) is left alone.
	if (process.platform === 'win32') return;
	try {
		const socks = await fs.promises.readdir(SOCKETS_DIR);
		for (const s of socks) {
			if (!s.endsWith('.sock')) continue;
			const p = path.join(SOCKETS_DIR, s);
			if (liveSockets.has(p) || await socketIsLive(p)) continue;
			await fs.promises.unlink(p).catch(() => undefined);
			log.appendLine(`[Bridge] Cleaned orphan socket: ${s}`);
		}
	} catch {
		// Sockets dir doesn't exist yet
	}
}

async function registerInstance(endpoint: { socketPath?: string; port?: number }): Promise<void> {
	const workspace = getWorkspacePath();
	const id = instanceId(workspace);
	const data = {
		...endpoint,
		workspace,
		pid: process.pid,
		startedAt: new Date().toISOString(),
	};
	try {
		await fs.promises.mkdir(INSTANCES_DIR, { recursive: true });
		instanceFile = path.join(INSTANCES_DIR, `${id}.json`);
		await fs.promises.writeFile(instanceFile, JSON.stringify(data, null, 2));
		log.appendLine(`[Bridge] Registered instance: ${instanceFile}`);
	} catch (err) {
		log.appendLine(`[Bridge] Failed to register instance: ${err}`);
	}
}

async function unregisterInstance(): Promise<void> {
	if (instanceFile) {
		try {
			await fs.promises.unlink(instanceFile);
		} catch {
			// Already gone
		}
		instanceFile = null;
	}
}

async function syncMcpServer(context: vscode.ExtensionContext): Promise<void> {
	const bundled = path.join(context.extensionPath, 'dist', 'mcp-server.mjs');
	try {
		await fs.promises.mkdir(STABLE_DIR, { recursive: true });
		await fs.promises.copyFile(bundled, STABLE_SERVER);
		log.appendLine(`[MCP] Synced server to ${STABLE_SERVER}`);
	} catch (err) {
		log.appendLine(`[MCP] Failed to sync server: ${err}`);
	}
}

async function configureClaude(): Promise<void> {
	const claudeSettingsPath = path.join(os.homedir(), '.claude.json');
	try {
		let config: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(claudeSettingsPath, 'utf-8');
			config = JSON.parse(raw);
		} catch {
			// File doesn't exist yet
		}

		const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;

		const desired = { command: 'node', args: [STABLE_SERVER] };
		const existing = mcpServers[MCP_KEY] as { command?: string; args?: string[]; env?: unknown } | undefined;
		if (existing?.command === desired.command
			&& existing?.args?.[0] === desired.args[0]
			&& existing?.args?.length === 1
			&& !existing.env) {
			log.appendLine('[MCP] Claude already configured');
			return;
		}

		mcpServers[MCP_KEY] = desired;
		config.mcpServers = mcpServers;

		// Atomic write: stage to a tmp file in the same directory, then
		// rename on top. If two VS Code windows boot simultaneously they can
		// both read-modify-write ~/.claude.json and the later one would
		// clobber the earlier one's changes. Rename is atomic on POSIX, so
		// the worst outcome is that one window's write is superseded — no
		// half-written file, no lost unrelated keys (both writes compute
		// from the same on-disk state and both add the same MCP entry).
		const tmpPath = `${claudeSettingsPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.promises.writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n');
		await fs.promises.rename(tmpPath, claudeSettingsPath);
		log.appendLine(`[MCP] Configured Claude MCP in ${claudeSettingsPath}`);
	} catch (err) {
		log.appendLine(`[MCP] Failed to configure Claude: ${err}`);
	}
}

/**
 * Explorer/editor context menu command: open the clicked resource in the
 * integrated browser. Uses the proposed-API `openTab` path when available
 * (keeps any existing tab open) and falls back to navigating the active
 * tab on the debug-session path.
 */
async function openInBrowser(uri?: vscode.Uri): Promise<void> {
	if (!uri) {
		const active = vscode.window.activeTextEditor?.document.uri;
		if (!active) {
			vscode.window.showErrorMessage('Open in Integrated Browser: no file selected.');
			return;
		}
		uri = active;
	}
	const url = uri.toString();
	if (!cdp) {
		vscode.window.showErrorMessage('Integrated Browser MCP is not active in this window. Run "Integrated Browser MCP: Start" from the Command Palette.');
		return;
	}
	try {
		if (hasProposedBrowserApi()) {
			await cdp.openTab(url, true);
			return;
		}
		// Fallback path: lazy-launch if needed, then navigate active tab.
		await ensureBrowser(url);
		const tab = cdp.getTab();
		if (!tab) {
			vscode.window.showErrorMessage('No active browser tab to navigate.');
			return;
		}
		await tab.send('Page.navigate', { url });
	} catch (err) {
		vscode.window.showErrorMessage(`Open in Integrated Browser failed: ${err instanceof Error ? err.message : err}`);
	}
}

function showStatus(): void {
	const cdpState = cdp?.state ?? 'disconnected';
	const transport = cdp?.transport ?? 'none';
	const serverState = running ? 'running' : 'stopped';
	const endpoint = actualEndpoint.socketPath ?? actualEndpoint.port ?? 'none';
	const tabs = cdp?.tabCount ?? 0;

	vscode.window.showInformationMessage(
		`Integrated Browser MCP: CDP ${cdpState} (${transport}), API on ${endpoint} (${serverState}), ${tabs} tab(s)`,
	);
}

export function deactivate() {
	return stopBridge();
}
