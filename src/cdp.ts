import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { CDPTab, CDPState, ConsoleEntry, NetworkEntry, DownloadEntry } from './cdp-tab';
import { allowsAllExistingTabs } from './sharing';
import { ClientRegistry } from './clients';

export { CDPState, ConsoleEntry, NetworkEntry, DownloadEntry };

export interface TabInfo {
	tabId: string;
	/**
	 * 1-indexed number shown in the tab title, assigned the first time an agent
	 * acts on the tab. `null` for a tab no agent has touched — those are never
	 * marked, so a number would refer to something invisible. Freed and reused
	 * when a tab closes.
	 */
	number: number | null;
	url: string;
	title: string;
	/**
	 * Favicon when VS Code exposes one: a theme-icon id, a URL, or `data:<type>`
	 * for one inlined in the page — the payload of those is dropped, see
	 * {@link compactIcon}.
	 */
	icon?: string;
	active: boolean;
	state: CDPState;
	transport: 'websocket' | 'browserTab' | null;
}

function generateTabId(): string {
	return 'tab-' + crypto.randomBytes(4).toString('hex');
}

/**
 * True when the `browser` API proposal is both declared *and granted*.
 *
 * Declaring it in package.json is not enough — VS Code only grants it in
 * extension development mode or when launched with
 * `--enable-proposed-api thimo.integrated-browser-mcp`. When declared but
 * ungranted the members still exist on the namespace and throw on access, so a
 * bare `typeof` probe reports a false positive. Probe a property too and treat
 * any throw as "not available".
 */
export function hasProposedBrowserApi(): boolean {
	try {
		const win = vscode.window as unknown as { openBrowserTab?: unknown; browserTabs?: unknown };
		if (typeof win.openBrowserTab !== 'function') return false;
		return Array.isArray(win.browserTabs);
	} catch {
		return false;
	}
}

/**
 * How many browser tabs VS Code has open in this window, whatever the bridge
 * is allowed to drive. Lets "no attached page" distinguish "nothing is open"
 * from "pages are open but not yours" — the common case once the bridge only
 * drives tabs it opened. Zero when the proposal is ungranted, where the count
 * is unknowable.
 */
export function openBrowserTabCount(): number {
	try {
		return hasProposedBrowserApi() ? vscode.window.browserTabs.length : 0;
	} catch {
		return 0;
	}
}

export type TabIndicatorMode = 'off' | 'marker' | 'number';

/**
 * How to mark a tab that is under agent control.
 *
 * Marking a tab means rewriting the page's real `document.title` through an
 * injected script — the only lever an extension has over the editor tab label
 * — so the page can observe it. That is acceptable on a tab the bridge opened
 * itself or has been asked to work in, and intrusive on one it has never
 * touched, which is why marking follows agent activity (see
 * {@link CDPManager.indicatorPrefixFor}).
 *
 *  - `number` — `(N) `, so a user can say "reload browser 2" and match it to
 *    `browser_tab_list`'s `number`.
 *  - `marker` — a fixed symbol: the tab is agent-controlled, without implying
 *    an ordering or renumbering as tabs come and go.
 *  - `off` — never touch titles.
 */
function tabIndicatorMode(): TabIndicatorMode {
	const value = vscode.workspace.getConfiguration('integratedBrowserMcp').get<string>('tabIndicator', 'number');
	return value === 'off' || value === 'marker' || value === 'number' ? value : 'number';
}

function tabIndicatorMarker(): string {
	const raw = vscode.workspace.getConfiguration('integratedBrowserMcp').get<string>('tabIndicatorMarker', '●');
	// The setting offers bare symbols so the dropdown reads cleanly (a trailing
	// space would be invisible there), but the prefix needs one to separate it
	// from the title. Normalising also keeps older settings that already
	// included the space working.
	const token = raw.trim();
	return token ? `${token} ` : '● ';
}

/**
 * `(N) ` parenthesised decimal prefix. ASCII, high contrast, legible at any
 * tab width, no upper cap. Matches the status bar's `Browser MCP (N)` count
 * notation. Replaces earlier Unicode circled-digit approaches (outlined
 * ①..⑳, negative ❶..⓴) which rendered too small in VS Code's tab strip.
 */
function numberToPrefix(n: number): string {
	return `(${n}) `;
}

/** Longest icon value worth passing through verbatim — comfortably fits a URL. */
const MAX_ICON_LENGTH = 256;

/**
 * Shorten an embedded favicon to its media type.
 *
 * VS Code hands back whatever the tab exposes: a theme-icon id (`globe`), a
 * URL, or the favicon inlined as a `data:` URI. That last form is routinely
 * 8 KB of base64 — per tab — which dwarfs every other field in
 * `browser_tab_list` and buys an agent nothing, since it cannot look at an
 * image it can only copy. Keep the fact that the tab has a favicon, drop the
 * payload.
 */
export function compactIcon(icon: string | undefined): string | undefined {
	if (!icon || icon.length <= MAX_ICON_LENGTH) return icon;
	if (!icon.startsWith('data:')) return icon.slice(0, MAX_ICON_LENGTH);
	// `data:<mediatype>[;base64],<payload>` — keep up to the media type. VS Code
	// hands the URI back percent-encoded, so the separators arrive as `%3B` and
	// `%2C`; matching only the literal characters found neither and returned the
	// whole payload as the "media type".
	const mediaType = icon.slice(5).split(/[;,]|%3B|%2C/i, 1)[0];
	return mediaType ? `data:${mediaType}` : 'data:';
}

/**
 * Owns a collection of {@link CDPTab}s and routes requests to the active or
 * explicitly-specified tab.
 *
 * Multi-tab is only meaningful on the proposed `browser` API path
 * (`openBrowserTab` + `BrowserTab.startCDPSession`). On the websocket /
 * debug-session fallback path, the manager wraps a single synthetic
 * `tab-main` and refuses multi-tab operations with a clear error.
 */
export class CDPManager {
	private tabs = new Map<string, CDPTab>();
	private _activeTabId: string | null = null;
	private tabSubscriptions = new Map<string, vscode.Disposable>();
	private log: vscode.OutputChannel;
	private _onStateChange = new vscode.EventEmitter<CDPState>();
	readonly onStateChange = this._onStateChange.event;

	/**
	 * Unique-per-process id used to mark BrowserTabs we own. VS Code's
	 * proposed `browser` API exposes tabs to every extension host that has
	 * the proposal enabled — across all windows. Without a cooperation
	 * marker, two bridge instances (e.g. two VS Code windows with this
	 * extension) would both adopt the same BrowserTab, install competing
	 * title scripts, and cause title oscillation + eventual page crash.
	 */
	readonly ownerId = 'owner-' + crypto.randomBytes(6).toString('hex');

	/**
	 * Per-`X-Bridge-Client` bookkeeping (active tab, ownership, the
	 * fallback-path lease) — see `clients.ts`. One registry per CDPManager,
	 * so it resets naturally on every bridge (re)start along with the tabs.
	 */
	readonly clients = new ClientRegistry();

	/**
	 * The title prefix a tab should carry, or null for "leave the title alone".
	 *
	 * Only tabs an agent has worked in are marked. The bridge attaches to
	 * *every* integrated browser tab in the window, so marking on adoption
	 * stamped a prefix onto pages the user had opened themselves — their title,
	 * their page, mutated because an unrelated tool happened to be running.
	 */
	private indicatorPrefixFor(tab: CDPTab): string | null {
		if (!tab.agentControlled) return null;
		const mode = tabIndicatorMode();
		if (mode === 'off') return null;
		if (mode === 'marker') return tabIndicatorMarker();
		return tab.displayNumber !== null ? numberToPrefix(tab.displayNumber) : tabIndicatorMarker();
	}

	/**
	 * Re-apply or clear indicators after a settings change. Without this,
	 * turning the setting off would leave every already-marked page with a
	 * polluted title until it was reopened.
	 */
	async refreshIndicators(): Promise<void> {
		for (const tab of this.tabs.values()) {
			const prefix = this.indicatorPrefixFor(tab);
			try {
				if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
				else await tab.removeTitlePrefix();
			} catch (err) {
				this.log.appendLine(`[Bridge] Indicator refresh failed for ${tab.tabId}: ${err}`);
			}
		}
	}

	/**
	 * Record that the bridge owns this tab after the fact, applying the
	 * indicator that the earlier (unowned) adoption skipped. Idempotent.
	 */
	/**
	 * Mark a freshly-adopted tab as bridge-owned when its CDP opener is a
	 * bridge-owned tab (window.open / target=_blank / "open in new tab" from an
	 * agent tab). Only children of the bridge's OWN tabs inherit, so a page in a
	 * user tab cannot spawn a bridge-owned (drivable-under-enforcement) tab.
	 * Best-effort: `openerId` may be unpopulated on the BrowserTab transport, in
	 * which case the tab simply stays user-owned.
	 */
	private async inheritOwnershipFromOpener(tab: CDPTab): Promise<void> {
		try {
			const openerId = await tab.getOpenerId();
			if (!openerId) return;
			for (const other of this.tabs.values()) {
				if (other !== tab && other.bridgeOwned && other.pageTargetId === openerId) {
					tab.bridgeOwned = true;
					// The agent's click opened it, so it counts as worked-in too.
					tab.agentControlled = true;
					if (tab.displayNumber === null) tab.displayNumber = this.allocateNumber();
					// And it belongs to the same client's working set as the
					// opener, not to whichever client happens to touch it next.
					const openerClientId = this.clients.owner(other.tabId);
					if (openerClientId) this.clients.setOwner(tab.tabId, openerClientId);
					this.log.appendLine(`[Bridge] Tab ${tab.tabId} inherited ownership from opener ${openerId}`);
					return;
				}
			}
		} catch (err) {
			this.log.appendLine(`[Bridge] Opener-inheritance check failed: ${err}`);
		}
	}

	private async claimOwnership(tab: CDPTab, makeActive = false, clientId?: string): Promise<CDPTab> {
		// Apply makeActive even if ownership was already set: when the open event
		// wins the race, openTab's makeActive intent reaches only here, and
		// without this the newly opened (visually focused) tab is not the active
		// one, so later tabId-less calls drive the wrong page.
		if (makeActive) {
			this._activeTabId = tab.tabId;
			if (clientId) this.clients.setActive(clientId, tab.tabId);
		}
		tab.bridgeOwned = true;
		// The client that opened this tab is its outright owner — same
		// contract as `/tab/open`. A legacy caller (no header) assigns no
		// owner, so the tab stays claimable by the first header-bearing
		// client that later works in it.
		if (clientId) this.clients.setOwner(tab.tabId, clientId);
		// Opening a tab is itself an agent action, so it starts out controlled.
		await this.noteAgentControl(tab);
		if (makeActive) this.emitStateChange();
		return tab;
	}

	/**
	 * Record that an agent is working in this tab, numbering and marking it if
	 * it was not already. Called for every action that can move the page — not
	 * for reads, which leave no trace and so warrant no marker.
	 */
	async noteAgentControl(tab: CDPTab): Promise<void> {
		if (tab.agentControlled) return;
		tab.agentControlled = true;
		if (tab.displayNumber === null) tab.displayNumber = this.allocateNumber();
		this.log.appendLine(`[Bridge] Claiming ${tab.tabId} as number ${tab.displayNumber} (${tab.url})`);
		const prefix = this.indicatorPrefixFor(tab);
		if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
		this.emitStateChange();
	}

	/**
	 * Lowest unused number, so releasing a tab frees its slot for the next one:
	 * with 1 and 2 held, losing 1 means the next tab is 1 again rather than 3.
	 * Only controlled tabs hold a number, so the sequence has no invisible gaps.
	 */
	private allocateNumber(): number {
		const used = new Set<number>();
		for (const tab of this.tabs.values()) {
			if (tab.displayNumber !== null) used.add(tab.displayNumber);
		}
		let n = 1;
		while (used.has(n)) n++;
		return n;
	}

	/**
	 * Dedupe concurrent `adoptBrowserTab` calls for the same underlying
	 * {@link vscode.BrowserTab}. `openTab` calls `adoptBrowserTab`, and the
	 * `onDidOpenBrowserTab` listener also does — without this cache they race,
	 * and a caller can get back a CDPTab whose connect is still in flight,
	 * causing `send()` to fail with "CDP not connected".
	 */
	private pendingAdoptions = new Map<vscode.BrowserTab, Promise<CDPTab>>();

	constructor(log: vscode.OutputChannel) {
		this.log = log;
	}

	/** Aggregate state: `connected` if any tab is; `connecting` if any is; else `disconnected`. */
	get state(): CDPState {
		if (this.tabs.size === 0) return 'disconnected';
		let sawConnecting = false;
		for (const tab of this.tabs.values()) {
			if (tab.state === 'connected') return 'connected';
			if (tab.state === 'connecting') sawConnecting = true;
		}
		return sawConnecting ? 'connecting' : 'disconnected';
	}

	/** Which transport all tabs are using (they all share one mode per session). */
	get transport(): 'websocket' | 'browserTab' | null {
		for (const tab of this.tabs.values()) {
			if (tab.transport) return tab.transport;
		}
		return null;
	}

	get activeTabId(): string | null {
		return this._activeTabId;
	}

	get tabCount(): number {
		return this.tabs.size;
	}

	/**
	 * A client's own active tab: its stored active tab if still open, else the
	 * most recent other tab it owns, else — only on the single-tab fallback
	 * path, where isolation is impossible — the sole tab. See `clients.ts`.
	 * Never falls through to another client's tab or the global pointer.
	 */
	private resolveActiveTabIdFor(clientId: string): string | null {
		const openTabIds = new Set(this.tabs.keys());
		const fallbackTabId = !hasProposedBrowserApi() && this.tabs.size === 1
			? this.tabs.keys().next().value ?? null
			: null;
		return this.clients.resolveActive(clientId, openTabIds, fallbackTabId);
	}

	/** Same notion as `activeTabId`, scoped to one client once it sends an `X-Bridge-Client` header; the global pointer for a legacy caller. */
	activeTabIdFor(clientId?: string): string | null {
		return clientId ? this.resolveActiveTabIdFor(clientId) : this._activeTabId;
	}

	/**
	 * Resolve a tab. `tabId` explicit always wins — any client can reach any
	 * tab by id, which is how a tab gets handed from one session to another.
	 * Omitted from a header-bearing client resolves through that client's own
	 * tabs (see `resolveActiveTabIdFor`); omitted from a legacy caller keeps
	 * the original global-pointer / only-tab behaviour untouched.
	 */
	getTab(tabId?: string, clientId?: string): CDPTab | undefined {
		if (tabId) return this.tabs.get(tabId);
		if (clientId) {
			const id = this.resolveActiveTabIdFor(clientId);
			return id ? this.tabs.get(id) : undefined;
		}
		if (this._activeTabId) return this.tabs.get(this._activeTabId);
		if (this.tabs.size === 1) return this.tabs.values().next().value;
		return undefined;
	}

	/** `active` marks the requesting client's own active tab once `clientId` is given; the global pointer otherwise. */
	list(clientId?: string): TabInfo[] {
		const activeId = clientId ? this.resolveActiveTabIdFor(clientId) : this._activeTabId;
		return Array.from(this.tabs.values()).map(tab => ({
			tabId: tab.tabId,
			number: tab.displayNumber,
			url: tab.url,
			title: tab.title,
			icon: compactIcon(tab.iconUri),
			active: tab.tabId === activeId,
			state: tab.state,
			transport: tab.transport,
		}));
	}

	/**
	 * The tabs a tabId-less log call (console, network, downloads, network
	 * clear) covers: every tab for a legacy caller, as before; for a client,
	 * the tabs it owns plus whatever its own active tab resolves to — so one
	 * session neither reads nor wipes another session's logs.
	 */
	scopedTabIds(clientId?: string): string[] {
		if (!clientId) return Array.from(this.tabs.keys());
		const ids = new Set(this.clients.ownedTabIds(clientId).filter(id => this.tabs.has(id)));
		const active = this.resolveActiveTabIdFor(clientId);
		if (active) ids.add(active);
		return Array.from(ids);
	}

	/** Assign ownership of `tab` to `clientId` if nobody owns it yet. No-op for a legacy caller (no header) — legacy never claims ownership. */
	claimTabForClient(tab: CDPTab, clientId?: string): void {
		if (clientId) this.clients.claimIfUnowned(tab.tabId, clientId);
	}

	/** Set `clientId`'s own active tab, alongside the existing global pointer (status bar, legacy callers). */
	setActiveForClient(tabId: string, clientId?: string): void {
		if (clientId) this.clients.setActive(clientId, tabId);
	}

	/**
	 * Open a new browser tab via the proposed API. Requires VS Code to be
	 * launched with `--enable-proposed-api=thimo.integrated-browser-mcp`.
	 *
	 * Opens the tab at `about:blank` first and navigates afterward. That order
	 * matters: the CDP handshake + proxy-level `Target.setAutoAttach` need to
	 * complete before the destination page loads, otherwise a web worker
	 * spawned on initial load can race our auto-attach and never get captured.
	 */
	async openTab(url: string, makeActive = true, beside = false, clientId?: string): Promise<CDPTab> {
		if (!hasProposedBrowserApi()) {
			throw new Error(
				'Multi-tab is unavailable in this build: the `browser` API proposal is declared but not granted, '
				+ 'so new tabs cannot be opened and existing pages cannot be attached to. '
				+ 'Relaunch VS Code with `--enable-proposed-api thimo.integrated-browser-mcp` to enable it. '
				+ 'Without it, call browser_navigate with no tabId — the bridge lazy-launches its own single tab and drives that.',
			);
		}
		// `preserveFocus` alone only keeps *keyboard* focus — the new tab still
		// becomes the visible editor, flipping the user's view. `background` is
		// what actually leaves their tab in front, and it is the whole point of
		// `makeActive: false`: an agent following the "open your own tab, don't
		// disturb the user" practice must not hijack the screen to do it.
		const browserTab = await vscode.window.openBrowserTab('about:blank', {
			preserveFocus: !makeActive,
			background: !makeActive,
			// Opt-in only: splitting the editor group is itself disruptive, so
			// the default stays in the current group.
			...(beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
		});
		const tab = await this.adoptBrowserTab(browserTab, makeActive, true, clientId);
		if (url !== 'about:blank') {
			await tab.send('Page.navigate', { url });
			// Don't return until the tab reports the destination. Returning
			// straight after `Page.navigate` reported `about:blank` for a page
			// that loaded correctly a moment later, so callers misdescribed
			// what they had just opened.
			await tab.settleNavigation();
		}
		return tab;
	}

	/**
	 * Wrap an existing {@link vscode.BrowserTab} in a {@link CDPTab} and start
	 * its CDP session. Idempotent: returns the existing wrapper if already
	 * tracked. Called both for tabs we created via {@link openTab} and for
	 * tabs the user opened via VS Code UI (via `onDidOpenBrowserTab`).
	 */
	async adoptBrowserTab(browserTab: vscode.BrowserTab, makeActive = false, bridgeOwned = false, clientId?: string): Promise<CDPTab> {
		// An in-flight adoption takes priority: a concurrent caller must wait
		// for the connect + title-prefix to finish, not grab the half-built
		// tab reference from the map.
		// Ownership has to be upgradeable, not just set at construction.
		// `onDidOpenBrowserTab` fires for tabs we open ourselves and calls this
		// without `bridgeOwned`, so whichever call arrives first decides — and
		// the event usually wins. A tab the bridge opened would then be recorded
		// as the user's: no indicator, and it would be revoked as a page the
		// bridge had no business driving.
		const pending = this.pendingAdoptions.get(browserTab);
		if (pending) return bridgeOwned ? pending.then(tab => this.claimOwnership(tab, makeActive, clientId)) : pending;
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) return bridgeOwned ? this.claimOwnership(tab, makeActive, clientId) : tab;
		}
		const promise = (async () => {
			const tab = new CDPTab(generateTabId(), this.log);
			tab.bridgeOwned = bridgeOwned;
			// Numbers track agent activity, not adoption: a tab sitting in the
			// window that no agent has touched shows nothing, so every visible
			// number belongs to a tab an agent is actually working in. A
			// bridge-opened tab qualifies at once — opening it was the action.
			if (bridgeOwned) {
				tab.agentControlled = true;
				tab.displayNumber = this.allocateNumber();
				// A fresh bridge-owned tab is unowned by construction, so the
				// client that asked for it (if any — a legacy caller assigns
				// nothing) is its outright owner, same as `/tab/open`.
				if (clientId) this.clients.setOwner(tab.tabId, clientId);
			}
			this.registerTab(tab);
			await tab.connectToBrowserTab(browserTab);

			// No bridge-level ownership handshake: the proposed API is
			// per-window, so two bridges never see the same tab. The check
			// we used to have here blocked legitimate reclaim after a window
			// reload (previous instance leaves a stale `window.__bridgeOwner`
			// in the page JS; a fresh instance must be allowed to take over).
			// The title-script's own loop-detection backs off cleanly if it
			// does somehow end up fighting a stale observer.

			// A tab opened FROM a bridge-owned tab (window.open, target=_blank,
			// "open in new tab") inherits ownership: it belongs to the agent's
			// working set, so number it and keep it drivable.
			if (!bridgeOwned) await this.inheritOwnershipFromOpener(tab);

			const prefix = this.indicatorPrefixFor(tab);
			if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
			if (makeActive || this.tabs.size === 1) this._activeTabId = tab.tabId;
			if (makeActive && clientId) this.clients.setActive(clientId, tab.tabId);
			this.emitStateChange();
			return tab;
		})();
		this.pendingAdoptions.set(browserTab, promise);
		promise.finally(() => this.pendingAdoptions.delete(browserTab));
		return promise;
	}

	/**
	 * Adopt a VS Code debug session (fallback path). Creates a single synthetic
	 * tab with id `tab-main`. `bridgeOwned` is true only for the session
	 * `launchBrowser()` started; returns null when an unowned session is refused.
	 */
	async adoptDebugSession(session: vscode.DebugSession, bridgeOwned: boolean, clientId?: string): Promise<CDPTab | null> {
		const existing = this.tabs.get('tab-main');
		if (existing) return existing;
		// A session the bridge did not launch is the user's own browser, and the
		// access model says we do not drive those. Unlike the proposed-API path
		// there is no per-tab lifecycle event to revoke from later, so the check
		// happens here instead of in `enforceTabAccess`: refusing to attach at all
		// beats opening a CDP connection to a page we would revoke on the first
		// call anyway.
		if (!bridgeOwned && !allowsAllExistingTabs()) {
			this.log.appendLine('[Bridge] Not adopting a browser session the bridge did not launch (integratedBrowserMcp.allowAllExistingTabs is off)');
			return null;
		}
		const tab = new CDPTab('tab-main', this.log);
		tab.bridgeOwned = bridgeOwned;
		// Same rule as `adoptBrowserTab`: opening the tab is itself an action, so a
		// bridge-launched one is numbered at once. An adopted one waits until an
		// agent actually works in it.
		if (bridgeOwned) {
			tab.agentControlled = true;
			tab.displayNumber = this.allocateNumber();
			if (clientId) this.clients.setOwner(tab.tabId, clientId);
		}
		this.registerTab(tab);
		await tab.connectToSession(session);
		const prefix = this.indicatorPrefixFor(tab);
		if (prefix) await tab.setTitlePrefix(prefix, this.ownerId);
		this._activeTabId = 'tab-main';
		if (clientId) this.clients.setActive(clientId, 'tab-main');
		this.emitStateChange();
		return tab;
	}

	private registerTab(tab: CDPTab): void {
		this.tabs.set(tab.tabId, tab);
		this.tabSubscriptions.set(tab.tabId, vscode.Disposable.from(
			tab.onStateChange(() => this.emitStateChange()),
			tab.onGaveUp(() => {
				this.dropUnreachableTab(tab.tabId).catch(err => {
					this.log.appendLine(`[Bridge] Dropping unreachable ${tab.tabId} failed: ${err}`);
				});
			}),
		));
	}

	/**
	 * Remove a tab whose CDP connection is gone for good. Untracking is the point:
	 * while it sits in the map the bridge looks like it has a tab, so nothing
	 * relaunches and every call fails. A bridge-owned session is terminated too,
	 * so the browser editor it left behind goes with it and the next request gets
	 * a fresh one; an adopted session belongs to the user and is left running.
	 */
	private async dropUnreachableTab(tabId: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		this.log.appendLine(`[Bridge] Dropping ${tabId}: CDP unreachable after repeated reconnects`);
		const session = tab.bridgeOwned ? tab.debugSession : null;
		tab.dispose();
		this.tabSubscriptions.get(tabId)?.dispose();
		this.tabSubscriptions.delete(tabId);
		this.tabs.delete(tabId);
		this.clients.removeTab(tabId);
		if (this._activeTabId === tabId) {
			this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
		}
		if (session) {
			try { await vscode.debug.stopDebugging(session); } catch { /* already gone */ }
		}
		this.emitStateChange();
	}

	private emitStateChange(): void {
		// Always fire — status-bar rendering depends on both state AND tab
		// count; tab count can change without state changing (e.g. dropping
		// a never-connected tab after an ownership conflict), and the bar
		// needs to re-render to switch out of warning.
		this._onStateChange.fire(this.state);
	}

	async closeTab(tabId: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) throw new Error(`No tab: ${tabId}`);
		// If it's a BrowserTab, close the VS Code tab too; lifecycle event will
		// trigger untrack via onDidCloseBrowserTab. On the fallback path the
		// tab is owned by a debug session — disconnecting CDP alone left the
		// browser editor open, so the page stayed in VS Code despite us
		// reporting it closed. Terminating the session is what actually closes it.
		const underlying = tab.browserTab;
		const session = tab.debugSession;
		await tab.disconnect();
		tab.dispose();
		this.tabSubscriptions.get(tabId)?.dispose();
		this.tabSubscriptions.delete(tabId);
		this.tabs.delete(tabId);
		this.clients.removeTab(tabId);
		if (this._activeTabId === tabId) {
			this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
		}
		if (underlying) {
			try { await underlying.close(); } catch { /* already closed */ }
		} else if (session) {
			try { await vscode.debug.stopDebugging(session); } catch { /* already gone */ }
		}
		this.emitStateChange();
	}

	/**
	 * Tabs detached because their page stopped being shared. Kept so a call
	 * against a stale `tabId` fails with the real reason instead of a generic
	 * "no tab" — an agent must be able to tell "revoked" from "never existed".
	 */
	private revoked = new Map<string, { url: string; reason: string; at: number }>();

	/** Cap on remembered revocations, so enforcement churn can't grow the map without bound. */
	private static readonly MAX_REVOKED = 100;

	revokedReason(tabId: string): string | undefined {
		return this.revoked.get(tabId)?.reason;
	}

	/**
	 * Detach from a tab the user unshared. Deliberately does NOT close the
	 * page — it is the user's, and revoking access must not destroy their work.
	 */
	async revokeTab(tabId: string, reason: string): Promise<void> {
		const tab = this.tabs.get(tabId);
		if (!tab) return;
		const url = tab.url;
		this.log.appendLine(`[Bridge] Revoking ${tabId} (${url}): ${reason}`);
		try { await tab.disconnect(); } catch { /* already gone */ }
		tab.dispose();
		this.tabSubscriptions.get(tabId)?.dispose();
		this.tabSubscriptions.delete(tabId);
		this.tabs.delete(tabId);
		this.clients.removeTab(tabId);
		if (this._activeTabId === tabId) {
			this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
		}
		this.revoked.set(tabId, { url, reason, at: Date.now() });
		// FIFO-evict the oldest so a long session under enforcement (every
		// user tab adopted then revoked) can't grow this without bound.
		while (this.revoked.size > CDPManager.MAX_REVOKED) {
			const oldest = this.revoked.keys().next().value;
			if (oldest === undefined) break;
			this.revoked.delete(oldest);
		}
		this.emitStateChange();
	}

	/** Called when the user closes a browser tab via the VS Code UI. */
	untrackBrowserTab(browserTab: vscode.BrowserTab): void {
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) {
				tab.dispose();
				this.tabSubscriptions.get(tab.tabId)?.dispose();
				this.tabSubscriptions.delete(tab.tabId);
				this.tabs.delete(tab.tabId);
				this.clients.removeTab(tab.tabId);
				if (this._activeTabId === tab.tabId) {
					this._activeTabId = this.tabs.size > 0 ? this.tabs.keys().next().value ?? null : null;
				}
				this.emitStateChange();
				return;
			}
		}
	}

	/** Route a VS Code tab-state change (url/title/icon) to its CDPTab. */
	notifyBrowserTabState(browserTab: vscode.BrowserTab): void {
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) {
				tab.notifyBrowserTabStateChanged();
				this.emitStateChange();
				return;
			}
		}
	}

	/** Sync internal active tab with `vscode.window.activeBrowserTab` events. */
	syncActive(browserTab: vscode.BrowserTab | undefined): void {
		if (!browserTab) return; // keep whatever we had
		for (const tab of this.tabs.values()) {
			if (tab.browserTab === browserTab) {
				this._activeTabId = tab.tabId;
				return;
			}
		}
	}

	activate(tabId: string, clientId?: string): void {
		if (!this.tabs.has(tabId)) throw new Error(`No tab: ${tabId}`);
		this._activeTabId = tabId;
		if (clientId) this.clients.setActive(clientId, tabId);
	}

	/** Aggregated across all tabs, stamped with originating tabId. */
	get console(): ConsoleEntry[] {
		const all: ConsoleEntry[] = [];
		for (const tab of this.tabs.values()) {
			for (const e of tab.console) all.push({ ...e, tabId: tab.tabId });
		}
		return all.sort((a, b) => a.timestamp - b.timestamp);
	}

	/** Per-tab console buffer (empty array if tab doesn't exist). */
	consoleForTab(tabId: string): ConsoleEntry[] {
		const tab = this.tabs.get(tabId);
		if (!tab) return [];
		return tab.console.map(e => ({ ...e, tabId }));
	}

	get network(): NetworkEntry[] {
		const all: NetworkEntry[] = [];
		for (const tab of this.tabs.values()) {
			for (const e of tab.network) all.push({ ...e, tabId: tab.tabId });
		}
		return all.sort((a, b) => a.timestamp - b.timestamp);
	}

	networkForTab(tabId: string): NetworkEntry[] {
		const tab = this.tabs.get(tabId);
		if (!tab) return [];
		return tab.network.map(e => ({ ...e, tabId }));
	}

	clearNetwork(tabId?: string): void {
		if (tabId) {
			this.tabs.get(tabId)?.clearNetwork();
			return;
		}
		for (const tab of this.tabs.values()) tab.clearNetwork();
	}

	get downloads(): DownloadEntry[] {
		const all: DownloadEntry[] = [];
		for (const tab of this.tabs.values()) {
			for (const e of tab.downloads) all.push({ ...e, tabId: tab.tabId });
		}
		return all.sort((a, b) => a.startedAt - b.startedAt);
	}

	downloadsForTab(tabId: string): DownloadEntry[] {
		const tab = this.tabs.get(tabId);
		if (!tab) return [];
		return tab.downloads.map(e => ({ ...e, tabId }));
	}

	/** Aggregated child sessions across all tabs, stamped with tabId. */
	get children(): Array<{ sessionId: string; type: string; url: string; tabId: string }> {
		const all: Array<{ sessionId: string; type: string; url: string; tabId: string }> = [];
		for (const tab of this.tabs.values()) {
			for (const c of tab.children) all.push({ ...c, tabId: tab.tabId });
		}
		return all;
	}

	/** Aggregated event counts across all tabs. */
	get events(): Record<string, number> {
		const merged: Record<string, number> = {};
		for (const tab of this.tabs.values()) {
			for (const [method, count] of Object.entries(tab.events)) {
				merged[method] = (merged[method] ?? 0) + count;
			}
		}
		return merged;
	}

	/** Diagnostic: pageSessionId of the active tab. */
	get pageSessionId(): string | null {
		return this.getTab()?.pageSessionId ?? null;
	}

	async dispose(): Promise<void> {
		for (const tab of this.tabs.values()) {
			tab.dispose();
		}
		this.tabs.clear();
		this.tabSubscriptions.forEach(s => s.dispose());
		this.tabSubscriptions.clear();
		this._activeTabId = null;
		this._onStateChange.dispose();
	}
}
