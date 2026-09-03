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
---

# Mona PPT Skill

Pipeline dispatcher for Mona PPT. This file owns execution discipline, step gates, and reference routing. Detailed instructions live in references and are loaded only when the step needs them.

Run every bundled Python helper through `skill_script_run` with
`skill="mona-ppt"`; never execute Skill files through `exec` or system Python.

Use the standard source -> project -> optional visual reference -> Strategist ->
Executor SVG -> quality gate -> `svg_to_pptx.py` export pipeline. The former
OfficeCLI template-edit track is retired and must not be selected for new tasks.

## Core Contract

1. Run the pipeline strictly in order. Check each step gate before entry.
2. Step 4 Eight Confirmations are blocking: wait for explicit user confirmation before writing `design_spec.md` / `spec_lock.md`.
3. Normal SVG path: no cross-phase bundling; no SVG during Strategist, no export before SVG quality passes.
4. Normal SVG path: every project SVG page is hand-written by the current main agent, one page at a time. No sub-agents, page batches, loops, templating scripts, or SVG generator scripts.
5. Normal SVG path: before every SVG page, read `<project_path>/spec_lock.md`; use only locked colors, fonts, icons, images, `page_rhythm`, `page_layouts`, and `page_charts`.
6. Do not directly inspect image files. Use `analyze_images.py` output and the design spec image list.
7. Normal SVG path: SVG image hrefs must use `../images/<filename>` for project images. Bare filenames like `cover_bg.png` are invalid unless the file is actually in `svg_output/`.
8. Normal SVG path: run `svg_quality_checker.py <project_path>` on `svg_output/`; all errors must be fixed before export. Use `--fix` to auto-repair XML entity errors, then re-run to confirm.
9. Normal SVG path: speaker notes must be real Markdown under `notes/`; SVG `<metadata>` does not count.
10. Export discipline: PPTX export must use `${SKILL_DIR}/scripts/svg_to_pptx.py`. For custom PPTX templates, add `--template-underlay <native_template_dir>/template.pptx`. Never create custom export scripts, never use Node/pptxgenjs, never install PPTX-generation npm packages.
11. When `PPT_UI_CHECKPOINTS=1`: Step 4 generates outline draft and stops; Step 6 generates SVG pages **one at a time** (not batch), stopping after each page for user confirmation. No `.review_ready` file is written.
12. SVG text must be well-formed XML: use raw Unicode for typographic symbols (em dash, ©, →, NBSP) and XML builtin entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) for XML reserved characters. HTML named entities (`&nbsp;`, `&mdash;`, `&copy;`) and bare `&` characters (`R&D`) are forbidden because they abort both preview and export.

## Mona Defaults

- `${SKILL_DIR}` resolves to `<workspace>/mona/skills/mona-ppt/`.
- Create generated projects under `<workspace>/ppt_projects/` with `--dir ppt_projects`.
- Do not select a Python executable; `skill_script_run` always supplies Mona's managed environment.
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

---

#### V3 UI Checkpoints (when PPT_UI_CHECKPOINTS=1)

当启动 Prompt 包含 `PPT_UI_CHECKPOINTS=1` 标记时，Step 4 行为变更如下：

⛔ **禁止 BLOCKING 聊天确认**：V3 模式下，启动 Prompt 已经预先携带了用户在 UI 中确认的 8 项偏好（画布格式 / 页数 / 风格 / 主色调 / 图标 / 字体 / 公式 / 图片）。**不要再把 8 项推荐作为聊天消息发出来等待用户回复**——这会阻塞 UI 流程。直接基于用户偏好完成分析并写文件。如果某项用户偏好为 "AI 推荐"，按你的专业判断选定一个具体值并写入 `design_spec_summary.json`。

1. 基于启动 Prompt 中的用户偏好完成八项确认分析（不发聊天消息）。
2. 写完整 `design_spec.md` 草稿。
3. 写 `page_visual_plan.json`（包含 schemaVersion=2, revision=0, pages 数组）。**每页必须包含以下中文字段**：
   - `title`：页面标题（中文）
   - `summary`：内容概要（中文，1-2 句话描述本页要传达的核心信息）
   - `bullets`：核心要点数组（中文，每条一个要点）
   - `visual_type`：视觉表达方式（如 text_layout / chart_bar / chart_line / chart_pie / diagram / process / comparison / timeline / image / cover / section_divider / quote）
   - `layout`：布局建议（中文，描述页面布局，如"左标题右内容""上下分栏""居中大图"等）
   - `image_plan`：图片方案（中文，描述本页图片需求，如"AI 生成科技感背景图""柱状图展示季度数据""无需图片"等）
   - `notes`：备注（中文，演讲词或补充说明）
   - `file`：SVG 文件名（如 page_001.svg）
   - `page`：页面 ID（如 page_001）
4. 写 `design_spec_summary.json` —— 八项确认的结构化摘要，供 UI 加载展示与用户修改。Schema：
   ```json
   {
     "schemaVersion": 1,
     "canvasFormat": "ppt169",
     "pageCount": 12,
     "audience": "技术团队",
     "styleMode": "general|consulting|top-consulting",
     "styleDescriptor": "minimalist tech",
     "primaryColor": "#1565C0",
     "colorScheme": "主色 #1565C0 / 辅助 #FF9800 / 背景 #FFFFFF / 文字 #212121（简短中文描述）",
     "iconApproach": "emoji|ai|builtin|custom",
     "iconLibrary": "chunk-filled|tabler-filled|tabler-outline|phosphor-duotone|null",
     "typographyPlan": "标题：Microsoft YaHei / 正文：Microsoft YaHei（简短中文描述）",
     "titleFont": "Microsoft YaHei",
     "bodyFont": "Microsoft YaHei",
     "formulaPolicy": "mixed|render-all|text-only",
     "imageApproach": "none|user|ai|web|placeholder",
     "imageRendering": "vector-illustration|null",
     "imagePalette": "cool-corporate|null",
     "updatedAt": "2026-07-31T12:00:00Z"
   }
   ```
   - 用户偏好已明确指定的项，直接填入；用户偏好为 "AI 推荐" 的项，由你按内容分析选定一个具体值（不要写 "AI 推荐" 字符串到 JSON）。
   - 所有颜色用 HEX 字符串；所有枚举值用小写英文。
5. **不写 `spec_lock.md`**。
6. **不进入 Step 5/6**。
7. 输出一行简短提示（不超过 2 句话）告知用户"大纲草稿已生成，请在 PPT 页面编辑每页内容后确认；如需调整全局设计规格请直接在聊天中说明"，然后结束当前 turn。**不要在 chat 中重复 8 项推荐内容**——它们已经写入 `design_spec_summary.json`，UI 会读取展示。

用户会在 UI 上编辑/增删/重排页面、编辑每页内容，确认后系统会自动锁定大纲。收到 `[OUTLINE_CONFIRMED]` 消息后，Agent 必须：
1. 读取最终 `page_visual_plan.json`。
2. 按其内容同步重建 `design_spec.md`。如用户在聊天中要求过规格调整，以调整后的 `design_spec.md` 当前状态为准，不要回退到 Step 4 初始草稿。
3. 按 `templates/spec_lock_reference.md` 生成完整 `spec_lock.md`（使用更新后的 `design_spec.md`）。
4. 如需 Step 5 图片获取，执行完毕。
5. 启动 Flask live preview。
6. **仅生成第 1 页 SVG**，写入 `svg_output/`，输出 required trace line。
7. 对该页运行质量检查，修复 error。
8. 写该页备注到 `notes/`。
9. **停止**，告知用户"第 1 页已生成，请预览确认"。
10. **不要生成其他页，不要进入 Step 7，不要写 `.review_ready`**。

**关于 8 项确认**：用户在大纲阶段不编辑全局 8 项确认（UI 只读展示 AI 推荐规格）。如用户需要调整全局规格，会通过聊天直接告知 Agent（如「主色改成 #1a73e8」「用深色背景」），Agent 收到后更新 `design_spec.md` + `design_spec_summary.json`。因此 `[OUTLINE_CONFIRMED]` 不携带 8 项修改字段，Agent 直接以 `design_spec.md` 当前状态生成 `spec_lock.md`。

收到 `[PAGE_CONFIRMED_NEXT]` 消息后，Agent 必须：
1. 生成下一页 SVG，输出 required trace line。
2. 对该页运行质量检查，修复 error。
3. 写该页备注到 `notes/`。
4. **停止**，告知用户"第 N 页已生成，请预览确认"。

收到 `[PAGE_REDO_REQUESTED]` 消息后，Agent 必须：
1. 如消息携带 `page_spec`，读取 `page_visual_plan.json` 中该页的最新规格（UI 已更新）。
2. 重新读取 `spec_lock.md`，确认锁定参数未变。
3. 如规格涉及内容修改，先同步 `design_spec.md` 和 `notes/` 中该页备注。
4. 重新手写该页 SVG，输出 required trace line。
5. 对该页运行质量检查，修复 error。
6. **停止**，告知用户"第 N 页已重做，请预览确认"。

收到 `[PAGE_GENERATE_REQUESTED]` 消息后，Agent 必须：
1. 生成指定页 SVG，输出 required trace line。
2. 对该页运行质量检查，修复 error。
3. 写该页备注到 `notes/`。
4. **停止**，告知用户"第 N 页已生成，请预览确认"。

收到 `[ALL_PAGES_CONFIRMED]` 消息后，Agent 必须：
1. 运行全量 `svg_quality_checker.py` 作为最终门控。
2. 执行 Step 7 后处理与导出。

收到 `[DESIGN_SPEC_UPDATED]` 消息后，Agent 必须：
1. 读取消息中列出的更新项（风格模式/主色调/图标方案/图片方案/公式策略/目标受众/视觉风格/页数/字体/画布格式）。
2. 更新 `design_spec.md` 中受影响的章节（颜色/字体/图标/图片/公式策略）。
3. 同步重写 `design_spec_summary.json` 中对应字段（保留未变更字段，更新 `updatedAt`）。
4. 如果 `spec_lock.md` 已生成，同步更新其中对应参数。
5. 如果已有 SVG 页面生成，告知用户哪些页面需要重新生成以匹配新规格。
6. **停止**，告知用户"设计规格已更新"。

未带 `PPT_UI_CHECKPOINTS=1` 标记的 CLI、普通聊天调用继续执行现有自动管线。

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

#### V3 Per-Page Mode (when PPT_UI_CHECKPOINTS=1)

当 `PPT_UI_CHECKPOINTS=1` 时，Step 6 变为**逐页生成模式**：

- 收到 `[OUTLINE_CONFIRMED]` 后，仅生成第 1 页 SVG + 质量检查 + 备注，然后停止
- 收到 `[PAGE_CONFIRMED_NEXT]` 后，生成下一页 SVG + 质量检查 + 备注，然后停止
- 收到 `[PAGE_REDO_REQUESTED]` 后，重做指定页 SVG + 质量检查，然后停止
- 收到 `[PAGE_GENERATE_REQUESTED]` 后，生成指定页 SVG + 质量检查 + 备注，然后停止
- **不写 `.review_ready` 文件**
- **不批量生成所有页**
- 每页生成后必须停止，等待用户在 UI 上确认后才推进

消息模板详见 `references/ui-checkpoints.md`。

收到 `[ALL_PAGES_CONFIRMED]` 后，运行全量质量检查作为最终门控，然后执行 Step 7 导出。

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
