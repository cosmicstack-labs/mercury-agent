#!/usr/bin/env bash
set -euo pipefail

# Node 22 is the baseline for every Mercury release (ADR-019: the bundled
# ink 8 renderer needs it). Build and publish on it, never on an older Node.
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "✗ Node $(node -v) — Mercury releases are built on Node 22 or newer (see .nvmrc). Run: nvm use" >&2
  exit 1
fi

echo "☿ Mercury Agent — Publish"
echo "────────────────────────────"

PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")

echo "Package: ${PKG_NAME}"
echo "Version: ${PKG_VERSION}"
echo ""

echo "1/6 Type checking..."
npm run typecheck

echo "2/6 Running tests..."
npm run test

echo "3/6 Verifying package integrity (dry-run install)..."
node scripts/verify-package.cjs

echo "4/6 Verifying shebang..."
head -1 dist/index.js

echo ""
echo "5/6 Publishing to npm..."
npm publish --access public

echo ""
echo "✓ Published ${PKG_NAME}@${PKG_VERSION}"

echo "Tagging git..."
git tag -a "v${PKG_VERSION}" -m "v${PKG_VERSION}"
echo "Done. Push with: git push origin main --tags"