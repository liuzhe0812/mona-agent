Update memory files based on the analysis below.
- [FILE] entries: use the `memory_edit` tool to add the described content to the appropriate file
- [FILE-REMOVE] entries: use the `memory_edit` tool (mode="replace") to delete the corresponding content from memory files
- [SKILL] entries: use the `skill_create` tool to create a new skill

## Memory and Skill Access

Memory files (SOUL.md / USER.md / MEMORY.md / AGENTS.md) and skills are stored OUTSIDE the workspace. Use dedicated tools:

- `memory_read(file="soul"|"user"|"memory"|"agents")` — read content
- `memory_edit(file="soul"|"user"|"memory"|"agents", content="...", mode="replace"|"append")` — edit content
- `skill_read(name="...")` — read existing skill
- `skill_create(name="...", content="...")` — create new skill

Do NOT use `read_file`/`write_file`/`edit_file` for these resources — they are outside the workspace boundary.

## File mapping
- [FILE] targeting SOUL.md → `memory_edit(file="soul", ...)`
- [FILE] targeting USER.md → `memory_edit(file="user", ...)`
- [FILE] targeting MEMORY.md → `memory_edit(file="memory", ...)`
- [SKILL] entries → `skill_create(name="<name>", content="...")`

## Editing rules
- For [FILE] additions: use `memory_edit(file=..., content=..., mode="append")` to add content
- For [FILE-REMOVE] deletions: read current content with `memory_read`, then `memory_edit(file=..., content=<new full content>, mode="replace")` with the removed section excluded
- Batch changes to the same file into one `memory_edit` call
- Surgical edits only — never replace entire files unless explicitly required
- If nothing to update, stop without calling tools

## Skill creation rules (for [SKILL] entries)
- Use `skill_create(name="<name>", content="<full SKILL.md content>")` to create a new skill
- Before creating, use `skill_read(name="skill-creator")` for format reference (frontmatter structure, naming conventions, quality standards)
- **Dedup check**: use `skill_read` on existing skills listed below to verify the new skill is not functionally redundant. Skip creation if an existing skill already covers the same workflow.
- Include YAML frontmatter with name and description fields
- Keep SKILL.md under 2000 words — concise and actionable
- Include: when to use, steps, output format, at least one example
- Do NOT overwrite existing skills — skip if the skill already exists (skill_create fails if it exists)
- Reference specific tools the agent has access to (read_file, write_file, exec, web_search, etc.)
- Skills are instruction sets, not code — do not include implementation code

## Quality
- Every line must carry standalone value
- Concise bullets under clear headers
- When reducing (not deleting): keep essential facts, drop verbose details
- If uncertain whether to delete, keep but add "(verify currency)"
