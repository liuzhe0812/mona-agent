# Prompt construction

Use this reference when an image has exact text, several content regions, a reference image, or a demanding visual brief. It turns decisions into a compact prompt; it is not a form that every image must fill.

Review only what the image model will receive. If a composition, material or text rule exists only in the agent's plan, it is still missing from the prompt. Ordinary compositions can pass; they do not need to imitate a signature case. Acceptance ends when the relevant subject, layout, style/material, text, output and constraints are concrete and compatible, without judging a rendered image.

## Start with the visible result

The opening sentence should settle the output type and prevent the model from producing a process board instead of the intended artifact.

- Good: `Create one finished 16:9 editorial illustration for a presentation cover.`
- Good: `Create one isolated product render on a neutral studio background.`
- Good: `Create one vertical museum-style exhibition poster, not a mockup or moodboard.`
- Weak: `Explore some visual ideas for...`

If the image is one asset in a larger work, describe the asset's own visual function. Do not paste the document outline, slide notes, research process, or unrelated background into the prompt.

## Give the subject a state or action

A noun identifies content; a state or action creates the image. Specify what is happening at the captured moment and which detail carries the meaning.

```text
A field engineer stands beside an open wind-turbine nacelle, checking a diagnostic tablet while dawn fog moves through the offshore farm. The glowing fault map on the tablet and the open machinery are the two evidence-bearing details.
```

For still-life and product work, state the product condition and physical relationship between objects: suspended, opened, cut away, stacked, splashing through liquid, casting a shadow, or resting on a material surface.

## Make composition operational

Use spatial instructions the model can render:

- focal subject size: dominant, secondary, background;
- frame: extreme close-up, close-up, medium, wide, aerial, cutaway;
- viewpoint: eye level, top-down, low angle, isometric, orthographic;
- placement: left third, centered, lower-right, foreground/background;
- depth: shallow field, layered foreground/midground/background, flat poster plane;
- negative space: location and approximate amount when layout depends on it;
- reading order: top-to-bottom, clockwise, numbered sequence, central hub to branches.

Avoid mutually exclusive camera instructions. A top-down orthographic diagram cannot also be a dramatic eye-level photograph. Choose the representation that serves the visual job.

For a poster, "landmark in front, skyline behind" establishes depth but leaves the page unresolved. Also place the headline relative to the landmark, establish which is dominant, and reserve an area without competing detail. State those choices in the final prompt; exact percentages are optional.

## Build a coherent visual system

Describe style through renderable properties rather than a pile of labels:

1. **Medium:** editorial vector, documentary photograph, ink wash, paper cut, clay render, product photography, architectural visualization.
2. **Shape language:** geometric, rounded, monolithic, delicate linework, bold flat silhouettes, irregular hand-drawn edges.
3. **Material and surface:** uncoated paper, translucent acrylic, brushed aluminum, matte vinyl, watercolor bloom, visible film grain.
4. **Palette:** name dominant, support, and accent colors; state saturation and contrast.
5. **Lighting:** source, direction, softness, color temperature, and shadow behavior.
6. **Finish:** restrained editorial, tactile handmade, clinical precision, cinematic realism, archival reproduction.

Choose one dominant system. A secondary influence may refine it, but should not contradict its geometry, material, or lighting.

For example, replace "modern travel poster, vibrant colors, professional layout" with "flat architectural illustration with crisp edges and fine screen-print grain; warm paper as the dominant field, deep blue for water and skyline, restrained vermilion on the main landmark; one consistent family of flat shadows." This is one possible direction, not a default palette to impose on every city.

## Treat text as designed content

For exact text, enumerate the visible strings in priority order and define their role:

```text
Visible text, copied exactly:
1. Headline, largest: “城市更新 2035”
2. Subtitle, one line: “从空间改造到社区复兴”
No other readable text, letters, logos, signatures, or watermarks.
```

Quote supplied text verbatim. Avoid unnecessary character counts, paraphrases or inferred slogans; any accompanying description must agree with the exact string. In a text-color edit, refer to the quoted title and its location rather than restating its length or rewriting its wording.

Limit text to what must be rendered into the image. Use short labels for infographics. If the visual is meant to sit behind editable slide or document text, request no text and reserve the appropriate quiet area.

For interface screenshots, menus, charts, and labels, specify the platform or information hierarchy, the exact strings, and the number of repeated modules. Do not ask the model to invent a dense page of plausible copy.

## Use constraints surgically

Positive instructions establish the design. Negative instructions should target likely category failures:

- finished poster: no moodboard, presentation board, framed mockup, or process sheet;
- product render: no extra products, floating labels, unrelated props, or altered package text;
- documentary photo: no studio polish, CGI surfaces, staged pose, or impossible shadows;
- diagram: no extra modules, long paragraphs, crossing connectors, or illegible labels;
- historical image: no modern objects, mixed periods, or invented costume structure;
- reference edit: no identity, geometry, crop, or background drift unless requested.

Do not append a universal negative list. It introduces concepts that were never likely and dilutes the task-specific constraints.

Check the positive brief against the exclusions: preserving a package logo conflicts with "no logos"; a requested contact sheet conflicts with "no panels"; an explicitly requested sunset should not be removed because another case avoids it. Limit the exclusion to the unwanted addition or failure.

## Compile edits around invariants

Reference-edit prompts work best when preservation is more concrete than “keep the same.” Identify stable visual anchors:

```text
Preserve the person's facial identity, short wavy hair, navy work jacket, three-quarter pose, and the original waist-up crop. Change only the background to a warm modern workshop at sunset and replace the handheld paper with a black tablet. Keep the face, hands, body proportions, jacket details, camera angle, and depth of field unchanged. Match the original photographic realism and lens behavior.
```

When using several references, assign each a role: identity reference, product-shape reference, palette reference, or composition reference. Do not imply that every property from every reference must be merged.

## Keep the prompt economical

Every sentence should fix a visible choice, preserve a required fact, or block a likely failure. Remove:

- praise adjectives without a visible meaning;
- repeated style synonyms;
- camera-brand trivia that does not change the image;
- contradictory media such as `flat vector, photorealistic oil painting, 3D watercolor`;
- workflow narration such as “the user is making a deck” when the visual purpose already captures it.

A concise prompt with a clear hierarchy usually outperforms a long catalog of aesthetics.
