import * as vscode from 'vscode';
import WebSocket from 'ws';

export type CDPState = 'disconnected' | 'connecting' | 'connected';

export interface ConsoleEntry {
	type: string;
	text: string;
	timestamp: number;
	/** Target type for entries originating in a child session (worker, iframe, service_worker). Absent for top-level page logs. */
	target?: string;
	/** Set by CDPManager when aggregating across tabs. */
	tabId?: string;
}

export interface NetworkEntry {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	statusText?: string;
	type?: string;
	timestamp: number;
	responseTimestamp?: number;
	/** Target type for entries originating in a child session (worker, iframe, service_worker). Absent for top-level requests. */
	target?: string;
	/** Set by CDPManager when aggregating across tabs. */
	tabId?: string;
}

/**
 * `Browser.setDownloadBehavior` modes.
 *
 *  - `allow`        — save to `downloadPath` using the server-suggested
 *                     filename. Chromium silently appends ` (N)` on
 *                     collision; the suffix is NOT observable from CDP.
 *  - `allowAndName` — save under the GUID instead of the suggested
 *                     filename. Pair with the events from `browser_downloads`
 *                     when the agent needs deterministic file naming.
 *  - `deny`         — block the download silently.
 *  - `default`      — restore the native "ask where to save" dialog.
 */
export type DownloadBehavior = 'allow' | 'allowAndName' | 'deny' | 'default';

/**
 * One entry in the download buffer. Built from `Browser.downloadWillBegin`
 * (creation) + `Browser.downloadProgress` (updates). Events only flow while
 * a `setDownloadBehavior` with `eventsEnabled: true` is active.
 */
export interface DownloadEntry {
	guid: string;
	url: string;
	suggestedFilename: string;
	state: 'inProgress' | 'completed' | 'canceled';
	totalBytes?: number;
	receivedBytes?: number;
	/**
	 * The download path the bridge configured at `downloadWillBegin` time.
	 * Helps the agent locate the file: with `behavior: "allow"` the file is
	 * at `<downloadPath>/<suggestedFilename>` (modulo collision suffix).
	 */
	downloadPath?: string;
	startedAt: number;
	updatedAt: number;
	/** Set by CDPManager when aggregating across tabs. */
	tabId?: string;
}

interface ChildTargetInfo {
	type: string;
	url: string;
	targetId: string;
}

const CONSOLE_BUFFER_SIZE = 200;
const NETWORK_BUFFER_SIZE = 200;
const DOWNLOAD_BUFFER_SIZE = 50;

/**
 * One browser tab's worth of CDP connection + buffers.
 *
 * Supports two transports, set by whichever `connectTo*` method is called:
 *  - `connectToSession(debugSession)` — uses `requestCDPProxy` → WebSocket (the debug-session fallback path; works on any VS Code 1.112+)
 *  - `connectToBrowserTab(tab)` — uses the proposed `browser` API's `BrowserTab.startCDPSession()` (requires `--enable-proposed-api`)
 */
/**
 * Recover the page's real title from VS Code's browser editor label.
 *
 * `BrowserTab.title` is not `document.title` — VS Code composes the editor
 * label as `"<document.title> (<origin>/)"`, so reporting it verbatim gave
 * callers `"Google (https://www.google.com/)"` for a page actually titled
 * `"Google"`. Only strips when the parenthesised part is exactly this page's
 * composed origin, so a page legitimately titled `"Careers (https://x/jobs)"`
 * (a real path) or `"Report (file:///b.html)"` survives intact — an origin-only
 * match stripped those, and treated every opaque-origin URL as equal.
 */
export function stripComposedLabel(label: string, url: string): string {
	const match = label.match(/^(.+?)\s+\(([a-z][a-z0-9+.-]*:\/\/[^()]*|about:blank)\)$/i);
	if (!match) return label;
	const [, title, suffix] = match;
	if (!url) return label;
	try {
		const page = new URL(url);
		const suf = new URL(suffix);
		// Strip only when the parenthetical is this page's origin ROOT (no
		// meaningful path/query/fragment). Compare parsed origins so a
		// non-normalized composition (explicit default port, uppercase host)
		// still matches, but a real path like "(https://x/jobs)" does not.
		if (suf.origin === page.origin && (suf.pathname === '/' || suf.pathname === '') && !suf.search && !suf.hash) return title;
		// Exact echo (about:blank and other opaque cases the origin test can't compare).
		if (suffix === url) return title;
	} catch {
		// Unparseable — keep the label rather than guess.
	}
	return label;
}

export class CDPTab {
	readonly tabId: string;

	/** Display number assigned by the manager (1..N). Shown as prefix in the tab title. */
	displayNumber: number | null = null;

	private ws: WebSocket | null = null;
	private _browserTabSession: vscode.BrowserCDPSession | null = null;
	private _browserTab: vscode.BrowserTab | null = null;
	private browserTabDisposables: vscode.Disposable[] = [];
	private requestId = 0;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private static readonly MAX_RECONNECT_ATTEMPTS = 5;
	private static readonly BASE_RECONNECT_DELAY = 1000;
	private _state: CDPState = 'disconnected';
	private _onStateChange = new vscode.EventEmitter<CDPState>();
	readonly onStateChange = this._onStateChange.event;

	private _onGaveUp = new vscode.EventEmitter<void>();
	/**
	 * Fires when reconnection is abandoned. The manager must prune the tab: the
	 * give-up clears the session identity every other cleanup path matches on
	 * (the debug-terminate listener keys on `sessionId`), so a tab left in the
	 * map here is never removed — `tabCount` stays above zero, the lazy relaunch
	 * never fires, and every call answers "CDP not connected" until a restart.
	 */
	readonly onGaveUp = this._onGaveUp.event;

	private _sessionId: string | null = null;
	private _session: vscode.DebugSession | null = null;
	private _transport: 'websocket' | 'browserTab' | null = null;

	/**
	 * CDP session ID for the primary page target. The browser CDP proxy
	 * requires explicit `Target.attachToTarget` before page-scoped commands
	 * and events work. All page-scoped `send()` calls are routed here unless
	 * an explicit `sessionId` override is passed.
	 */
	private _pageSessionId: string | null = null;

	/** CDP target id of this tab's page (for matching a child tab's openerId). */
	private _pageTargetId: string | null = null;

	/** CDP target id of the target that opened this tab, captured at attach. */
	private _openerId: string | null = null;

	/** CDP session ID for the browser-level handshake session. */
	private _browserSessionId: string | null = null;

	private consoleBuffer: ConsoleEntry[] = [];
	private networkBuffer: NetworkEntry[] = [];
	private networkMap = new Map<string, NetworkEntry>();
	private downloadBuffer: DownloadEntry[] = [];
	private downloadMap = new Map<string, DownloadEntry>();
	/** Last download path configured via setDownloadBehavior (allow/allowAndName). Stamped onto DownloadEntry.downloadPath on downloadWillBegin so the agent can locate completed files. */
	private currentDownloadPath: string | null = null;
	private childSessions = new Map<string, ChildTargetInfo>();
	private eventCounts = new Map<string, number>();

	private log: vscode.OutputChannel;
	private disposed = false;

	constructor(tabId: string, log: vscode.OutputChannel) {
		this.tabId = tabId;
		this.log = log;
	}

	get state(): CDPState {
		return this._state;
	}

	/** The VS Code debug session this tab is bridged to, if on the websocket path. */
	get sessionId(): string | null {
		return this._sessionId;
	}

	/**
	 * The debug session backing this tab on the websocket fallback path, or
	 * null on the BrowserTab path. Closing a fallback tab means terminating
	 * this session — disconnecting CDP alone leaves the browser editor open.
	 */
	get debugSession(): vscode.DebugSession | null {
		return this._session;
	}

	/**
	 * The tab's favicon as a plain string so it survives the HTTP/MCP boundary.
	 * `IconPath` is a union (Uri | {light,dark} | ThemeIcon), hence the probing.
	 * Useful when several tabs share a title.
	 */
	get iconUri(): string | undefined {
		const icon = this._browserTab?.icon as unknown;
		if (!icon) return undefined;
		if (typeof icon === 'string') return icon;
		if (typeof icon !== 'object') return undefined;
		const candidate = icon as { id?: string; dark?: { toString(): string }; toString(): string };
		if (typeof candidate.id === 'string') return candidate.id;
		if (candidate.dark) return candidate.dark.toString();
		return candidate.toString();
	}

	/** The underlying BrowserTab, if on the proposed API path. */
	get browserTab(): vscode.BrowserTab | null {
		return this._browserTab;
	}

	/** Tab's current URL (from the BrowserTab proposal when available, else last known from navigation). */
	get url(): string {
		return this._browserTab?.url ?? this._lastKnownUrl ?? '';
	}

	/**
	 * Tab's current title.
	 *
	 * Prefers `BrowserTab.title`, except while VS Code is still seeding it with
	 * the page URL (which it does until the document supplies a real title). In
	 * that window the `document.title` read by {@link refreshTitle} is the
	 * accurate one — otherwise callers report a page's title as its URL.
	 */
	get title(): string {
		const fromTab = this._browserTab?.title;
		if (fromTab) {
			const cleaned = stripComposedLabel(fromTab, this.url);
			if (cleaned && cleaned !== 'about:blank') return cleaned;
		}
		return this._lastKnownTitle || fromTab || '';
	}

	/** Fires when VS Code reports a url/title/icon change for this tab. */
	private _onTabStateChange = new vscode.EventEmitter<void>();

	private _lastKnownUrl = '';
	private _lastKnownTitle = '';

	/**
	 * True when the bridge itself opened this tab (vs. adopting one the user
	 * already had). Governs **access**: enforcement only revokes the user's own
	 * pages, never a tab the bridge created.
	 */
	bridgeOwned = false;

	/**
	 * True when an agent has worked in this tab. Governs the **number and
	 * marker**, which answer a different question than {@link bridgeOwned}
	 * does: not "who opened this" but "where has the agent been". Set the first
	 * time an agent acts on the tab and kept for the tab's lifetime.
	 *
	 * Deliberately not released when the user navigates the tab themselves.
	 * That was tried and reverted: the number is an *address* — the user says
	 * "reload browser 2" — so letting their own interaction dissolve it takes
	 * the label away exactly when it is being used. It also made a visible
	 * label depend on guessing who caused a navigation, which CDP does not
	 * report; the marker moved for reasons neither side could see.
	 */
	agentControlled = false;

	/**
	 * Read `document.title` out of the page and cache it.
	 *
	 * On the BrowserTab (proposed API) path the title arrives for free from
	 * `BrowserTab.title`. On the websocket / debug-session path nothing ever
	 * populates it, so `title` would report `''` forever and callers would
	 * describe a real page as untitled. Best-effort: failures leave the cached
	 * value untouched rather than clobbering it.
	 */
	/**
	 * Wait for post-navigation metadata to catch up before reporting it.
	 *
	 * `Page.navigate` resolves when the navigation is *committed*, not when the
	 * tab's observable state has caught up: `BrowserTab.url` can still read
	 * `about:blank` and `BrowserTab.title` can still be the raw URL. Callers
	 * that answered immediately therefore described the page wrongly, and
	 * `/tabs` and the live `document.title` could disagree. Bounded and
	 * best-effort — a page that genuinely stays on
	 * `about:blank` just costs the timeout.
	 */
	async settleNavigation(timeoutMs = 3000): Promise<void> {
		const deadline = Date.now() + timeoutMs;

		// BrowserTab path: VS Code pushes url/title/icon changes via
		// `onDidChangeBrowserTabState`, so wait on the event rather than
		// polling. No timer loop, no extra CDP round-trip, and the values are
		// exactly what VS Code itself believes.
		if (this._browserTab) {
			while (!this.metadataSettled() && Date.now() < deadline) {
				if (!await this.waitForTabStateChange(deadline - Date.now())) break;
			}
			return;
		}

		// Websocket/debug-session path has no such event, and `title` there is
		// only whatever refreshTitle last cached. Refresh *inside* the loop so
		// metadataSettled tests fresh values: otherwise a fresh tab (empty cached
		// title) never settles and burns the full timeout, and a re-navigated tab
		// settles immediately on the *previous* page's title.
		while (Date.now() < deadline) {
			await this.refreshTitle();
			if (this.metadataSettled()) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	}

	/** Both url and title look like real page values rather than placeholders. */
	private metadataSettled(): boolean {
		const url = this.url;
		const title = this.title;
		return !!url && url !== 'about:blank' && !!title && title !== 'about:blank' && !title.startsWith(url);
	}

	/** Resolves true on the next tab-state change, false on timeout. */
	private waitForTabStateChange(ms: number): Promise<boolean> {
		if (ms <= 0) return Promise.resolve(false);
		return new Promise(resolve => {
			const timer = setTimeout(() => { subscription.dispose(); resolve(false); }, ms);
			const subscription = this._onTabStateChange.event(() => {
				clearTimeout(timer);
				subscription.dispose();
				resolve(true);
			});
		});
	}

	/** Called when VS Code reports this tab's url/title/icon changed. */
	notifyBrowserTabStateChanged(): void {
		this._onTabStateChange.fire();
	}

	async refreshTitle(): Promise<string> {
		try {
			const result = await this.send('Runtime.evaluate', {
				expression: 'document.title',
				returnByValue: true,
			}) as { result?: { value?: unknown } };
			const value = result?.result?.value;
			if (typeof value === 'string') this._lastKnownTitle = value;
		} catch {
			// Page may be mid-navigation or the transport may be down; keep the cached title.
		}
		return this._lastKnownTitle;
	}

	/** Diagnostic: the CDP sessionId for the primary page target (or null). */
	get pageSessionId(): string | null {
		return this._pageSessionId;
	}

	/** CDP target id of this tab's page, for matching a child tab's openerId. */
	get pageTargetId(): string | null {
		return this._pageTargetId;
	}

	/**
	 * The CDP target id of the target that opened this tab (window.open, a
	 * link, or "open in new tab"), or undefined if none / unavailable. Used to
	 * inherit bridge-ownership from a bridge-owned opener. May be unpopulated on
	 * the BrowserTab transport — callers must tolerate undefined.
	 */
	async getOpenerId(): Promise<string | undefined> {
		// Prefer the value captured at attach; fall back to an explicit
		// browser-level getTargetInfo (a bare getTargetInfo with no targetId is
		// not honoured on some proxies).
		if (this._openerId) return this._openerId;
		if (!this._pageTargetId) return undefined;
		try {
			const r = await this.send('Target.getTargetInfo', { targetId: this._pageTargetId }, {
				sessionId: this._browserSessionId ?? null,
			}) as { targetInfo?: { openerId?: string } };
			return r?.targetInfo?.openerId || undefined;
		} catch {
			return undefined;
		}
	}

	/** Diagnostic: list of tracked child sessions (workers/iframes). */
	get children(): Array<{ sessionId: string; type: string; url: string }> {
		return Array.from(this.childSessions.entries()).map(([sessionId, info]) => ({
			sessionId,
			type: info.type,
			url: info.url,
		}));
	}

	/** Diagnostic: CDP event method → count. */
	get events(): Record<string, number> {
		return Object.fromEntries(this.eventCounts);
	}

	/** Diagnostic: which transport is active. */
	get transport(): 'websocket' | 'browserTab' | null {
		return this._transport;
	}

	get console(): ConsoleEntry[] {
		return this.consoleBuffer;
	}

	get network(): NetworkEntry[] {
		return this.networkBuffer;
	}

	clearNetwork(): void {
		this.networkBuffer = [];
		this.networkMap.clear();
	}

	get downloads(): DownloadEntry[] {
		return this.downloadBuffer;
	}

	private setState(state: CDPState): void {
		this._state = state;
		// Guard: fire() on a disposed emitter throws. `dispose()` sets
		// `disposed = true` before triggering the final disconnect chain, so
		// any setState calls from that chain become no-ops instead of
		// blowing up.
		if (!this.disposed) this._onStateChange.fire(state);
	}

	async connectToSession(session: vscode.DebugSession): Promise<void> {
		this.log.appendLine(`[CDP:${this.tabId}] connectToSession called (session: ${session.name}, id: ${session.id})`);
		this._session = session;
		this._sessionId = session.id;
		this._transport = 'websocket';
		this.setState('connecting');

		try {
			const proxy = await this.requestCDPProxy(session);
			const wsUrl = `ws://${proxy.host}:${proxy.port}${proxy.path ?? ''}`;
			this.log.appendLine(`[CDP:${this.tabId}] Connecting WebSocket to ${wsUrl}`);
			await this.connectWebSocket(wsUrl);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] Failed to connect: ${err}`);
			this.setState('disconnected');
			this.scheduleReconnect();
		}
	}

	/**
	 * Connect via VS Code's proposed `browser` API (BrowserTab.startCDPSession).
	 * This bypasses vscode-js-debug entirely, giving us direct access to the
	 * multiplexed CDP stream. Events from all sessions (worker, iframe,
	 * service_worker) flow without js-debug's sessionId-stripping subscribe
	 * filter. Requires `--enable-proposed-api=thimo.integrated-browser-mcp`
	 * when launching VS Code.
	 */
	async connectToBrowserTab(tab: vscode.BrowserTab): Promise<void> {
		this.log.appendLine(`[CDP:${this.tabId}] connectToBrowserTab called (url: ${tab.url})`);
		this._browserTab = tab;
		this._transport = 'browserTab';
		this.setState('connecting');

		try {
			const session = await tab.startCDPSession();
			this._browserTabSession = session;
			this.browserTabDisposables.push(
				session.onDidReceiveMessage((msg: unknown) => {
					this.handleMessage(msg as Record<string, unknown>);
				}),
				session.onDidClose(() => {
					this.log.appendLine(`[CDP:${this.tabId}] BrowserCDPSession closed`);
					this._browserTabSession = null;
					this.pending.forEach(p => p.reject(new Error('Session closed')));
					this.pending.clear();
					if (!this.disposed) this.setState('disconnected');
				}),
			);
			this.log.appendLine(`[CDP:${this.tabId}] BrowserCDPSession ready`);
			await this.establishPageSession();
			await this.enableDomains();
			// Flip to 'connected' only after the page session is attached and
			// domains are enabled. Otherwise callers that fire send() the moment
			// state === 'connected' race with an in-flight bootstrap — their
			// commands default to sessionId: null (browser/root) instead of
			// _pageSessionId, silently hitting the wrong target.
			this.setState('connected');
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] connectToBrowserTab failed: ${err}`);
			this.setState('disconnected');
		}
	}

	private async requestCDPProxy(
		session: vscode.DebugSession,
	): Promise<{ host: string; port: number; path?: string }> {
		// Must be called on a CHILD debug session (the page target), not the
		// root launcher session. The root session has no CDP connection.
		this.log.appendLine(`[CDP:${this.tabId}] Requesting CDP proxy...`);
		const proxy = await Promise.race([
			session.customRequest('requestCDPProxy'),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('requestCDPProxy timed out after 30s')), 30000),
			),
		]) as { host: string; port: number; path?: string };
		this.log.appendLine(`[CDP:${this.tabId}] Got proxy: ${JSON.stringify(proxy)}`);
		return proxy;
	}

	private connectWebSocket(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			let settled = false;

			ws.on('open', async () => {
				this.ws = ws;
				this.reconnectAttempts = 0;
				this.log.appendLine(`[CDP:${this.tabId}] WebSocket connected`);
				settled = true;
				try {
					await this.subscribeToEvents();
					await this.establishPageSession();
					await this.enableDomains();
					// Flip to 'connected' only after bootstrap is complete (see
					// comment in connectToBrowserTab for why).
					this.setState('connected');
				} catch (err) {
					this.log.appendLine(`[CDP:${this.tabId}] Failed to enable domains: ${err}`);
					this.setState('disconnected');
				}
				resolve();
			});

			ws.on('message', (data) => {
				try {
					const msg = JSON.parse(data.toString());
					this.handleMessage(msg);
				} catch (err) {
					this.log.appendLine(`[CDP:${this.tabId}] Message parse error: ${err}`);
				}
			});

			ws.on('close', () => {
				this.log.appendLine(`[CDP:${this.tabId}] WebSocket closed`);
				this.ws = null;
				this.pending.forEach(p => p.reject(new Error('WebSocket closed')));
				this.pending.clear();
				if (!this.disposed) {
					this.setState('disconnected');
					// Reconnect on unexpected mid-session drops
					if (settled) {
						this.scheduleReconnect();
					}
				}
			});

			ws.on('error', (err) => {
				this.log.appendLine(`[CDP:${this.tabId}] WebSocket error: ${err.message}`);
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
		});
	}

	private handleMessage(msg: Record<string, unknown>): void {
		if (msg.id !== undefined) {
			const p = this.pending.get(msg.id as number);
			if (p) {
				this.pending.delete(msg.id as number);
				if (msg.error) {
					p.reject(new Error((msg.error as { message: string }).message));
				} else {
					p.resolve(msg.result);
				}
			}
		} else if (msg.method) {
			this.handleEvent(
				msg.method as string,
				(msg.params ?? {}) as Record<string, unknown>,
				msg.sessionId as string | undefined,
			);
		}
	}

	/**
	 * The prefix is re-applied per document instead of being registered with
	 * `Page.addScriptToEvaluateOnNewDocument`. Those registrations outlive the
	 * CDP session that created them: after an ungraceful shutdown (window
	 * reload, extension update, crash) the orphaned script kept re-marking
	 * every page the tab visited, and no later instance could remove it —
	 * `Page.removeScriptToEvaluateOnNewDocument` needs the identifier from the
	 * session that is gone. Evaluating per navigation costs a brief unprefixed
	 * title and leaves nothing behind when this instance dies.
	 */
	private reapplyTitlePrefix = (): void => {
		if (!this.currentTitlePrefix) return;
		const script = this.buildTitleScript(this.currentTitlePrefix, this.titleOwnerId);
		this.send('Runtime.evaluate', { expression: script }).catch(() => {
			// The context may not be ready yet; the next navigation event retries.
		});
	};

	/** Owner id to stamp into the injected script, kept for re-application. */
	private titleOwnerId: string | null = null;
	private currentTitlePrefix: string | null = null;

	/**
	 * Build the title-prefix script for a given prefix. Strips any previously-
	 * set prefix (either our own numbered-circles / fisheye / overflow emoji,
	 * or a stale one from an earlier install) and prepends the current one.
	 *
	 * The script is idempotent on re-install: subsequent runs disconnect the
	 * previous MutationObserver before installing a new one, and share the
	 * document.title setter interception via a one-time flag.
	 */
	/**
	 * Regex source matching any prefix we may have applied, so it can be
	 * stripped before a new one goes on.
	 *
	 * The historical markers are fixed, but the current marker is
	 * user-configurable — so switching from `● ` to `(1) ` has to remove a
	 * token this code cannot know statically. Callers pass whatever is on the
	 * title now; without it, changing modes leaves residue like `(1) ● Site`.
	 */
	private stripSource(extraToken?: string | null): string {
		// Strip control chars first (a newline in the token would break the regex
		// literal this is spliced into), then escape regex metacharacters —
		// including `/`, since the source is embedded in a `/.../u` literal.
		const token = (extraToken ?? '').trim().replace(/[\u0000-\u001f]/g, '');
		const extra = token ? '|' + token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') : '';
		// U+25CF (●) is deliberately NOT in this static set: it is the default
		// `tabIndicatorMarker` marker, handled dynamically via `extra`, and pages
		// legitimately titled "● …" (live/recording indicators) must keep it when
		// it is not the active marker. U+25C9 (◉) stays — a real historical bridge
		// marker (0.3.0), never page content.
		return `^(?:(?:\\(\\d+\\)|\\[\\d+\\]${extra}|[\\u{2460}-\\u{2473}\\u{2776}-\\u{277F}\\u{24EB}-\\u{24F4}\\u{25C9}]|\\u{1F92F}) )+`;
	}

	private buildTitleScript(prefix: string, ownerId: string | null): string {
		const prefixJson = JSON.stringify(prefix);
		const ownerJson = JSON.stringify(ownerId);
		// Known bridge markers across extension versions:
		//   - `(N) ` — current parenthesised decimal (0.4.0+)
		//   - `[N] ` — interim bracketed decimal (short-lived)
		//   - ①..⑳ (U+2460-2473) — outlined circled, pre-0.4.0 numbered
		//   - ❶..❿ (U+2776-277F) — negative circled 1-10 (interim)
		//   - ⓫..⓴ (U+24EB-24F4) — negative circled 11-20 (interim)
		//   - ◉ (U+25C9) — 0.3.0 fisheye
		//   - 🤯 (U+1F92F) — legacy overflow
		// The `+` after the alternation group makes the strip greedy:
		// `(1) ① ❷ Site` collapses to `Site` in one pass, preventing
		// oscillation with rival scripts left behind by older versions.
		const markerToken = prefix.replace(/\s+$/, '');
		const STRIP_RE = `/${this.stripSource(markerToken)}/u`;
		return `(function(){
			var P = ${prefixJson};
			var STRIP = ${STRIP_RE};
			var MY_OWNER = ${ownerJson};
			// Record our owner id for diagnostics; no longer used to gate
			// installation. A window reload would leave the previous
			// instance's id here, and respecting it would block the new
			// instance from re-installing — breaking the common case.
			if (MY_OWNER) window.__bridgeOwner = MY_OWNER;
			var updating = false;

			// Back-off against stale observers from older extension versions
			// (e.g. a 0.3.0 MutationObserver still alive in the page JS context
			// from before the extension was upgraded). Only count a rewrite as
			// a fight if our previous write was stripped of its prefix — that's
			// the signature of a rival observer undoing us. A plain SPA title
			// change (new base title) shouldn't trip the counter.
			var fightCount = 0;
			var gaveUp = false;
			var lastOurWrite = '';
			var FIGHT_THRESHOLD = 5;

			function ensurePrefix() {
				if (updating || gaveUp) return;
				var el = document.querySelector('title');
				if (!el) {
					// Don't fabricate a <title> on \`documentElement\` — the HTML
					// parser later adds the real one inside <head>, giving us
					// two titles, and \`document.title\` reads the head one, so
					// ours has no visible effect. Only fabricate if we're past
					// DOMContentLoaded AND <head> exists (pages without a
					// native <title>, like about:blank); otherwise wait — the
					// MutationObserver fires when the parser creates the real
					// title element.
					if (document.readyState === 'loading') return;
					if (!document.head) return;
					el = document.createElement('title');
					updating = true;
					document.head.appendChild(el);
					updating = false;
				}
				var current = el.textContent;
				var stripped = current.replace(STRIP, '');
				var want = P + stripped;
				if (current === want) return;

				// A "fight" is when we wrote X = P + S, and something else
				// changed it to exactly S (stripped our prefix). If the
				// current value is our last write stripped, it's a revert.
				// Any other change is a legitimate new title; reset the
				// counter so we don't accrue false positives over time.
				if (lastOurWrite && current === lastOurWrite.replace(STRIP, '')) {
					fightCount++;
				} else {
					fightCount = 0;
				}
				if (fightCount > FIGHT_THRESHOLD) {
					gaveUp = true;
					try { if (window.__bridgeTitleObserver) window.__bridgeTitleObserver.disconnect(); } catch (_) {}
					// Strip our own prefix one last time so the rival's marker
					// stands alone. Otherwise we leave a stacked "◉ (N) Title"
					// behind until the tab reloads.
					updating = true;
					el.textContent = stripped;
					updating = false;
					return;
				}

				updating = true;
				el.textContent = want;
				lastOurWrite = want;
				updating = false;
			}

			// Replace any previous observer installed by a prior prefix update.
			if (window.__bridgeTitleObserver) {
				try { window.__bridgeTitleObserver.disconnect(); } catch (_) {}
			}
			var observer = new MutationObserver(ensurePrefix);
			observer.observe(document, { childList: true, subtree: true, characterData: true });
			window.__bridgeTitleObserver = observer;

			// Intercept JS document.title setter once. Subsequent installs just
			// update the active prefix via the shared getter/setter.
			window.__bridgeTabPrefix = P;
			if (!window.__bridgeTitleIntercepted) {
				var og = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
				if (og) {
					Object.defineProperty(document, 'title', {
						get: function() { return og.get.call(this); },
						set: function(v) {
							var current = window.__bridgeTabPrefix || '';
							var s = String(v).replace(STRIP, '');
							og.set.call(this, current + s);
						},
						configurable: true,
					});
					window.__bridgeTitleIntercepted = true;
				}
			}

			ensurePrefix();
		})();`;
	}

	/**
	 * vscode-js-debug's CDP proxy only forwards events the client has
	 * subscribed to (via the synthetic `JsDebug.subscribe` domain). Without
	 * this, no Runtime/Network/Target events reach our WebSocket — only
	 * command responses. Supports `Domain.*` wildcards.
	 * @see vscode-js-debug/src/adapter/cdpProxy.ts
	 */
	private async subscribeToEvents(): Promise<void> {
		try {
			await this.send('JsDebug.subscribe', {
				events: ['Runtime.*', 'Network.*', 'Target.*', 'Page.*', 'Browser.*'],
			}, { sessionId: null });
			this.log.appendLine(`[CDP:${this.tabId}] Subscribed to events (Runtime, Network, Target, Page, Browser)`);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] JsDebug.subscribe failed (${err}); events may not flow`);
		}
	}

	/**
	 * In VS Code 1.117+, the browser CDP proxy requires an explicit attach
	 * to the browser target before Target queries return page targets, and
	 * page-scoped commands/events must carry the page session id. On older
	 * versions the proxy auto-routed commands, so we gracefully fall back to
	 * implicit routing if the handshake isn't supported.
	 */
	private async establishPageSession(): Promise<void> {
		let browserSessionId: string | undefined;
		try {
			const r = await this.send('Target.attachToBrowserTarget', undefined, {
				sessionId: null,
			}) as { sessionId?: string };
			browserSessionId = r.sessionId;
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] attachToBrowserTarget failed (${err}); falling back to implicit routing`);
			return;
		}
		if (!browserSessionId) {
			this.log.appendLine(`[CDP:${this.tabId}] attachToBrowserTarget returned no sessionId`);
			return;
		}
		this._browserSessionId = browserSessionId;
		// Scrub the browser session from childSessions in case its attachedToTarget
		// event raced ahead of this assignment.
		this.childSessions.delete(browserSessionId);

		try {
			const targetsResult = await this.send('Target.getTargets', undefined, {
				sessionId: browserSessionId,
			}) as { targetInfos?: Array<{ targetId: string; type: string; url?: string; openerId?: string }> };
			const pages = (targetsResult.targetInfos ?? []).filter(t => t.type === 'page');
			if (pages.length === 0) {
				this.log.appendLine(`[CDP:${this.tabId}] No page target found`);
				return;
			}
			// On the proposed API path, each BrowserCDPSession wraps ONE tab, so
			// the first page is this tab's page. On the websocket path (per-debug-
			// session), same story. Picking pages[0] is therefore always correct.
			const page = pages[0];
			this._pageTargetId = page.targetId;
			// Capture the opener at attach time — the target info carries it here,
			// which is more reliable than a later Target.getTargetInfo on some proxies.
			if (page.openerId) this._openerId = page.openerId;
			const attachResult = await this.send('Target.attachToTarget', {
				targetId: page.targetId,
				flatten: true,
			}, { sessionId: browserSessionId }) as { sessionId?: string };
			if (attachResult.sessionId) {
				this._pageSessionId = attachResult.sessionId;
				this._lastKnownUrl = page.url ?? '';
				// Same racing concern as the browser session above.
				this.childSessions.delete(attachResult.sessionId);
				this.log.appendLine(`[CDP:${this.tabId}] Attached to page session ${attachResult.sessionId} (${page.url ?? page.targetId})`);
			} else {
				this.log.appendLine(`[CDP:${this.tabId}] Target.attachToTarget returned no sessionId`);
			}
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] Page session bootstrap failed (${err})`);
		}
	}

	private async enableDomains(): Promise<void> {
		await Promise.all([
			this.send('Runtime.enable'),
			this.send('Page.enable'),
			this.send('Network.enable'),
			this.send('DOM.enable'),
			this.send('Accessibility.enable'),
		]);
		this.log.appendLine(`[CDP:${this.tabId}] Domains enabled`);
		await this.enableAutoAttach();
		// Title prefix is installed separately by CDPManager once the tab's
		// display number is known.
	}

	/**
	 * Enable the browser CDP proxy's auto-attach so worker/iframe targets
	 * registered by VS Code's browserViewGroup are attached automatically.
	 * Sent at browser/root level (sessionId: null) — that sets the proxy's
	 * internal `_autoAttach` flag. Per-session setAutoAttach wouldn't help
	 * because child sessions created via CDP auto-attach bypass the proxy's
	 * session map.
	 */
	private async enableAutoAttach(): Promise<void> {
		try {
			await this.send('Target.setAutoAttach', {
				autoAttach: true,
				waitForDebuggerOnStart: false,
				flatten: true,
			}, { sessionId: null });
			this.log.appendLine(`[CDP:${this.tabId}] Auto-attach enabled`);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] setAutoAttach not supported (${err}); child sessions will not be captured`);
		}
	}

	/**
	 * Install or update the tab-title prefix (e.g. "(1) "). Called by
	 * CDPManager on adopt and on renumber. Idempotent: skips CDP work if the
	 * prefix is already the requested one.
	 */
	async setTitlePrefix(prefix: string, ownerId?: string): Promise<void> {
		if (this.currentTitlePrefix === prefix) return;
		// Check transport before removing: removeTitlePrefix nulls currentTitlePrefix
		// even when it can't reach the page, which would desync the bridge (thinks
		// no prefix) from the page (still shows the old one).
		const hasTransport = (this.ws && this.ws.readyState === WebSocket.OPEN) || this._browserTabSession !== null;
		if (!hasTransport) return;
		// Remove the previous prefix first. The new script only knows how to
		// strip its own marker, so switching e.g. marker -> number would
		// otherwise leave the old one behind as `(1) ● Site`.
		if (this.currentTitlePrefix) await this.removeTitlePrefix();
		const script = this.buildTitleScript(prefix, ownerId ?? null);
		try {
			await this.send('Runtime.evaluate', { expression: script });
			// Record the successful prefix only after the CDP round-trip
			// succeeds. Otherwise a failed install would leave
			// `currentTitlePrefix` set, and the early-return guard above would
			// block the next retry. Setting it also arms `reapplyTitlePrefix`
			// for subsequent navigations.
			this.titleOwnerId = ownerId ?? null;
			this.currentTitlePrefix = prefix;
			this.log.appendLine(`[CDP:${this.tabId}] Title prefix set to "${prefix}"`);
		} catch (err) {
			this.log.appendLine(`[CDP:${this.tabId}] Failed to set title prefix: ${err}`);
		}
	}

	/** Remove any injected title prefix and restore the page's own title. */
	async removeTitlePrefix(): Promise<void> {
		// Nothing was ever installed on this tab (e.g. an adopted user page in a
		// bridge-owned-only setup): do not inject a strip script into a page we
		// never marked. Guards revoke/disconnect/refreshIndicators at once.
		if (!this.currentTitlePrefix) return;
		try {
			const hasTransport = (this.ws && this.ws.readyState === WebSocket.OPEN) || this._browserTabSession !== null;
			if (!hasTransport) return;
			// Best-effort: disconnect observer, strip our prefix, and uninstall the
			// document.title setter interception. Deleting the own-property accessor
			// exposes the native Document.prototype title again; leaving it in place
			// kept mangling titles the page set (with a stale STRIP after a marker
			// switch) for the life of the document.
			await this.send('Runtime.evaluate', {
				expression: `(function(){
					try { if (window.__bridgeTitleObserver) window.__bridgeTitleObserver.disconnect(); } catch (_) {}
					window.__bridgeTabPrefix = '';
					try { delete document.title; } catch (_) {}
					window.__bridgeTitleIntercepted = false;
					var el = document.querySelector('title');
					if (el) {
						el.textContent = el.textContent.replace(/${this.stripSource(this.currentTitlePrefix)}/u, '');
					}
				})();`,
			}, { timeoutMs: 2000 });
		} catch {
			// Best-effort cleanup
		} finally {
			this.currentTitlePrefix = null;
			this.titleOwnerId = null;
		}
	}

	private handleEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
		this.eventCounts.set(method, (this.eventCounts.get(method) ?? 0) + 1);
		switch (method) {
			case 'Runtime.consoleAPICalled':
				this.onConsole(params, sessionId);
				break;
			case 'Network.requestWillBeSent':
				this.onNetworkRequest(params, sessionId);
				break;
			case 'Network.responseReceived':
				this.onNetworkResponse(params);
				break;
			case 'Target.attachedToTarget':
				this.onTargetAttached(params);
				break;
			case 'Target.detachedFromTarget':
				this.onTargetDetached(params);
				break;
			case 'Page.frameNavigated': {
				const frame = params.frame as { url?: string; parentId?: string } | undefined;
				// Root frame only — subframes don't set our tab's URL.
				if (frame?.url && !frame.parentId) {
					this._lastKnownUrl = frame.url;
					// A new document has no prefix and no observer: put ours back.
					this.reapplyTitlePrefix();
				}
				break;
			}
			// Safety net for the frameNavigated race: if the execution context
			// was not ready yet, the evaluate above failed silently. The script
			// is idempotent (it disconnects any observer it already installed),
			// so running it twice on a settled document costs nothing.
			case 'Page.domContentEventFired':
				this.reapplyTitlePrefix();
				break;
			// Download events fire under `Page.*` on the BrowserTab
			// (proposed-API) transport and also surface as `Browser.*` on
			// some Chromium / proxy combinations. The CDP spec marks the
			// `Page.*` variants deprecated, but in practice they're the ones
			// that fire in the integrated browser today. Listen to both and
			// dedupe by guid in `onDownloadWillBegin` so a future Chromium
			// that emits both doesn't create duplicate buffer entries.
			case 'Browser.downloadWillBegin':
			case 'Page.downloadWillBegin':
				this.onDownloadWillBegin(params);
				break;
			case 'Browser.downloadProgress':
			case 'Page.downloadProgress':
				this.onDownloadProgress(params);
				break;
		}
	}

	private onDownloadWillBegin(params: Record<string, unknown>): void {
		const guid = params.guid as string | undefined;
		if (!guid) return;
		const entry: DownloadEntry = {
			guid,
			url: (params.url as string) ?? '',
			suggestedFilename: (params.suggestedFilename as string) ?? '',
			state: 'inProgress',
			startedAt: Date.now(),
			updatedAt: Date.now(),
		};
		if (this.currentDownloadPath) entry.downloadPath = this.currentDownloadPath;
		this.downloadMap.set(guid, entry);
		this.downloadBuffer.push(entry);
		if (this.downloadBuffer.length > DOWNLOAD_BUFFER_SIZE) {
			const removed = this.downloadBuffer.shift()!;
			this.downloadMap.delete(removed.guid);
		}
	}

	private onDownloadProgress(params: Record<string, unknown>): void {
		const guid = params.guid as string | undefined;
		if (!guid) return;
		const entry = this.downloadMap.get(guid);
		if (!entry) return;
		if (typeof params.totalBytes === 'number') entry.totalBytes = params.totalBytes;
		if (typeof params.receivedBytes === 'number') entry.receivedBytes = params.receivedBytes;
		const state = params.state as DownloadEntry['state'] | undefined;
		if (state) entry.state = state;
		entry.updatedAt = Date.now();
	}

	/**
	 * Configure download handling for this tab. With behavior `allow`
	 * (default) Chromium saves files to `downloadPath` using the server-
	 * suggested filename (collisions get a " (1)" suffix that's not
	 * observable from CDP). `allowAndName` saves under the GUID instead —
	 * pair with the events from `browser_downloads` if you need
	 * deterministic naming. `deny` blocks. `default` restores the native
	 * save dialog.
	 *
	 * Two CDP commands exist for this:
	 *  - `Page.setDownloadBehavior(behavior, downloadPath)` — deprecated
	 *    upstream but the only one that actually takes effect through VS
	 *    Code's BrowserTab session multiplexer (verified empirically: a
	 *    `Browser.setDownloadBehavior` at the browser session is silently
	 *    ignored, the native save dialog still appears). Page-scoped, so
	 *    each tab is configured independently.
	 *  - `Browser.setDownloadBehavior(behavior, downloadPath, browserContextId?, eventsEnabled?)`
	 *    — newer, browser-wide. Required for `allowAndName` (Page.* doesn't
	 *    support it). We send it as a best-effort second call so it
	 *    propagates wherever the proxy is willing to honor it; failure is
	 *    swallowed to keep behavior consistent on the integrated-browser
	 *    transport.
	 *
	 * Download events fire automatically at the Page domain — no separate
	 * `eventsEnabled` flag needed for `Page.setDownloadBehavior`.
	 */
	async setDownloadBehavior(downloadPath: string, behavior: DownloadBehavior = 'allow'): Promise<void> {
		if ((behavior === 'allow' || behavior === 'allowAndName') && !downloadPath) {
			throw new Error('downloadPath required for behavior ' + behavior);
		}
		const pageBehavior = behavior === 'allowAndName' ? 'allow' : behavior;
		const pageParams: Record<string, unknown> = { behavior: pageBehavior };
		if (pageBehavior === 'allow') pageParams.downloadPath = downloadPath;
		await this.send('Page.setDownloadBehavior', pageParams);

		// Best-effort browser-level call so `allowAndName` and any future
		// browser-context-scoped flags work where the proxy honors them.
		// Silently swallowed on the integrated-browser transport.
		const browserParams: Record<string, unknown> = { behavior, eventsEnabled: true };
		if (behavior === 'allow' || behavior === 'allowAndName') browserParams.downloadPath = downloadPath;
		await this.send('Browser.setDownloadBehavior', browserParams, {
			sessionId: this._browserSessionId ?? null,
		}).catch(() => { /* not supported on this transport */ });

		this.currentDownloadPath = (behavior === 'allow' || behavior === 'allowAndName') ? downloadPath : null;
	}

	private onTargetAttached(params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string | undefined;
		const targetInfo = params.targetInfo as { type: string; url: string; targetId: string } | undefined;
		if (!sessionId || !targetInfo) return;
		// Skip our own handshake sessions — they aren't children to tag.
		if (sessionId === this._pageSessionId || sessionId === this._browserSessionId) return;
		// VS Code 1.135+ (vscode PR #331085): root-level setAutoAttach also attaches
		// targets that already exist, so we get a second session on our own page.
		// Enabling domains on it would duplicate every console/network entry. Left
		// attached but idle — detaching is unsafe here because our own page
		// session's event can race ahead of the `_pageSessionId` assignment.
		if (this._pageTargetId && targetInfo.targetId === this._pageTargetId) return;
		this.childSessions.set(sessionId, {
			type: targetInfo.type,
			url: targetInfo.url,
			targetId: targetInfo.targetId,
		});
		this.log.appendLine(`[CDP:${this.tabId}] Child session attached: ${targetInfo.type} (${targetInfo.url || targetInfo.targetId})`);
		// Enable Runtime + Network on the child so its events flow through.
		// Browser-level targets can't enable Network; skip those.
		this.send('Runtime.enable', undefined, { sessionId }).catch(err => {
			this.log.appendLine(`[CDP:${this.tabId}] Runtime.enable failed for ${targetInfo.type}: ${err}`);
		});
		if (targetInfo.type !== 'browser') {
			this.send('Network.enable', undefined, { sessionId }).catch(err => {
				this.log.appendLine(`[CDP:${this.tabId}] Network.enable failed for ${targetInfo.type}: ${err}`);
			});
		}
	}

	private onTargetDetached(params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string | undefined;
		if (!sessionId) return;
		const info = this.childSessions.get(sessionId);
		if (info) {
			this.log.appendLine(`[CDP:${this.tabId}] Child session detached: ${info.type}`);
			this.childSessions.delete(sessionId);
		}
	}

	private onConsole(params: Record<string, unknown>, sessionId?: string): void {
		const args = params.args as Array<{ type: string; value?: unknown; description?: string }> | undefined;
		const text = args
			? args.map(a => a.value !== undefined ? String(a.value) : a.description ?? '').join(' ')
			: '';
		const entry: ConsoleEntry = {
			type: params.type as string,
			text,
			timestamp: Date.now(),
		};
		const target = sessionId ? this.childSessions.get(sessionId)?.type : undefined;
		if (target) entry.target = target;
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_SIZE) {
			this.consoleBuffer.shift();
		}
	}

	private onNetworkRequest(params: Record<string, unknown>, sessionId?: string): void {
		const request = params.request as { method: string; url: string } | undefined;
		if (!request) return;
		const entry: NetworkEntry = {
			requestId: params.requestId as string,
			method: request.method,
			url: request.url,
			type: params.type as string | undefined,
			timestamp: Date.now(),
		};
		const target = sessionId ? this.childSessions.get(sessionId)?.type : undefined;
		if (target) entry.target = target;
		this.networkMap.set(entry.requestId, entry);
		this.networkBuffer.push(entry);
		if (this.networkBuffer.length > NETWORK_BUFFER_SIZE) {
			const removed = this.networkBuffer.shift()!;
			this.networkMap.delete(removed.requestId);
		}
	}

	private onNetworkResponse(params: Record<string, unknown>): void {
		const entry = this.networkMap.get(params.requestId as string);
		if (!entry) return;
		const response = params.response as { status: number; statusText: string } | undefined;
		if (response) {
			entry.status = response.status;
			entry.statusText = response.statusText;
			entry.responseTimestamp = Date.now();
		}
	}

	/**
	 * Send a CDP command. By default routes to the primary page session
	 * (`_pageSessionId`). Pass `opts.sessionId` as:
	 *   - a string: explicit session id (e.g. a worker/iframe child).
	 *   - `null`: no sessionId in envelope; the proxy handles it at browser/root level
	 *     (needed for Browser.* / Target.* commands during session bootstrap).
	 *   - omitted / undefined: fall through to `_pageSessionId` if known.
	 */
	send(
		method: string,
		params?: Record<string, unknown>,
		opts: { sessionId?: string | null; timeoutMs?: number } = {},
	): Promise<unknown> {
		const timeoutMs = opts.timeoutMs ?? 30000;
		return new Promise((resolve, reject) => {
			const wsOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
			const tabOpen = this._browserTabSession !== null;
			if (!wsOpen && !tabOpen) {
				reject(new Error('CDP not connected'));
				return;
			}
			const id = ++this.requestId;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP request timed out after ${timeoutMs}ms: ${method}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			const envelope: Record<string, unknown> = { id, method, params };
			const sessionId = opts.sessionId === undefined ? this._pageSessionId : opts.sessionId;
			if (sessionId) envelope.sessionId = sessionId;
			if (this._browserTabSession) {
				this._browserTabSession.sendMessage(envelope).then(undefined, (err: Error) => {
					this.pending.delete(id);
					clearTimeout(timer);
					reject(err);
				});
			} else {
				this.ws!.send(JSON.stringify(envelope));
			}
		});
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer || !this._session) return;
		if (this.reconnectAttempts >= CDPTab.MAX_RECONNECT_ATTEMPTS) {
			this.log.appendLine(`[CDP:${this.tabId}] Max reconnect attempts (${CDPTab.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
			// Announce before clearing: the handler still needs `debugSession` to
			// tear the session down.
			this._onGaveUp.fire();
			this._session = null;
			this._sessionId = null;
			return;
		}
		const delay = CDPTab.BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;
		const session = this._session;
		this.log.appendLine(`[CDP:${this.tabId}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${CDPTab.MAX_RECONNECT_ATTEMPTS})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.disposed && this._state === 'disconnected' && this._session === session) {
				this.connectToSession(session);
			}
		}, delay);
	}

	async disconnect(): Promise<void> {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		// Run the title-prefix cleanup BEFORE nulling out `_pageSessionId` —
		// `removeTitlePrefix` calls `send()` which defaults to that sessionId.
		// If we cleared it first, the command would route to the browser/root
		// level and never reach the page, leaving stale markers on the tab.
		await this.removeTitlePrefix();
		this._session = null;
		this._sessionId = null;
		this._pageSessionId = null;
		this._browserSessionId = null;
		this._transport = null;
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.browserTabDisposables.forEach(d => d.dispose());
		this.browserTabDisposables = [];
		if (this._browserTabSession) {
			try { await this._browserTabSession.close(); } catch { /* best effort */ }
			this._browserTabSession = null;
		}
		this._browserTab = null;
		this.pending.forEach(p => p.reject(new Error('Disconnected')));
		this.pending.clear();
		this.childSessions.clear();
		this.setState('disconnected');
	}

	dispose(): void {
		// Order matters: set `disposed` first so the setState-guard in
		// `setState()` prevents the in-flight disconnect chain from firing on
		// an emitter we're about to dispose below.
		this.disposed = true;
		this.disconnect();
		this._onStateChange.dispose();
		this._onTabStateChange.dispose();
		this._onGaveUp.dispose();
	}
}
