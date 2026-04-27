# Releasing

How to cut a release of `integrated-browser-mcp`. Optimised for muscle memory — copy-paste the commands.

## Versioning (SemVer)

- **Patch** `0.5.x` — bug fixes, no surface change
- **Minor** `0.x.0` — new MCP tools or HTTP endpoints, new options on existing ones
- **Major** `x.0.0` — breaking changes to the MCP tool surface or HTTP API

## One-time setup

- VS Code Marketplace personal access token, stored locally so `vsce publish` can authenticate. See [the vsce docs](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token).
- `gh` CLI logged in (`gh auth status`).

## Pre-flight

```bash
git switch main
git pull --ff-only
npm ci
npm run check-types
npm run compile
```

CHANGELOG should already have the new entries under `## [Unreleased]`. If not, write them now — leaning verbose is the project style; explain the *why* of each addition, not just the *what*.

## Bump

1. `package.json` → `"version"` — single source of truth. The MCP server reads this at build time via esbuild's `define` (see `esbuild.js`).
2. `CHANGELOG.md` → `## [Unreleased]` becomes `## [X.Y.Z] — YYYY-MM-DD`

## Commit, tag, build

```bash
git add package.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git tag vX.Y.Z
npx vsce package          # writes integrated-browser-mcp-X.Y.Z.vsix
```

## Smoke test (recommended)

Worth doing before publishing — the marketplace doesn't let you delete a published version, only deprecate.

```bash
code --install-extension integrated-browser-mcp-X.Y.Z.vsix --force
```

Then restart Claude Code (the MCP child process is captured at session start; reloading VS Code or reinstalling the extension doesn't refresh it). Run through the new features end-to-end against a real page.

## Publish to marketplace

```bash
npm run publish:marketplace -- --packagePath integrated-browser-mcp-X.Y.Z.vsix
```

The `publish:marketplace` script bakes in `--allow-proposed-apis browser`, which `vsce publish` requires because the extension declares `enabledApiProposals: ["browser"]`. Without that flag you'll get `Extensions using unallowed proposed API ... can't be published to the Marketplace`.

## Push and create GitHub Release

```bash
git push origin main
git push origin vX.Y.Z

gh release create vX.Y.Z integrated-browser-mcp-X.Y.Z.vsix \
  --title "vX.Y.Z" \
  --notes-file <(awk '/^## \[X\.Y\.Z\]/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md)
```

The `awk` pulls the just-released CHANGELOG section as the release body. Replace `X\.Y\.Z` with the actual version (escaping the dots for the regex). Example: for 0.5.0, it's `/^## \[0\.5\.0\]/`.

The release must include the `.vsix` so users who don't use the marketplace (or want to pin a version) can install it manually.

## Verify

- Marketplace listing shows the new version: <https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp>
- GitHub release is "Latest": <https://github.com/thimo/integrated-browser-mcp/releases>
- README badges render correctly on the repo home

## Troubleshooting

- **`vsce publish` says "Extensions using unallowed proposed API"** — you ran bare `vsce publish` instead of `npm run publish:marketplace`. The script passes the required flag.
- **VS Code Extension Development Host doesn't pick up new code** — `Developer: Reload Window`, or restart F5.
- **Claude Code doesn't see new MCP tools** — full Claude Code restart (`/exit` + relaunch). The MCP child process holds the registered tool set in memory; reinstalling the extension on disk doesn't replace an already-running child.
- **Tag already exists locally but you need to recreate it** — `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` then re-tag. Don't do this once a release is out — it breaks anyone who downloaded the tag.

## Why the manual smoke test step is non-negotiable

The Chromium and VS Code APIs this extension leans on (`Page.setDeviceMetricsOverride`, `BrowserTab` proposed API, the `vscode-js-debug` CDP proxy) are all moving targets. A diff that compiles and packages cleanly can still be a no-op at runtime if the underlying API changed shape. Treat compile + package as evidence of nothing about runtime behaviour.
