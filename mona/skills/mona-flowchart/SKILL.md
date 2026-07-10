---
name: mona-flowchart
description: >
  AI-driven flowchart generation system using draw.io. Converts text descriptions
  into structured flowcharts with auto-layout, editable in embedded draw.io editor.
  Use when user asks to "create flowchart", "make diagram", "制作流程图", "生成图表",
  or mentions "mona-flowchart".
metadata:
  mona:
    emoji: "🔀"
    always: false
    requires:
      bins: ["python"]
---

# Mona Flowchart Skill

Pipeline dispatcher for Mona Flowchart. Produces draw.io flowcharts via three-step generation: logical description → auto_layout → build_xml. User can edit the result in embedded draw.io editor (C route: agent generates + user edits).

Pipeline: source → project → Strategist (logical graph) → auto_layout (coordinates) → build_xml (mxGraph) → draw.io embed preview → export SVG/PNG.

## Core Contract

1. Run the pipeline strictly in order. Check each step gate before entry.
2. Step 4 logical graph confirmation is blocking: wait for explicit user confirmation before writing `graph_lock.md`.
3. **Never hand-write mxGraph XML directly.** Always use the three-step pipeline:
   - Step 5a: Write logical description (nodes / edges / hierarchy) to `graph.json`
   - Step 5b: Run `auto_layout.py` to compute coordinates → `layout.json`
   - Step 5c: Run `build_xml.py` to generate mxGraph XML → `diagram.drawio`
4. Before build_xml, read `graph_lock.md`; use only locked node styles, edge styles, and color palette.
5. Preview each diagram in draw.io embed editor. All XML errors must be fixed before export.
6. Export discipline: SVG/PNG export must use `${SKILL_DIR}/scripts/export_svg.py`. Never create custom export scripts.
7. User can edit the diagram in draw.io editor after generation. Edits are saved back to `diagram.drawio`.

## Mona Defaults

- `${SKILL_DIR}` resolves to `<workspace>/mona/skills/mona-flowchart/`.
- Create generated projects under `<workspace>/flowchart_projects/` with `--dir flowchart_projects`.
- On Windows, if `python3` fails, rerun the same command with `python`.
- Reply in the user's language unless explicitly asked otherwise.
- `graph.json` uses the logical schema defined in `references/strategist.md`.
- This is a flowchart workflow, not a generic coding task. Do not create branches, worktrees, tests, or app scaffolding by default.

## Reference Load Map

| Moment | Load |
|---|---|
| Step 1-2 source conversion / project setup | `references/source-project.md` |
| Step 4 Strategist (logical graph) | `references/strategist.md` |
| Step 5 Executor (build XML) | `references/executor-run.md` |
| Step 6 draw.io embed preview | `references/drawio-embed.md` |
| Resume existing project | `workflows/resume-execute.md` |

## Pipeline Steps

### Step 1: Source Intake
Convert source (text description / PDF / URL / Markdown) to `source.md` in project dir.

### Step 2: Project Setup
Create project directory under `flowchart_projects/`. Init `graph.json` skeleton.

### Step 3: Source Analysis
Analyze source, extract entities, relationships, and hierarchy levels.

### Step 4: Strategist — Logical Graph
Plan node list, edge list, and hierarchy. Write to `graph.json`. **Blocking gate**: wait for user confirmation before writing `graph_lock.md`.

### Step 5: Executor — Three-Step Generation
- **5a**: Verify `graph.json` matches locked spec
- **5b**: Run `auto_layout.py` → `layout.json` (coordinates via dagre/elkjs)
- **5c**: Run `build_xml.py` → `diagram.drawio` (mxGraph XML)

### Step 6: Quality Gate + Preview
Run `validate_xml.py` on `diagram.drawio`. Fix errors. Load in draw.io embed editor for preview.

### Step 7: Export
Export to SVG/PNG via `export_svg.py`. Output to `<project_path>/output/`.
