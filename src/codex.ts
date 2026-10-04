import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function configureCodexMcp(
	serverName: string,
	serverPath: string,
	log: (message: string) => void,
	command = 'codex',
): Promise<void> {
	let servers: unknown;
	try {
		const { stdout } = await execFileAsync(command, ['mcp', 'list', '--json'], { timeout: 10_000, windowsHide: true });
		servers = JSON.parse(stdout);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`[MCP] Could not inspect Codex MCP servers: ${reason}`);
		return;
	}

	if (!Array.isArray(servers)) {
		log('[MCP] Codex returned an unexpected MCP server list');
		return;
	}

	if (servers.some(server => server !== null && typeof server === 'object' && 'name' in server && server.name === serverName)) {
		log('[MCP] Codex already configured');
		return;
	}

	try {
		await execFileAsync(command, ['mcp', 'add', serverName, '--', 'node', serverPath], { timeout: 10_000, windowsHide: true });
		log('[MCP] Configured Codex MCP');
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`[MCP] Failed to configure Codex: ${reason}`);
	}
}
