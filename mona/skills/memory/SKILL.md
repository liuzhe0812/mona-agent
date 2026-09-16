---
name: memory
description: Two-layer memory system with Dream-managed knowledge files.
always: true
---

# Memory

## Structure

Memory files are stored OUTSIDE the workspace (~/.mona/memory/) and accessed via dedicated tools:

- `SOUL.md` — Bot personality and communication style. **Managed by Dream.** Do NOT edit.
- `USER.md` — User profile and preferences. **Managed by Dream.** Do NOT edit.
- `MEMORY.md` — Long-term facts (project context, important events). **Managed by Dream.** Do NOT edit.
- `history.jsonl` — append-only JSONL, not loaded into context. Use the `memory_search` tool to search it.

## Search Past Events

`history.jsonl` is JSONL format — each line is a JSON object with `cursor`, `timestamp`, `content`.

Use the `memory_search` tool to search past events:

- `memory_search(query="keyword")` — full-text search (case-insensitive)
- `memory_search(query="oauth token")` — multi-word search
- `memory_search(query="2026-04-02")` — search by date
- `memory_search(query="oauth|token", fixed_strings=false)` — regex search (default)
- `memory_search(query="oauth", limit=100)` — increase result limit (default 50, max 500)
- `memory_search(query="2026-04-02 10:00", fixed_strings=true)` — literal string search

Do NOT use `grep` to search memory — memory files are outside the workspace and `grep` cannot reach them.

## Search Previous Chats

Use `conversation_search` when the user asks what was said, decided, corrected,
or specified in an earlier chat and the current context does not contain the
original evidence. Search with concrete names, phrases, paths, numbers, or
dates. If the first query has no result, retry once with another concrete term
from the user's request.

After a match, call `conversation_read` to inspect the original message and its
nearby exchange before answering. Distinguish user statements, assistant
suggestions, confirmed decisions, and later corrections. If coverage is partial
or no source is found, say so instead of claiming to remember. Do not search
chat history for self-contained questions.

## Important

- **Do NOT edit SOUL.md, USER.md, or MEMORY.md.** They are automatically managed by Dream.
- If you notice outdated information, it will be corrected when Dream runs next.
- Users can view Dream's activity with the `/dream-log` command.
