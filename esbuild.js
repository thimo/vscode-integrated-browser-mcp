const esbuild = require("esbuild");
const pkg = require("./package.json");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	// Build the VS Code extension (CommonJS, excludes vscode)
	const extCtx = await esbuild.context({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	// Build the MCP server (ESM, standalone stdio process)
	const mcpCtx = await esbuild.context({
		entryPoints: ['src/mcp-server.ts'],
		bundle: true,
		format: 'esm',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/mcp-server.mjs',
		banner: { js: '#!/usr/bin/env node' },
		// Inject the version from package.json so we have one source of
		// truth (mcp-server.ts declares __PKG_VERSION__ at the top).
		define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	if (watch) {
		await Promise.all([extCtx.watch(), mcpCtx.watch()]);
	} else {
		await Promise.all([extCtx.rebuild(), mcpCtx.rebuild()]);
		await Promise.all([extCtx.dispose(), mcpCtx.dispose()]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
