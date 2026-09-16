---
name: image-generation
description: >-
  Create or revise images with generate_image using the complete awesome-gpt-image-2 template method. Use for requested images and for imagery another workflow decides to generate: select the relevant source template, adapt its composition and style, preserve user constraints, and send a production-ready prompt.
short_description: >-
  Create/revise images with generate_image using the complete
  awesome-gpt-image-2 template. For requested or workflow-needed imagery,
  choose/adapt the source template, preserve constraints, and send a
  production-ready prompt.
---

# Image Generation

Turn the caller's image intent into a complete prompt, then call `generate_image`. The calling workflow decides whether it needs an image and how the result is used.

Unless the user explicitly asks only for a prompt, finish by calling the tool. Keep template names and internal selection notes out of the user-facing reply unless they answer the user's question.

## Use the complete reference method

For a new image whose brief does not already contain a complete design:

1. Read [upstream/templates-index.md](references/upstream/templates-index.md) using `skill_reference_read(skill="image-generation", ref_path="upstream/templates-index.md")`.
2. Match the intended output category, requested style and scene to one of the 22 source templates. When the choice is unclear, read `upstream/style-library.md` for the original category, style, scene and example-case relationships.
3. Read the one matching `upstream/templates-*.md` file from the index. It contains the complete source templates, advanced variants and pitfalls; the index alone is insufficient.
4. For a short or open-ended request, also read the matching `upstream/examples-<template-id>.md` file. Use its source prompts to understand useful specificity, then adapt the subject, facts, text, palette and layout to the current request. Do not copy an unrelated example wholesale.
5. If those designated examples do not fit, search all 541 bundled source cases with `skill_script_run(skill="image-generation", script="find_upstream_cases.py", args='"<subject, output and style terms>" --category "<source category>" --limit 3')`. Use the returned prompt and source metadata as references; do not load `cases.json` into context.
6. Select one coherent direction. If several directions would materially change the result and context cannot resolve them, offer two or three choices; otherwise choose the strongest fit and proceed.

An already complete brief can proceed after the prompt check below. A narrow reference-image edit should preserve the existing design and does not need a new template. Mona's shorter [template catalog](references/template-catalog.md), [case index](references/case-index.md) and [style systems](references/style-systems.md) are optional aids; the files under `references/upstream/` are authoritative for the reference project's method.

## Build the final prompt

Write natural instructions in the user's language. Every applicable block must contain visible decisions in the actual text sent to `generate_image`:

- **Subject and task:** exact output type, purpose, recognizable subject, scene or action, audience when relevant, and user constraints.
- **Composition and layout:** focal hierarchy, subject placement and relative scale, viewpoint, spatial relationships, reading order and purposeful empty space. Phrases such as “professional layout” do not decide a layout.
- **Style and materials:** one coherent medium or rendering language, visible mark-making or material behavior, palette roles, lighting or tonal treatment. Phrases such as “modern, vibrant, cinematic, high quality” do not decide a style.
- **Text and labels:** quote exact strings, define hierarchy and placement, and state whether other lettering is allowed. For a text-free asset, prohibit added typography while preserving required branding in references.
- **Output:** one finished image, asset, poster, board or sheet as requested; framing and background; ratio consistent with the tool call when selected.
- **Constraints:** a few category-specific exclusions and preservation rules aimed at likely failures. They must not contradict the positive brief.

Omit blocks that truly do not apply. Keep factual labels, product details, brands, names, numbers and units exactly as supplied. Do not use a template's sample facts as claims about the user's subject.

Before calling the tool, point to the sentence supplying each applicable block. A reference read, case ID, planning note or long prompt is not evidence of quality when the final prompt leaves the decision to the image model.

Read [prompt-construction.md](references/prompt-construction.md) when text, layout or reference preservation is complex. Read [quality-repair.md](references/quality-repair.md) only to repair a concrete gap or contradiction. [worked-examples.md](references/worked-examples.md) includes a complete ordinary Wuhan travel-poster example.

## Edit from references

Pass real user-image or generated-artifact paths in `reference_images`. State:

- what must be preserved, including identity, geometry, composition, existing text and unaffected styling;
- the exact change;
- what must remain unchanged;
- the finish required around the changed area.

Do not select a new aesthetic for a narrow edit. Do not promise pixel-level preservation because provider support varies.

## Keep a series consistent

For related images, define a short shared anchor covering medium, shape language, palette, light, texture and perspective. Repeat it verbatim in each prompt while changing scene-specific content and composition. Use separate calls for distinct concepts; use `count` for variants of the same concept.

## Apply output settings and errors

Omit `image_size` and `aspect_ratio` to use the user's defaults. Pass them only as per-call overrides when the image needs different output dimensions. Explicit pixel dimensions determine their own ratio; if both are supplied they must agree. Common presets are convenient choices, not guarantees that every provider accepts them.

If a size is rejected with alternatives and `retry_safe: true`, choose another only when it still meets the request. If `retry_safe` is false, do not resubmit because the original job may be running. Preserve completed artifacts from partial failures and distinguish size, authentication, balance and service errors.

When the service successfully returns an image, use and deliver that image as-is. Do not compare the returned dimensions with the requested dimensions as an acceptance check, issue a size-mismatch warning, or generate again to correct the result. `actual_size` is informational, not a retry trigger. Do not crop, stretch or upscale automatically. Further changes require a new user request.

## Acceptance boundary

The Skill passes when the final prompt contains concrete, compatible instructions for every applicable block and remains faithful to the request. Generated-image appearance is outside this prompt-quality acceptance. Do not generate comparisons or revise an adequate prompt merely because a model rendered it poorly. User-requested image revisions remain normal new work.
