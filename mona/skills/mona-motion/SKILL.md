---
name: mona-motion
description: Create and revise code-animation videos with Mona Motion from chat or the workbench; support director confirmation and explicitly authorized automatic production.
short_description: Design, produce, review and deliver continuous animation; finish unattended when the user explicitly requests it.
metadata:
  mona:
    emoji: "🎬"
    always: false
---

# Mona Motion

Use the bundled director, motion languages, templates and runtime as
one creative system. Read [creative-direction.md](references/creative-direction.md)
and [the library](references/huashu-motion/library/README.md). Reuse real source;
do not imitate screenshots or replace content with titles and decorations.
Mona's project, approval, audio and security contract below takes precedence over
upstream standalone CLI, installation, publishing and extra-approval instructions.
Use Mona Motion as the product name in replies and generated titles. Do not carry
example vendor branding into the user's video. Keep bundled licenses and source
provenance intact; they remain the record of third-party authorship.

## Start from the user's task

The workbench is a place to observe and adjust a project, not a prerequisite for
production. For a new chat task, use video.create with a unique project name;
the host binds it to the current conversation. Do not create another chat or
change the current conversation's workspace or agent_kind. Existing workbench
projects continue with their actual project name.
New chat projects default to narration enabled, like the workbench. Apply the
requested aspect ratio, language and voice settings; explicitly set
settings.narrationEnabled=false when the user requests a silent animation.

When the user asks to produce a finished video in ordinary chat, creation defaults
to execution_mode=automatic: preserve the actual production request in instruction
and complete the artifact without requiring workbench confirmation. Dedicated
workbench sessions default to interactive. If the user asks only for a plan or
explicitly wants to review before production, select interactive even in chat.
Do not create a full production for a question or a code/example-only request.
For an existing owned project, video.execution changes its mode using the current
plan_revision and the user's instruction. When resuming full production in chat,
inspect the saved plan and its mode first; if an older chat project is waiting on
the previous interactive default, use execution to continue automatically under
the user's production request. Preserve an explicit review-first choice unless
the user now requests production. Do not recreate the project or repeat unknown
writes to resume it.

Inspect executionMode and executionAuthorizationMode. In automatic mode the
service approves each current plan revision within that authorization; continue
through audio, composition, review and export without waiting for a human or
opening the workbench. This does not waive factual, visual, motion or export
checks. Missing input, unavailable services and non-retryable failures still
require a truthful result, not guessed content or repeated failed calls.

Write drafts in inspect.draftDirectory; read filmSourcePath for an existing
composition when provided. The ordinary chat workspace and the saved video
project may differ. Use the returned readable sources, styleExamples and asset
workspacePath, not guessed parent paths. sync transfers an authorized local
workspace draft to the owned project; canonical files stay tool-managed.

## Prepare the director plan

Inspect the current project, authorized source material, settings and saved style.
Read its source.template and the matching Huashu reference. When stylePreference
is auto, select an available style with video.style and current plan_revision;
retain a user-selected style. Style sets palette, type and visual treatment;
content determines objects, actions, camera and rhythm. Saved custom styles also
provide actual rules and styleExamples; read and adapt them.

Choose the main idea, subjects, meaningful transformations and continuity across
the whole film. A director scene is a user-facing content segment, not a separate
slide or an isolated animation. Keep object identities and spatial relationships
through scene boundaries. Plan the hardest important action before filling the
rest. Use real product UI and evidence; never invent facts or product behavior.

Save video.plan with title, duration, narration, visual, animation and asset IDs
for each segment. In automatic mode include the current plan_revision. Describe
visible changes in ordinary language. Interactive videos stop here: the user
confirms and adjusts this plan in the director workbench. Automatic videos
continue with the service-authorized current revision. Do not generate audio,
images, animation code or exports before that revision is approved.
There is one confirmation, not a separate decision form for every creative step.

For styleAuthoring with requirePlanApproval=false, save reusable visual/motion
rules using style_rules, then build and preview the short style sample. The
explicit sample request already authorizes this; no extra approval or export.

## Build one continuous composition

Inspect current plan_revision again. Generate video.audio for every narrated
segment, passing top-level scene_index and plan_revision. Use actual returned
subtitleTrack and extended duration. Every later segment starts at the sum of
actual earlier segment durations. Keep the selected voice; a service/configuration
failure requires its remedy, never a substituted voice or a repeated call loop.

Read [runtime.md](references/runtime.md). Copy the selected real Huashu template
or needed resources from assets/huashu-motion with skill_asset_copy, then write
one complete drafts/film.html. Use one HTML composition, one global paused GSAP
timeline and Huashu OM helpers. The runtime supplies actual global speech words
as om-cues. OM.cue returns seconds, OM.clock bridges Canvas/WebGL drawings to the
same clock, OM.camera carries the viewer through one world. Use explicit initial
states, OM.random(seed), and pure time-derived drawing. No wall-clock animation,
unseeded randomness or external scripts/network. Use data-om-id for stable targets.

Adapt the source to the approved content, actual aspect ratio, shared --mona-*
style variables and authorized media. Preserve the technical quality of the
source's typography, drawing and movement. Do not ship its example wording,
demonstration data or the author's personal character. The supplied source and
license notices stay with bundled resources; no unrelated watermark is added.

Call video.sync with source_file=drafts/film.html and current plan_revision;
scene_index is not needed. This saves the whole film and regenerates its segment
time slices. Canonical scene_sources/film.html, composition/index.html and scenes/
belong to the tool. A new sync invalidates all segment motion reviews.

Narration, music, effects and source sound stay in Mona's audioTracks with global
seconds. Do not place audio elements or unmuted source audio in the composition.
Import authorized media using video.assets. New assets for an approved visual
intent can be appended with sync(scene_index,scene={assets:[existing and new IDs]}).
No standalone upstream voice/render/install commands or new download directories.

## Observe, repair and deliver

Read [motion-design.md](references/motion-design.md) and preview every segment.
Preview returns actual sampled frames, a contact sheet and technical observations.
Look at subject/action/meaning before, during and after spoken ideas; camera and
objects must remain understandable across boundaries. Review readability at the
actual viewing scale, subtitle clearance, useful pauses, rhythm and sound.

A pixel-change counter is not a creativity score. Do not add drifting, breathing
or flashing to make a static explanation pass. Diagnose what the viewer cannot
understand, repair that cause, and run the default full segment preview again.
preview(timestamps=[...]) is partial observation and does not replace full review.
Check forward, backward and repeated seeks for consistent output. State accurately
when normal-speed playback or listening was unavailable.

For a user's explicit local revision, use video.edit with scene_index, current
plan_revision and their instruction. Read the shared film source and change only
the requested objects/times; preserve other content and stable IDs. Refresh changed
audio, sync the film and preview affected segments plus any changed boundary.
A new theme or overall structure returns to director confirmation in interactive
mode; automatic projects retain their explicitly authorized execution mode. Code/visual
repairs use sync and require no repeated plan approval.

Use video.export and status for a finished approved film. Preview and export load
the same single composition and managed audio mix. Verify uncertain writes using
inspect/status rather than replaying them. Report actual results in user language.
When status reports done with a current output, use its deliveryPath with deliver_file to return the
actual completed video in the originating chat. Do not claim delivery from a
render-start response, an outputStale result, or a guessed path from the
project-relative output field.
