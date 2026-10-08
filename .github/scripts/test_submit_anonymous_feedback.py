#!/usr/bin/env python3
"""Offline tests for the GitHub Actions feedback writer; never writes to GitHub."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO

SCRIPT = Path(__file__).with_name("submit_anonymous_feedback.py")
spec = importlib.util.spec_from_file_location("feedback_writer", SCRIPT)
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)

class FakeResponse:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self):
        return self.payload

class FeedbackWriterTests(unittest.TestCase):
    def run_writer(self, extra_env=None, responses=()):
        env = {
            "CONSENT_CONFIRMED": "yes",
            "POST_REPORT_UPDATES_COMPLETE": "yes",
            "TOOL_VERSION": "V0.9",
            "SUMMARY": "The test asked too few questions before giving a recommendation.",
            "EVALUATION": "Please ask about time available.",
            "GITHUB_TOKEN": "unit-test-token",
            "GITHUB_REPOSITORY": "njyuer-arch/side-hustle-direction-self-test",
        }
        if extra_env:
            env.update(extra_env)
        output = StringIO()
        error = StringIO()
        with patch.dict(os.environ, env, clear=True):
            with patch.object(writer.urllib.request, "urlopen", side_effect=list(responses)) as request:
                with redirect_stdout(output), redirect_stderr(error):
                    writer.main()
        return output.getvalue(), error.getvalue(), request

    def test_success_writes_deidentified_entry_as_actions_bot(self):
        output, _, request = self.run_writer(responses=[
            FakeResponse({"default_branch": "main"}),
            FakeResponse({
                "content": {"html_url": "https://github.com/njyuer-arch/side-hustle-direction-self-test/blob/main/feedback/entries/2026-10/id.md"},
                "commit": {"sha": "a" * 40},
            }),
        ])
        self.assertEqual(request.call_count, 2)
        payload = json.loads(request.call_args_list[1].args[0].data)
        self.assertEqual(payload["author"]["name"], "github-actions[bot]")
        self.assertEqual(payload["committer"]["name"], "github-actions[bot]")
        document = base64.b64decode(payload["content"]).decode("utf-8")
        self.assertIn("Tester identity: not collected", document)
        self.assertIn("De-identified summary", document)
        self.assertNotIn("GITHUB_TOKEN", document)
        self.assertIn('"status": "success"', output)
        self.assertIn("feedback/entries/2026-10/", output)

    def test_no_consent_fails_closed_without_network(self):
        with self.assertRaises(SystemExit):
            self.run_writer({"CONSENT_CONFIRMED": "no"})

    def test_incomplete_corrections_fail_closed_without_network(self):
        with self.assertRaises(SystemExit):
            self.run_writer({"POST_REPORT_UPDATES_COMPLETE": "no"})

    def test_direct_identifier_fails_closed_without_network(self):
        with self.assertRaises(SystemExit):
            self.run_writer({"SUMMARY": "Call me at 13812345678"})

    def test_missing_success_receipt_does_not_report_success(self):
        with self.assertRaises(SystemExit):
            self.run_writer(responses=[
                FakeResponse({"default_branch": "main"}),
                FakeResponse({"content": {}, "commit": {}}),
            ])

if __name__ == "__main__":
    unittest.main()
