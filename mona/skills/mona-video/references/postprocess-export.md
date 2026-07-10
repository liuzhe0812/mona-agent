# Video Postprocess & Export(占位,Phase 3 完善)

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

- 旁白音频: `<project_path>/audio/narration.mp3`
- 背景音乐: `<project_path>/audio/bgm.mp3`
- 合成命令:
  ```bash
  ffmpeg -i video.mp4 -i narration.mp3 -c:v copy -c:a aac -shorter output/video.mp4
  ```
