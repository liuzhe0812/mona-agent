# Video Postprocess & Export

## Render Pipeline

1. 收集 `scenes/` 下所有 HTML 文件,按编号排序
2. 对每个场景逐帧截图(使用 headless Chromium)
3. 合并所有帧为 MP4(使用 FFmpeg)
4. 可选:合成旁白音频

## Render Command

```bash
python ${SKILL_DIR}/scripts/render.py <project_path> [--quality draft|high] [--output <path>]
```

## Quality Presets

| quality | 帧率 | 分辨率 | 说明 |
|---------|------|--------|------|
| draft | 24fps | 原尺寸 50% | 快速预览 |
| high | 60fps | 原尺寸 100% | 最终输出 |

## Output

- 默认输出: `<project_path>/output/video.mp4`
- 中间帧: `<project_path>/frames/`(渲染后可清理)

## FFmpeg Command(参考)

```bash
ffmpeg -framerate 30 -i frames/frame_%04d.png -c:v libx264 -pix_fmt yuv420p output/video.mp4
```

## Audio(可选)

- 旁白音频: `<project_path>/audio/narration.mp3`(由 Step 6.5 的 `synthesize_narration.py` 生成)
- 背景音乐: `<project_path>/audio/bgm.mp3`(用户手动放入)
- 合成命令(将 narration 混入无声 MP4):
  ```bash
  ffmpeg -i output/video_silent.mp4 -i audio/narration.mp3 \
    -c:v copy -c:a aac -shorter output/video.mp4
  ```
- 如需同时混入 BGM:
  ```bash
  ffmpeg -i output/video_silent.mp4 -i audio/narration.mp3 -i audio/bgm.mp3 \
    -filter_complex "[1:a]volume=1.0[a1];[2:a]volume=0.2[a2];[a1][a2]amix=inputs=2[aout]" \
    -map 0:v -map "[aout]" -c:v copy -c:a aac -shorter output/video.mp4
  ```

## Narration Synthesis(Step 6.5)

由 `scripts/synthesize_narration.py` 完成,agent 通过 `skill_script_run` 触发:

```bash
python ${SKILL_DIR}/scripts/synthesize_narration.py <project_path>
```

脚本行为:
1. 读 `meta.json` 中的 `narrationEnabled / ttsProvider / ttsVoice / ttsRate`(默认 `edge` + `zh-CN-XiaoyiNeural` + `+0%`,免费无需 API key)
2. 解析 `storyboard.md` 中每个 `### Scene N:` 块的 `- Narration:` 文本
3. 对每个 scene 调用 `mona.providers.tts` 生成 `audio/scene_NN.mp3`
4. 用 FFmpeg concat 拼接成 `audio/narration.mp3`

若 `narrationEnabled: false`,脚本返回 `{ok: false, skipped: true}`,agent 应跳过音频合成直接进入 Step 7。
