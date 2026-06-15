#!/usr/bin/env python3
"""Helper for the release skill: collect git history and update site changelog."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG_PATH = ROOT / "site" / "public" / "changelog.json"


def run_git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr}")
    return result.stdout.strip()


def get_current_hash() -> str:
    return run_git("rev-parse", "HEAD")


def get_previous_hash() -> str:
    if not CHANGELOG_PATH.exists():
        return ""
    data = json.loads(CHANGELOG_PATH.read_text(encoding="utf-8"))
    for release in data.get("releases", []):
        git_hash = release.get("gitHash", "")
        if git_hash:
            return git_hash
    return ""


def get_commits_between(previous: str, current: str) -> list[dict[str, str]]:
    if not previous:
        return []
    fmt = "%H|%s|%b%x00"
    out = run_git("log", f"{previous}..{current}", f"--pretty=format:{fmt}")
    if not out:
        return []
    commits: list[dict[str, str]] = []
    for raw in out.split("\x00"):
        raw = raw.strip()
        if not raw:
            continue
        parts = raw.split("|", 2)
        if len(parts) < 2:
            continue
        commits.append({
            "hash": parts[0].strip(),
            "subject": parts[1].strip(),
            "body": parts[2].strip() if len(parts) > 2 else "",
        })
    return commits


def collect() -> dict[str, object]:
    current = get_current_hash()
    previous = get_previous_hash()
    commits = get_commits_between(previous, current) if previous else []
    return {
        "currentGitHash": current,
        "previousGitHash": previous,
        "commitCount": len(commits),
        "commits": commits,
    }


def write_release(version: str, summary: str, items: list[str]) -> None:
    current = get_current_hash()
    previous = get_previous_hash()

    if CHANGELOG_PATH.exists():
        data = json.loads(CHANGELOG_PATH.read_text(encoding="utf-8"))
    else:
        data = {"releases": []}

    release = {
        "version": version,
        "pubDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gitHash": current,
        "previousGitHash": previous,
        "summary": summary,
        "items": items,
    }

    releases: list[dict] = data.setdefault("releases", [])
    # Replace existing entry with same version, otherwise prepend.
    for i, r in enumerate(releases):
        if r.get("version") == version:
            releases[i] = release
            break
    else:
        releases.insert(0, release)

    CHANGELOG_PATH.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Updated {CHANGELOG_PATH}: v{version} ({current[:8]})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Update Mona changelog data")
    sub = parser.add_subparsers(dest="command", required=True)

    collect_cmd = sub.add_parser("collect", help="Print current/previous git hash and commits")
    collect_cmd.set_defaults(func=lambda _: print(json.dumps(collect(), indent=2, ensure_ascii=False)))

    write_cmd = sub.add_parser("write", help="Write a new release entry")
    write_cmd.add_argument("--version", required=True)
    write_cmd.add_argument("--summary", required=True)
    write_cmd.add_argument("--items", action="append", required=True)
    write_cmd.set_defaults(func=lambda args: write_release(args.version, args.summary, args.items))

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
