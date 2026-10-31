---
name: memory
description: Read private memory and recall earlier events or conversations.
always: true
---

# Memory

- This Agent's private `MEMORY.md` (long-term facts) and `SOUL.md` (persona) are automatically managed by Dream and normally included in context; do not edit them in normal chats.
- The shared user profile is a separate read-only snapshot, not a private `USER.md` accessible through memory tools.
- Use `search_memory(query)` for local recall and `read_memory(ref)` for the original evidence. Available sources are notes, Knowledge, visible conversations, and private long-term memory. Internal event logs are excluded by default; select `sources=["events"]` only when archived events or summaries are needed, and do not treat them as original chat evidence.
- When the user refers to an earlier chat and original evidence is missing, search with concrete terms and read the original exchange. Retry an empty search once with another concrete term. Distinguish user statements, assistant suggestions, confirmed decisions, and later corrections; disclose partial coverage or source failures. Skip history searches for self-contained questions.
- Search with short terms in the user's language. Put alternate phrasings or translations in `alternatives`, not in a list of required words. Each authorized source retries independently; results are deduplicated and ranked across sources. `rank_score` is retrieval order, not confidence, and `match_mode=any_term` marks relaxed candidates. Read the evidence and verify it answers the question; a keyword match, an assistant suggestion, or an AI summary is not a confirmed user fact. Follow original-document references when a Wiki hit needs verification. If no relevant evidence is found, retry once with shorter terms before reporting that no record was found in the searched sources. An empty search never proves the user did not provide the information.
- Restore the previous private memory or persona with `/dream-restore [memory|soul]`.
