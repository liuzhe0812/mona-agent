---
name: mona-video
description: >
  AI-driven video generation system using Hyperframes. Converts source documents
  or topic descriptions into HTML+GSAP animation compositions, previews in WebView2,
  and exports to MP4 via headless Chromium + FFmpeg.
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

Pipeline dispatcher for Mona Video. Produces videos via Hyperframes: agent writes HTML + GSAP animation compositions, previews in WebView2, and exports to MP4 via headless Chromium + FFmpeg.

Pipeline: source → project → Strategist (storyboard) → Executor (HTML/GSAP) → quality gate → WebView2 preview → narration synthesis → MP4 export.

## Core Contract

1. Run the pipeline strictly in order. Check each step gate before entry.
2. Step 4 storyboard confirmation is blocking: wait for explicit user confirmation before writing `storyboard.md`.
3. Every animation composition is hand-written by the current main agent, one scene at a time. No sub-agents, no batch generation, no templating scripts.
4. Before every scene, read `<project_path>/storyboard_lock.md`; use only locked visual style, color palette, fonts, and timing.
5. Use `data-start` / `data-duration` attributes for declarative timing. Use GSAP timelines for complex sequences.
6. Preview each scene in WebView2 before rendering. All HTML errors must be fixed before export.
7. If system Edge/Chrome is not detected, prompt user to download Chrome Headless Shell (~170MB) before rendering.
8. MP4 导出由后端 `/api/video/project/export` 自动处理，agent 不需要直接调用 `render.py`。

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

### Step 4: Strategist — Storyboard (草稿生成后停止)
Plan scene-by-scene storyboard: visual description, duration, animation style, narration text.

**重要：草稿生成后必须停止**。生成 storyboard.md 后，告知用户"分镜草稿已就绪，请在右侧分镜审阅界面编辑确认"，然后**等待用户操作**：
- 不要主动写 `storyboard_lock.md`
- 不要主动进入 Step 5 编写 HTML
- 不要主动调用任何渲染脚本

用户会在 UI 上编辑/增删/重排场景，确认后由后端 API 自动写 storyboard_lock.md 并解锁后续步骤。Agent 只在被用户在聊天中明确要求时才继续。

### Step 5: Executor — HTML/GSAP Composition
For each scene, write HTML + CSS + GSAP animation. Use `data-start`/`data-duration` for timing. Preview in WebView2.

### Step 6: Quality Gate + Preview
Run quality check on all scenes. Fix errors. Confirm all scenes are previewable in WebView2.

### Step 6.5: Narration Synthesis (conditional)
Only run when `<project_path>/meta.json` contains `narrationEnabled: true`.

1. Read `meta.json` to obtain TTS config (`ttsProvider`, `ttsVoice`, `ttsRate`). Defaults: `edge` + `zh-CN-XiaoyiNeural` + `+0%` — no API key required.
2. Ensure every scene in `storyboard.md` has a non-empty `- Narration:` line. If any is missing, ask the user before proceeding.
3. Run the synthesis script via `skill_script_run`:
   ```
   python ${SKILL_DIR}/scripts/synthesize_narration.py <project_path>
   ```
   Output: `<project_path>/audio/scene_NN.mp3` per scene + `<project_path>/audio/narration.mp3` (concatenated).
4. If the script reports `skipped: true`, narration is disabled for this project — proceed to Step 7 without audio.

### Step 7: Export
告知用户："所有场景的 HTML + GSAP 已就绪，请在右侧导出界面点击『开始导出 MP4』按钮"。

MP4 导出由前端 `ExportPhase` 组件触发后端 `/api/video/project/export` API 完成：
- 后端启动 headless Chrome，通过 CDP 协议逐帧截图（按目标 fps）
- FFmpeg 将 PNG 序列编码为 silent MP4
- 若 `audio/narration.mp3` 存在，自动 mux 进最终 MP4
- 输出：`<project_path>/renders/output.mp4`

Agent 不需要直接调用 `render.py`。用户在 UI 上选择质量（draft/standard/high）并点击导出按钮即可。

如需手动重新混音（添加 BGM 等），可运行：
```bash
python ${SKILL_DIR}/scripts/postprocess.py <project_path> [--bgm-volume 0.2]
```
