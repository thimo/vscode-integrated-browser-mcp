import * as http from 'http';
import * as fs from 'fs';
import express from 'express';
import type { CDPManager } from './cdp';
import type { CDPTab, DownloadBehavior } from './cdp-tab';
import type * as vscode from 'vscode';

const DOWNLOAD_BEHAVIORS: ReadonlySet<DownloadBehavior> = new Set(['allow', 'allowAndName', 'deny', 'default']);

export class BridgeServer {
	private app: express.Application;
	private server: http.Server | null = null;
	private cdp: CDPManager;
	private log: vscode.OutputChannel;
	private ensureBrowser: ((url?: string) => Promise<void>) | null = null;

	constructor(cdp: CDPManager, log: vscode.OutputChannel) {
		this.cdp = cdp;
		this.log = log;
		this.app = express();
		this.app.use(express.json());
		this.setupRoutes();
	}

	setEnsureBrowser(fn: (url?: string) => Promise<void>): void {
		this.ensureBrowser = fn;
	}

	/**
	 * Middleware that ensures at least one tab exists. If none exist, lazy-launches
	 * a browser. For `/navigate` (which has a URL), the launch navigates directly
	 * to the target; other endpoints get about:blank. Errors out if still no tab
	 * after the launch attempt.
	 */
	private requireAnyTab(lazyUrl?: (req: express.Request) => string | undefined): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
		return (req, res, next) => {
			const run = async () => {
				if (this.cdp.tabCount === 0 && this.ensureBrowser) {
					this.log.appendLine('[HTTP] No tabs, launching browser...');
					await this.ensureBrowser(lazyUrl?.(req));
				}
				if (this.cdp.state !== 'connected') {
					res.json({ ok: false, error: 'CDP not connected' });
					return;
				}
				next();
			};
			run().catch(err => {
				this.log.appendLine(`[HTTP] ensureBrowser error: ${err}`);
				res.json({ ok: false, error: 'Failed to launch browser' });
			});
		};
	}

	/** Resolve the target tab for a request (query `?tabId=` or body `tabId`). */
	private resolveTab(req: express.Request): { tab?: CDPTab; error?: string } {
		const tabId = (req.query.tabId as string | undefined) ?? (req.body?.tabId as string | undefined);
		const tab = this.cdp.getTab(tabId);
		if (!tab) {
			return { error: tabId ? `No tab with id ${tabId}` : 'No active tab. Use browser_tab_open first.' };
		}
		return { tab };
	}

	private setupRoutes(): void {
		const anyTab = this.requireAnyTab();
		const anyTabLazyNavigate = this.requireAnyTab(req => req.body?.url as string | undefined);

		// Health / diagnostic
		this.app.get('/status', (_req, res) => {
			res.json({
				ok: true,
				data: {
					cdp: this.cdp.state,
					server: true,
					transport: this.cdp.transport,
					activeTabId: this.cdp.activeTabId,
					tabCount: this.cdp.tabCount,
					pageSessionId: this.cdp.pageSessionId,
					children: this.cdp.children,
					consoleBufferSize: this.cdp.console.length,
					networkBufferSize: this.cdp.network.length,
					events: this.cdp.events,
				},
			});
		});

		// Tab management
		this.app.get('/tabs', (_req, res) => {
			res.json({ ok: true, data: this.cdp.list() });
		});

		this.app.post('/tab/open', async (req, res) => {
			try {
				const url = req.body.url;
				const makeActive = req.body.makeActive !== false;
				if (!url) {
					res.json({ ok: false, error: 'Missing url' });
					return;
				}
				const tab = await this.cdp.openTab(url, makeActive);
				res.json({ ok: true, data: { tabId: tab.tabId, url: tab.url, title: tab.title } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.post('/tab/close/:tabId', async (req, res) => {
			try {
				await this.cdp.closeTab(req.params.tabId);
				res.json({ ok: true, data: { closed: req.params.tabId } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.post('/tab/activate/:tabId', (req, res) => {
			try {
				this.cdp.activate(req.params.tabId);
				res.json({ ok: true, data: { active: req.params.tabId } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		// Navigation
		this.app.post('/navigate', anyTabLazyNavigate, async (req, res) => {
			try {
				const { url } = req.body;
				if (!url) {
					res.json({ ok: false, error: 'Missing url' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Page.navigate', { url });
				res.json({ ok: true, data: result });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Eval
		this.app.post('/eval', anyTab, async (req, res) => {
			try {
				const { expression } = req.body;
				if (!expression) {
					res.json({ ok: false, error: 'Missing expression' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression,
					returnByValue: true,
					awaitPromise: true,
				}) as { result: { value?: unknown; description?: string }; exceptionDetails?: unknown };
				if (result.exceptionDetails) {
					res.json({ ok: false, error: result.result.description ?? 'Evaluation error' });
					return;
				}
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Click
		this.app.post('/click', anyTab, async (req, res) => {
			try {
				const { selector } = req.body;
				if (!selector) {
					res.json({ ok: false, error: 'Missing selector' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const selectorJson = JSON.stringify(selector);
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression: `(() => {
						const sel = ${selectorJson};
						const el = document.querySelector(sel);
						if (!el) return { error: 'Element not found: ' + sel };
						el.click();
						return { clicked: true };
					})()`,
					returnByValue: true,
					awaitPromise: true,
				}) as { result: { value?: { error?: string; clicked?: boolean } } };
				const val = result.result.value;
				if (val?.error) {
					res.json({ ok: false, error: val.error });
					return;
				}
				res.json({ ok: true, data: val });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Type
		this.app.post('/type', anyTab, async (req, res) => {
			try {
				const { selector, text } = req.body;
				if (!selector || text === undefined) {
					res.json({ ok: false, error: 'Missing selector or text' });
					return;
				}
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const selectorJson = JSON.stringify(selector);
				const focusResult = await resolved.tab.send('Runtime.evaluate', {
					expression: `(() => {
						const sel = ${selectorJson};
						const el = document.querySelector(sel);
						if (!el) return { error: 'Element not found: ' + sel };
						el.focus();
						return { focused: true };
					})()`,
					returnByValue: true,
					awaitPromise: true,
				}) as { result: { value?: { error?: string } } };
				if (focusResult.result.value?.error) {
					res.json({ ok: false, error: focusResult.result.value.error });
					return;
				}
				await resolved.tab.send('Input.insertText', { text });
				res.json({ ok: true, data: { typed: text.length } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll
		this.app.post('/scroll', anyTab, async (req, res) => {
			try {
				const deltaX = Number(req.body.deltaX) || 0;
				const deltaY = Number(req.body.deltaY) || 0;
				const { selector } = req.body;
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				if (selector) {
					await resolved.tab.send('Runtime.evaluate', {
						expression: `document.querySelector(${JSON.stringify(selector)})?.scrollBy(${deltaX}, ${deltaY})`,
						returnByValue: true,
					});
				} else {
					await resolved.tab.send('Runtime.evaluate', {
						expression: `window.scrollBy(${deltaX}, ${deltaY})`,
						returnByValue: true,
					});
				}
				res.json({ ok: true, data: { scrolled: true } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Screenshot. `fullPage=true` captures the whole scrollable page
		// (`captureBeyondViewport`); default is viewport-only. `waitMs`
		// sleeps before the capture — needed when the page is mid-CSS-
		// transition (theme flip, view swap), where `className` changes
		// synchronously but paint lags by the transition duration.
		this.app.get('/screenshot', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const fullPage = req.query.fullPage === 'true';
				const waitMs = Math.min(10000, Math.max(0, Number(req.query.waitMs) || 0));
				if (waitMs > 0) {
					await new Promise(resolve => setTimeout(resolve, waitMs));
				}
				const result = await resolved.tab.send('Page.captureScreenshot', {
					format: 'png',
					captureBeyondViewport: fullPage,
				}) as { data: string };
				res.json({ ok: true, data: result.data });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Emulate device metrics + (when mobile) touch + optional UA.
		// Sticky until cleared with `{reset:true}` — leaking emulation
		// between tool calls is a frequent "why does my screenshot look
		// wrong" source. `mobile:true` also flips touch on so
		// `(hover:none)` / `(pointer:coarse)` media queries fire;
		// without that, mobile sites render their desktop fallback even
		// at iPhone dimensions.
		//
		// Uses the deprecated `Page.setDeviceMetricsOverride` rather
		// than the modern `Emulation.setDeviceMetricsOverride`. In a
		// normal Chrome they're equivalent, but VS Code's `BrowserTab`
		// surface silently drops the Emulation call's
		// width/height/deviceScaleFactor (only the mobile flag sticks).
		// The deprecated `Page.*` path isn't filtered and is the only
		// way to get actual viewport + DPR overrides in the integrated
		// browser pane. `Emulation.clearDeviceMetricsOverride` clears
		// the Page.* override too, so reset stays one call.
		this.app.post('/emulate', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const { reset, width, height, deviceScaleFactor, mobile, userAgent } = req.body;
				if (reset) {
					await resolved.tab.send('Emulation.clearDeviceMetricsOverride');
					await resolved.tab.send('Emulation.setTouchEmulationEnabled', { enabled: false });
					await resolved.tab.send('Emulation.setUserAgentOverride', { userAgent: '' });
					res.json({ ok: true, data: { reset: true } });
					return;
				}
				if (typeof width !== 'number' || typeof height !== 'number') {
					res.json({ ok: false, error: 'Missing width and height (or pass {reset:true} to clear)' });
					return;
				}
				const isMobile = mobile === true;
				await resolved.tab.send('Page.setDeviceMetricsOverride', {
					width,
					height,
					deviceScaleFactor: typeof deviceScaleFactor === 'number' ? deviceScaleFactor : 1,
					mobile: isMobile,
				});
				await resolved.tab.send('Emulation.setTouchEmulationEnabled', { enabled: isMobile });
				if (typeof userAgent === 'string' && userAgent.length > 0) {
					await resolved.tab.send('Emulation.setUserAgentOverride', { userAgent });
				}
				res.json({ ok: true, data: { width, height, deviceScaleFactor: deviceScaleFactor ?? 1, mobile: isMobile, userAgent: userAgent ?? null } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Scroll-and-capture one viewport-height slice. Returns metadata
		// always, image only when `slice` is provided. Designed for AI
		// consumers of tall pages: Chromium's single-PNG axis cap
		// (~16384 px) makes `fullPage` capture fail on huge docs, and
		// compressing a 60k-px-tall image to thumbnail loses the detail
		// the model needs anyway. The AI-friendlier flow is (1) call
		// with no slice to learn the page shape, (2) request specific
		// slices by index. `slice: 0` is the top, `slice: -1` is the
		// last (Pythonic negative indexing). Out-of-range clamps.
		// Pair with `browser_emulate` first to anchor the viewport at a
		// real desktop/mobile size — slicing the editor pane's natural
		// width gives meaningless results.
		this.app.get('/screenshot-slice', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const dims = await resolved.tab.send('Runtime.evaluate', {
					expression: '({scrollHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight})',
					returnByValue: true,
				}) as { result: { value: { scrollHeight: number; viewportHeight: number } } };
				const { scrollHeight, viewportHeight } = dims.result.value;
				const totalSlices = Math.max(1, Math.ceil(scrollHeight / viewportHeight));

				const sliceParam = req.query.slice;
				if (sliceParam === undefined || sliceParam === '') {
					res.json({ ok: true, data: { totalSlices, scrollHeight, viewportHeight, slice: null } });
					return;
				}
				const rawSlice = Number(sliceParam);
				if (!Number.isFinite(rawSlice)) {
					res.json({ ok: false, error: 'slice must be an integer (negative counts from end)' });
					return;
				}
				let slice = Math.trunc(rawSlice);
				if (slice < 0) slice = totalSlices + slice;
				slice = Math.max(0, Math.min(totalSlices - 1, slice));

				const targetY = slice * viewportHeight;
				await resolved.tab.send('Runtime.evaluate', {
					expression: `window.scrollTo(0, ${targetY}); new Promise(r => setTimeout(r, 200))`,
					returnByValue: true,
					awaitPromise: true,
				});
				const shot = await resolved.tab.send('Page.captureScreenshot', { format: 'png' }) as { data: string };
				res.json({ ok: true, data: { totalSlices, scrollHeight, viewportHeight, slice, image: shot.data } });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Markdown extraction. Pure-JS DOM walker injected into the page;
		// no Readability/Turndown, no deps. Maps headings → `#`, links →
		// `[text](url)`, code/pre → backtick markup, lists → `-` / `1.`,
		// blockquotes → `>`. Skips script/style/svg/iframe/button.
		//
		// Two non-obvious refinements over a naive walker, both forced by
		// real-world docs sites (Apple Developer in particular):
		//
		//  1. *Link-text trim.* Apple's HTML often contains `<a> View </a>`
		//     with whitespace inside the anchor. A naive walker emits
		//     `[ View ](...)`, which renders with literal brackets-with-
		//     spaces in most markdown viewers. Trimming the inner text
		//     before bracketing produces clean `[View](...)`.
		//
		//  2. *Inline-sibling separator.* When a parent contains adjacent
		//     inline elements with no whitespace between them in the
		//     source — Apple's platform availability is the canonical
		//     case: `<span>iOS 13.0+</span><span>iPadOS 13.0+</span>` —
		//     concatenating their text gives the run-on "iOS 13.0+iPadOS
		//     13.0+". When walking children, if two adjacent kids are
		//     both inline elements and the join would mash non-whitespace
		//     against non-whitespace, insert a single space. A boundary
		//     character on either side (punctuation, whitespace) opts out
		//     so we don't break `<strong>word</strong>.`.
		this.app.get('/markdown', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const selector = (req.query.selector as string | undefined) || 'main';
				const expression = `(() => {
					const root = document.querySelector(${JSON.stringify(selector)}) || document.body;
					const SKIP = new Set(['script','style','noscript','svg','iframe','button']);
					const INLINE = new Set(['span','a','strong','b','em','i','code','small','sub','sup','mark']);
					function walk(n) {
						if (n.nodeType === 3) return n.textContent.replace(/\\s+/g, ' ');
						if (n.nodeType !== 1) return '';
						const tag = n.tagName.toLowerCase();
						if (SKIP.has(tag)) return '';
						let kids = '';
						let prev = null;
						for (const c of n.childNodes) {
							const p = walk(c);
							if (!p) continue;
							if (kids && prev && prev.nodeType === 1 && INLINE.has(prev.tagName.toLowerCase())
									&& c.nodeType === 1 && INLINE.has(c.tagName.toLowerCase())) {
								const lc = kids[kids.length - 1], fc = p[0];
								if (/\\S/.test(lc) && /\\S/.test(fc)) kids += ' ';
							}
							kids += p;
							prev = c;
						}
						switch (tag) {
							case 'h1': return '\\n\\n# ' + kids.trim() + '\\n\\n';
							case 'h2': return '\\n\\n## ' + kids.trim() + '\\n\\n';
							case 'h3': return '\\n\\n### ' + kids.trim() + '\\n\\n';
							case 'h4': return '\\n\\n#### ' + kids.trim() + '\\n\\n';
							case 'h5': return '\\n\\n##### ' + kids.trim() + '\\n\\n';
							case 'h6': return '\\n\\n###### ' + kids.trim() + '\\n\\n';
							case 'p': return '\\n\\n' + kids.trim() + '\\n\\n';
							case 'br': return '\\n';
							case 'hr': return '\\n\\n---\\n\\n';
							case 'strong': case 'b': return '**' + kids + '**';
							case 'em': case 'i': return '*' + kids + '*';
							case 'code':
								if (n.parentElement && n.parentElement.tagName === 'PRE') return kids;
								return '\`' + kids + '\`';
							case 'pre': return '\\n\\n\`\`\`\\n' + n.textContent.trim() + '\\n\`\`\`\\n\\n';
							case 'a': { const h = n.getAttribute('href'); const t = kids.trim(); return h ? '[' + t + '](' + h + ')' : t; }
							case 'img': { const a = n.getAttribute('alt') || ''; const s = n.getAttribute('src') || ''; return s ? '![' + a + '](' + s + ')' : ''; }
							case 'li': { const ord = n.parentElement && n.parentElement.tagName === 'OL'; return (ord ? '1. ' : '- ') + kids.trim() + '\\n'; }
							case 'ul': case 'ol': return '\\n' + kids + '\\n';
							case 'blockquote': return '\\n' + kids.split('\\n').map(l => l ? '> ' + l : '').join('\\n') + '\\n\\n';
							default: return kids;
						}
					}
					return walk(root).replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]+$/gm, '').trim();
				})()`;
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression,
					returnByValue: true,
				}) as { result: { value?: string; description?: string }; exceptionDetails?: unknown };
				if (result.exceptionDetails) {
					res.json({ ok: false, error: result.result.description ?? 'Markdown extraction failed' });
					return;
				}
				res.json({ ok: true, data: result.result.value ?? '' });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Accessibility snapshot
		this.app.get('/snapshot', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Accessibility.getFullAXTree') as { nodes: unknown[] };
				res.json({ ok: true, data: result.nodes });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// DOM
		this.app.get('/dom', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression: 'document.documentElement.outerHTML',
					returnByValue: true,
				}) as { result: { value?: string } };
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Console — filter by tabId when provided, aggregated otherwise
		this.app.get('/console', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const tabId = req.query.tabId as string | undefined;
			const entries = tabId ? this.cdp.consoleForTab(tabId) : this.cdp.console;
			res.json({ ok: true, data: entries.slice(-limit) });
		});

		// Network — filter by tabId when provided, aggregated otherwise
		this.app.get('/network', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 50;
			const tabId = req.query.tabId as string | undefined;
			const filter = req.query.filter as string | undefined;
			let entries = tabId ? this.cdp.networkForTab(tabId) : this.cdp.network;
			if (filter) {
				entries = entries.filter(e => e.url.includes(filter));
			}
			res.json({ ok: true, data: entries.slice(-limit) });
		});

		this.app.post('/network/clear', (req, res) => {
			const tabId = req.query.tabId as string | undefined;
			this.cdp.clearNetwork(tabId);
			res.json({ ok: true, data: { cleared: tabId ?? 'all' } });
		});

		// Download behavior. Replaces the native save dialog with a configured
		// directory so an agent can download files headless. Path scoping to
		// the workspace happens in the MCP layer (browser_download_set);
		// callers hitting this endpoint directly (curl, scripts) pass an
		// absolute path and own the consequences.
		this.app.post('/download/set', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const downloadPath = req.body.path as string | undefined;
				const behavior = (req.body.behavior as string | undefined) ?? 'allow';
				if (!DOWNLOAD_BEHAVIORS.has(behavior as DownloadBehavior)) {
					res.json({ ok: false, error: `Invalid behavior "${behavior}". Expected one of: allow, allowAndName, deny, default` });
					return;
				}
				if (behavior === 'allow' || behavior === 'allowAndName') {
					if (!downloadPath) {
						res.json({ ok: false, error: 'path is required for behavior allow/allowAndName' });
						return;
					}
					await fs.promises.mkdir(downloadPath, { recursive: true });
				}
				await resolved.tab.setDownloadBehavior(downloadPath ?? '', behavior as DownloadBehavior);
				res.json({ ok: true, data: { path: (behavior === 'allow' || behavior === 'allowAndName') ? downloadPath : null, behavior } });
			} catch (err) {
				res.json({ ok: false, error: String(err instanceof Error ? err.message : err) });
			}
		});

		this.app.get('/downloads', (req, res) => {
			const limit = parseInt(req.query.limit as string) || 20;
			const tabId = req.query.tabId as string | undefined;
			const entries = tabId ? this.cdp.downloadsForTab(tabId) : this.cdp.downloads;
			res.json({ ok: true, data: entries.slice(-limit) });
		});

		// URL
		this.app.get('/url', anyTab, async (req, res) => {
			try {
				const resolved = this.resolveTab(req);
				if (!resolved.tab) { res.json({ ok: false, error: resolved.error }); return; }
				const result = await resolved.tab.send('Runtime.evaluate', {
					expression: 'window.location.href',
					returnByValue: true,
				}) as { result: { value?: string } };
				res.json({ ok: true, data: result.result.value });
			} catch (err) {
				res.json({ ok: false, error: String(err) });
			}
		});

		// Global error handler
		this.app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
			this.log.appendLine(`[HTTP] Unhandled error: ${err.message}`);
			res.status(500).json({ ok: false, error: 'Internal server error' });
		});
	}

	get port(): number | null {
		const addr = this.server?.address();
		return addr && typeof addr === 'object' ? addr.port : null;
	}

	async start(preferredPort: number, maxRetries = 20): Promise<number> {
		for (let attempt = 0; attempt < maxRetries; attempt++) {
			const port = preferredPort + attempt;
			try {
				await this.listen(port);
				return port;
			} catch (err: unknown) {
				if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EADDRINUSE') {
					this.log.appendLine(`[HTTP] Port ${port} in use, trying next...`);
					continue;
				}
				throw err;
			}
		}
		throw new Error(`No free port found after ${maxRetries} attempts starting from ${preferredPort}`);
	}

	private listen(port: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const server = this.app.listen(port, '127.0.0.1');
			server.once('listening', () => {
				this.server = server;
				this.log.appendLine(`[HTTP] Server listening on http://127.0.0.1:${port}`);
				resolve();
			});
			server.once('error', (err) => {
				server.close();
				reject(err);
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.closeAllConnections();
				this.server.close(() => resolve());
				this.server = null;
			} else {
				resolve();
			}
		});
	}
}
