# Post-processing & Export

Use this reference at Step 7.

## Entry Gate

Step 6 must be complete:

- SVGs generated to `<project_path>/svg_output/`
- `svg_quality_checker.py <project_path>` passed with 0 errors
- speaker notes exist at `<project_path>/notes/total.md`; SVG `<metadata>` notes do not count

## Image Readiness Gate

If Step 5 left any AI image row as `Needs-Manual`, verify every expected file exists at:

```text
<project_path>/images/<filename>
```

If files are missing, pause. List the missing filenames, point the user to `images/image_prompts.md`, and ask them to place generated files under `project/images/<filename>`. Resume only after all expected files exist.

`finalize_svg.py` and `svg_to_pptx.py` do not catch this layer of missing manual files; skipping the gate can produce broken image references.

## Run One Command At A Time

Never combine these into one shell block or one chained invocation.

### 7.1 Split speaker notes

```bash
python3 ${SKILL_DIR}/scripts/total_md_split.py <project_path>
```

If this step reports missing `notes/total.md`, no parsed notes, or no per-page note files, stop and return to Step 6 to write real Markdown notes. Do not rely on SVG `<metadata>`.

### 7.2 Finalize SVG

```bash
python3 ${SKILL_DIR}/scripts/finalize_svg.py <project_path>
```

Never substitute `cp` for `finalize_svg.py`.

If this step reports missing or unresolved images, fix the SVG hrefs or file placement before export. For project images, SVG hrefs must be `../images/<filename>`, not bare filenames like `cover_bg.png`.

### 7.3 Export PPTX

```bash
python3 ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path>
```

If a brand template is required:

```bash
python3 ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path> --template <brand_template_pptx_path>
```

If a custom PPTX template underlay is selected:

```bash
python3 ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path> --template-underlay <native_template_dir>/template.pptx
```

Output is canonical at:

```text
<project_path>/exports/<project_name>_<timestamp>.pptx
```

When reporting to the user, always include the full project-relative path:

```text
ppt_projects/<project_name>/exports/<project_name>_<timestamp>.pptx
```

## Optional Export Flags

Use only when needed:

- `--svg-snapshot`: also emit SVG-image preview PPTX from `svg_final/`.
- `-s output` / `-s final`: force a single source. Avoid unless there is a specific reason.
- `--merge-paragraphs`: merge stacked text lines into editable text frames; default off for visual fidelity.
- `-t <effect>`: page transition. Default `fade`.
- `-a <effect>`: per-element entrance animation. Default `auto`; use `none`, a named effect, or `mixed` only when requested.
- `--animation-trigger {on-click,with-previous,after-previous}`: default `after-previous`.
- `--animation-config <path>`: object-level sidecar; default `<project_path>/animations.json` when present.
- `--auto-advance <seconds>`: kiosk-style autoplay.
- `--recorded-narration audio`: only after running `workflows/generate-audio.md`.

For full animation behavior, read `references/animations.md`. For object-level tuning, read `workflows/customize-animations.md`.

## Forbidden Export Shortcuts

- Do not create custom PPTX export scripts such as `convert_to_pptx.js`, `export.py`, or any Node.js/pptxgenjs script.
- Do not install PPTX-generation npm packages.
- Do not force `-s output` for the legacy/preview PPTX without a concrete reason; the default split source preserves icons and rounded corners correctly.
- Do not use `--only`; it suppresses one of the expected output files.
- If `svg_to_pptx.py` reports `no notes files found`, the export is incomplete for decks that require notes; go back to Step 6/7.1 and fix notes generation before delivering.

## Post-export Annotation Window

The live preview service from Step 6 usually stays running after export.

If the user submitted browser annotations and asks to apply them, run `workflows/live-preview.md` Step 2, then re-export through this Step 7 sequence.

If the user asks for preview and the service is not running, run `workflows/live-preview.md` Step 1. If it is already running, report the URL.
