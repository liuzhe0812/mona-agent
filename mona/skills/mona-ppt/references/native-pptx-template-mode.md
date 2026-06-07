# Custom PPTX Template Underlay Mode

Use only when the selected template directory is:

```text
mona/skills/mona-ppt/templates/native/<template_id>/
```

and it contains `template.pptx`.

## Hard Rules

- This is still the normal high-quality SVG pipeline.
- Do not create `native_content_plan.json`.
- Do not use `native_pptx_builder.py`.
- Do not infer template roles such as cover, toc, content, or thanks.
- Treat `template.pptx` slide 1 as a repeated visual underlay for every final slide.
- Build the final PPTX with `svg_to_pptx.py --template-underlay`.

## Workflow

Follow the normal Mona PPT steps:

1. Create `design_spec.md`, `spec_lock.md`, and `page_visual_plan.json`.
2. Acquire AI/web/manual images when required.
3. Hand-write all SVG pages under `svg_output/`.
4. Run `svg_quality_checker.py` until it reports 0 errors.
5. Generate real speaker notes under `notes/`.
6. Export with the template underlay.

The template is a visual background, not a layout planner. The AI should design content normally while keeping enough whitespace for the uploaded template's background.

## Export

Run:

```bash
python mona/skills/mona-ppt/scripts/svg_to_pptx.py <project_path> \
  --template-underlay mona/skills/mona-ppt/templates/native/<template_id>/template.pptx
```

If a custom output path is required, keep the same underlay flag:

```bash
python mona/skills/mona-ppt/scripts/svg_to_pptx.py <project_path> \
  --template-underlay mona/skills/mona-ppt/templates/native/<template_id>/template.pptx \
  --output <project_path>/exports/<project_name>.pptx
```

Report the final project-relative PPTX path.
