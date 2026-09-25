/**
 * Unit tests for the pure functions that parse or transform untrusted input.
 *
 * These four are the ones that fail *silently* — a mis-implemented PNG
 * un-filter or AX filter returns plausible-looking data rather than throwing,
 * so a caller confidently reports the wrong answer. Everything else in the
 * extension needs a live browser and is covered by manual testing.
 *
 * Run with `npm run test:unit`. No test framework: the modules import `vscode`,
 * which only exists inside the extension host, so each is bundled with esbuild
 * against a stub. That is also why this is a plain script rather than
 * `vscode-test` — none of this needs an extension host.
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'module';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';

const VSCODE_STUB = `
	export const workspace = { getConfiguration: () => ({ get: (_k, d) => d }) };
	export const window = {};
	export const lm = {};
	export const debug = {};
	export class CancellationTokenSource { constructor() { this.token = {}; } cancel() {} dispose() {} }
	export class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
`;

const stubVscode = {
	name: 'stub-vscode',
	setup(build) {
		build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE_STUB, loader: 'js' }));
	},
};

async function load(entry) {
	const result = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		logLevel: 'silent',
		external: ['express', 'ws'],
		plugins: [stubVscode],
	});
	const module = { exports: {} };
	new Function('module', 'exports', 'require', result.outputFiles[0].text)(
		module, module.exports, createRequire(import.meta.url),
	);
	return module.exports;
}

let failures = 0;
let checks = 0;
const eq = (name, actual, expected) => {
	checks++;
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) return;
	failures++;
	console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const throws = (name, fn) => {
	checks++;
	try { fn(); failures++; console.log(`  FAIL ${name} (expected a throw)`); } catch { /* expected */ }
};
const section = name => console.log(`\n${name}`);

// ---------------------------------------------------------------- cdp-tab
{
	section('stripComposedLabel — BrowserTab.title is an editor label, not document.title');
	const { stripComposedLabel: strip } = await load('src/cdp-tab.ts');

	eq('strips the origin suffix', strip('Google (https://www.google.com/)', 'https://www.google.com/?gws_rd=ssl'), 'Google');
	eq('handles a query on the tab url', strip('Search - Microsoft Bing (https://www.bing.com/)', 'https://www.bing.com/?toWww=1'), 'Search - Microsoft Bing');
	eq('keeps parentheses inside the title', strip('Profit (Q3) (https://x.com/)', 'https://x.com/a'), 'Profit (Q3)');
	// The guard that matters: only strip when the suffix really is this page.
	eq('leaves a foreign url alone', strip('Foo (https://evil.com)', 'https://good.com/'), 'Foo (https://evil.com)');
	eq('leaves a real parenthetical alone', strip('Rust (programming language)', 'https://en.wikipedia.org/wiki/Rust'), 'Rust (programming language)');
	eq('passes through an unsuffixed title', strip('Plain Title', 'https://x.com/'), 'Plain Title');
	eq('needs a url to compare against', strip('Google (https://www.google.com/)', ''), 'Google (https://www.google.com/)');
	eq('handles about:blank', strip('Untitled (about:blank)', 'about:blank'), 'Untitled');
	// Regressions the origin-only compare got wrong: a same-origin real path,
	// and two distinct opaque-origin (file:) urls that both compared as "null".
	eq('keeps a same-origin url with a real path', strip('Careers (https://x.com/jobs)', 'https://x.com/home'), 'Careers (https://x.com/jobs)');
	eq('keeps a foreign file url on a file page', strip('Report (file:///b.html)', 'file:///a.html'), 'Report (file:///b.html)');
	// Tolerates a non-normalized composed origin (explicit default port).
	eq('tolerates a default port in the composed origin', strip('Local (http://localhost:80/)', 'http://localhost/app'), 'Local');
}

// -------------------------------------------------------------------- cdp
{
	section('compactIcon — an inlined favicon dwarfs every other field in a tab listing');
	const { compactIcon } = await load('src/cdp.ts');

	// Theme-icon ids and ordinary URLs are already short: pass them through.
	eq('keeps a theme icon id', compactIcon('globe'), 'globe');
	eq('keeps a favicon URL', compactIcon('https://example.com/favicon.ico'), 'https://example.com/favicon.ico');
	eq('keeps undefined', compactIcon(undefined), undefined);
	// A short data URI is harmless; only the long ones are the problem.
	eq('keeps a short data URI', compactIcon('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');

	const long = 'data:image/vnd.microsoft.icon;base64,' + 'A'.repeat(9000);
	eq('drops the payload of an inlined favicon', compactIcon(long), 'data:image/vnd.microsoft.icon');
	// The shape VS Code actually hands back: the separators are percent-encoded,
	// so matching only literal `;` and `,` found neither and kept the whole blob.
	const encoded = 'data:image/vnd.microsoft.icon%3Bbase64%2C' + 'A'.repeat(9000);
	eq('percent-encoded separators', compactIcon(encoded), 'data:image/vnd.microsoft.icon');
	eq('lowercase percent-encoding', compactIcon('data:image/png%3bbase64%2c' + 'A'.repeat(9000)), 'data:image/png');
	eq('without a media type', compactIcon('data:;base64,' + 'A'.repeat(9000)), 'data:');
	eq('no semicolon, only a comma', compactIcon('data:image/png,' + 'A'.repeat(9000)), 'data:image/png');
	// A non-data URI that is somehow enormous still gets bounded.
	eq('bounds a huge non-data value', compactIcon('https://x.com/' + 'a'.repeat(9000)).length, 256);
}

// ------------------------------------------------------------ http-server
{
	section('projectAXNodes — a raw SPA tree is six figures of characters');
	const { projectAXNodes: project, descendantsOf } = await load('src/http-server.ts');
	const v = value => ({ value });

	const nodes = [
		{ nodeId: '1', role: v('RootWebArea'), name: v('PrintStream'), childIds: ['2', '3'] },
		{ nodeId: '2', role: v('button'), name: v('Save'), properties: [
			{ name: 'disabled', value: v(false) }, { name: 'focused', value: v(true) }, { name: 'live', value: v('polite') },
		] },
		{ nodeId: '3', role: v('generic'), name: v(''), childIds: ['4'] },
		{ nodeId: '4', role: v('textbox'), name: v('Search'), value: v('abc') },
		{ nodeId: '5', role: v('StaticText'), name: v('hidden'), ignored: true },
		{ nodeId: '6', role: v('button'), name: v('') },
		{ nodeId: '7', role: v('InlineTextBox'), name: v('duplicate of parent') },
	];

	eq('drops ignored, unnamed generics and duplicate roles', project(nodes).map(n => n.nodeId), ['1', '2', '4', '6']);
	eq('flattens the value wrappers', project(nodes)[2], { nodeId: '4', role: 'textbox', name: 'Search', value: 'abc' });
	eq('keeps informative properties, drops defaults', project(nodes)[1], { nodeId: '2', role: 'button', name: 'Save', focused: true });
	// An unnamed button is still actionable (and an a11y bug worth surfacing).
	eq('keeps unnamed actionable nodes', project(nodes)[3], { nodeId: '6', role: 'button' });
	eq('interactiveOnly keeps only actionable roles', project(nodes, { interactiveOnly: true }).map(n => n.role), ['button', 'textbox', 'button']);
	eq('includeIgnored restores them', project(nodes, { includeIgnored: true }).map(n => n.nodeId), ['1', '2', '4', '5', '6']);

	eq('descendantsOf includes root and children', descendantsOf(nodes, '3').map(n => n.nodeId), ['3', '4']);
	eq('descendantsOf tolerates an unknown root', descendantsOf(nodes, 'nope'), []);
	eq('descendantsOf survives a cyclic tree', descendantsOf([{ nodeId: 'a', childIds: ['b'] }, { nodeId: 'b', childIds: ['a'] }], 'a').map(n => n.nodeId), ['a', 'b']);
	// Siblings must come back in document order, not reversed by the LIFO stack.
	const ordered = [{ nodeId: 'r', childIds: ['a', 'b', 'c'] }, { nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }];
	eq('descendantsOf preserves sibling order', descendantsOf(ordered, 'r').map(n => n.nodeId), ['r', 'a', 'b', 'c']);

	// Tristate props arrive as strings; "false" must drop like a boolean false,
	// "true" must normalise to a boolean, and a numeric value must survive.
	const tri = [
		{ nodeId: 'c1', role: v('checkbox'), name: v('A'), properties: [{ name: 'checked', value: v('false') }] },
		{ nodeId: 'c2', role: v('checkbox'), name: v('B'), properties: [{ name: 'checked', value: v('true') }] },
		{ nodeId: 'c3', role: v('checkbox'), name: v('C'), properties: [{ name: 'checked', value: v('mixed') }] },
		{ nodeId: 's1', role: v('slider'), name: v('Vol'), value: v(42) },
	];
	eq('drops tristate "false"', project(tri)[0], { nodeId: 'c1', role: 'checkbox', name: 'A' });
	eq('normalises tristate "true" to boolean', project(tri)[1], { nodeId: 'c2', role: 'checkbox', name: 'B', checked: true });
	eq('keeps tristate "mixed"', project(tri)[2], { nodeId: 'c3', role: 'checkbox', name: 'C', checked: 'mixed' });
	eq('keeps a numeric value', project(tri)[3], { nodeId: 's1', role: 'slider', name: 'Vol', value: 42 });

	// The point of the exercise: framework wrappers must collapse to nothing.
	const spa = [];
	for (let i = 0; i < 1000; i++) spa.push({ nodeId: `g${i}`, role: v('generic'), name: v('') });
	for (let i = 0; i < 20; i++) spa.push({ nodeId: `b${i}`, role: v('button'), name: v(`Action ${i}`) });
	eq('only meaningful nodes survive', project(spa).length, 20);
}

// -------------------------------------------------------------------- png
{
	section('decodePng — a wrong un-filter yields plausible but wrong colours');
	const { decodePng, pixelAt } = await load('src/png.ts');

	// Encode by hand so the test does not depend on an encoder we also wrote.
	const table = (() => {
		const t = [];
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
			t[n] = c >>> 0;
		}
		return t;
	})();
	const crc32 = buf => {
		let x = 0xFFFFFFFF;
		for (const b of buf) x = table[(x ^ b) & 0xFF] ^ (x >>> 8);
		return (x ^ 0xFFFFFFFF) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const makePng = (w, h, pixels, filterRow) => {
		const ihdr = Buffer.alloc(13);
		ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
		ihdr[8] = 8;  // bit depth
		ihdr[9] = 6;  // RGBA
		const rows = [];
		for (let y = 0; y < h; y++) {
			const raw = Buffer.alloc(w * 4);
			for (let x = 0; x < w; x++) {
				const p = pixels[y * w + x];
				for (let c = 0; c < 4; c++) raw[x * 4 + c] = p[c];
			}
			rows.push(filterRow(raw, y, pixels, w));
		}
		return Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', ihdr),
			chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
			chunk('IEND', Buffer.alloc(0)),
		]);
	};

	const pixels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [18, 52, 86, 128]];
	const none = raw => Buffer.concat([Buffer.from([0]), raw]);
	const image = decodePng(makePng(2, 2, pixels, none));

	eq('reads the header', [image.width, image.height, image.channels], [2, 2, 4]);
	eq('red', pixelAt(image, 0, 0), { r: 255, g: 0, b: 0, a: 255, hex: '#ff0000' });
	eq('green', pixelAt(image, 1, 0), { r: 0, g: 255, b: 0, a: 255, hex: '#00ff00' });
	eq('blue', pixelAt(image, 0, 1), { r: 0, g: 0, b: 255, a: 255, hex: '#0000ff' });
	eq('alpha and zero-padded hex', pixelAt(image, 1, 1), { r: 18, g: 52, b: 86, a: 128, hex: '#123456' });
	eq('clamps out-of-range coordinates', pixelAt(image, 99, 99), { r: 18, g: 52, b: 86, a: 128, hex: '#123456' });

	// Chromium picks filters per scanline, so the un-filters must all agree.
	const sub = makePng(2, 2, pixels, raw => {
		const out = Buffer.from(raw);
		for (let i = raw.length - 1; i >= 4; i--) out[i] = (raw[i] - raw[i - 4]) & 0xff;
		return Buffer.concat([Buffer.from([1]), out]);
	});
	eq('filter 1 (Sub)', pixelAt(decodePng(sub), 1, 1), { r: 18, g: 52, b: 86, a: 128, hex: '#123456' });

	const up = makePng(2, 2, pixels, (raw, y, px, w) => {
		if (y === 0) return Buffer.concat([Buffer.from([0]), raw]);
		const prev = Buffer.alloc(w * 4);
		for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) prev[x * 4 + c] = px[x][c];
		const out = Buffer.alloc(raw.length);
		for (let i = 0; i < raw.length; i++) out[i] = (raw[i] - prev[i]) & 0xff;
		return Buffer.concat([Buffer.from([2]), out]);
	});
	eq('filter 2 (Up)', pixelAt(decodePng(up), 0, 1), { r: 0, g: 0, b: 255, a: 255, hex: '#0000ff' });

	// Average and Paeth are what Chromium emits most; a single-row image keeps
	// the previous row zero so the encoder just inverts the decoder's maths.
	const row2 = [[10, 20, 30, 40], [200, 100, 50, 255]];
	const avg = makePng(2, 1, row2, raw => {
		const out = Buffer.from(raw);
		for (let i = 0; i < raw.length; i++) { const left = i >= 4 ? raw[i - 4] : 0; out[i] = (raw[i] - (left >> 1)) & 0xff; }
		return Buffer.concat([Buffer.from([3]), out]);
	});
	eq('filter 3 (Average)', pixelAt(decodePng(avg), 1, 0), { r: 200, g: 100, b: 50, a: 255, hex: '#c86432' });

	const pae = makePng(2, 1, row2, raw => {
		const out = Buffer.from(raw);
		for (let i = 4; i < raw.length; i++) out[i] = (raw[i] - raw[i - 4]) & 0xff;
		return Buffer.concat([Buffer.from([4]), out]);
	});
	eq('filter 4 (Paeth)', pixelAt(decodePng(pae), 1, 0), { r: 200, g: 100, b: 50, a: 255, hex: '#c86432' });

	// RGB (colour type 2, 3 channels): alpha must default to 255.
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const rgbIhdr = Buffer.alloc(13); rgbIhdr.writeUInt32BE(1, 0); rgbIhdr.writeUInt32BE(1, 4); rgbIhdr[8] = 8; rgbIhdr[9] = 2;
	const rgbPng = Buffer.concat([sig, chunk('IHDR', rgbIhdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 10, 20, 30]))), chunk('IEND', Buffer.alloc(0))]);
	eq('RGB colour type defaults alpha to 255', pixelAt(decodePng(rgbPng), 0, 0), { r: 10, g: 20, b: 30, a: 255, hex: '#0a141e' });

	// A stream that inflates short must throw, not silently zero-fill.
	const shortIhdr = Buffer.alloc(13); shortIhdr.writeUInt32BE(2, 0); shortIhdr.writeUInt32BE(2, 4); shortIhdr[8] = 8; shortIhdr[9] = 6;
	const shortPng = Buffer.concat([sig, chunk('IHDR', shortIhdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(9))), chunk('IEND', Buffer.alloc(0))]);
	throws('rejects truncated image data', () => decodePng(shortPng));

	// A crafted oversized header must be rejected before allocating gigabytes.
	const bigIhdr = Buffer.alloc(13); bigIhdr.writeUInt32BE(40000, 0); bigIhdr.writeUInt32BE(40000, 4); bigIhdr[8] = 8; bigIhdr[9] = 6;
	const bigPng = Buffer.concat([sig, chunk('IHDR', bigIhdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(4))), chunk('IEND', Buffer.alloc(0))]);
	throws('rejects an oversized header', () => decodePng(bigPng));

	throws('rejects a non-PNG', () => decodePng(Buffer.from('definitely not a png')));
}

// -------------------------------------------------------------- instances
{
	section('instance selection — which VS Code window a call is routed to');
	const { selectInstance, resolveTarget, foreignWindowNote, readInstances } = await load('src/instances.ts');
	const inst = (workspace, extra = {}) => ({ workspace, pid: 1, startedAt: '2026-01-01T00:00:00.000Z', port: 3788, ...extra });

	const natrium = inst('/Users/x/src/electrolyte-natrium', { port: 3792, startedAt: '2026-08-18T10:01:00.000Z' });
	const energica = inst('/Users/x/src/energica-tool', { port: 3789, startedAt: '2026-08-17T17:03:53.000Z' });
	const src = inst('/Users/x/src', { port: 3790, startedAt: '2026-08-14T19:36:00.000Z' });
	const magnesium = inst('/Users/x/src/electrolyte-magnesium', { port: 3788, startedAt: '2026-08-17T14:03:29.000Z' });

	eq('exact workspace match', selectInstance([energica, natrium], '/Users/x/src/electrolyte-natrium').match, 'cwd');
	eq('cwd inside the workspace', selectInstance([energica, natrium], '/Users/x/src/electrolyte-natrium/app/models').instance.port, 3792);
	// The bug this whole block exists for: no window is registered for the
	// caller's directory, so an unrelated window gets driven.
	eq('no match falls back to the newest', selectInstance([magnesium, energica], '/Users/x/src/electrolyte-natrium').instance.port, 3789);
	eq('and says it fell back', selectInstance([magnesium, energica], '/Users/x/other').match, 'fallback');
	eq('deepest workspace wins over a parent', selectInstance([src, natrium], '/Users/x/src/electrolyte-natrium').instance.port, 3792);
	// A sibling directory sharing a prefix is not inside the workspace.
	eq('matches on a path boundary', selectInstance([natrium], '/Users/x/src/electrolyte-natrium-old').match, 'fallback');
	eq('nothing registered at all', selectInstance([], '/Users/x/src').instance, null);

	// resolveTarget: env pin wins, and still names the window it points at.
	const pinned = { BROWSER_BRIDGE_SOCKET: '/tmp/a.sock' };
	const socketInst = inst('/Users/x/src/pottagold', { port: undefined, socketPath: '/tmp/a.sock' });
	eq('env socket pin', resolveTarget(pinned, '/Users/x/elsewhere', [socketInst, energica]).match, 'env');
	eq('env pin resolves the window', resolveTarget(pinned, '/Users/x/elsewhere', [socketInst, energica]).instance.workspace, '/Users/x/src/pottagold');
	eq('env port pin', resolveTarget({ BROWSER_BRIDGE_PORT: '3789' }, '/Users/x/elsewhere', [energica]).endpoints, [{ port: 3789 }]);
	eq('ignores a junk env port', resolveTarget({ BROWSER_BRIDGE_PORT: 'nope' }, '/Users/x/src/energica-tool', [energica]).match, 'cwd');
	// A discovered instance is authoritative: no silent 3788 fallback appended,
	// because 3788 is a different workspace's bridge in a multi-window setup.
	eq('discovered socket only', resolveTarget({}, '/Users/x/src/pottagold', [socketInst, energica]).endpoints, [{ socketPath: '/tmp/a.sock' }]);
	eq('nothing discovered uses the default port', resolveTarget({}, '/Users/x/src', []).endpoints, [{ port: 3788 }]);

	// The note: only when the choice was genuinely ambiguous.
	const ambiguous = resolveTarget({}, '/Users/x/src/electrolyte-natrium', [magnesium, energica]);
	const note = foreignWindowNote(ambiguous);
	eq('warns on a fallback with several windows', typeof note, 'string');
	eq('names the window that got the call', note.includes('/Users/x/src/energica-tool'), true);
	eq('names the caller directory', note.includes('/Users/x/src/electrolyte-natrium'), true);
	eq('silent on a cwd match', foreignWindowNote(resolveTarget({}, '/Users/x/src/energica-tool', [energica, magnesium])), null);
	// One window open: the age fallback is the ordinary case, not an accident.
	eq('silent with a single window', foreignWindowNote(resolveTarget({}, '/Users/x/elsewhere', [energica])), null);
	eq('silent on an env pin', foreignWindowNote(resolveTarget(pinned, '/Users/x/elsewhere', [socketInst, energica])), null);

	// readInstances: a window that died leaves its file behind until swept.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibm-instances-'));
	fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify(inst('/Users/x/live', { pid: 100 })));
	fs.writeFileSync(path.join(dir, 'dead.json'), JSON.stringify(inst('/Users/x/dead', { pid: 200 })));
	fs.writeFileSync(path.join(dir, 'corrupt.json'), '{ not json');
	fs.writeFileSync(path.join(dir, 'ignore.txt'), 'not an instance file');
	eq('skips dead and corrupt instances', readInstances(dir, pid => pid === 100).map(i => i.workspace), ['/Users/x/live']);
	eq('missing dir is not an error', readInstances(path.join(dir, 'nope')), []);
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- clients
{
	section('ClientRegistry — per-session active tab, ownership, and the fallback-path lease');
	const { ClientRegistry, leaseBusyError, FALLBACK_LEASE_TTL_MS } = await load('src/clients.ts');

	// Active-tab resolution
	{
		const reg = new ClientRegistry();
		eq('unknown client, no fallback, resolves to nothing', reg.resolveActive('a', new Set(['t1']), null), null);
		eq('unknown client falls back on the single-tab path', reg.resolveActive('a', new Set(['t1']), 't1'), 't1');

		reg.setActive('a', 't1');
		eq('own active tab wins, no fallback needed', reg.resolveActive('a', new Set(['t1', 't2']), 't2'), 't1');
		eq('never another client\'s tab even without one of its own', reg.resolveActive('b', new Set(['t1']), null), null);

		eq('active tab that closed drops out', reg.resolveActive('a', new Set(['t2']), null), null);
	}

	// Ownership
	{
		const reg = new ClientRegistry();
		eq('unclaimed tab has no owner', reg.owner('t1'), undefined);
		reg.claimIfUnowned('t1', 'a');
		eq('first claim wins', reg.owner('t1'), 'a');
		reg.claimIfUnowned('t1', 'b');
		eq('a later claim on an owned tab is a no-op', reg.owner('t1'), 'a');
		reg.setOwner('t1', 'b');
		eq('setOwner reassigns outright (unlike claimIfUnowned)', reg.owner('t1'), 'b');

		// "the most recent other tab it owns": falls back to an owned tab once
		// the active one is gone, most-recently-claimed first.
		reg.setOwner('t2', 'c');
		reg.setOwner('t3', 'c');
		eq('falls back to the most recently claimed owned tab', reg.resolveActive('c', new Set(['t2', 't3']), null), 't3');
		reg.setActive('c', 't2');
		eq('an explicitly active tab still wins over ownership recency', reg.resolveActive('c', new Set(['t2', 't3']), null), 't2');
	}

	// Removing a tab (closed / revoked / untracked)
	{
		const reg = new ClientRegistry();
		reg.setActive('a', 't1');
		reg.setOwner('t1', 'a');
		reg.setOwner('t2', 'a');
		reg.removeTab('t1');
		eq('removed tab loses its owner', reg.owner('t1'), undefined);
		eq('removed active tab clears to null, not silently to another owned tab', reg.activeTabId('a'), null);
		eq('other ownership untouched', reg.owner('t2'), 'a');
		eq('falls back to the surviving owned tab once active is gone', reg.resolveActive('a', new Set(['t2']), null), 't2');
	}

	// Fallback-path lease
	{
		const reg = new ClientRegistry();
		const t0 = 1_000_000;
		eq('first controlling call claims the lease', reg.claimLease('a', t0), { ok: true });
		eq('the same client refreshes its own lease', reg.claimLease('a', t0 + 1000), { ok: true });
		const blocked = reg.claimLease('b', t0 + 2000);
		eq('a different client is refused while the lease is live', blocked, { ok: false, since: t0 + 1000 });
		// A blocked attempt has no side effect: the lease is still 'a's, unmoved.
		eq('a refused claim does not steal the lease', reg.claimLease('b', t0 + 2000), { ok: false, since: t0 + 1000 });
	}
	{
		// touchLease: refreshes only the current holder, never a bystander.
		const reg = new ClientRegistry();
		const t0 = 1_000_000;
		reg.claimLease('a', t0);
		reg.touchLease('b', t0 + 3000); // b does not hold it — no-op
		eq('touchLease is a no-op for a client that does not hold the lease', reg.claimLease('b', t0 + 3000).ok, false);
		reg.touchLease('a', t0 + 3000); // a refreshes its own
		eq('touchLease refreshes the holder\'s lease', reg.claimLease('b', t0 + 3000 + FALLBACK_LEASE_TTL_MS - 1).ok, false);
	}
	{
		// Past the TTL from the last refresh, the tab is up for grabs again.
		const reg = new ClientRegistry();
		const t0 = 1_000_000;
		reg.claimLease('a', t0);
		eq('lease expires after the TTL', reg.claimLease('b', t0 + FALLBACK_LEASE_TTL_MS + 1), { ok: true });
	}
	{
		// release() frees a held lease immediately, without waiting out the TTL.
		const reg = new ClientRegistry();
		const t0 = 1_000_000;
		reg.claimLease('a', t0);
		reg.release('a');
		eq('release frees a held lease immediately', reg.claimLease('b', t0 + 1), { ok: true });
	}
	{
		// The client cap evicts the least-recently-used session, not the
		// oldest busy one, and takes its ownership claims with it.
		const reg = new ClientRegistry();
		reg.setOwner('t1', 'a');
		for (let i = 0; i < 199; i++) reg.setActive(`c${i}`, 'x');
		reg.setActive('a', 't1');
		reg.setActive('late', 'x');
		eq('a recently used client survives the cap', reg.activeTabId('a'), 't1');
		eq('the least-recently-used client is evicted', reg.activeTabId('c0'), null);
		for (let i = 0; i < 200; i++) reg.setActive(`d${i}`, 'x');
		eq('an evicted client loses its ownership claims', reg.owner('t1'), undefined);
	}
	{
		// The lease guards the one fallback tab; once that tab is gone, the
		// next session must be able to drive the tab it relaunches.
		const reg = new ClientRegistry();
		const t0 = 1_000_000;
		reg.claimLease('a', t0);
		reg.removeTab('tab-main');
		eq('closing the fallback tab frees its lease', reg.claimLease('b', t0 + 1), { ok: true });
	}

	// release() also drops ownership and active-tab state
	{
		const reg = new ClientRegistry();
		reg.setActive('a', 't1');
		reg.setOwner('t1', 'a');
		reg.setOwner('t2', 'a');
		reg.release('a');
		eq('released client has no active tab', reg.activeTabId('a'), null);
		eq('released client\'s ownership claims are gone', [reg.owner('t1'), reg.owner('t2')], [undefined, undefined]);
	}

	// leaseBusyError: pure formatting, checked without the HTTP layer.
	eq('reports a fresh lease in seconds', leaseBusyError(0, 15_000).includes('15s ago'), true);
	eq('reports an older lease in minutes', leaseBusyError(0, 3 * 60_000).includes('3m ago'), true);
	eq('names the two ways it frees up', leaseBusyError(0, 0).includes('frees up when that session ends or after 5 minutes idle'), true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
	console.log(`${failures} FAILED`);
	process.exit(1);
}
