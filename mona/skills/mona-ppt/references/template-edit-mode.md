# Template Edit Mode (officecli Track)

Use only when the user provides a `.pptx` template file and asks to build a
presentation **from that template** (template edit mode). This track edits the
template directly with `officecli` and preserves its masters, layouts, theme
colors, and fonts.

This is a separate track from the normal SVG pipeline. Never mix them.

## Hard Rules

- Never modify the user's original template file. Always work on a copy inside
  the project directory.
- Do not use the SVG pipeline: no `design_spec.md` / `spec_lock.md` SVG
  lockflow, no `svg_output/`, no `svg_to_pptx.py`, no `native_pptx_builder.py`.
- Do not rebuild slides from scratch. Reuse the template's own slide layouts
  (`--prop layout="<Layout Name>"`) so theme, fonts, and placeholders stay
  intact.
- Keep the template's theme colors and fonts. Do not hardcode colors/fonts on
  individual shapes unless the user explicitly asks.
- Every mutation goes through `officecli` (`add` / `set` / `remove` / `move` /
  `batch`). Never edit the pptx XML by hand, never unzip/rezip the file.
- Finish with `validate` and `close` before reporting the result.

## Locating the officecli Binary

The binary is provisioned on first use into Mona's per-user resources
directory (not bundled with the app). Resolve it with:

```bash
python -c "from mona.api.officecli_runtime import OfficeCliRuntime; print(OfficeCliRuntime().get_officecli_path() or 'NOT_FOUND')"
```

If this prints `NOT_FOUND`, stop and tell the user to download the engine from
the PPT template panel (the UI shows a download button on first use). Do not
attempt to download it yourself.

All examples below use `officecli` as the command name; substitute the
resolved absolute path. Always add `--json` for machine-readable output.

## Workflow

### 1. Project Setup and Template Copy

- Initialize the project normally:
  `python ${SKILL_DIR}/scripts/project_manager.py init <project_name> --format ppt169 --dir ppt_projects`
- Copy the user template into the project as the working file:

```bash
# Windows / Unix equivalent — use the shell's copy command
copy "<template_file>" "<project_path>/working.pptx"   # cmd
cp "<template_file>" "<project_path>/working.pptx"     # sh
```

All officecli commands target `<project_path>/working.pptx`. The original
template path is read-only.

### 2. Template Analysis (mandatory before any edit)

Run these and read the output before planning:

```bash
officecli get working.pptx / --json
```

Returns slide size, default font, and the full theme color palette
(`theme.color.accent1..6`, `dk1/dk2/lt1/lt2`). Record these; use theme color
names (`accent1`, `light1`, …) instead of hex values when a color must be set.

```bash
officecli query working.pptx slide --json
```

Lists existing slides with their `layout` and a text `preview`. This tells
you which sample slides exist and which layouts they use.

```bash
officecli get working.pptx /slide[N] --json
```

Inspect a representative slide's children: placeholder shapes
(`shape[@phType=title]`, `shape[@phType=body]`), text frames, pictures,
tables. Note the shape paths you will later target with `set`.

Available layouts come from the template's slide masters. The slide query
output plus the layouts referenced by existing slides are the authoritative
layout names; pass them verbatim to `--prop layout="..."`.

### 3. Content Mapping Plan

Before editing, write a short plan in the chat (no separate file required):

- Which existing slides to keep, duplicate, or remove.
- For each final page: source layout + the text/data that fills each
  placeholder (title, body, picture, table).
- Total page count, matching the user's request when one was given.

Prefer duplicating a well-designed existing slide over adding a blank one:
add a slide with the same layout, then mirror the reference slide's shape
structure.

### 4. Execute Edits

Keep the document open in a resident process for the whole editing session
(faster, and edits stay consistent):

```bash
officecli open working.pptx
```

Typical operations:

```bash
# Add a slide bound to a template layout, with title + body placeholder text
officecli add working.pptx / --type slide \
  --prop layout="Title and Content" \
  --prop title="Slide Title" \
  --prop text="First bullet line" --json

# Rewrite the title of an existing slide (target the placeholder shape)
officecli set working.pptx "/slide[2]/shape[@phType=title]" \
  --prop text="New Title" --json

# Replace body text on a paragraph level
officecli set working.pptx "/slide[2]/shape[@phType=body]/paragraph[1]/run[1]" \
  --prop text="Updated paragraph" --json

# Remove a sample slide that is not needed
officecli remove working.pptx /slide[3] --json

# Add a freeform textbox / picture when the layout has no matching slot
officecli add working.pptx /slide[2] --type textbox \
  --prop text="Caption" --prop x="1cm" --prop y="12cm" \
  --prop w="8cm" --prop h="1cm" --json
officecli add working.pptx /slide[2] --type picture \
  --prop src="<project_path>/images/chart.png" \
  --prop x="2cm" --prop y="4cm" --prop w="14cm" --json

# Speaker notes for a page
officecli set working.pptx /slide[2] --prop notes="Speaker notes here" --json
```

For many edits in one pass, prefer `batch` (single open/save cycle through
the resident):

```bash
officecli batch working.pptx --commands '[
  {"command":"add","parent":"/","type":"slide","props":{"layout":"Title and Content","title":"Q3 Summary"}},
  {"command":"set","path":"/slide[2]/shape[@phType=title]","props":{"text":"Agenda"}},
  {"command":"remove","path":"/slide[4]"}
]' --json
```

Batch item fields: `command` (bare verb), `parent` (add target), `path`,
`selector`, `type`, `props`, `to`/`after`/`before` (move), `path2` (swap).
Read the array from a file with `--input edits.json` when it is long.

Rules while editing:

- After every structural change (add/remove/move), re-run
  `officecli query working.pptx slide --json` and re-index: slide numbers
  shift, so never reuse stale `/slide[N]` paths from before the change.
- Text overflow: keep body text concise; the template's placeholder geometry
  is fixed. Shorten content instead of shrinking fonts below the template's
  body size.
- Images must live under `<project_path>/images/` first (download or generate
  them there), then reference the absolute path in `src`.

### 5. Validate and Flush

```bash
officecli validate working.pptx --json
officecli close working.pptx
```

`validate` must report no schema errors; fix any it finds (usually a bad
`raw-set` or an out-of-place element — prefer redoing that edit with the
high-level verbs). `close` flushes all in-memory changes to disk. A direct
file copy before `close`/`save` reads the pre-edit file — never skip this
step.

### 6. Export

```bash
mkdir "<project_path>/exports" 2>nul & rem (Windows) / mkdir -p (Unix)
copy "<project_path>/working.pptx" "<project_path>/exports/<project_name>.pptx"
```

Report the final project-relative path:
`ppt_projects/<project_name>/exports/<project_name>.pptx`

## Quick Command Reference

| Task | Command |
|---|---|
| Document + theme info | `officecli get <file> / --json` |
| List slides | `officecli query <file> slide --json` |
| Inspect one slide | `officecli get <file> /slide[N] --json` |
| Add slide from layout | `officecli add <file> / --type slide --prop layout="..." --prop title="..."` |
| Edit placeholder text | `officecli set <file> "/slide[N]/shape[@phType=title]" --prop text="..."` |
| Add textbox/picture | `officecli add <file> /slide[N] --type textbox|picture --prop ...` |
| Remove slide | `officecli remove <file> /slide[N]` |
| Reorder slides | `officecli move <file> /slide[N] --to <index>` |
| Many edits at once | `officecli batch <file> --commands '[...]'` |
| Validate schema | `officecli validate <file> --json` |
| Flush to disk | `officecli close <file>` (or `save` to keep resident) |
| Element capabilities | `officecli help pptx <element>` (e.g. `slide`, `shape`, `table`, `chart`) |

When unsure about a property name or element capability, run
`officecli help pptx <element>` before guessing.
