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
| `prd-document` | Product requirements and feature specifications; format follows the user's request. |
| `image-generation` | Plan, generate, and iteratively edit images with reusable visual templates and prompt-quality guidance. |
| `long-goal` | Explicit `/goal` objectives: `long_task`, `complete_goal`, idempotent goals, modular project work, early research. |
| `memory` | Two-layer memory system with Dream-managed knowledge files. |
| `mona-docx` | Word creation and editing through live Office sessions, with advanced OOXML helpers loaded when needed. |
| `mona-xlsx` | Professional spreadsheet editing through live Office sessions. |
| `mona-pptx` | Presentation design and editing through live Office sessions. |
| `mona-canvas` | Create and edit content on Mona's canvas. |
| `mona-design` | Shared design references, style specimens and source assets for web, Office and video tasks. |
| `mona-motion` | Create, preview and export continuous Mona Motion compositions through the built-in video workflow. |
| `mona-visualizer` | Create inline visual explanations and interactive widgets in chat. |
| `pdf` | Built-in PDF text/table extraction, rendering, creation, merging, page extraction and forms; reuses Mona's bundled Python libraries. |
| `skill-creator` | Create or update AgentSkills. |

GitHub and tmux remain available as [optional skills](../../expert-library/skills/README.md).
Runtime diagnostics and scheduling use their existing tools directly.
