# mona Skills

This directory contains built-in skills that extend mona's capabilities.

## Skill Format

Each skill is a directory containing a `SKILL.md` file with:
- YAML frontmatter (name, description, metadata)
- Markdown instructions for the agent

When skills reference large local documentation or logs, prefer mona's built-in
`grep` tool to narrow the search space before loading full files.
Use `grep(output_mode="count")` / `files_with_matches` for broad searches first,
use `head_limit` / `offset` to page through large result sets,
and `grep(glob="*.md")` to filter by file name pattern.

## Attribution

These skills are adapted from [OpenClaw](https://github.com/openclaw/openclaw)'s skill system.
The skill format and metadata structure follow OpenClaw's conventions to maintain compatibility.

## Available Skills

<!-- NOTE: This list is manually maintained. When adding a new skill directory
     with a SKILL.md file, add a corresponding row here. A test in
     tests/agent/test_skills_readme.py verifies this list stays in sync. -->

| Skill | Description |
|-------|-------------|
| `clawhub` | Search and install agent skills from ClawHub, the public skill registry. |
| `cron` | Schedule reminders and recurring tasks. |
| `prd-document` | Product requirements and feature specifications; format follows the user's request. |
| `github` | Interact with GitHub using the `gh` CLI. |
| `html-report` | Create self-contained HTML deliverables — research reports, whitepapers, PRDs, dashboards, portfolios, etc. |
| `image-generation` | Plan, generate, and iteratively edit images with reusable visual templates and prompt-quality guidance. |
| `long-goal` | Explicit `/goal` objectives: `long_task`, `complete_goal`, idempotent goals, modular project work, early research. |
| `memory` | Two-layer memory system with Dream-managed knowledge files. |
| `mona-docx` | Word creation and editing through live Office sessions, with advanced OOXML helpers loaded when needed. |
| `mona-xlsx` | Professional spreadsheet editing through live Office sessions. |
| `mona-pptx` | Presentation design and editing through live Office sessions. |
| `mona-canvas` | Create and edit content on Mona's canvas. |
| `mona-ppt` | AI-driven multi-format SVG content generation system. Exports to PPTX through multi-role collaboration. |
| `mona-video` | AI-driven video generation system using Hyperframes. Renders HTML+GSAP animation compositions to MP4. |
| `my` | Check and set the agent's own runtime state (model, iterations, context window, token usage, web config). |
| `pdf` | Comprehensive PDF manipulation toolkit for extracting text/tables, creating, merging, and splitting PDFs. |
| `skill-creator` | Create or update AgentSkills. |
| `summarize` | Summarize or extract text/transcripts from URLs, podcasts, and local files (YouTube/video transcription fallback). |
| `tmux` | Remote-control tmux sessions for interactive CLIs. |
| `update-setup` | One-time setup wizard for the mona upgrade skill. |
| `weather` | Get current weather and forecasts (no API key required). |
