# Mercury sandbox smoke test

This reproducible smoke test validates Mercury inside the sandbox with `glm-5.1` without changing agent logic.

## What it automates

- manually loads `mercury-home/.env`
- exports `MERCURY_HOME`
- sets the working directory to the sandbox workspace
- starts Mercury in foreground mode with a PTY via `node dist/index.js start --foreground`
- selects `Ask Me` by sending `\r`
- sends `Reply with OK only.`
- verifies that the useful assistant response is exactly one line: `OK` (duplicate streamed output fails)
- stores both a raw transcript and an ANSI-stripped transcript

## Requirements

- `dist/index.js` must exist in the repo (`npm run build` if needed)
- `python3` with `pexpect` available
- a sandbox with:
  - `MERCURY_SANDBOX_HOME` pointing to your `mercury-home` directory
  - `MERCURY_SANDBOX_WORKSPACE` pointing to your sandbox workspace

By default, `scripts/run_mercury_sandbox_smoke.sh` derives sandbox paths from portable repo-relative locations:

- first choice: `$REPO_ROOT/sandbox/mercury-home` and `$REPO_ROOT/sandbox/workspace`
- fallback convenience: `$REPO_ROOT/../sandbox/mercury-home` and `$REPO_ROOT/../sandbox/workspace`

If your setup lives somewhere else, override the environment variables explicitly.

## Usage

From the repo root:

```bash
./scripts/run_mercury_sandbox_smoke.sh
```

You can optionally override paths or the prompt:

```bash
MERCURY_SANDBOX_HOME=/path/to/mercury-home \
MERCURY_SANDBOX_WORKSPACE=/path/to/workspace \
MERCURY_SMOKE_PROMPT='Reply with OK only.' \
./scripts/run_mercury_sandbox_smoke.sh
```

## Output

Transcripts are written to `tmp/mercury-smoke/`:

- `*.log`: raw terminal output
- `*.clean.txt`: cleaned output without ANSI sequences

The script fails if:

- `.env` is missing
- `dist/index.js` is missing
- startup does not show `glm-5.1`
- it cannot get past the permissions menu
- the assistant response is not exactly one line `OK` (including duplicated `OK` output)
