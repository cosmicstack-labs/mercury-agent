#!/usr/bin/env bash
# Checks for native build tool prerequisites needed by optional native modules (better-sqlite3).
# This is informational — it does NOT block the install, but warns the user early.
set -euo pipefail

echo "☿ Checking native build tool prerequisites..."

missing=0

if ! command -v make &>/dev/null; then
  echo "⚠  'make' not found — better-sqlite3 will not compile."
  echo "   Install with: sudo apt-get install build-essential  (Debian/Ubuntu)"
  echo "                 sudo yum groupinstall 'Development Tools'  (RHEL/CentOS)"
  missing=1
fi

if ! command -v gcc &>/dev/null && ! command -v cc &>/dev/null; then
  echo "⚠  C compiler not found — better-sqlite3 will not compile."
  echo "   Install with: sudo apt-get install gcc  (Debian/Ubuntu)"
  echo "                 sudo yum install gcc       (RHEL/CentOS)"
  missing=1
fi

if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
  echo "⚠  Python not found — better-sqlite3 will not compile."
  echo "   Install with: sudo apt-get install python3  (Debian/Ubuntu)"
  missing=1
fi

node_version=$(node -v 2>/dev/null || echo "unknown")
node_major=$(echo "$node_version" | sed 's/^v\([0-9]*\).*/\1/' 2>/dev/null || echo "0")

if [ "$node_major" -lt 22 ] 2>/dev/null; then
  echo "⚠  Node.js $node_version detected — Mercury requires Node >= 22."
  echo "   Upgrade with: nvm install 22"
  missing=1
fi

if [ "$missing" -eq 0 ]; then
  echo "✓  All native build prerequisites found."
else
  echo ""
  echo "   Second brain memory will be disabled until the above are resolved."
  echo "   The rest of mercury-agent will work fine without better-sqlite3."
fi