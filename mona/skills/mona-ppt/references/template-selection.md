# Template Selection

Use this reference only for Step 3 when the user supplied explicit template directory path(s).

## Default Behavior

Default is free design. Do not query any `*_index.json`, do not ask the user, and do not infer templates from style words, brand mentions, slug-like names, or vague intent.

"What templates exist?" is out-of-band Q&A: list from the relevant index, then wait for the user to send an explicit directory path before Step 3 triggers.

## Trigger Rule

Step 3 triggers only when the initial user request contains one or more explicit directory paths, and each path resolves to a directory containing `design_spec.md` with frontmatter:

```yaml
kind: brand | layout | deck
```

Anything else skips Step 3.

## Template Kinds

| Kind | Contains | Strategist lock |
|---|---|---|
| `brand` | Identity only: colors, typography, logo, voice, icon style | Identity locked; structure stays free |
| `layout` | Structure only: canvas, page structure, page types, SVG roster | Structure locked; identity decided in Eight Confirmations |
| `deck` | Full replica: identity + structure + middle/template overview | All template segments locked; confirmations narrow deck-content fields |

Segment ownership for fusion:

| Segment | Owner |
|---|---|
| Identity | `brand` |
| Structure | `layout` |
| Middle/template overview | `deck` |

## Single-Path Dispatch

Copy the template package into the project:

```bash
TEMPLATE_DIR=<user-supplied path>
cp -r ${TEMPLATE_DIR}/* <project_path>/templates/
```

The copied `design_spec.md` frontmatter tells Strategist how to read it.

## Multi-Path Fusion

When the user gives two or more paths of different kinds, fuse them into a single `<project_path>/templates/design_spec.md` at segment level. Do not do implicit field-level mixing.

Priority:

- brand owns Identity
- layout owns Structure
- deck owns Middle/template overview

Field-level user edits, such as "use this brand but change primary to #FF0000", flow into Strategist's Eight Confirmations as normal user requirements.

When the user gives two paths of the same kind, stop and surface a segment-level conflict prompt before fusing. Three or more same-kind paths are not supported.

When fusion happens, add a provenance block under the H1 of the fused `design_spec.md`, listing sources and resolved conflicts. Single-path dispatch does not add provenance.

Full architecture details live in `docs/zh/templates-architecture.md`.

## Creating New Templates

- New layout/deck template: read `workflows/create-template.md`.
- New brand-only preset: read `workflows/create-brand.md`.

## Checkpoint

Before Step 4:

- free-design path is selected, or
- template files are copied/fused into `<project_path>/templates/`

## Deck Hard Constraints

When `kind: deck` is selected:
- Strategist MUST read the Page Roster from `design_spec.md`.
- `spec_lock.md.page_layouts` MUST be populated with template page selections.
- Executor MUST read the corresponding template SVG before generating each page.
- If no suitable template page exists for a given slide, the Executor MAY design freely but MUST note the reason in `spec_lock.md`.
- Export will FAIL if `page_layouts` is missing in a deck project.

When no template is selected:
- Do not run template-selection behavior.
- Do not create `<project_path>/templates/` just for this feature.
- `spec_lock.md.page_layouts` stays optional as before.
