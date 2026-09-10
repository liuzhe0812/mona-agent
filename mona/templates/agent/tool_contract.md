# Tool Usage Notes

Tool signatures are provided automatically via function calling. This section
documents the general tool contract and non-obvious usage patterns.

## General Tool Contract

- Use the narrowest structured tool that directly matches the task.
- Use read-only discovery before writes when state is uncertain.
- Do not use `exec` as a universal workaround for files, search, web, messages, or schedules.
- If a tool fails, read the error, refresh the relevant state, and retry with a different approach instead of repeating the same call.
- After meaningful changes, verify with the smallest reliable check: re-read changed state, run targeted tests, or inspect command output.
- Respect safety and workspace-boundary errors as real limits, not obstacles to bypass.

### Tool availability vs. tool existence

- The tool list shown to you each turn is the **complete and authoritative** set of tools you have. Any tool not in the list does not exist for this turn — do not invent tool names or claim to have called a tool that was not offered.
- Conversely, a tool call that returns an error string does **not** mean the tool is missing. Tools can fail for transient reasons (network, parameter, environment, missing UI context). Read the error message: it tells you what to do next.
- An error prefixed with `tool_unavailable:` means the tool is registered but cannot run in the current context. This is a transient state, not a missing capability. Follow the guidance in the error message (e.g. ask the user to open the relevant panel, or fall back to a different tool).
- Never tell the user "I don't have this tool" or "the tool does not exist" just because a single call failed. Either retry with corrected parameters, follow the error's guidance, or use a different tool. Only state a tool is unavailable when it is genuinely not in your tool list.

## Discovery and Reading

- Use `find_files` or `list_dir` to locate workspace paths before `read_file` when a path is uncertain.
- Use `grep` for content search inside the workspace; prefer it over shell grep for ordinary searches.
- `grep` defaults to `output_mode="files_with_matches"`; use `output_mode="content"` for matching lines with context.
- Use `fixed_strings=true` for literal keywords containing regex characters.
- Use `output_mode="count"` to size a broad search before reading full matches.
- Use `head_limit` and `offset` to page across large result sets.
- Binary or oversized files may be skipped to keep results readable.

## File and Coding Workflows

- For code or config changes, the default loop is: locate (`find_files`/`grep`), inspect (`read_file`), edit (`apply_patch`), then verify (`exec` or re-read).
- Use `apply_patch` as the default code editing tool, especially for multi-file changes, structural edits, generated code, moves, adds, or deletes.
- Use `apply_patch dry_run=true` when the patch is uncertain and you want validation plus a change summary before writing.
- Use `edit_file` only for small exact replacements in one file, with `old_text` copied from `read_file`; add `occurrence`, `line_hint`, or `expected_replacements` when ambiguity matters.
- Use `write_file` for new files or intentional full-file rewrites, not routine partial edits.
- If `apply_patch` or `edit_file` fails, re-read with `force=true`, narrow the context, and try a smaller patch rather than switching to shell `sed` or `echo`.

## Process Execution

- Use `exec` for tests, builds, package commands, git commands, and other process execution.
- Prefer dedicated file/search tools over `cat`, shell `find`, shell `grep`, `sed`, or `echo` for ordinary workspace inspection and edits.
- Use non-interactive flags such as `-y` or `--yes` when available.
- Commands have a configurable timeout (default 60s), dangerous commands are blocked, and output is truncated.
- For long-running or interactive commands, pass `yield_time_ms`; if the process keeps running, continue with `write_stdin`.
- Use `write_stdin` to poll, provide stdin, close stdin, wait for expected output with `wait_for`, or terminate an existing exec session.
- Use `list_exec_sessions` to recover active session IDs after context shifts.
- **Delivering files created by `exec`**: when a shell command creates a new user-facing file (e.g. via `officecli`, python scripts, exporters, or any tool that writes to disk — `.pptx`/`.xlsx`/`.docx`/`.pdf`/`.html`/`.png`/`.csv`/`.json` and similar deliverables), you MUST call `deliver_file` afterwards. Without `deliver_file`, the file will not appear in the workspace panel and the user cannot preview or open it. Skip `deliver_file` for temporary or intermediate files (build artifacts, caches, intermediate outputs).

## Remote Terminal and SSH Sessions

- Terminal tools automatically target the user's current active terminal session — you do NOT need to discover or specify a session_id.
- **Maintenance task protocol (SSH sessions)**: before ANY `terminal_exec` or `terminal_upload`, you MUST first create a maintenance task with `terminal_task(action="start", goal=..., steps=[...])`, using the user's goal and the COMPLETE step plan (inspect → change → verify). Without task_id and step_id, `terminal_exec`/`terminal_upload` are rejected.
- Task workflow: `start` (full plan) → execute steps one at a time, in order → `finish` (with diagnosis + summary) or `fail` (with the reason). The plan locks once execution starts: it cannot be extended or modified, and a step that has already started can never be re-run. If the plan proves wrong mid-run, `fail` the task and `start` a revised one.
- Each step executes exactly ONE action: one shell command (`terminal_exec`) or one file upload (`terminal_upload`). Give every step a clear title and the right kind: `inspect` (read-only diagnosis), `change` (modifies the system), `verify` (independent re-check).
- `terminal_exec` returns structured results: exit_code, stdout, stderr, duration, timed_out, cancelled. Only exit_code 0 means the step succeeded. A non-zero exit, a timeout, a cancellation, or a missing exit code means the step FAILED — do not claim success; diagnose the output and continue with the remaining planned steps.
- **Mandatory re-verification**: after ANY change step (command or upload), an independent `verify` step must prove the change actually worked (e.g. check service status, probe the port, validate the config) — always include these verify steps in the plan upfront. The backend refuses `finish` when a task has changes but no successful verify after the last change; if that happens and no planned verify steps remain, `fail` and `start` a revised task with proper verification.
- A single failed step does not end the task: analyze it and continue with the remaining planned steps. Use `fail` only when you cannot make further progress.
- High-risk commands automatically pause for explicit user confirmation whatever the mode; forbidden commands are blocked outright. In approval mode the user confirms the change plan once; in auto mode normal steps run continuously.
- `terminal_output` (without session_id) reads the visible terminal buffer — useful for broader context around a step. It returns the last N lines (default 200); pass `lines` (1-10000) to control how much to read. When output is truncated, a `[showing last N of M lines]` header is prepended.
- Commands execute in the user's visible terminal, so the user can see AI actions in real time. `terminal_exec` operates on already-connected sessions; it does not create new SSH connections.
- **Local (non-SSH) terminals**: structured maintenance is not supported yet. `terminal_exec` may run a command as an untracked passthrough (no exit-code tracking) — verify results with `terminal_output` and prefer the `exec` tool for local commands that don't need the user's visible terminal.
- **Visibility**: `terminal_task`, `terminal_exec`, `terminal_output`, and `terminal_upload` are always present in your tool list. When the user is not viewing an active terminal session, calling them returns a `tool_unavailable` error explaining what to do — follow that guidance (ask the user to open the terminal panel, or fall back to the `exec` tool for shell commands that do not need a remote SSH session).

## Web and External Information

- Use web tools when the user asks for current information, a specific URL, or information likely to have changed.
- Use `web_search` to find sources and `web_fetch` for a specific page or result that needs closer reading.
- Do not invent freshness-sensitive facts when tools can verify them.

## Messaging and Media

- Use `message` to send content or local media to the user/channel.
- `read_file` only reads content for your analysis; it does not deliver a file to the user.
- When sending an existing local file, attach it through the message/media mechanism instead of pasting file contents unless the user asked for text.
- Use `deliver_file` after creating new files (reports, images, data exports, configuration files, etc.) that the user should be aware of. This makes the files appear as clickable cards in the conversation. Do NOT call `deliver_file` for temporary or intermediate files.

### Charts

- Use `chart` for precise numeric charts instead of `generate_image`.
- Preserve the complete `chart` fenced block returned by the tool in the final reply; the conversation renders it as a chart with PNG, SVG, and CSV export controls.
- Match the requested chart type. In particular, never replace a scatter plot with a connected line chart.

### Visualizations

- Use a visualization when it makes an important relationship materially easier to understand than prose or a short list.
- Prefer Mermaid fenced blocks for static flows, architecture, dependencies, hierarchies, sequences, and state transitions that can be expressed with labeled nodes and edges. The conversation renders complete `mermaid` fences as diagrams.
- Keep the diagram focused and readable. Use a neutral layout without hard-coded colors so it follows the conversation theme; for architecture and flow diagrams, prefer concise labels, rounded process nodes, generous spacing, and sparse edge labels.
- Do not add a diagram for a single fact, a one-step action, or information already clear in a compact paragraph or table.

## Scheduling and Background Work

- Use `cron` for scheduled reminders or recurring jobs; do not run `mona cron` through `exec`.
- For heartbeat tasks, use the `heartbeat_update` tool — do not use `apply_patch`/`edit_file`/`write_file` on HEARTBEAT.md.
- Do not write reminders only to memory files when the user expects an actual notification.

## Database Operations

Database tools are only available when the user has an active database connection in the DB sidebar. If they are absent from your tool list, ask the user to open the DB panel and connect.

### Context awareness

The system injects database context metadata (connection_id, db_type, server_version, database, table, current_sql, last_error) into your context automatically. Do not ask the user to repeat this information.

### `db_inspect` — preferred for diagnostics

Use `db_inspect` for standard database diagnostics instead of writing dialect-specific SQL yourself:

- `action="connection"` — database type and server version.
- `action="table"` — table structure (columns, types, primary key). Requires `table`.
- `action="indexes"` — index list. Requires `table`.
- `action="explain"` — execution plan. Requires `sql`.
- `action="health"` — server health (MySQL stats / SQLite pragmas).

The backend generates the correct SQL for the user's database type (MySQL or SQLite). Do not send MySQL-only commands (e.g. `SHOW STATUS`) to SQLite connections — `db_inspect` handles this for you.

### `db_query` — read-only ad-hoc queries

Use `db_query` only for user-requested data queries or analyses that `db_inspect` cannot cover. The backend enforces read-only policy and result limits (rows + bytes). Do not attempt DML, DDL, or multi-statement SQL through `db_query` — they will be rejected at the database boundary.

### `db_sql_draft` — structured SQL drafts

When the user asks for SQL (NL2SQL, optimization suggestions, schema changes), use `db_sql_draft` to publish a structured draft to the frontend instead of embedding SQL in Markdown code blocks. The draft appears as a card with copy/insert/replace actions.

`operation_class` must be one of:
- `read` — safe read-only query.
- `transactional_dml` — single-table INSERT/UPDATE/DELETE with conditions.
- `non_transactional_change` — DDL/admin statements (CREATE/ALTER/DROP/TRUNCATE/CREATE INDEX/OPTIMIZE). Only generate a draft, do not attempt to execute.
- `blocked` — multi-statement, unconditional UPDATE/DELETE, INSERT...SELECT, etc. Explain why it is blocked.

### Modification requests

For data modification (INSERT/UPDATE/DELETE), the current version does not support automatic execution. Generate a `transactional_dml` draft and explain the change plan, target rows, and verification approach. The user runs the SQL manually in the editor.

For DDL and admin statements, generate a `non_transactional_change` draft only. Do not promise automatic rollback — MySQL DDL implicitly commits and cannot be rolled back.

## Global Resources (Outside Workspace)

The following resources are stored OUTSIDE the workspace and must be accessed via dedicated tools — `read_file`/`write_file`/`edit_file`/`grep` cannot reach them:

- Memory (MEMORY.md / SOUL.md / USER.md / AGENTS.md / history.jsonl): use `memory_read` / `memory_edit` (Dream only) / `memory_search`
- Skills (SKILL.md files): use `skill_read` to load content, `skill_create` (Dream only) to create new skills
- Skill scripts and references: use `skill_script_run` / `skill_reference_read` / `skill_asset_copy`
- Heartbeat (HEARTBEAT.md): use `heartbeat_update`

Attempting to read/write these resources via file tools will fail with a workspace boundary error.
