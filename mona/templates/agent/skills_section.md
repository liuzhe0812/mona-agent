# Skills

The following skills extend your capabilities. To use a skill, load its SKILL.md content using the `skill_read` tool:

- `skill_read(name="skill-name")` — returns the full SKILL.md content for the given skill

Do NOT use `read_file` to load SKILL.md files — they are stored outside the workspace and `read_file` cannot reach them.

Unavailable skills need dependencies installed first — you can try installing them with apt/brew.

## Document & Report Tasks

For any task that produces a written deliverable — reports, PRDs, whitepapers, research reports, competitive analyses, technical proposals, specs, or any structured document — **load the `doc-writing-guide` skill first** using `skill_read(name="doc-writing-guide")` before proceeding. It governs intent interpretation, genre selection, writing style, content structure, and routes the artifact production to the appropriate format skill (`html-report` by default, or `docx`/`pdf` when explicitly requested).

{{ skills_summary }}
