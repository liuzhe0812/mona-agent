# Executor Run Orchestration

Use this reference at Step 6 before generating SVG pages.

## Required References

Always read:

```text
references/executor-base.md
references/shared-standards.md
```

Then read exactly one style reference:

| Confirmed style | Read |
|---|---|
| General flexible style | `references/executor-general.md` |
| Consulting style | `references/executor-consultant.md` |
| Top consulting / MBB-level style | `references/executor-consultant-top.md` |

Do not read all style references by default.

## SVG Color Rule

All SVG colors must use `#RRGGBB`. Do not use `rgba()`. For gradient transparency, use `stop-opacity`; do not embed alpha in `stop-color`.

## Before First SVG

1. Output design parameter confirmation from the spec: canvas dimensions, color scheme, font plan, and body font size.
2. Start live preview:

   ```bash
   python3 ${SKILL_DIR}/scripts/svg_editor/server.py <project_path> --live
   ```

   Start it even when `svg_output/` is empty. Default URL is `http://localhost:5050`; if occupied, use `--port <other>` and report the actual URL.

3. Keep the preview service running through Executor and export unless the user clicks Exit preview or explicitly asks to stop it.
4. Do not read or apply submitted annotations during generation. Annotation handling starts only after Step 7 export through `workflows/live-preview.md`.
5. Batch-read every distinct layout SVG from `spec_lock.page_layouts`, every distinct chart SVG from `spec_lock.page_charts`, and any chart templates referenced in the design spec but not covered by `page_charts`. Read each file once up front; do not re-read these during page generation.

## Per-Page Generation

Before each page:

1. Read `<project_path>/spec_lock.md`.
2. Use only lock values for colors, fonts, icons, images, `page_rhythm`, `page_layouts`, and `page_charts`.
3. Reference project images only as `../images/<filename>` where `<filename>` is listed in `spec_lock.md images`. Bare image hrefs such as `cover_bg.png` are invalid unless the file actually lives beside the SVG in `svg_output/`.
4. Output the trace line required by `references/executor-base.md` Section 2.1.
5. Write the page SVG by hand to `<project_path>/svg_output/`.

No sub-agents. No page batches. No script or template loop may generate project SVG pages.

## V3 Per-Page Mode (when PPT_UI_CHECKPOINTS=1)

When `PPT_UI_CHECKPOINTS=1` is active, the executor operates in **per-page mode**:

- After `[OUTLINE_CONFIRMED]`: generate spec_lock.md, then **only the first page** SVG. Stop.
- After `[PAGE_CONFIRMED_NEXT]`: generate **only the next page** SVG. Stop.
- After `[PAGE_REDO_REQUESTED]`: regenerate **only the specified page** SVG. Stop.
- After `[PAGE_GENERATE_REQUESTED]`: generate **only the specified page** SVG. Stop.

Key differences from batch mode:

1. **One page at a time**: never generate multiple pages in a single turn.
2. **Per-page quality check**: after writing each SVG, run `svg_quality_checker.py` and fix any errors on that page before stopping.
3. **Per-page notes**: write the current page's speaker notes to `notes/` (or append to `notes/total.md`) before stopping. Do not wait until all pages are done.
4. **No `.review_ready` file**: V3 does not use `.review_ready`. The review gate is replaced by per-page UI confirmation.
5. **Stop after each page**: always stop and wait for the next UI message. Do not automatically proceed to the next page.
6. **Final quality gate**: when `[ALL_PAGES_CONFIRMED]` is received, run a full `svg_quality_checker.py` on all SVGs as the final gate before Step 7 export.

## Quality Gate

After all SVGs are generated, before annotations, notes splitting, or export:

```bash
python3 ${SKILL_DIR}/scripts/svg_quality_checker.py <project_path>
```

Run it against `svg_output/`, not after `finalize_svg.py`.

- Any `error` must be fixed before proceeding: regenerate the affected page and rerun the checker.
- Fix warnings when straightforward; otherwise acknowledge them and proceed.
- Output the quality trace:

```text
🔍 Quality Check: ___ errors, ___ warnings
   Errors resolved: yes/no (if yes, list fixed pages)
```

If errors were found and fixed, rerun the checker and output a second trace confirming 0 errors.

Hard gate: if there is no visible quality trace confirming 0 errors, Step 6 is not complete and Step 7 must not start.

## Notes

Generate speaker notes into:

```text
<project_path>/notes/total.md
```

SVG `<metadata>` is not a valid speaker-notes handoff. `svg_to_pptx.py` reads Markdown files from `notes/`; if `notes/total.md` is missing, create it before Step 7.

## Chart Verification Decision

After the quality gate, inspect `spec_lock.md page_charts`.

- If it has at least one `P<NN>: <chart_name>` entry, run `workflows/verify-charts.md` before Step 7.
- If absent or empty, output `✅ No chart pages - skipping verify-charts` and continue.

## Visual Review

Run `workflows/visual-review.md` only when the user explicitly asked for a per-page visual self-check, such as "visual review", "check pages visually", or equivalent.

## Checkpoint

Before Step 7:

- live preview was started and URL reported
- all SVGs exist in `svg_output/`
- `svg_quality_checker.py` has 0 errors
- notes exist at `notes/total.md`
- chart verification was run or explicitly skipped
