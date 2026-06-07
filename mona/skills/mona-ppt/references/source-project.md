# Source Processing & Project Setup

Use this reference for Step 1 and Step 2.

## Source Conversion

When the user provides non-Markdown content, convert it before project import.

| User provides | Command / handling |
|---|---|
| PDF | `python3 ${SKILL_DIR}/scripts/source_to_md/pdf_to_md.py <file>` |
| DOCX / Word / Office document | `python3 ${SKILL_DIR}/scripts/source_to_md/doc_to_md.py <file>` |
| XLSX / XLSM / Excel workbook | `python3 ${SKILL_DIR}/scripts/source_to_md/excel_to_md.py <file>` |
| CSV / TSV | Read directly as a plain-text table source |
| PPTX / PowerPoint deck | `python3 ${SKILL_DIR}/scripts/source_to_md/ppt_to_md.py <file>` |
| EPUB / HTML / LaTeX / RST / other document | `python3 ${SKILL_DIR}/scripts/source_to_md/doc_to_md.py <file>` |
| Web link | `python3 ${SKILL_DIR}/scripts/source_to_md/web_to_md.py <URL>` |
| WeChat / high-security page | `python3 ${SKILL_DIR}/scripts/source_to_md/web_to_md.py <URL>`; requires `curl_cffi` from requirements |
| Markdown | Read directly |
| Direct conversation text | No conversion; treat conversation content as source |

If `python3` fails on Windows, rerun the same command with `python`.

## Office Vector Assets

`doc_to_md.py` and `ppt_to_md.py` extract embedded Office vector images (`.emf` / `.wmf`) alongside bitmap assets.

Do not convert EMF/WMF to PNG. After `import-sources`, they live in `images/` with `image_manifest.json` and are first-class image resources. `finalize_svg.py` skips them and `svg_to_pptx.py` embeds them as PPTX-native `image/x-emf` / `image/x-wmf` media.

Browser live preview cannot render EMF and may show a blank placeholder. The PPTX output is the source of truth for those assets.

## Project Initialization

Create the project under Mona's shared project directory:

```bash
python3 ${SKILL_DIR}/scripts/project_manager.py init <project_name> --format <format> --dir ppt_projects
```

Default format is `ppt169`. For `ppt43`, `xhs`, `story`, and other canvas choices, read `references/canvas-formats.md`.

## Import Sources

| Situation | Action |
|---|---|
| Source files exist | `python3 ${SKILL_DIR}/scripts/project_manager.py import-sources <project_path> <source_files...> --move` |
| User provided text only in chat | No import; later roles read from conversation context |

Hard rule: use `--move`, not copy. Step 1 converted Markdown, original PDFs / Markdown / images, and related intermediate folders are moved into `sources/` / `images/` so Mona history and download APIs see one canonical project package.

## Checkpoint

Before leaving Step 2, verify:

- `<project_path>/` exists under `ppt_projects/`
- source files are under `<project_path>/sources/`
- extracted images or Office vectors are under `<project_path>/images/` when present
- converted Markdown or direct conversation content is ready for Strategist
