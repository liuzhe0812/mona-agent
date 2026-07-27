# Design Constraints

These rules govern architectural decisions. When adding a feature or fixing a bug, prefer paths that respect these boundaries.

## Core stays small; extend at the edges

New capabilities should be added via `channels/`, `tools/`, skills, or MCP servers. The files `agent/loop.py` and `agent/runner.py` form the critical core path; changes there should be minimal and justified. If a feature can live in a channel adapter, a tool, or an external MCP server, it should not be inlined into the agent loop.

## Less structure, more intelligence

Prefer simple, readable code over new framework layers and indirection. Add structure only when it removes real complexity, protects an important boundary, or matches an established local pattern. The best fix is often a smaller prompt, a tighter tool contract, a channel-local change, or one focused regression test.

## Prefer duplication over premature abstraction

Channels and providers are allowed to repeat similar logic (send retries, media handling, message splitting). Do not introduce complex base classes or shared helpers just to eliminate duplication across channel files. Each channel file should remain self-contained and readable on its own. The same applies to provider implementations.

## Minimal change that solves the real problem

Fix bugs by changing only what is necessary. Do not bundle unrelated refactors or clean-ups into a feature or bugfix PR. If a refactor is genuinely required, it should be a separate PR targeting `nightly`.

## Keep PRs reviewable

A bugfix should make the protected invariant clear, change the smallest surface that enforces it, and add only the closest regression test. If a diff starts changing ownership boundaries or mixing behavior changes with clean-up, split it before it becomes hard to review.

## Explicit over magical

Configuration must be declared explicitly in `config/schema.py` Pydantic models. Error handling should raise clear exceptions rather than silently correcting bad input. Provider auto-detection exists, but every resolution path must be traceable from the factory to the concrete provider class.

## KV-cache contract

The system prompt must stay byte-stable across all iterations within a single turn so provider-side prompt caches (Anthropic `cache_control`, OpenAI prefix caching) can be hit.

Invariants:

- `ContextBuilder.build_messages` is called exactly once at the turn entry (`AgentLoop._build_initial_messages` / `_dispatch`). The `AgentRunner` iteration loop only appends assistant and tool messages; it never rebuilds the system message.
- Dynamic per-turn context (current time, channel, chat id, sender id, browser page url/title, goal-state runtime lines) is appended to the **user** message via `_build_runtime_context` and tagged with `_RUNTIME_CONTEXT_TAG`. It must never enter the system prompt.
- The system prompt's cross-turn variation sources are limited to legitimate semantic changes: `memory/MEMORY.md` edits, the always-on skills list, unprocessed `history.jsonl` entries, and the archived session summary. These change between turns, not within a turn.
- Tool implementations must not mutate `MEMORY.md`, `SOUL.md`, `USER.md`, the skills list, or `history.jsonl` as a side effect of being called within a turn. If a tool needs to persist state, write to a separate artifact path; durable memory updates belong to the Dream/Consolidator layers, which run between turns.

Follow-up (not yet implemented): inject explicit `cache_control: {type: "ephemeral"}` markers at the end of the system prompt and the tool definitions for providers that support it. This is a provider-layer change and must not alter the prompt text itself.
