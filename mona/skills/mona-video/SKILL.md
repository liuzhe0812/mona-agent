---
name: mona-video
description: >
  AI-driven video generation system using Hyperframes. Converts source documents
  or topic descriptions into HTML+GSAP animation compositions and renders to MP4.
  Use when user asks to "create video", "make video", "制作视频", "生成视频",
  or mentions "mona-video".
metadata:
  mona:
    emoji: "🎬"
    always: false
    requires:
      bins: ["python"]
---

# Mona Video Skill

Pipeline dispatcher for Mona Video. Produces videos via Hyperframes: agent writes HTML + GSAP animation compositions, previews in WebView2, renders to MP4 via headless Chromium.

Pipeline: source → project → Strategist (storyboard) → Executor (HTML/GSAP) → quality gate → hyperframes render → MP4 export.

## Core Contract

1. Run the pipeline strictly in order. Check each step gate before entry.
2. Step 4 storyboard confirmation is blocking: wait for explicit user confirmation before writing `storyboard.md`.
3. Every animation composition is hand-written by the current main agent, one scene at a time. No sub-agents, no batch generation, no templating scripts.
4. Before every scene, read `<project_path>/storyboard_lock.md`; use only locked visual style, color palette, fonts, and timing.
5. Use `data-start` / `data-duration` attributes for declarative timing. Use GSAP timelines for complex sequences.
6. Preview each scene in WebView2 before rendering. All HTML errors must be fixed before export.
7. Export discipline: video render must use `${SKILL_DIR}/scripts/render.py`. Never create custom render scripts.
8. If system Edge/Chrome is not detected, prompt user to download Chrome Headless Shell (~170MB) before rendering.

## Mona Defaults

- `${SKILL_DIR}` resolves to `<workspace>/mona/skills/mona-video/`.
- Create generated projects under `<workspace>/video_projects/` with `--dir video_projects`.
- On Windows, if `python3` fails, rerun the same command with `python`.
- Reply in the user's language unless explicitly asked otherwise.
- `storyboard.md` must keep the English section structure; values may use the user's language.
- This is a video workflow, not a generic coding task. Do not create branches, worktrees, tests, or app scaffolding by default.

## Reference Load Map

| Moment | Load |
|---|---|
| Step 1-2 source conversion / project setup | `references/source-project.md` |
| Step 4 Strategist (storyboard) | `references/strategist.md` |
| Step 5 Executor (HTML/GSAP) | `references/executor-run.md` |
| Step 6 render | `references/hyperframes-render.md` |
| Resume existing project | `workflows/resume-execute.md` |

## Pipeline Steps

### Step 1: Source Intake
Convert source (PDF/DOCX/URL/Markdown/topic) to `source.md` in project dir.

### Step 2: Project Setup
Create project directory under `video_projects/`. Init `storyboard.md` skeleton.

### Step 3: Source Analysis
Analyze source, extract key messages, determine video duration and scene count.

### Step 4: Strategist — Storyboard
Plan scene-by-scene storyboard: visual description, duration, animation style, narration text. **Blocking gate**: wait for user confirmation before writing `storyboard_lock.md`.

### Step 5: Executor — HTML/GSAP Composition
For each scene, write HTML + CSS + GSAP animation. Use `data-start`/`data-duration` for timing. Preview in WebView2.

### Step 6: Quality Gate + Render
Run quality check on all scenes. Fix errors. Render to MP4 via `render.py`.

### Step 7: Export
Output final MP4 to `<project_path>/output/`.
