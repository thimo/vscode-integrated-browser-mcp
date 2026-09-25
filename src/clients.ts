/**
 * Per-client (per-MCP-process) bookkeeping for tab isolation.
 *
 * Several Claude Code sessions can each run their own `mcp-server.ts` stdio
 * process against the same bridge. Without per-client state, a tabId-less
 * call falls through to CDPManager's single global `_activeTabId`, so one
 * session's `browser_navigate` loads over another session's page, and a
 * `browser_tab_open` from one moves the pointer so the other's next
 * tabId-less call lands in the wrong tab. This module tracks, per client id
 * (the `X-Bridge-Client` header a session sends on every request):
 *
 *  - which tab is that client's own "active" tab
 *  - which client owns each tab (opened it, or claimed it first)
 *  - a lease, used only when the bridge has exactly one drivable tab (the
 *    debug-session fallback path, where per-client tabs are impossible) to
 *    lock that tab to whichever client is using it
 *
 * Pure — no `vscode` import — so it is unit-testable without the extension
 * host, and so CDPManager/http-server (which do need `vscode` types) stay
 * free of this bookkeeping's internals.
 *
 * A request with no `X-Bridge-Client` header (curl, an older MCP build, the
 * VS Code language-model tools in lm-tools.ts) is "legacy": callers here
 * simply never invoke these methods for a legacy request, so today's
 * global-pointer behaviour is untouched.
 */

/**
 * How long an idle lease holder keeps the fallback-path lock. Deliberately
 * a named constant — this is the one knob likely to need tuning once it
 * sees real multi-session use.
 */
export const FALLBACK_LEASE_TTL_MS = 5 * 60 * 1000;

interface ClientState {
	/** This client's own active tab, or null if it has none yet. */
	activeTabId: string | null;
	/**
	 * Tabs this client owns, most-recently-claimed first. Used to pick a
	 * fallback when `activeTabId` closes: "the most recent other tab it owns".
	 */
	ownedTabs: string[];
}

/**
 * Cap on tracked clients, mirroring the FIFO-eviction CDPManager already
 * does for its revoked-tab log: a client that crashes instead of sending
 * `/client/release` must not grow this map without bound over a long-lived
 * bridge.
 */
const MAX_CLIENTS = 200;

export class ClientRegistry {
	private clients = new Map<string, ClientState>();
	private tabOwner = new Map<string, string>();
	private lease: { clientId: string; at: number } | null = null;

	private client(clientId: string): ClientState {
		let state = this.clients.get(clientId);
		// Re-insert on every touch so Map order is least-recently-used first:
		// eviction must hit an abandoned session, not the oldest busy one.
		if (state) this.clients.delete(clientId);
		else state = { activeTabId: null, ownedTabs: [] };
		this.clients.set(clientId, state);
		// Evict the least-recently-used client so an abandoned session
		// (crashed, never released) can't grow this without bound.
		while (this.clients.size > MAX_CLIENTS) {
			const oldest = this.clients.keys().next().value;
			if (oldest === undefined) break;
			this.release(oldest);
		}
		return state;
	}

	/** This client's own active tab, or null if it never set one / it closed. */
	activeTabId(clientId: string): string | null {
		return this.clients.get(clientId)?.activeTabId ?? null;
	}

	/** Set this client's active tab. Does not touch ownership. */
	setActive(clientId: string, tabId: string): void {
		this.client(clientId).activeTabId = tabId;
	}

	/** Tabs this client owns, most-recently-claimed first (may include closed ones; callers filter). */
	ownedTabIds(clientId: string): readonly string[] {
		return this.clients.get(clientId)?.ownedTabs ?? [];
	}

	/** The client that owns `tabId`, or undefined if nobody has claimed it. */
	owner(tabId: string): string | undefined {
		return this.tabOwner.get(tabId);
	}

	/** Assign ownership outright — for a tab this client just opened (`/tab/open`, a lazy launch, opener inheritance). */
	setOwner(tabId: string, clientId: string): void {
		this.tabOwner.set(tabId, clientId);
		this.noteOwned(clientId, tabId);
	}

	/**
	 * Claim ownership only if nobody holds it yet — for a controlling call
	 * landing on a tab nobody has claimed. No-op if already owned, by this
	 * client or another; ownership never gets reassigned by a later call.
	 */
	claimIfUnowned(tabId: string, clientId: string): void {
		if (this.tabOwner.has(tabId)) return;
		this.setOwner(tabId, clientId);
	}

	private noteOwned(clientId: string, tabId: string): void {
		const state = this.client(clientId);
		const i = state.ownedTabs.indexOf(tabId);
		if (i !== -1) state.ownedTabs.splice(i, 1);
		state.ownedTabs.unshift(tabId);
	}

	/**
	 * Resolve the tab a tabId-less request from `clientId` should hit: that
	 * client's own active tab if it is still open; else the most recently
	 * claimed other tab it owns that is still open; else — only when
	 * `fallbackTabId` is passed, meaning the caller already established this
	 * is the single-tab fallback path — that tab; else null. Never considers
	 * another client's tabs, so a tabId-less call can't land on someone
	 * else's page.
	 */
	resolveActive(clientId: string, openTabIds: ReadonlySet<string>, fallbackTabId: string | null): string | null {
		const state = this.clients.get(clientId);
		if (state?.activeTabId && openTabIds.has(state.activeTabId)) return state.activeTabId;
		if (state) {
			for (const tabId of state.ownedTabs) {
				if (openTabIds.has(tabId)) return tabId;
			}
		}
		return fallbackTabId;
	}

	/**
	 * Drop a closed/revoked/untracked tab from every client's bookkeeping.
	 * Also frees the lease: it guards the one fallback tab, and a lease that
	 * outlived its tab would lock the next session out of the tab it just
	 * relaunched.
	 */
	removeTab(tabId: string): void {
		this.tabOwner.delete(tabId);
		this.lease = null;
		for (const state of this.clients.values()) {
			if (state.activeTabId === tabId) state.activeTabId = null;
			const i = state.ownedTabs.indexOf(tabId);
			if (i !== -1) state.ownedTabs.splice(i, 1);
		}
	}

	// ---- fallback-path lease (single tab, isolation impossible — lock instead) ----

	/**
	 * Refresh `clientId`'s lease if it currently holds it. Called on every
	 * request — reads included, "refreshed by ANY request it makes" — so an
	 * active session's lock survives as long as it keeps calling. A no-op
	 * for anyone who does not currently hold the lease, so a read from a
	 * different session can never extend or steal it.
	 */
	touchLease(clientId: string, now = Date.now()): void {
		if (this.lease && this.lease.clientId === clientId) this.lease.at = now;
	}

	/**
	 * Attempt to use the fallback tab for a *controlling* call. Succeeds —
	 * claiming or refreshing the lease — when nobody holds it, the caller
	 * already does, or the previous holder's lease expired. Otherwise fails
	 * without side effects, reporting since when the current holder has been
	 * active so the caller can explain the wait.
	 */
	claimLease(clientId: string, now = Date.now()): { ok: true } | { ok: false; since: number } {
		if (this.lease && this.lease.clientId !== clientId && now - this.lease.at <= FALLBACK_LEASE_TTL_MS) {
			return { ok: false, since: this.lease.at };
		}
		this.lease = { clientId, at: now };
		return { ok: true };
	}

	/**
	 * Forget everything belonging to `clientId`: its active tab, its
	 * ownership claims, and its fallback lease if it holds one. Called from
	 * `POST /client/release` (a session exiting) — best-effort, so a session
	 * that crashes without sending it just ages out via the lease TTL and
	 * the `MAX_CLIENTS` eviction instead.
	 */
	release(clientId: string): void {
		this.clients.delete(clientId);
		for (const [tabId, owner] of this.tabOwner) {
			if (owner === clientId) this.tabOwner.delete(tabId);
		}
		if (this.lease?.clientId === clientId) this.lease = null;
	}
}

/**
 * Human-readable refusal for a controlling call blocked by another client's
 * live fallback-path lease. Pure so it is unit-testable without the HTTP
 * layer.
 */
export function leaseBusyError(since: number, now = Date.now()): string {
	const idleSeconds = Math.max(0, Math.round((now - since) / 1000));
	const age = idleSeconds < 60 ? `${idleSeconds}s` : `${Math.round(idleSeconds / 60)}m`;
	return `The browser tab is in use by another agent session (last active ${age} ago). `
		+ `It frees up when that session ends or after ${FALLBACK_LEASE_TTL_MS / 60000} minutes idle.`;
}
