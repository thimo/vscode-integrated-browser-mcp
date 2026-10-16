/**
 * Which window's bridge a call goes to.
 *
 * Every VS Code window registers a JSON file in `~/.integrated-browser-mcp/instances/`
 * describing where its bridge listens and which workspace it has open. The MCP
 * server runs outside all of them, so it has to work out which one the caller
 * meant — normally from its own working directory, which for a CLI client is
 * the project the user is in.
 *
 * Split out of mcp-server.ts so the selection rules can be unit-tested: that
 * module opens a stdio transport on import.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const INSTANCES_DIR = path.join(os.homedir(), '.integrated-browser-mcp', 'instances');

export interface Instance {
	/** Present when the bridge listens on TCP. */
	port?: number;
	/** Present when the bridge listens on a unix socket / named pipe (preferred). */
	socketPath?: string;
	workspace: string;
	pid: number;
	startedAt: string;
}

export interface Endpoint {
	socketPath?: string;
	port?: number;
}

/**
 * How the target was chosen. `fallback` is the one worth reporting: nothing
 * matched the caller's directory, so we picked a window on age alone.
 */
export type MatchKind = 'env' | 'cwd' | 'fallback' | 'default';

export interface Resolution {
	/** Endpoints to try, in order. */
	endpoints: Endpoint[];
	match: MatchKind;
	/** The window we aimed at, when one is known. */
	instance: Instance | null;
	/** Live bridges found, whichever we picked — the ambiguity measure. */
	liveCount: number;
	cwd: string;
	/** Set once a request has actually succeeded against one of the endpoints. */
	used?: Endpoint;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Every registered instance whose extension host is still running. */
export function readInstances(dir: string = INSTANCES_DIR, alive: (pid: number) => boolean = isProcessAlive): Instance[] {
	const instances: Instance[] = [];
	try {
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith('.json')) continue;
			try {
				const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as Instance;
				if (!alive(data.pid)) continue; // window is gone; its file has not been swept yet
				// Unvalidated JSON: a non-string workspace would throw in every path
				// call downstream. Keep the bridge reachable, as a window without one.
				if (typeof data.workspace !== 'string') data.workspace = '';
				instances.push(data);
			} catch {
				// Skip corrupt files
			}
		}
	} catch {
		// instances dir doesn't exist yet
	}
	return instances;
}

/**
 * How paths compare on this host. A parameter rather than a module constant so
 * the tests can run the Windows rules (drive letters, `\`, folded case) on any
 * OS instead of only on the one CI happens to use.
 */
export interface PathRules {
	path: path.PlatformPath;
	/** Windows and (default) macOS filesystems are case-insensitive; Linux is not. A guess — so window selection only. */
	caseInsensitive: boolean;
	/** Follow symlinks; throws when the path does not exist. */
	realpath: (p: string) => string;
}

const NATIVE: PathRules = {
	path,
	caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
	realpath: p => fs.realpathSync.native(p),
};

/** Newest `startedAt` first. */
const newestFirst = (a: Instance, b: Instance) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');

/**
 * Real path of `p`, or — for a file not written yet — of its deepest existing
 * ancestor with the rest re-appended, so `/tmp/new.md` still becomes
 * `/private/tmp/new.md` on macOS.
 */
function realpathOfExisting(p: string, rules: PathRules): string {
	const rest: string[] = [];
	for (let cur = p; ;) {
		try {
			return rules.path.join(rules.realpath(cur), ...rest);
		} catch {
			const parent = rules.path.dirname(cur);
			if (parent === cur) return p; // nothing exists, not even the root
			rest.unshift(rules.path.basename(cur));
			cur = parent;
		}
	}
}

/**
 * Canonical form for matching only — never written back or displayed. `cwd` is
 * the filesystem's real path, while VS Code stores `uri.fsPath`, which
 * lowercases the Windows drive letter — never meaningful, so it is always
 * uppercased. Resolve separators/`..` and, with `follow`, symlinks. Any other
 * case is preserved; selectInstance folds it as a fallback.
 */
function comparablePath(p: string, rules: PathRules, follow = true): string {
	let out = rules.path.resolve(p);
	if (follow) out = realpathOfExisting(out, rules);
	return rules.path.sep === '\\' ? out.replace(/^[a-z](?=:)/, c => c.toUpperCase()) : out;
}

/** True when `ws` is `target` itself or a parent of it, on a path boundary. */
function onPathBoundary(target: string, ws: string, sep: string): boolean {
	// A root (`/`, `C:\`) keeps its separator, so it is already the prefix.
	return target === ws || target.startsWith(ws.endsWith(sep) ? ws : ws + sep);
}

/**
 * Whether `target` lies inside `workspace` — the outputPath / download-path
 * scope check — so a path built from the caller's cwd is not rejected for a
 * drive letter's case or a symlinked workspace. Accepted when inside either as
 * given or with symlinks resolved. Unlike window selection, this never guesses
 * at case beyond the drive letter: a wrong guess here would write outside the
 * workspace on a case-sensitive volume, not merely pick the wrong window. A
 * case variant of an *existing* folder on a case-insensitive volume still
 * passes, because realpath returns its on-disk spelling — same folder, so
 * that is correct; only components that do not exist yet are compared as-is.
 */
export function isInsideWorkspace(target: string, workspace: string, rules: PathRules = NATIVE): boolean {
	return [false, true].some(follow =>
		onPathBoundary(comparablePath(target, rules, follow), comparablePath(workspace, rules, follow), rules.path.sep));
}

/**
 * Pick the window a caller in `cwd` most likely means: the deepest registered
 * workspace containing it. Failing that, the most recently started window —
 * which is what makes a session started outside any open workspace work at
 * all, and what quietly drives an unrelated browser when several are open.
 * The `match` is returned so callers can say which of the two happened.
 */
export function selectInstance(instances: Instance[], cwd: string, rules: PathRules = NATIVE): { instance: Instance | null; match: 'cwd' | 'fallback' | 'default' } {
	const target = comparablePath(cwd, rules);
	// Deepest workspace first so a nested one wins; newest first breaks a tie so
	// two windows on the same workspace resolve identically per call, instead of
	// following readdir order. Instance files are unvalidated JSON: a non-string
	// workspace is skipped rather than allowed to throw out of every call.
	const ranked = instances
		.filter(i => typeof i.workspace === 'string' && i.workspace)
		.map(i => ({ inst: i, ws: comparablePath(i.workspace, rules) }))
		.sort((a, b) => (b.ws.length - a.ws.length) || newestFirst(a.inst, b.inst));
	// Exact match first (deepest, then newest). Folding case is a fallback, so a
	// case-sensitive volume whose directories differ only by case is not forced
	// into a case-insensitive false positive while an exact match exists.
	// Match on a path boundary: /foo/bar must not match /foo/bar-baz.
	for (const fold of rules.caseInsensitive ? [false, true] : [false]) {
		const t = fold ? target.toLowerCase() : target;
		for (const { inst, ws } of ranked) {
			if (onPathBoundary(t, fold ? ws.toLowerCase() : ws, rules.path.sep)) return { instance: inst, match: 'cwd' };
		}
	}
	const byAge = [...instances].sort(newestFirst);
	if (byAge.length > 0) return { instance: byAge[0], match: 'fallback' };
	return { instance: null, match: 'default' };
}

/**
 * Resolve how to reach the bridge, and record how that choice was made.
 * A unix socket / named pipe is preferred (no listening port at all); TCP
 * remains for instances that could not create one, and for the explicit
 * BROWSER_BRIDGE_PORT override.
 *
 * Re-resolved on every call. Caching was unsafe: VS Code windows shift ports
 * and socket paths on reload, so a cached endpoint can silently route calls to
 * the wrong workspace's bridge. Reading the instances dir costs ~1ms.
 */
export function resolveTarget(
	env: Record<string, string | undefined>,
	cwd: string,
	instances: Instance[],
	defaultPort = 3788,
): Resolution {
	// Env override takes priority (VS Code-hosted clients, manual config,
	// cross-boundary setups where the MCP server and extension host do not
	// share a filesystem). Socket first, matching the socket-preferred policy
	// everywhere else. The instance is looked up anyway: it names the window,
	// and workspace-scoped paths must resolve against the window we talk to.
	const envSocket = env.BROWSER_BRIDGE_SOCKET;
	if (envSocket) {
		const pinned = instances.find(i => i.socketPath === envSocket) ?? null;
		return { endpoints: [{ socketPath: envSocket }], match: 'env', instance: pinned, liveCount: instances.length, cwd };
	}
	const envPort = Number(env.BROWSER_BRIDGE_PORT);
	if (env.BROWSER_BRIDGE_PORT && Number.isFinite(envPort) && envPort > 0) {
		const pinned = instances.find(i => i.port === envPort) ?? null;
		return { endpoints: [{ port: envPort }], match: 'env', instance: pinned, liveCount: instances.length, cwd };
	}

	const { instance, match } = selectInstance(instances, cwd);
	if (instance) {
		// A discovered instance is authoritative: try exactly what it published
		// and let a failure surface. Appending the default port here would let a
		// transient socket error silently reroute to whatever listens on 3788,
		// which in a multi-window setup is a *different workspace's* bridge.
		// Driving the wrong window without knowing is worse than failing.
		const endpoints: Endpoint[] = [];
		if (instance.socketPath) endpoints.push({ socketPath: instance.socketPath });
		if (instance.port) endpoints.push({ port: instance.port });
		if (endpoints.length) return { endpoints, match, instance, liveCount: instances.length, cwd };
	}
	// Nothing discovered: fall back to the lowest port the extension binds, which
	// also covers the version-skew case where an older extension is on TCP and
	// never wrote a socket path.
	return { endpoints: [{ port: defaultPort }], match: 'default', instance: null, liveCount: instances.length, cwd };
}

/** Human-readable form of an endpoint, for status output. */
export function describeEndpoint(endpoint: Endpoint | undefined): string | null {
	if (!endpoint) return null;
	if (endpoint.socketPath) return endpoint.socketPath;
	return endpoint.port != null ? `127.0.0.1:${endpoint.port}` : null;
}

/**
 * The line an agent needs when a call landed in a window the user is not
 * looking at. Only fires when the choice was actually ambiguous: with a single
 * bridge running, the age fallback is the normal case for a session started
 * outside a workspace, not an accident worth narrating.
 */
export function foreignWindowNote(resolution: Resolution | null): string | null {
	if (!resolution || resolution.match !== 'fallback') return null;
	if (resolution.liveCount < 2 || !resolution.instance) return null;
	return `Bridge note: no VS Code window is registered for this session's directory (${resolution.cwd}), `
		+ `so the call went to the window for ${resolution.instance.workspace} — the most recently started of `
		+ `${resolution.liveCount} windows running the bridge. Any tab it opens is in that window, not the one `
		+ `the user is looking at. Say so instead of reporting a plain success. Opening ${resolution.cwd} in a `
		+ `VS Code window with the extension active routes later calls there.`;
}
