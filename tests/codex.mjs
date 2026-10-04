import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';

if (process.platform === 'win32') {
	console.log('Codex MCP registration checks require a POSIX test executable');
	process.exit(0);
}

const result = await esbuild.build({
	entryPoints: ['src/codex.ts'],
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'node',
});
const loaded = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(
	loaded, loaded.exports, createRequire(import.meta.url),
);
const { configureCodexMcp } = loaded.exports;

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrated-browser-codex-'));
const fakeCodex = path.join(testDir, 'codex');
const statePath = path.join(testDir, 'state.json');
const serverName = 'integrated-browser-mcp';
const serverPath = path.join(testDir, 'mcp-server.mjs');
const messages = [];

fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
if (args.join(' ') === 'mcp list --json') {
  process.stdout.write(JSON.stringify(state.servers));
} else if (args[0] === 'mcp' && args[1] === 'add') {
  state.servers.push({ name: args[2] });
} else {
  process.exitCode = 1;
}
fs.writeFileSync(statePath, JSON.stringify(state));
`);
fs.chmodSync(fakeCodex, 0o755);

const setState = servers => fs.writeFileSync(statePath, JSON.stringify({ servers, calls: [] }));
const getState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

try {
	setState([]);
	await configureCodexMcp(serverName, serverPath, message => messages.push(message), fakeCodex);
	assert.deepEqual(getState().calls, [
		['mcp', 'list', '--json'],
		['mcp', 'add', serverName, '--', 'node', serverPath],
	]);

	await configureCodexMcp(serverName, serverPath, message => messages.push(message), fakeCodex);
	assert.equal(getState().calls.filter(call => call[1] === 'add').length, 1);

	setState([{ name: serverName, transport: { command: 'custom-browser' } }]);
	await configureCodexMcp(serverName, serverPath, message => messages.push(message), fakeCodex);
	assert.deepEqual(getState().calls, [['mcp', 'list', '--json']]);

	setState({ unexpected: 'shape' });
	await configureCodexMcp(serverName, serverPath, message => messages.push(message), fakeCodex);
	assert.deepEqual(getState().calls, [['mcp', 'list', '--json']]);
	assert.ok(messages.some(message => message.includes('unexpected MCP server list')));

	await configureCodexMcp(serverName, serverPath, message => messages.push(message), path.join(testDir, 'missing'));
	assert.ok(messages.some(message => message.includes('Could not inspect Codex')));
} finally {
	fs.rmSync(testDir, { recursive: true, force: true });
}

console.log('Codex MCP registration checks passed');
