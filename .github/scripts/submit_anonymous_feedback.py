#!/usr/bin/env python3
"""Write one consented, de-identified feedback entry to this public repository."""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

API = "https://api.github.com"
MAX_SUMMARY = 5000
MAX_EVALUATION = 2000
BOT = {"name": "github-actions[bot]", "email": "41898282+github-actions[bot]@users.noreply.github.com"}

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def api(method, url, token, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "side-hustle-anonymous-feedback"
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        fail(f"GitHub write failed with HTTP {exc.code}; no feedback entry was confirmed.")
    except (urllib.error.URLError, TimeoutError):
        fail("GitHub request failed; no feedback entry was confirmed.")

def main():
    if os.environ.get("CONSENT_CONFIRMED") != "yes":
        fail("Explicit consent is required; no feedback entry was written.")
    if os.environ.get("POST_REPORT_UPDATES_COMPLETE") != "yes":
        fail("Post-report corrections must be complete; no feedback entry was written.")
    version = os.environ.get("TOOL_VERSION", "").strip()
    summary = os.environ.get("SUMMARY", "").strip()
    evaluation = os.environ.get("EVALUATION", "").strip()
    if not re.fullmatch(r"V0\.\d+", version):
        fail("Invalid tool version; no feedback entry was written.")
    if not summary or len(summary) > MAX_SUMMARY or len(evaluation) > MAX_EVALUATION:
        fail("Feedback text is empty or too long; no feedback entry was written.")
    text = "\n".join(part for part in (summary, evaluation) if part)
    direct_identifiers = [
        r"(?<!\d)1[3-9]\d{9}(?!\d)",
        r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b",
        r"(?<!\d)\d{17}[\dXx](?!\d)",
    ]
    if any(re.search(pattern, text, re.IGNORECASE) for pattern in direct_identifiers):
        fail("Feedback appears to contain a phone number, email, or ID number; remove it before submission.")
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo or "/" not in repo:
        fail("GitHub writer configuration is unavailable; no feedback entry was written.")
    metadata = api("GET", f"{API}/repos/{repo}", token)
    branch = metadata.get("default_branch")
    if not branch:
        fail("Could not identify the repository default branch; no feedback entry was written.")
    now = datetime.now(timezone.utc)
    path = f"feedback/entries/{now:%Y-%m}/{uuid.uuid4()}.md"
    body = (
        "# Anonymous self-test feedback\n\n"
        f"- Tool version: {version}\n"
        f"- Submitted: {now.isoformat()}\n"
        "- Tester identity: not collected\n\n"
        "## De-identified summary\n\n"
        f"{summary}\n"
    )
    if evaluation:
        body += f"\n## Tester feedback\n\n{evaluation}\n"
    payload = {
        "message": "Add anonymous self-test feedback",
        "content": base64.b64encode(body.encode("utf-8")).decode("ascii"),
        "branch": branch,
        "author": BOT,
        "committer": BOT,
    }
    result = api("PUT", f"{API}/repos/{repo}/contents/{urllib.parse.quote(path, safe='/')}", token, payload)
    commit = result.get("commit", {})
    url = result.get("content", {}).get("html_url")
    sha = commit.get("sha")
    if not url or not sha:
        fail("GitHub did not return a complete success receipt; verify before retrying.")
    print(json.dumps({"status": "success", "path": path, "url": url, "commit": sha}, ensure_ascii=False))

if __name__ == "__main__":
    main()
