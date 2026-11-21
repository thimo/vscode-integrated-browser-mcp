import * as fs from 'fs';

/**
 * Read `~/.claude.json` for a read-modify-write. Returns `{}` only when the
 * file does not exist; any other failure (unparseable JSON from Claude Code
 * being mid-write, a trailing comma, a BOM, a non-object top level, EACCES)
 * returns null so the caller skips the write. Treating those as "empty" and
 * writing our entry back would replace the user's whole config.
 */
export async function readClaudeConfig(file: string): Promise<Record<string, unknown> | null> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(file, 'utf-8');
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}
