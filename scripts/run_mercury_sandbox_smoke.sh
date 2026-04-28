#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_HOME="${MERCURY_SANDBOX_HOME:-/home/raul/dev/mercury-test/sandbox/mercury-home}"
WORKSPACE="${MERCURY_SANDBOX_WORKSPACE:-/home/raul/dev/mercury-test/sandbox/workspace}"
TRANSCRIPTS_DIR="${MERCURY_SMOKE_TRANSCRIPTS_DIR:-$REPO_ROOT/tmp/mercury-smoke}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TRANSCRIPT_PATH="$TRANSCRIPTS_DIR/mercury-smoke-$TIMESTAMP.log"
PROMPT="${MERCURY_SMOKE_PROMPT:-Di solo OK y nada más.}"
EXPECTED_MODEL="${MERCURY_SMOKE_EXPECTED_MODEL:-glm-5.1}"
ENTRYPOINT="$REPO_ROOT/dist/index.js"

if [[ ! -f "$SANDBOX_HOME/.env" ]]; then
  echo "ERROR: no existe $SANDBOX_HOME/.env" >&2
  exit 1
fi

if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "ERROR: no existe $ENTRYPOINT" >&2
  echo "Tip: compila Mercury antes con 'npm run build'." >&2
  exit 1
fi

mkdir -p "$TRANSCRIPTS_DIR"

set -a
# shellcheck disable=SC1090
source "$SANDBOX_HOME/.env"
set +a
export MERCURY_HOME="$SANDBOX_HOME"

echo "[smoke] repo_root=$REPO_ROOT"
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
