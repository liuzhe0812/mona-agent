---
name: mona-ppt
description: >
  AI-driven multi-format SVG content generation system. Converts source documents
  (PDF/DOCX/URL/Markdown) into high-quality SVG pages and exports to PPTX through
  multi-role collaboration. Use when user asks to "create PPT", "make presentation",
  "生成PPT", "做PPT", "制作演示文稿", or mentions "mona-ppt".
metadata:
  mona:
    emoji: "📊"
    always: false
    requires:
      bins: ["python"]
---

# Mona PPT Skill

Pipeline dispatcher for Mona PPT. This file owns execution discipline, step gates, and reference routing. Detailed instructions live in references and are loaded only when the step needs them.

Two tracks exist:

- **Track A (default)**: source -> project -> optional template -> Strategist -> optional image acquisition -> Executor SVG -> quality gate -> `svg_to_pptx.py` export.
- **Track B (template edit)**: user supplies a `.pptx` template file to fill in directly -> `references/template-edit-mode.md` (officecli track, no SVG pipeline).

When the prompt says "模版编辑模式" or names `references/template-edit-mode.md`, follow Track B only and ignore every Track A step below.

## Core Contract

1. Run the pipeline strictly in order. Check each step gate before entry.
2. Step 4 Eight Confirmations are blocking: wait for explicit user confirmation before writing `design_spec.md` / `spec_lock.md`.
3. Normal SVG path: no cross-phase bundling; no SVG during Strategist, no export before SVG quality passes.
4. Normal SVG path: every project SVG page is hand-written by the current main agent, one page at a time. No sub-agents, page batches, loops, templating scripts, or SVG generator scripts.
5. Normal SVG path: before every SVG page, read `<project_path>/spec_lock.md`; use only locked colors, fonts, icons, images, `page_rhythm`, `page_layouts`, and `page_charts`.
6. Do not directly inspect image files. Use `analyze_images.py` output and the design spec image list.
7. Normal SVG path: SVG image hrefs must use `../images/<filename>` for project images. Bare filenames like `cover_bg.png` are invalid unless the file is actually in `svg_output/`.
8. Normal SVG path: run `svg_quality_checker.py <project_path>` on `svg_output/`; all errors must be fixed before export.
9. Normal SVG path: speaker notes must be real Markdown under `notes/`; SVG `<metadata>` does not count.
10. Export discipline: PPTX export must use `${SKILL_DIR}/scripts/svg_to_pptx.py`. For custom PPTX templates, add `--template-underlay <native_template_dir>/template.pptx`. Never create custom export scripts, never use Node/pptxgenjs, never install PPTX-generation npm packages.

## Mona Defaults

- `${SKILL_DIR}` resolves to `<workspace>/mona/skills/mona-ppt/`.
- Create generated projects under `<workspace>/ppt_projects/` with `--dir ppt_projects`.
- On Windows, if `python3` fails, rerun the same command with `python`.
- Reply in the user's language unless explicitly asked otherwise.
- `design_spec.md` must keep the English section structure and field names from `templates/design_spec_reference.md`; values may use the user's language.
- This is a PPT workflow, not a generic coding task. Do not create branches, worktrees, tests, or app scaffolding by default.

## Reference Load Map

| Moment | Load |
|---|---|
| Template edit mode (Track B, user .pptx template to fill) | `references/template-edit-mode.md` |
| Step 1-2 source conversion / project setup | `references/source-project.md` |
| Step 3 explicit template directory path(s) only | `references/template-selection.md` |
| Custom PPTX template selected | `references/native-pptx-template-mode.md` |
| Step 4 Strategist | `references/strategist.md`, `templates/design_spec_reference.md`; `references/canvas-formats.md` only for special canvas choices |
| Step 5 image rows exist | `references/image-base.md`; plus `references/image-generator.md` only for `Acquire Via: ai`, `references/image-searcher.md` only for `Acquire Via: web` |
| Step 6 Executor | `references/executor-run.md`, `references/executor-base.md`, `references/shared-standards.md`, and exactly one style file: `executor-general.md` / `executor-consultant.md` / `executor-consultant-top.md` |
| Step 6 chart pages | `workflows/verify-charts.md` after SVG quality passes |
| Step 6 user explicitly asks visual review | `workflows/visual-review.md` after SVG quality passes |
| Step 7 export | `references/postprocess-export.md`; load animation/audio/live-preview workflows only when requested |
| Topic-only request | `workflows/topic-research.md` before Step 1 |
| Resume existing project | `workflows/resume-execute.md` |
| Create reusable template/brand | `workflows/create-template.md` / `workflows/create-brand.md` |

## Capability Anchors

- AI images: Step 5 handles `Acquire Via: ai`; never replace requested AI/web images with SVG placeholders.
- Charts / MATLAB-style plots: Strategist chooses native SVG charts or `plot_renderer.py` assets and locks the choice in `spec_lock.md` / `page_visual_plan.json`.
- Content-driven layouts and diagrams: Strategist selects rhythm, layout, flowchart, architecture, process, matrix, or chart expression from content.
- Formula assets: Strategist writes `images/formula_manifest.json`, runs `latex_render.py`, and records rendered PNGs as `Acquire Via: formula`.

## Workflow

### Step 1: Source Content Processing

Gate: user supplied source material, substantive text, conversation content, or requirements.

- If the user only gives a topic with no usable content, run `workflows/topic-research.md` first.
- Read `references/source-project.md`.
- Convert non-Markdown sources immediately.
- Preserve Office EMF/WMF vectors; do not rasterize them.

Checkpoint: source content is ready.

### Step 2: Project Initialization

Gate: Step 1 complete.

- Initialize with `project_manager.py init <project_name> --format <format> --dir ppt_projects`.
- Import source files with `project_manager.py import-sources <project_path> <source_files...> --move`.
- Chat-only text needs no import.

Checkpoint: project exists under `ppt_projects/`, and file sources are under `sources/`.

### Step 3: Template Option

Gate: Step 2 complete.

- Default is free design.
- Do not query template indexes, ask for templates, or fuzzy-match style names.
- Read `references/template-selection.md` only when explicit template directory path(s) are supplied.
- Style words and brand mentions without a path flow into Step 4 as user preferences.

- When no template is selected, keep the normal free-design flow: do not require `page_layouts`, do not copy template files, and do not add template export flags.

Checkpoint: free design is selected, or template files are copied/fused into `<project_path>/templates/`.

- When a `native` template is selected, keep the normal SVG pipeline and use the template PPTX first slide as a repeated underlay at export.
- Do not output `native_content_plan.json`; do not use `native_pptx_builder.py`.

### Custom PPTX Template Underlay Mode

Gate: Step 3 selected a directory under `mona/skills/mona-ppt/templates/native/<template_id>` containing `template.pptx`, `template_roles.json`, and `template_manifest.json`.

- Read `references/native-pptx-template-mode.md`.
- Treat `template.pptx` slide 1 as a repeated visual underlay for every final slide.
- Do not infer cover/toc/content/thanks roles from the template.
- Complete Step 4, Step 5, Step 6, SVG quality checks, notes, and chart verification normally.
- Export with `python ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path> --template-underlay <native_template_dir>/template.pptx`.

### Step 4: Strategist Phase

Gate: Step 3 complete.

Read `references/strategist.md` and `templates/design_spec_reference.md`.

Mandatory:

- Present the Eight Confirmations as one bundled recommendation set, include the required split-mode note, and wait for user confirmation.
- After confirmation, produce `<project_path>/design_spec.md`, `<project_path>/spec_lock.md`, and `<project_path>/page_visual_plan.json`.
- Before leaving Step 4, self-check `design_spec.md` has all template sections I-XI from `templates/design_spec_reference.md`.
- `spec_lock.md` must be generated from `templates/spec_lock_reference.md`. It must include filled `canvas`, `colors`, `typography`, `icons`, and one `page_rhythm` entry per page. Include `images` when any image/formula asset is used.
- `page_layouts` and `page_charts` are conditional: fill them only when pages actually use template SVGs or chart catalog templates; otherwise omit the whole section, do not leave empty shells.
- If formulas are selected for rendering, write `images/formula_manifest.json`, run `latex_render.py`, and include rendered formula PNGs in the image list and `spec_lock.md`.
- If user images or formula images exist, run `analyze_images.py <project_path>/images` before finalizing the spec.
- For charts, architecture views, flowcharts, process diagrams, matrices, and MATLAB-style plots, lock the expression tool in `spec_lock.md` / `page_visual_plan.json`.

Checkpoint: Strategist deliverables complete; continue automatically to Step 5 or Step 6 unless the user chose split mode.

### Step 5: Image Acquisition Phase

Gate: Step 4 complete.

Trigger when `design_spec.md` Section VIII has any row with `Acquire Via: ai` or `Acquire Via: web`.

- Read `references/image-base.md`.
- Lazy-load `references/image-generator.md` only for `ai` rows and `references/image-searcher.md` only for `web` rows.
- For `ai` rows: invoke Mona's `generate_image` tool with `prompt`, `aspect_ratio` (`16:9` for cover/landscape, `4:3` for content), `count: 1`; save output to `<project_path>/images/<filename>`.
- Every processed row must end at `Generated`, `Sourced`, or `Needs-Manual`; no `Pending` rows may remain.
- Acquisition failure does not halt the pipeline; follow the retry / `Needs-Manual` handling in `image-base.md`.
- Do not substitute SVG-drawn placeholders for requested AI/web images.

Checkpoint: acquisition attempted for every relevant row. Continue automatically unless the user explicitly chose split mode.

### Step 6: Executor Phase

Gate: Step 4 complete, and Step 5 complete if it was triggered.

Read Step 6 references from the Load Map. Read exactly one executor style file.

Mandatory:

- Start live preview before the first SVG and report the URL.
- Output design parameter confirmation before the first SVG.
- Batch-read referenced layout/chart SVGs once up front.
- For each page: re-read `spec_lock.md`, output the required trace line, then hand-write the SVG to `svg_output/`.
- For images, use only `../images/<filename>` hrefs for project assets listed in `spec_lock.md images`; do not use bare filenames.
- After all SVGs, run `svg_quality_checker.py <project_path>`, output the quality trace, fix every error, and rerun until 0 errors. No 0-error trace means Step 6 is not complete.
- Generate speaker notes at `<project_path>/notes/total.md`; notes embedded only in SVG `<metadata>` are non-compliant.
- If `spec_lock.md page_charts` has entries, run `workflows/verify-charts.md`; otherwise say chart verification is skipped.
- Run `workflows/visual-review.md` only when the user explicitly requested visual review.

Checkpoint: live preview started, all SVGs generated, quality gate has 0 errors, notes exist, chart verification was run or skipped.

### Step 7: Post-processing & Export

Gate: Step 6 complete.

Read `references/postprocess-export.md`.

- If Step 5 left `Needs-Manual` images, verify required files exist before export; pause and list missing filenames if not.
- Run one command at a time: `total_md_split.py`, then `finalize_svg.py`, then `svg_to_pptx.py`.
- If `total_md_split.py` or `svg_to_pptx.py` reports no notes files, stop and return to Step 6 notes generation.
- If `finalize_svg.py` reports missing/unresolved images, fix the SVG hrefs or file placement before export.
- Report the full project-relative path: `ppt_projects/<project_name>/exports/<project_name>_<timestamp>.pptx`.
- Apply browser annotations only after export and only when the user asks.

## Role Switch Marker

Before role work, read the matching reference and output:

```markdown
## [Role Switch: <Role Name>]
Reading role definition: references/<filename>.md
Current task: <brief description>
```
