#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -d "$REPO_ROOT/sandbox" ]]; then
  DEFAULT_SANDBOX_ROOT="$REPO_ROOT/sandbox"
elif [[ -d "$REPO_ROOT/../sandbox" ]]; then
  DEFAULT_SANDBOX_ROOT="$(cd "$REPO_ROOT/../sandbox" && pwd)"
else
  DEFAULT_SANDBOX_ROOT="$REPO_ROOT/sandbox"
fi

SANDBOX_HOME="${MERCURY_SANDBOX_HOME:-$DEFAULT_SANDBOX_ROOT/mercury-home}"
WORKSPACE="${MERCURY_SANDBOX_WORKSPACE:-$DEFAULT_SANDBOX_ROOT/workspace}"
TRANSCRIPTS_DIR="${MERCURY_SMOKE_TRANSCRIPTS_DIR:-$REPO_ROOT/tmp/mercury-smoke}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TRANSCRIPT_PATH="$TRANSCRIPTS_DIR/mercury-smoke-$TIMESTAMP.log"
PROMPT="${MERCURY_SMOKE_PROMPT:-Reply with OK only.}"
EXPECTED_MODEL="${MERCURY_SMOKE_EXPECTED_MODEL:-glm-5.1}"
ENTRYPOINT="$REPO_ROOT/dist/index.js"

if [[ ! -f "$SANDBOX_HOME/.env" ]]; then
  echo "ERROR: missing $SANDBOX_HOME/.env" >&2
  echo "Tip: set MERCURY_SANDBOX_HOME if your sandbox lives elsewhere." >&2
  exit 1
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "ERROR: missing $ENTRYPOINT" >&2
  echo "Tip: build Mercury first with 'npm run build'." >&2
  exit 1
fi

mkdir -p "$TRANSCRIPTS_DIR"

# Reset sandbox token budget so runs don't accumulate across the same day
TOKEN_USAGE="$SANDBOX_HOME/token-usage.json"
if [[ -f "$TOKEN_USAGE" ]]; then
  TODAY="$(date +%Y-%m-%d)"
  python3 - "$TOKEN_USAGE" "$TODAY" <<'PYEOF'
import json, sys
path, today = sys.argv[1], sys.argv[2]
data = json.loads(open(path).read())
data["dailyUsed"] = 0
data["lastResetDate"] = today
data["requestLog"] = []
open(path, "w").write(json.dumps(data, indent=2))
PYEOF
  echo "[smoke] token budget reset for $TODAY"
fi

set -a
# shellcheck disable=SC1090
source "$SANDBOX_HOME/.env"
set +a
export MERCURY_HOME="$SANDBOX_HOME"

echo "[smoke] repo_root=$REPO_ROOT"
echo "[smoke] sandbox_root=$DEFAULT_SANDBOX_ROOT"
echo "[smoke] workspace=$WORKSPACE"
echo "[smoke] mercury_home=$MERCURY_HOME"
echo "[smoke] transcript=$TRANSCRIPT_PATH"

python3 "$REPO_ROOT/scripts/mercury_sandbox_smoke.py" \
  --workspace "$WORKSPACE" \
  --mercury-home "$SANDBOX_HOME" \
  --entrypoint "$ENTRYPOINT" \
  --transcript "$TRANSCRIPT_PATH" \
  --prompt "$PROMPT" \
  --expected-model "$EXPECTED_MODEL"
