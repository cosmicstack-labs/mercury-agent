#!/usr/bin/env python3
from __future__ import annotations

import unittest

from scripts.mercury_sandbox_smoke import extract_assistant_payload, normalize_lines, validate_assistant_payload


class MercurySandboxSmokeTest(unittest.TestCase):
    def test_extracts_single_ok_payload_from_cleaned_transcript(self) -> None:
        response_segment = """You: Reply with OK only.\nMercury Sandbox:\nMercury Sandbox is thinking...\nOK\nYou: \n"""

        payload = extract_assistant_payload(normalize_lines(response_segment))

        self.assertEqual(payload, ["OK"])

    def test_rejects_duplicate_ok_payload(self) -> None:
        with self.assertRaisesRegex(AssertionError, "exactly one line 'OK'"):
            validate_assistant_payload(["OK", "OK"])


if __name__ == "__main__":
    unittest.main()
