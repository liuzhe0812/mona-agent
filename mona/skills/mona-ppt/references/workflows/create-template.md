---
description: Generate a new layout or deck template based on existing project files or reference templates
---
# Create New Template Workflow
> **Role invoked**: [Template_Designer](../references/template-designer.md)
Generate a complete set of reusable PPT templates for the **global template library**.
> This workflow is for **library asset creation**, not project-level one-off customization. The output must be reusable by future PPT projects and discoverable from the appropriate index file.
> **Companion workflow**: identity-only locking (colors / typography / logo / voice without SVG pages) is handled by [`create-brand.md`](./create-brand.md). Use that when the user wants brand identity but free page layout; use this when fixed page structures are required.
## Kind decision — deck (default) vs layout
This workflow produces one of two kinds of templates depending on whether the source PPT carries a specific brand identity:
| Kind | When | Output dir | What `design_spec.md` writes |
|---|---|---|---|
| **deck** (default) | Source is a specific organization's branded PPT (e.g. company report, university defense template); the visual identity is part of the replica | `templates/decks/<id>/` | Full segments: identity + structure + middle |
| **layout** | Source is a generic stylistic template (no specific brand); only the structural skeleton should be reusable; color / typography decided per-deck downstream | `templates/layouts/<id>/` | Structure segments only (canvas / page structure / page types / SVG roster); identity segment omitted |
Default to **deck** unless the user explicitly says "structure only" / "layout only" / "no brand identity". When in doubt, lean deck — losing identity later is easy; reconstructing it from a layout-mode strip is not. See [`docs/zh/templates-architecture.md`](../../../docs/zh/templates-architecture.md) for the full kind / schema / fusion model.
## Process Overview
```
Reference Intake & Analysis -> Fact-Based Brief Proposal -> User Confirmation Gate -> Create Directory + Invoke Template_Designer -> Validate Assets -> Register Index -> Output
```
The first three steps derive the brief from facts, not guesses. **No final template directory may be created and no template SVG / `design_spec.md` may be written until `[TEMPLATE_BRIEF_CONFIRMED]` is emitted in Step 3.** Reference-analysis intermediates produced by `pptx_template_import.py` (typically under `/tmp/pptx_template_import/`) are explicitly **not** subject to this gate — they are temporary workspaces feeding Step 2.
---
## Step 1: Reference Intake & Analysis
Branch by the type of reference source the user supplied. This step produces analysis artefacts only — it does **not** create the final template directory, write `design_spec.md`, or touch `layouts_index.json`.
### Input source taxonomy
| Type | What the user supplied | Tool / read path | Replication modes available |
|------|-------------------------|------------------|------------------------------|
| **A** `.pptx` reference | A `.pptx` file path | `pptx_template_import.py` → `manifest.json` + `svg/master_*.svg` + `svg/layout_*.svg` + `svg/slide_*.svg` + `svg-flat/slide_*.svg` + `assets/` | `standard` / `fidelity` / `mirror` |
| **B** Existing SVG assets | `ppt_projects/<x>/svg_output/`, `templates/layouts/<existing>`, or a loose `.svg` folder | `ls` + `Read` each `*.svg`; plus `design_spec.md` / `spec_lock.md` if present | `standard` / `fidelity` (AI visual clustering) / `mirror` (direct 1:1 copy) |
| **C** Image / visual references | Screenshot folder, single image, PDF pages | `ls` + `Read` each file (multimodal visual recognition) | `standard` only |
| **D** No reference source | Verbal description only ("McKinsey style", "tech blue", "dark minimal") | — | `standard` only |
`fidelity` and `mirror` are not available for type C / D — visual references and verbal-only briefs cannot drive page-by-page replication. Type A is the canonical path: `manifest.json` page-type candidates and the layered `svg/` workspace anchor cluster detection (fidelity) and verbatim copy (mirror) with factual data. Type B is supported with caveats:
- **mirror on type B** — direct 1:1 copy. B's SVGs are already self-contained (one file per page, equivalent to `svg-flat/slide_*.svg`). Page-type for the `<NNN>_<page_type>.svg` filename is read from the source filename when it follows the PPT Master naming convention (`01_cover.svg` → `cover`, `03a_content_two_col.svg` → `content`); fall back to `content` otherwise. Particularly natural when the source is `templates/layouts/<existing>` and the user wants to fork an existing template.
- **fidelity on type B** — clustering relies on the AI's visual judgement of the SVGs; there is no `manifest.json.pageTypeCandidates` to anchor it. Variant count and grouping are more subjective and may need iteration. If the input is already a PPT Master template (`templates/layouts/<existing>`), parse the existing variant filenames (`03a_content_two_col` etc.) as authoritative cluster hints rather than re-clustering visually.
### 1A. `.pptx` reference
Run the unified preparation helper:
```bash
python3 skills/mona-ppt/scripts/pptx_template_import.py "<reference_template.pptx>"
```
This produces, in one workspace:
- `manifest.json` — single source of truth: slide size, theme colors, fonts, per-master theme summaries, asset inventory, placeholder metadata, SVG file paths, per-slide / per-layout / per-master metadata, page-type candidates
- `summary.md` — short human-readable digest derived from manifest.json (for quick scanning only)
- `assets/` — extracted reusable image assets; `manifest.json` owns the asset-name mapping and SVG `href` values reuse that mapping
- `svg/` — **primary view** (layered template view):
  - `svg/master_*.svg` — every slide master in the deck rendered once, including masters that no sample slide currently uses (template packages routinely ship more masters than the visible samples reference)
  - `svg/layout_*.svg` — every slide layout in the deck rendered once (its own contribution; master shapes do **not** repeat here)
  - `svg/slide_NN.svg` — each slide's own shapes and slide-local background; master / layout shapes and backgrounds are **not** inlined here
  - `svg/inheritance.json` — which layout & master each slide consumes
- `svg-flat/` — **companion view** (one self-contained SVG per slide):
  - `svg-flat/slide_NN.svg` — master + layout + slide painted into a single SVG so opening any slide on its own shows the full page like PowerPoint would. Use this for previews / screenshot pipelines / "what does the slide actually look like" sanity checks.
- The default `--inheritance-mode both` emits both views. Pass `layered` to skip `svg-flat/`, or `flat` for round-trip use cases (legacy: `svg/` becomes self-contained slides without the master/layout/inheritance files).
Import fidelity rules:
- Placeholder metadata is recorded in `manifest.json`; master / layout SVGs show lightweight dashed guides with labels only in `svg/`, not in `svg-flat/`.
- Charts, SmartArt, diagrams, and OLE objects are typed placeholders in `svg/`. In `svg-flat/`, they use a preview image with a small badge when one exists; otherwise they stay visible as placeholders. Tables are converted to real SVG.
- Missing media and external linked images fail the import. EMF / WMF Office vector media are converted to PNG previews when supported by the local toolchain; otherwise the import fails.
It is a reconstruction aid, not a final direct template conversion.
**Read order during analysis** (read everything below before composing Step 2):
1. `manifest.json` (factual metadata: slide size, theme, assets, layouts, masters, slide page-types)
2. `svg/master_*.svg` and `svg/layout_*.svg` — read these **before** any slide SVG; they show the deck's shared visual language (background, headers, footers, decorative bars). This is what the new template's fixed structure should adapt from.
3. `svg/inheritance.json` — confirms which slide uses which layout/master
4. exported `assets/`
5. cleaned slide SVG references `svg/slide_NN.svg` — content unique to each slide; consult after the master/layout language is understood
6. `summary.md` only as a quick orientation aid
7. user-provided screenshots or the original PPTX only for visual cross-checking
Interpretation rule (carries forward into Steps 2 and 4):
- `manifest.json` is the source of truth for slide size, theme colors, fonts, background inheritance, reusable asset inventory, unique layout/master structure, and slide reuse relationships
- `summary.md` is a quick scan; never treat it as the canonical fact source — go back to `manifest.json` if anything is unclear
- exported `assets/` are the canonical reusable image pool — `<image>` references in `svg/` already point at these files directly
- `svg/master_*.svg` / `svg/layout_*.svg` are the **primary source for fixed structural design** — recurring backgrounds, page chrome, decorative motifs that the template should preserve. The new template's `01_cover` / `02_chapter` / `03_content` / `04_ending` typically inherit elements from these layers.
- `svg/slide_NN.svg` shows page-specific content — useful for judging composition rhythm and content density, not for fixed structure. Read every slide regardless of count.
- `svg-flat/slide_NN.svg` is for human preview and screenshot comparison; do not treat duplicated master/layout chrome inside flat slides as separate reusable template structure.
- screenshots remain useful for judging composition and style, but should not override extracted factual metadata unless the import result is clearly incomplete
**Hard read gate** (`standard` / `fidelity` modes — `mirror` differs, see below):
- The agent MUST finish reading every `svg/master_*.svg`, `svg/layout_*.svg`, and `svg/slide_*.svg` file under `<import_workspace>/svg/` before moving on to Step 2
- The agent MUST list the read master / layout / slide filenames inside the Step 2 brief proposal as proof of the gate
Do **not** treat the imported PPTX or exported slide SVGs as direct final template assets — Step 4 reconstructs them as a clean, maintainable PPT Master template package, not a 1:1 shape translation.
> **Mirror-mode fast path** — when the user has indicated mirror replication (verbatim copy of every source slide):
> - Read **only** `svg-flat/slide_*.svg` (the self-contained, what-PowerPoint-shows view) and `manifest.json` (for theme colors, fonts, asset inventory).
> - Skip `svg/master_*.svg` / `svg/layout_*.svg` / `svg/inheritance.json` — chrome / content separation is irrelevant in mirror mode (no placeholder insertion happens).
> - Mirror is explicitly a verbatim copy flow — every slide becomes a template page as-is. The "reconstruct, don't translate" rule applies to `standard` / `fidelity` only.
### 1B. Existing SVG assets
`ls` the directory and `Read` every `*.svg` to extract:
- canvas size (`viewBox` on the root `<svg>`)
- recurring colors (`fill` / `stroke` values; identify the dominant 2–4 hex codes as candidate theme colors)
- fonts (`font-family` attributes on `<text>`)
- placeholder usage (existing `{{...}}` strings, if any)
- structural decoration (recurring `<rect>` bars, `<path>` motifs, embedded `<image>` references)
If a `design_spec.md` or `spec_lock.md` accompanies the SVGs, `Read` it too — it is a higher-confidence source than re-deriving from the SVG alone. Record the equivalent of a `manifest.json`'s factual fields in your own analysis notes (no actual file written) so Step 2 can label them `[fact]`.
### 1C. Image / visual references
`ls` the folder (or single file) and `Read` each image / PDF page. Extract what's visible:
- rough theme colors (eyeball the dominant 2–4 hues; do NOT report exact HEX as fact)
- page count (count the supplied images as an approximate slide count)
- dominant typography style (sans / serif / display) — never report a font name
- decorative motifs and composition rhythm
Be explicit in Step 2 that exact HEX values, font names, and placeholder structure are **estimates from visual inspection** (`[suggested]`), never `[fact]`.
### 1D. No reference source
Skip the analysis. Step 2 will list every Required item as `[decision]`; nothing is fact-derivable from a non-existent source.
---
## Step 2: Fact-Based Brief Proposal
Compose a single message that surfaces every Required brief item to the user, **labelling each value's provenance**:
- **`[fact]`** — extracted from Step 1 analysis (e.g. theme color from `manifest.json`)
- **`[suggested]`** — AI-inferred from analysis or context (e.g. tone summary, applicable scenarios; visually estimated values from type C)
- **`[decision]`** — pure user choice, no analysis substitute (e.g. `template_id`, `replication mode`, `category`)
Items to surface:
| Item | Required | Provenance by input type |
|------|----------|--------------------------|
| New template ID | Yes | `[decision]` — user chooses ASCII slug; if Chinese brand name, must be filesystem-safe and match `layouts_index.json` exactly |
| Template display name | Yes | `[decision]` (often the source deck title — `[suggested]` from `summary.md` for type A) |
| Category | Yes | `[decision]` — one of `brand` / `general` / `scenario` / `government` / `special` |
| Applicable scenarios | Yes | `[suggested]` from analysis; user confirms |
| Tone summary | Yes | `[suggested]` from analysis (e.g. `Modern, restrained, data-driven`) |
| Theme mode | Yes | A: `[fact]` from `manifest.json` background colors. B: `[fact]` from SVG `fill`. C: `[suggested]` from visual estimate. D: `[decision]` |
| Canvas format | Yes | A/B: `[fact]` from slide size or SVG `viewBox`. C: `[suggested]` from image aspect ratio. D: `[decision]`, default `ppt169` |
| Replication mode | Yes | `[decision]` — `standard` always available; `fidelity` and `mirror` available for type A (canonical, manifest-anchored) and type B (AI visual clustering / direct 1:1 copy — see Step 1 caveats); reject `fidelity` / `mirror` upfront for type C / D |
| Visual fidelity for fixed pages | Yes for `standard` / `fidelity` when reference exists; **N/A for `mirror`** (mirror is implicitly literal) | `[decision]` — `literal` (preserve original geometry / decoration / sprite crops as-is; for cover / chapter / ending especially) or `adapted` (use the reference for tone/structure but allow design evolution). Different page types may take different settings |
| Reference source | Optional | already known if Step 1 ran |
| Theme color | Optional | A: `[fact]` from theme XML. B: `[fact]` from dominant SVG `fill`. C: `[suggested]` from visual estimate (HEX is approximate). D: `[decision]` |
| Fonts | Optional | A: `[fact]` from `manifest.json`. B: `[fact]` from SVG `font-family`. C / D: not derivable — `[decision]` if user wants a custom stack |
| Design style | Optional | `[suggested]` from analysis |
| Assets list | Optional | A: `[fact]` from `assets/` listing; user picks which to bundle. B / C: `[decision]` per file. D: none |
| Keywords | Yes | `[suggested]` from analysis (3–5 short tags); user confirms |
For type A, also include in this message:
- the exact `svg/master_*.svg`, `svg/layout_*.svg`, `svg/slide_*.svg` filenames you read (proof of the hard read gate)
- a one-line summary of the master / layout structure you extracted
The user replies with corrections, additions, or "all good".
> **Persist the brief into `design_spec.md`**. When the Template_Designer writes `design_spec.md` in Step 4, declare a YAML frontmatter block at the top with the confirmed brief (`template_id`, `category`, `summary`, `keywords`, `primary_color`, `canvas_format`, `replication_mode`, etc.). `register_template.py` reads this in Step 6, so the brief flows directly into the index without the AI re-deriving it from prose. See Step 6 for the recommended frontmatter shape.
---
## Step 3: User Confirmation Gate
**MANDATORY interactive gate — this step BLOCKS Steps 4 onward.**
