# Template Selection

Use this reference only for Step 3 when the user supplied explicit template directory path(s).

## Default Behavior

Default is free design. Do not query any `*_index.json`, do not ask the user, and do not infer templates from style words, brand mentions, slug-like names, or vague intent.

"What templates exist?" is out-of-band Q&A: list from the relevant index, then wait for the user to send an explicit directory path before Step 3 triggers.

## Trigger Rule

Step 3 triggers only when the initial user request contains one or more explicit directory paths.

For `brand` and `layout`, each path must resolve to a directory containing `design_spec.md` with frontmatter:

```yaml
kind: brand | layout
```

For `native`, the path must resolve to a directory containing:

```text
template.pptx
template_roles.json
template_manifest.json
```

Anything else skips Step 3.

## Template Kinds

| Kind | Contains | Strategist lock |
|---|---|---|
| `brand` | Identity only: colors, typography, logo, voice, icon style | Identity locked; structure stays free |
| `layout` | Structure only: canvas, page structure, page types, SVG roster | Structure locked; identity decided in Eight Confirmations |
| `native` | Original PPTX template; slide 1 is the repeated visual underlay | Normal SVG pipeline; export adds `--template-underlay` |

Segment ownership for fusion:

| Segment | Owner |
|---|---|
| Identity | `brand` |
| Structure | `layout` |

## Single-Path Dispatch

Copy the template package into the project:

```bash
TEMPLATE_DIR=<user-supplied path>
cp -r ${TEMPLATE_DIR}/* <project_path>/templates/
```

The copied `design_spec.md` frontmatter tells Strategist how to read it.

For a `native` template, do not copy or fuse `design_spec.md`. Keep the selected directory as the source of truth, then switch to `references/native-pptx-template-mode.md`.

## Multi-Path Fusion

When the user gives two or more paths of different kinds, fuse them into a single `<project_path>/templates/design_spec.md` at segment level. Do not do implicit field-level mixing.

Priority:

- brand owns Identity
- layout owns Structure

Field-level user edits, such as "use this brand but change primary to #FF0000", flow into Strategist's Eight Confirmations as normal user requirements.

When the user gives two paths of the same kind, stop and surface a segment-level conflict prompt before fusing. Three or more same-kind paths are not supported.

When fusion happens, add a provenance block under the H1 of the fused `design_spec.md`, listing sources and resolved conflicts. Single-path dispatch does not add provenance.

Full architecture details live in `docs/zh/templates-architecture.md`.

## Creating New Templates

- New layout template: read `workflows/create-template.md`.
- New brand-only preset: read `workflows/create-brand.md`.

## Checkpoint

Before Step 4:

- free-design path is selected, or
- template files are copied/fused into `<project_path>/templates/`

When no template is selected:
- Do not run template-selection behavior.
- Do not create `<project_path>/templates/` just for this feature.
- `spec_lock.md.page_layouts` stays optional as before.

When `kind: native` is selected:
- Treat `template.pptx` slide 1 as the repeated visual underlay.
- Do not infer template roles such as cover, toc, content, or thanks.
- Do not output `native_content_plan.json`.
- Use the normal SVG pipeline and quality gate.
- Step 7 uses `svg_to_pptx.py --template-underlay <native_template_dir>/template.pptx`.

When no template is selected:
- Do not run template-selection behavior.
- Do not create `<project_path>/templates/` just for this feature.
- Use the normal SVG pipeline as before.
