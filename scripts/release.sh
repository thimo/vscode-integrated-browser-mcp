#!/usr/bin/env bash
# Release automation for integrated-browser-mcp.
#
# Usage:
#   scripts/release.sh <version> [flags]
#
# Flags:
#   --skip-smoke-test   Skip the manual smoke-test confirmation prompt
#   --no-marketplace    Skip the VS Code Marketplace publish step
#   --dry-run           Print every command without executing
#   --clean-install     Run `npm ci` during pre-flight (slower; defensive)
#   -h, --help          Show this help
#
# Steps (mirrors RELEASING.md):
#   1. Pre-flight: clean tree, on main, fast-forward, types/compile pass
#   2. Bump package.json + date-stamp `## Unreleased` in CHANGELOG.md
#   3. Commit, tag, build .vsix
#   4. Pause for smoke test (unless --skip-smoke-test)
#   5. Publish to VS Code Marketplace (unless --no-marketplace)
#   6. Push main + tag to origin
#   7. Create GitHub release with .vsix attached
#
# The smoke-test pause is the last reversible point. After confirmation the
# script publishes externally; failures past that point are recoverable
# (re-run individual steps) but irreversible (you can't unpublish).

set -euo pipefail

VERSION=""
SKIP_SMOKE=false
NO_MARKETPLACE=false
DRY_RUN=false
CLEAN_INSTALL=false

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-smoke-test) SKIP_SMOKE=true; shift ;;
		--no-marketplace) NO_MARKETPLACE=true; shift ;;
		--dry-run) DRY_RUN=true; shift ;;
		--clean-install) CLEAN_INSTALL=true; shift ;;
		-h|--help)
			# Print the leading comment block as help text.
			sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		-*)
			echo "Unknown flag: $1" >&2
			exit 1
			;;
		*)
			if [[ -n "$VERSION" ]]; then
				echo "Version specified twice: $VERSION and $1" >&2
				exit 1
			fi
			VERSION="$1"; shift
			;;
	esac
done

if [[ -z "$VERSION" ]]; then
	echo "Usage: $0 <version> [--skip-smoke-test] [--no-marketplace] [--dry-run] [--clean-install]" >&2
	exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Version must be X.Y.Z (got: $VERSION)" >&2
	exit 1
fi

run() {
	echo "+ $*"
	if ! $DRY_RUN; then
		"$@"
	fi
}

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

VSIX="integrated-browser-mcp-$VERSION.vsix"

# === 1. Pre-flight ===
echo "==> Pre-flight"

current_branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "main" ]]; then
	echo "Must be on main (currently on $current_branch)" >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	if $DRY_RUN; then
		echo "(dry-run: ignoring dirty tree)"
	else
		echo "Working tree must be clean. git status:" >&2
		git status --short >&2
		exit 1
	fi
fi

current_version=$(node -p "require('./package.json').version")
if [[ "$current_version" == "$VERSION" ]]; then
	echo "package.json is already at $VERSION — bump aborted" >&2
	exit 1
fi

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
	echo "Tag v$VERSION already exists locally" >&2
	exit 1
fi

if git ls-remote --tags origin "v$VERSION" 2>/dev/null | grep -q "refs/tags/v$VERSION$"; then
	echo "Tag v$VERSION already exists on origin" >&2
	exit 1
fi

if ! grep -q "^## Unreleased" CHANGELOG.md; then
	echo "CHANGELOG.md must have a '## Unreleased' section. Write release notes there first." >&2
	exit 1
fi

unreleased_body=$(awk '/^## Unreleased/{flag=1; next} /^## \[/{flag=0} flag' CHANGELOG.md | sed '/^[[:space:]]*$/d')
if [[ -z "$unreleased_body" ]]; then
	echo "CHANGELOG.md '## Unreleased' section is empty — write entries first." >&2
	exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
	echo "gh CLI not found in PATH. brew install gh" >&2
	exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
	echo "gh CLI not authenticated. Run: gh auth login" >&2
	exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
	echo "npx not found in PATH" >&2
	exit 1
fi

run git pull --ff-only

if $CLEAN_INSTALL; then
	run npm ci
fi

echo "==> Type-check + compile"
run npm run check-types
run npm run compile

# === 2. Bump ===
echo "==> Bumping to $VERSION ($(date +%Y-%m-%d))"

today=$(date +%Y-%m-%d)

if ! $DRY_RUN; then
	# package.json — use node so JSON formatting (2-space indent + trailing newline) is preserved.
	node -e "const fs=require('fs'); const p=require('./package.json'); p.version=process.argv[1]; fs.writeFileSync('./package.json', JSON.stringify(p, null, 2)+'\n');" "$VERSION"

	# CHANGELOG: replace '## Unreleased' (and any trailing whitespace on that line) with '## [VERSION] — DATE'.
	python3 - "$VERSION" "$today" <<'PY'
import re, sys
version, today = sys.argv[1], sys.argv[2]
path = 'CHANGELOG.md'
with open(path) as f:
    text = f.read()
# Match the literal '## Unreleased' header line, replace with the dated heading.
new = f'## [{version}] — {today}'
text, n = re.subn(r'^## Unreleased[ \t]*$', new, text, count=1, flags=re.MULTILINE)
if n == 0:
    sys.exit("Could not find '## Unreleased' line to replace")
with open(path, 'w') as f:
    f.write(text)
PY
fi

# === 3. Commit, tag, package ===
echo "==> Commit + tag + package"

run git add package.json CHANGELOG.md
run git commit -m "Release $VERSION"
run git tag "v$VERSION"

run npx vsce package --out "$VSIX"

if [[ ! -f "$VSIX" && "$DRY_RUN" == "false" ]]; then
	echo "Expected $VSIX to be produced by vsce package" >&2
	exit 1
fi

# === 4. Smoke test pause ===
if ! $SKIP_SMOKE; then
	cat <<EOF

==> Smoke test (manual)

  1. code --install-extension $VSIX --force
  2. Fully restart Claude Code (/exit + relaunch) — the MCP child process holds
     its tool list in memory; reinstalling on disk doesn't refresh a running one.
  3. Exercise the new features end-to-end against a real page.

If something is wrong, abort here and roll back with:
  git tag -d v$VERSION
  git reset --hard HEAD~1
  trash $VSIX

EOF
	read -r -p "Smoke test passed? Continue with marketplace + push + GitHub release? [y/N] " ans
	if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
		echo "Aborted before publish. Local commit + tag + .vsix retained." >&2
		exit 1
	fi
fi

# === 5. Marketplace ===
# Per RELEASING.md the marketplace publish runs before the git push. Order is
# defensive: if the marketplace rejects the .vsix (PAT expired, manifest issue),
# we want to find out before the tag is on origin.
if ! $NO_MARKETPLACE; then
	echo "==> Publishing to VS Code Marketplace"
	run npm run publish:marketplace -- --packagePath "$VSIX"
else
	echo "==> Skipping marketplace publish (--no-marketplace)"
fi

# === 6. Push ===
echo "==> Pushing main + tag to origin"
run git push origin main
run git push origin "v$VERSION"

# === 7. GitHub release ===
echo "==> Creating GitHub release"

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT

if ! $DRY_RUN; then
	# Extract the just-released CHANGELOG section as the release body.
	# Python over awk because awk's regex needs the version's dots escaped
	# and the bash-quoting-into-awk dance gets ugly fast.
	python3 - "$VERSION" "$notes" <<'PY'
import re, sys
version, notes_path = sys.argv[1], sys.argv[2]
with open('CHANGELOG.md') as f:
    text = f.read()
pattern = r'^## \[' + re.escape(version) + r'\][^\n]*\n(.*?)(?=^## \[|\Z)'
m = re.search(pattern, text, flags=re.MULTILINE | re.DOTALL)
body = (m.group(1) if m else '').strip()
if not body:
    sys.exit(f"Could not find CHANGELOG section for {version}")
with open(notes_path, 'w') as f:
    f.write(body + '\n')
PY
fi

run gh release create "v$VERSION" "$VSIX" \
	--title "v$VERSION" \
	--notes-file "$notes"

# === Done ===
cat <<EOF

==> Done

  Marketplace:  https://marketplace.visualstudio.com/items?itemName=thimo.integrated-browser-mcp
  GitHub:       https://github.com/thimo/integrated-browser-mcp/releases/tag/v$VERSION

EOF
