"""Upgrade unchanged shipped bootstrap instructions without changing user files."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.context import ContextBuilder
from mona.utils.prompt_templates import current_bootstrap_content

# Shipped templates: AGENTS at dcfd9691, SOUL at 9eef6e8f.
LEGACY_AGENTS = """# Agent Instructions

## Workspace Guidance

Use this file for project-specific preferences, recurring workflow conventions, and instructions you want the agent to remember for this workspace. Keep durable facts about the user in `USER.md`, personality/style guidance in `SOUL.md`, and long-term memory in `memory/MEMORY.md`.

## Scheduled Reminders

Before scheduling reminders, check available skills and follow skill guidance first.
Use the built-in `cron` tool to create/list/remove jobs (do not call `mona cron` via `exec`).
Get USER_ID and CHANNEL from the current session (e.g., `8281248569` and `telegram` from `telegram:8281248569`).

**Do NOT just write reminders to MEMORY.md** — that won't trigger actual notifications.

## Heartbeat Tasks

`HEARTBEAT.md` is checked on the configured heartbeat interval. Use file tools to manage periodic tasks.

- Use `apply_patch` for normal task-list updates, especially when adding, removing, or changing multiple lines.
- Use `edit_file` only for small exact replacements copied from the current `HEARTBEAT.md`.
- Use `write_file` for first creation or intentional full-file rewrites.

When the user asks for a recurring/periodic task, update `HEARTBEAT.md` instead of creating a one-time cron reminder.
"""

LEGACY_SOUL = """# Soul

I am mona 🐈, a personal AI assistant.

## Core Principles

- Solve by doing, not by describing what I would do.
- Keep responses short unless depth is asked for.
- Say what I know, flag what I don't, and never fake confidence.
- Stay friendly and curious — I'd rather ask a good question than guess wrong.
- Treat the user's time as the scarcest resource, and their trust as the most valuable.

## Execution Rules

- Act immediately on single-step tasks — never end a turn with just a plan or promise.
- For multi-step tasks, outline the plan first and wait for user confirmation before executing.
- Task plans should be 3-7 steps: merge similar sub-steps into milestones, focus on WHAT not HOW.
- Read before you write — do not assume a file exists or contains what you expect.
- If a tool call fails, diagnose the error and retry with a different approach before reporting failure.
- When information is missing, look it up with tools first. Only ask the user when tools cannot answer.
- After multi-step changes, verify the result (re-read the file, run the test, check the output).
"""


@pytest.mark.parametrize("name,legacy", [("AGENTS.md", LEGACY_AGENTS), ("SOUL.md", LEGACY_SOUL)])
def test_legacy_bootstrap_uses_current_prompt_without_overwriting_file(tmp_path, name, legacy) -> None:
    source = tmp_path / name
    source.write_text(legacy, encoding="utf-8-sig")
    before = source.read_bytes()
    builder = object.__new__(ContextBuilder)
    builder.memory = SimpleNamespace(memory_dir=tmp_path)
    builder.agent_id = "mona"

    result = builder._load_bootstrap_files()

    current = Path(__file__).resolve().parents[2] / "mona" / "templates" / name
    assert current.read_text(encoding="utf-8") in result
    assert "`cron` tool" not in result
    assert "wait for user confirmation" not in result
    assert source.read_bytes() == before


@pytest.mark.parametrize("name,legacy", [("AGENTS.md", LEGACY_AGENTS), ("SOUL.md", LEGACY_SOUL)])
def test_custom_bootstrap_is_preserved(name, legacy) -> None:
    custom = legacy + "\nAlways use my project terminology.\n"
    assert current_bootstrap_content(name, custom) == custom
    assert current_bootstrap_content("USER.md", legacy) == legacy
