#!/usr/bin/env bash
set -euo pipefail

# Node 22 is the baseline for every Mercury release (ADR-019: the bundled
# ink 8 renderer needs it). Build and publish on it, never on an older Node.
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node $(node -v) — Mercury releases are built on Node 22 or newer (see .nvmrc). Run: nvm use" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Mercury DEV-channel publisher
#
# Publishes a dev build as the rolling GitHub PRE-release `mercury-dev-latest`:
#
#   - pre-releases are EXCLUDED from /releases/latest, so the stable install
#     script and every current user are untouched;
#   - the tag is force-moved on each run, so this script is the single source
#     of "the latest dev build";
#   - `release/` stays git-ignored — binaries are Release assets, never git
#     objects (GitHub rejects files >100MB in git; these are 65–99MB).
#
# Dev users install/update with:
#   curl -fsSL https://mercuryagent.sh/install-dev.sh | sh
#
# What this script does, in order:
#   1. typecheck + test suite           (never publish broken dev builds)
#   2. npm run build                    (tsup stamps MERCURY_CHANNEL_VERSION)
#   3. build-bin --dev                  (5 Bun-compiled targets → release/dev)
#   4. delete + recreate the rolling    (gh CLI, authenticated as you)
#      mercury-dev-latest pre-release
# ─────────────────────────────────────────────────────────────────────────────

REPO="${GITHUB_REPO:-cosmicstack-labs/mercury-agent}"
DEV_TAG="${DEV_TAG:-mercury-dev-latest}"

echo "☿ Mercury Agent — Dev-channel publish"
echo "────────────────────────────"

STAMP="$(date -u +%Y%m%d)"
SHORT_SHA="$(git rev-parse --short HEAD)"
DEV_VERSION="$(node -p "require('./package.json').version")-dev.${STAMP}.${SHORT_SHA}"

echo "Package:   $(node -p "require('./package.json').name")"
echo "Dev build: ${DEV_VERSION}"
echo "Rolling t: ${DEV_TAG} (force-moved)"
echo ""

command -v gh >/dev/null 2>&1 || { echo "x gh CLI not found — install it and run 'gh auth login'." >&2; exit 1; }

echo "1/4 Type checking..."
npm run typecheck

echo "2/4 Running tests..."
npm run test

echo "3/4 Building (version stamped as ${DEV_VERSION})..."
MERCURY_CHANNEL_VERSION="$DEV_VERSION" npm run build
node scripts/build-bin.cjs --dev

echo "4/4 Publishing rolling pre-release ${DEV_TAG}..."
# The tag has no value beyond "latest dev build" — delete and recreate is the
# simplest force-move. Cleanup-tag keeps git from accumulating orphan tags.
gh release delete "$DEV_TAG" --repo "$REPO" --yes --cleanup-tag 2>/dev/null || \
  echo "  (no existing ${DEV_TAG} — first dev publish)"

# A stable release might legitimately own these tag names; --dev builds never
# overwrite one that exists on a numbered release (delete above only touches
# our own rolling tag, which is always a pre-release).
NOTES="Dev build ${DEV_VERSION}.
Rolling preview — may be unstable. Stable users are NOT served this release.

Install: curl -fsSL https://mercuryagent.sh/install-dev.sh | sh  (macOS/Linux)
Windows: irm https://mercuryagent.sh/install-dev.ps1 | iex"

gh release create "$DEV_TAG" release/dev/* --repo "$REPO" \
  --prerelease \
  --target "$(git rev-parse --abbrev-ref HEAD)" \
  --title "Mercury Dev — ${DEV_VERSION}" \
  --notes "$NOTES"

echo ""
echo "✓ Dev channel updated: https://github.com/${REPO}/releases/tag/${DEV_TAG}"
echo "  Install/update: curl -fsSL https://mercuryagent.sh/install-dev.sh | sh"
echo "  A stable release published later still wins on /releases/latest."