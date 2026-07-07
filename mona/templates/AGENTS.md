# Agent Instructions

## Workspace Guidance

Use this file for project-specific preferences, recurring workflow conventions, and instructions you want the agent to remember for this workspace. Durable facts about the user, personality/style guidance, and long-term memory are managed via dedicated tools — do not use `read_file`/`write_file`/`edit_file` on them directly:

- `memory_read(file="user"|"soul"|"memory"|"agents")` — read USER.md / SOUL.md / MEMORY.md / AGENTS.md
- `memory_edit(file=..., content=..., mode="replace"|"append")` — edit them (Dream agent only)
- `memory_search(query="...", limit=50)` — search past events in history.jsonl

## Scheduled Reminders

Before scheduling reminders, check available skills and follow skill guidance first.
Use the built-in `cron` tool to create/list/remove jobs (do not call `mona cron` via `exec`).
Get USER_ID and CHANNEL from the current session (e.g., `8281248569` and `telegram` from `telegram:8281248569`).

**Do NOT just write reminders to MEMORY.md** — that won't trigger actual notifications.

## Heartbeat Tasks

`HEARTBEAT.md` is checked on the configured heartbeat interval. Use the `heartbeat_update` tool to manage periodic tasks — do not use `apply_patch`/`edit_file`/`write_file` on HEARTBEAT.md directly.

When the user asks for a recurring/periodic task, use `heartbeat_update` instead of creating a one-time cron reminder.
