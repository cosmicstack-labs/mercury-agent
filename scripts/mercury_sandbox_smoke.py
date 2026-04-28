#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import signal
import sys
from pathlib import Path

import pexpect

DEFAULT_PROMPT = "Reply with OK only."
DEFAULT_MODEL = "glm-5.1"
DEFAULT_TIMEOUT = 180
ANSI_RE = re.compile(r"\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
SEPARATOR_RE = re.compile(r"^[\-─\s\d.]+s?$")


class TeeTranscript:
    def __init__(self, raw_path: Path) -> None:
        self.raw_path = raw_path
        self.raw_path.parent.mkdir(parents=True, exist_ok=True)
        self._file = raw_path.open("w", encoding="utf-8")
        self._chunks: list[str] = []

    def write(self, data: str) -> None:
        self._chunks.append(data)
        self._file.write(data)
        self._file.flush()

    def flush(self) -> None:
        self._file.flush()

    def close(self) -> None:
        self._file.close()

    def snapshot(self) -> int:
        return len(self.text)

    @property
    def text(self) -> str:
        return "".join(self._chunks)


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def normalize_lines(text: str) -> list[str]:
    cleaned = strip_ansi(text).replace("\r", "")
    return [line.rstrip() for line in cleaned.splitlines()]


def extract_assistant_payload(lines: list[str]) -> list[str]:
    payload: list[str] = []
    capturing = False

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("You:"):
            capturing = False
            continue
        if line in {"Mercury Sandbox:", "Mercury:"}:
            capturing = True
            continue
        if line.startswith("Mercury Sandbox is thinking"):
            continue
        if line.startswith("Confirm-before-act mode active"):
            continue
        if line.startswith("Mercury Sandbox is live"):
            continue
        if line.startswith("Ctrl+C to exit"):
            continue
        if line.startswith("Select permission mode"):
            continue
        if line.startswith("Choose how Mercury handles risky actions"):
            continue
        if line.startswith("↑↓ to move"):
            continue
        if line.startswith("Providers:") or line.startswith("Models:") or line.startswith("Skills:") or line.startswith("Creator:"):
            continue
        if SEPARATOR_RE.match(line):
            continue
        if capturing:
            payload.append(line)

    return payload


def validate_assistant_payload(payload: list[str]) -> None:
    if payload != ["OK"]:
        raise AssertionError(f"Assistant response was not exactly one line 'OK': {payload}")


def ensure_exists(path: Path, label: str) -> None:
    if not path.exists():
        raise SystemExit(f"ERROR: {label} does not exist: {path}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reproducible smoke test for Mercury sandbox (glm-5.1).")
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--mercury-home", required=True, type=Path)
    parser.add_argument("--entrypoint", required=True, type=Path)
    parser.add_argument("--transcript", required=True, type=Path)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--expected-model", default=DEFAULT_MODEL)
    parser.add_argument("--startup-timeout", type=int, default=60)
    parser.add_argument("--response-timeout", type=int, default=DEFAULT_TIMEOUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace = args.workspace.resolve()
    mercury_home = args.mercury_home.resolve()
    entrypoint = args.entrypoint.resolve()
    raw_transcript = args.transcript.resolve()
    clean_transcript = raw_transcript.with_suffix(".clean.txt")

    ensure_exists(workspace, "workspace")
    ensure_exists(mercury_home, "MERCURY_HOME")
    ensure_exists(mercury_home / ".env", "sandbox .env")
    ensure_exists(entrypoint, "Mercury entrypoint")

    env = os.environ.copy()
    env["MERCURY_HOME"] = str(mercury_home)
    env.setdefault("TERM", "xterm-256color")

    transcript = TeeTranscript(raw_transcript)
    child: pexpect.spawn | None = None

    try:
        print(f"[smoke] workspace={workspace}")
        print(f"[smoke] mercury_home={mercury_home}")
        print(f"[smoke] transcript={raw_transcript}")
        print(f"[smoke] clean_transcript={clean_transcript}")
        print(f"[smoke] expected_model={args.expected_model}")

        child = pexpect.spawn(
            "node",
            [str(entrypoint), "start", "--foreground"],
            cwd=str(workspace),
            env=env,
            encoding="utf-8",
            timeout=args.response_timeout,
        )
        child.delaybeforesend = 0.05
        child.logfile = transcript

        child.expect("Select permission mode:", timeout=args.startup_timeout)
        startup_lines = normalize_lines(transcript.text)
        if not any(args.expected_model in line for line in startup_lines):
            raise AssertionError(f"Expected model '{args.expected_model}' was not shown during startup.")

        child.send("\r")
        child.expect("Type a message and press Enter.", timeout=args.startup_timeout)
        child.expect("You: ", timeout=args.startup_timeout)

        response_start = transcript.snapshot()
        child.sendline(args.prompt)
        child.expect("Mercury Sandbox:", timeout=args.response_timeout)
        child.expect("You: ", timeout=args.response_timeout)

        response_segment = transcript.text[response_start:]
        payload = extract_assistant_payload(normalize_lines(response_segment))
        if not payload:
            raise AssertionError("Could not extract assistant response content.")
        validate_assistant_payload(payload)

        clean_transcript.write_text(strip_ansi(transcript.text).replace("\r", ""), encoding="utf-8")
        print("[smoke] PASS Mercury replied with OK only.")
        print(f"[smoke] assistant_payload={payload}")
        print(f"[smoke] raw_transcript={raw_transcript}")
        print(f"[smoke] clean_transcript={clean_transcript}")
        return 0
    except (pexpect.EOF, pexpect.TIMEOUT, AssertionError) as exc:
        clean_transcript.write_text(strip_ansi(transcript.text).replace("\r", ""), encoding="utf-8")
        print(f"[smoke] FAIL {exc}", file=sys.stderr)
        print(f"[smoke] raw_transcript={raw_transcript}", file=sys.stderr)
        print(f"[smoke] clean_transcript={clean_transcript}", file=sys.stderr)
        return 1
    finally:
        if child is not None and child.isalive():
            try:
                child.sendcontrol("c")
                child.expect(pexpect.EOF, timeout=20)
            except Exception:
                try:
                    child.kill(signal.SIGINT)
                except Exception:
                    pass
                try:
                    child.close(force=True)
                except Exception:
                    pass
        transcript.close()


if __name__ == "__main__":
    raise SystemExit(main())
