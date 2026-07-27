"""Generate release notes from git history, with optional AI polish.

Pulls commits between two refs, groups them by conventional-commit prefix,
and optionally asks the configured LLM to write a friendly summary with
highlights. Falls back to a deterministic grouped list when the LLM is
unavailable, misbehaves, or times out.

Usage:
  python scripts/generate_release_notes.py [--from REF] [--to REF] [--output FILE]

Defaults:
  --from  : the most recent tag before HEAD (via ``git describe``)
  --to    : HEAD

The script reuses Mona's provider config (``config.json``) so no API key is
hardcoded. Set ``RELEASE_NOTES_NO_AI=1`` to skip the LLM entirely.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

_LLM_TIMEOUT_S = 60.0
_MAX_COMMITS = 400

_GROUP_ORDER = ["feat", "fix", "perf", "refactor", "docs", "chore", "test", "build", "ci"]
_GROUP_LABELS = {
    "feat": "New Features",
    "fix": "Bug Fixes",
    "perf": "Performance",
    "refactor": "Refactors",
    "docs": "Documentation",
    "chore": "Chores",
    "test": "Tests",
    "build": "Build",
    "ci": "CI",
}

_CONVENTIONAL_RE = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^)]+)\))?!?:\s*(?P<subject>.+)$")


def _run_git(args: list[str]) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=_PROJECT_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed: {result.stderr.strip() or result.returncode}"
        )
    return result.stdout


def _default_from_ref() -> str:
    try:
        return _run_git(["describe", "--tags", "--abbrev=0"]).strip()
    except RuntimeError:
        return "HEAD~20"


def _collect_commits(from_ref: str, to_ref: str) -> list[tuple[str, str]]:
    raw = _run_git([
        "log", "--pretty=format:%h%x09%s", "--no-merges",
        f"{from_ref}..{to_ref}",
    ])
    commits: list[tuple[str, str]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 1)
        if len(parts) == 2:
            commits.append((parts[0], parts[1]))
    return commits[:_MAX_COMMITS]


def _group_commits(commits: list[tuple[str, str]]) -> "OrderedDict[str, list[tuple[str, str]]]":
    grouped: OrderedDict[str, list[tuple[str, str]]] = OrderedDict()
    fallback = grouped.setdefault("other", [])
    for sha, subject in commits:
        match = _CONVENTIONAL_RE.match(subject)
        if match:
            ctype = match.group("type")
            if ctype not in _GROUP_LABELS:
                ctype = "other"
            grouped.setdefault(ctype, []).append((sha, subject))
        else:
            fallback.append((sha, subject))
    return grouped


def _render_deterministic(grouped: "OrderedDict[str, list[tuple[str, str]]]") -> str:
    lines: list[str] = []
    for ctype in _GROUP_ORDER:
        items = grouped.get(ctype)
        if not items:
            continue
        lines.append(f"## {_GROUP_LABELS[ctype]}")
        for sha, subject in items:
            lines.append(f"- {subject} ({sha})")
        lines.append("")
    other = grouped.get("other")
    if other:
        lines.append("## Other")
        for sha, subject in other:
            lines.append(f"- {subject} ({sha})")
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _build_llm_prompt(commits: list[tuple[str, str]], from_ref: str, to_ref: str) -> str:
    commit_list = "\n".join(f"- {s} ({h})" for h, s in commits)
    return (
        f"以下是 {from_ref} 到 {to_ref} 之间的提交记录。"
        "请生成一份面向用户的 release notes（中文），要求：\n"
        "1. 开头一句话概括本次更新的主题\n"
        "2. 列出 3-5 条 Highlights（用户最关心的变化）\n"
        "3. 按主题分组列出主要变更，每条简明扼要\n"
        "4. 忽略纯内部重构/chore 类改动（除非影响用户）\n"
        "5. 不要编造未在提交中出现的功能\n\n"
        f"提交记录：\n{commit_list}\n"
    )


async def _generate_with_llm(commits: list[tuple[str, str]], from_ref: str, to_ref: str) -> str | None:
    if os.environ.get("RELEASE_NOTES_NO_AI"):
        return None
    try:
        from mona.providers.factory import load_provider_snapshot
    except Exception:
        return None
    try:
        snapshot = load_provider_snapshot()
    except Exception as exc:
        print(f"[release-notes] provider load failed: {exc}", file=sys.stderr)
        return None
    prompt = _build_llm_prompt(commits, from_ref, to_ref)
    try:
        response = await asyncio.wait_for(
            snapshot.provider.chat(
                messages=[{"role": "user", "content": prompt}],
                model=snapshot.model,
                max_tokens=2048,
                temperature=0.4,
            ),
            timeout=_LLM_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        print("[release-notes] LLM timed out, falling back to deterministic", file=sys.stderr)
        return None
    except Exception as exc:
        print(f"[release-notes] LLM call failed: {exc}", file=sys.stderr)
        return None
    content = (response.content or "").strip()
    return content or None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate release notes from git history.")
    parser.add_argument("--from", dest="from_ref", default=None, help="Starting git ref (default: last tag)")
    parser.add_argument("--to", dest="to_ref", default="HEAD", help="Ending git ref (default: HEAD)")
    parser.add_argument("--output", default=None, help="Write to file instead of stdout")
    args = parser.parse_args(argv)

    from_ref = args.from_ref or _default_from_ref()
    to_ref = args.to_ref

    commits = _collect_commits(from_ref, to_ref)
    if not commits:
        print(f"[release-notes] no commits between {from_ref}..{to_ref}", file=sys.stderr)
        return 1

    grouped = _group_commits(commits)
    ai_notes = asyncio.run(_generate_with_llm(commits, from_ref, to_ref))

    if ai_notes:
        output = ai_notes
        if not output.endswith("\n"):
            output += "\n"
    else:
        output = _render_deterministic(grouped)

    header = f"# Release Notes\n\n_{from_ref} → {to_ref} ({len(commits)} commits)_\n\n"
    output = header + output

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"[release-notes] written to {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
