/**
 * Pure input helpers shared by `/click`, `/drag`, and `/press` — key-name
 * lookup, modifier bitmask, and point interpolation. No `vscode` import, so
 * `tests/unit.mjs` can bundle and exercise this module directly instead of
 * needing a live CDP connection.
 */

/** What `Input.dispatchKeyEvent` needs for one key. `text`/`unmodifiedText` are
 * present only for keys that should actually insert a character (printable
 * keys, and Enter for its `\r`) — see `/press` in http-server.ts, which drops
 * them when Control/Meta is held. */
export interface KeyDefinition {
	key: string;
	code: string;
	windowsVirtualKeyCode: number;
	nativeVirtualKeyCode: number;
	text?: string;
	unmodifiedText?: string;
}

interface NamedKey {
	code: string;
	vk: number;
	/** Only set for keys that insert a character (currently: Enter, Space). */
	text?: string;
	/** DOM `key` value when it differs from the name — Space's is ' '. */
	key?: string;
}

const NAMED_KEYS: Record<string, NamedKey> = {
	Escape: { code: 'Escape', vk: 27 },
	Enter: { code: 'Enter', vk: 13, text: '\r' },
	Tab: { code: 'Tab', vk: 9 },
	Backspace: { code: 'Backspace', vk: 8 },
	Delete: { code: 'Delete', vk: 46 },
	ArrowUp: { code: 'ArrowUp', vk: 38 },
	ArrowDown: { code: 'ArrowDown', vk: 40 },
	ArrowLeft: { code: 'ArrowLeft', vk: 37 },
	ArrowRight: { code: 'ArrowRight', vk: 39 },
	Home: { code: 'Home', vk: 36 },
	End: { code: 'End', vk: 35 },
	PageUp: { code: 'PageUp', vk: 33 },
	PageDown: { code: 'PageDown', vk: 34 },
	Space: { code: 'Space', vk: 32, text: ' ', key: ' ' },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS['F' + i] = { code: 'F' + i, vk: 111 + i };

/** Names accepted by `keyDefinition`, for the "unknown key" error message. Single printable characters are accepted too but aren't enumerable. */
export const SUPPORTED_KEY_NAMES: readonly string[] = Object.keys(NAMED_KEYS);

/**
 * Resolve a Playwright-style key name (or a single printable character) to
 * the fields `Input.dispatchKeyEvent` needs. Returns undefined for an
 * unrecognised multi-character name — the caller lists `SUPPORTED_KEY_NAMES`
 * in its error rather than silently sending a garbage keycode.
 */
export function keyDefinition(key: string): KeyDefinition | undefined {
	if (key.length === 1) {
		if (/[a-zA-Z]/.test(key)) {
			const upper = key.toUpperCase();
			const vk = upper.charCodeAt(0);
			return { key, code: 'Key' + upper, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: key, unmodifiedText: key };
		}
		if (/[0-9]/.test(key)) {
			const vk = key.charCodeAt(0);
			return { key, code: 'Digit' + key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: key, unmodifiedText: key };
		}
		if (key === ' ') {
			return { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' };
		}
		// Punctuation: `text` alone makes CDP insert the character, but legacy
		// `keyCode` handlers (the '/'-focuses-search idiom checks 191) need the
		// real Windows VK, which is not the character code. US layout, shifted
		// variants share the physical key with their base character.
		const punct = PUNCTUATION[key];
		if (punct) {
			return { key, code: punct.code, windowsVirtualKeyCode: punct.vk, nativeVirtualKeyCode: punct.vk, text: key, unmodifiedText: key };
		}
		// Anything else printable: no VK we can vouch for, so send none (keyCode
		// 0) rather than a wrong one; `key`/`text` still reach the page.
		return { key, code: '', windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0, text: key, unmodifiedText: key };
	}
	const named = NAMED_KEYS[key];
	if (!named) return undefined;
	return {
		key: named.key ?? key,
		code: named.code,
		windowsVirtualKeyCode: named.vk,
		nativeVirtualKeyCode: named.vk,
		...(named.text !== undefined ? { text: named.text, unmodifiedText: named.text } : {}),
	};
}

const PUNCTUATION: Record<string, { code: string; vk: number }> = {};
for (const [chars, code, vk] of [
	[';:', 'Semicolon', 186], ['=+', 'Equal', 187], [',<', 'Comma', 188], ['-_', 'Minus', 189],
	['.>', 'Period', 190], ['/?', 'Slash', 191], ['`~', 'Backquote', 192], ['[{', 'BracketLeft', 219],
	['\\|', 'Backslash', 220], [']}', 'BracketRight', 221], ['\'"', 'Quote', 222],
] as const) {
	for (const ch of chars) PUNCTUATION[ch] = { code, vk };
}
// Shifted digits sit on the digit keys.
for (const [i, ch] of [...')!@#$%^&*('].entries()) PUNCTUATION[ch] = { code: 'Digit' + i, vk: 48 + i };

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** CDP's `Input.dispatchKeyEvent` modifiers bitmask: Alt=1, Control=2, Meta=4, Shift=8. Unknown names are ignored rather than rejected. */
export function modifiersBitmask(modifiers: readonly string[] = []): number {
	let bits = 0;
	for (const m of modifiers) bits |= MODIFIER_BITS[m] ?? 0;
	return bits;
}

export interface Point {
	x: number;
	y: number;
}

/**
 * `steps` for `/drag` from an untrusted body value: default 10, clamped to
 * [1, 100]. A caller passing something outside that range gets a valid drag
 * instead of a rejected request. The single place the range is defined.
 */
export function clampSteps(raw: unknown): number {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 10;
	return Math.max(1, Math.min(100, Math.trunc(n)));
}

/**
 * `steps` evenly spaced points between `from` and `to`, excluding `from` (the
 * caller already dispatched `mousePressed` there) and always ending exactly on
 * `to` — computed directly rather than via the last `t = n/n` step, so it can't
 * drift off by a rounding error right before `mouseReleased` fires there.
 * `steps` is trusted to be a positive integer (see `clampSteps`).
 */
export function interpolate(from: Point, to: Point, steps: number): Point[] {
	const n = steps;
	const points: Point[] = [];
	for (let i = 1; i < n; i++) {
		const t = i / n;
		points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
	}
	points.push({ x: to.x, y: to.y });
	return points;
}
