# Prompt quality and revision

Use this reference to repair missing or contradictory instructions in the final image prompt. The object of evaluation is the text sent to the image model. Do not inspect or generate an image to decide whether that text passes, and do not attribute poor rendered results to an adequate prompt.

## Pre-call review

Apply the six content criteria in SKILL.md: subject/purpose, composition/layout, style/materials, text, output and constraints. Point to the actual prompt sentence supplying each relevant decision. Category headings, case IDs and a list of tools read are not evidence of prompt quality.

Preserve specific choices that already work. A front/middle/background arrangement supplies depth; improve its missing hierarchy or text placement without claiming it has no composition at all. If a narrow edit explicitly preserves the reference's composition and medium, do not invent replacements merely to fill a checklist.

## Failure patterns

### Generic style words without decisions

**Cause:** abstract subject, no moment, style adjectives without visible properties.

**Repair:** specify placement, hierarchy, medium, palette roles and surface behavior. Consult [case-index.md](case-index.md) if a concrete example would help, but do not require a new visual concept when the requested ordinary composition is appropriate. Extra adjectives and additional landmarks do not resolve missing layout decisions.

### Named reference without its useful instructions

**Cause:** the agent chose its scene before reading the case, copied only style adjectives, or reduced a complete example back to a generic subject/background paragraph.

**Repair:** compare the card's anchors to the prompt. For example, a typography-led city case needs landmarks integrated with letterforms, while a monochrome streetscape needs one hue, architectural linework, paper white and spatial perspective. Restore those relationships; remove incompatible additions. If the user wants no text, change away from the typography case instead of forcing its title into the asset.

### Unspecified hierarchy

**Cause:** too many equal-priority objects, modules, colors, or style influences.

**Repair:** declare the dominant subject and its frame coverage; reduce modules or props; assign secondary and background roles; reserve explicit negative space.

### Wrong artifact type

**Cause:** the prompt asks for concepts, designs, or references rather than a finished output.

**Repair:** open with `Create one finished...` and exclude moodboards, presentation boards, mockups, contact sheets, process diagrams, or captions as appropriate.

### Unspecified or conflicting lettering

**Cause:** too much copy, no exact strings, or no ban on invented text.

**Repair:** keep only necessary titles and short labels; quote each string; state role and placement; add `No other readable text, letters, logos, signatures, or watermarks.`

### Incorrect UI or infographic structure

**Cause:** platform, module count, reading order, or repeated-unit layout is vague.

**Repair:** specify platform or graphic type, exact module count, grid, ordering, header/footer regions, connectors, label length, and reserved whitespace. Remove decorative modules.

### Missing identity or product preservation rules

**Cause:** “same” is underspecified, or stylistic changes override the subject anchors.

**Repair:** list face/hair/costume or geometry/material/label anchors in `Preserve`; state what may change; assign each reference image one role; forbid changes to the remaining anchors.

### Inconsistent instructions across a series

**Cause:** each prompt paraphrases the style or adds new aesthetic labels.

**Repair:** establish one shared style-anchor paragraph and repeat it verbatim. Keep medium, palette, light direction, texture, perspective, and exclusion language unchanged.

### Narrative prompt without an event

**Cause:** setting replaces story; there is no visible event or tension.

**Repair:** capture an exact moment with an active verb, a consequence visible in-frame, foreground/midground/background clues, and a camera angle that supports the power relation.

### Vague realism

**Cause:** perfect surfaces, inconsistent light, or unsupported camera jargon.

**Repair:** add plausible wear, contact shadows, material behavior, environmental mess, one motivated light source, and a credible viewpoint. Remove decorative lens specifications that conflict with the framing.

### Contradictory geometry or perspective instructions

**Cause:** dramatic styling outruns physical structure or perspective.

**Repair:** request one consistent projection, vertical correction or orthographic view, grounded contact points, realistic joints and proportions, and fewer simultaneous objects.

### Historical mixing

**Cause:** “ancient” or “traditional” is too broad.

**Repair:** state region, period or dynasty, social role, garment structure, material culture, architecture, and forbidden later or modern elements. Avoid treating fantasy details as historical evidence.

## Revision discipline

Evaluate contradictions and missing choices in the prompt itself. Keep the user's subject, already concrete composition, and style anchors unless one conflicts with the request. Change only the layer with a demonstrated textual gap:

1. content or identity;
2. composition;
3. style, palette, or light;
4. text;
5. targeted exclusions.

Stop when the relevant criteria are satisfied. Do not add detail indefinitely, demand a named case, or run image comparisons as a condition of passing. A separately requested image edit can use the user's stated feedback as a new brief. Provider parameter errors and truthful size receipts remain operational concerns, not measures of prompt design quality.
