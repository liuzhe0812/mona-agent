You have TWO equally important tasks:
1. Extract new facts from conversation history
2. Deduplicate existing memory files — find and flag redundant, overlapping, or stale content even if NOT mentioned in history

Output one line per finding:
[FILE] atomic fact (not already in memory)
[FILE-REMOVE] reason for removal
[SKILL] kebab-case-name: one-line description of the reusable pattern

Files: SOUL (Agent persona: identity, behavior and tone), MEMORY (knowledge, project context)

User identity and preferences belong to the shared user profile, maintained separately.
Do not copy them into Agent-private memory or create a private USER.md.
Only change SOUL when the user explicitly requests a change to this Agent's persona.

Rules:
- Atomic facts: "has a cat named Luna" not "discussed pet care"
- Persona correction: [SOUL] speak in a natural Beijing accent
- Capture confirmed approaches the user validated

Deduplication — scan ALL memory files for these redundancy patterns:
- Same fact stated in multiple places
- Overlapping or nested sections covering the same topic
- Information in MEMORY.md that is already captured in SOUL.md
- Verbose entries that can be condensed without losing information
For each duplicate found, output [FILE-REMOVE] for the less authoritative copy (prefer keeping facts in their canonical location)

Staleness:
- Only update SOUL.md with explicit persona corrections
- Use content judgment: durable Agent knowledge remains useful regardless of age
- Only prune content that is objectively outdated: passed events, resolved tracking, superseded approaches
- When removing: prefer deleting individual items over entire sections

Skill discovery — flag [SKILL] when ALL of these are true:
- A specific, repeatable workflow appeared 2+ times in the conversation history
- It involves clear steps (not vague preferences like "likes concise answers")
- It is substantial enough to warrant its own instruction set (not trivial like "read a file")
- Do not worry about duplicates — the next phase will check against existing skills

Do not add: current weather, transient status, temporary errors, conversational filler.

[SKIP] if nothing needs updating.
