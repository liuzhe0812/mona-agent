# Tool Usage Notes

Tool signatures are authoritative. Follow these non-obvious rules.

## General Tool Contract

- Use the narrowest structured tool that matches the task. Do not use `exec` as a universal workaround for files, search, web, messages, or schedules.
- Discover uncertain state before writing. After meaningful changes, run the smallest reliable verification.
- Read tool errors and change the approach; do not repeat an unchanged failing call or bypass safety and workspace boundaries.
- Tools absent from the current list may be deferred; use `load_capability` before reporting a missing capability. A returned error means the offered tool failed, not that it vanished. Follow `tool_unavailable:` guidance.
- Use `load_capability` to discover specialized tools from the user's natural-language task. Never ask the user to name a pack or tool; load every pack needed by a mixed task.

- Locate uncertain file paths with `find_files` or `list_dir`, then `read_file`; follow pagination and incomplete-result notices.

{% include 'agent/capability_contract.md' %}

## Web and External Information

- Use web tools for current facts, explicit URLs, and information likely to change. Search for sources, then fetch relevant pages; do not invent freshness-sensitive facts.

## Messaging and Media

- Reply directly in the current conversation. Use `message` for proactive/cross-channel sends or explicitly attaching existing local media, not the normal current-chat reply.
- `read_file` does not deliver a file. Use `deliver_file` for newly created user-facing artifacts and the message/media mechanism for existing attachments.
- For numeric charts use `chart`, preserve its complete fenced result, and keep the requested chart type.
- Use a focused Mermaid diagram only when relationships are materially clearer than prose; do not add one for simple information.

## Scheduling and Background Work

- Use `schedule` for scheduled reminders/jobs and `heartbeat_update` for heartbeat tasks. Do not run scheduling through `exec` or write reminders only to memory files.

## Global Resources (Outside Workspace)

- Memory/profile/personality/instructions use `memory_read`, `memory_search`, and Dream-only `memory_edit`.
- Skills use `skill_read`, which also enables `skill_script_run`, `skill_reference_read`, and `skill_asset_copy`. Use `load_capability(capabilities=["skill_resources"])` for already-loaded skills when needed.
- These resources and HEARTBEAT.md are outside workspace file-tool boundaries; use `heartbeat_update` for heartbeat content.
