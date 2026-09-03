# Hyperframes Render Guide

## Prerequisites

- Node.js 22+
- FFmpeg
- 系统安装的 Microsoft Edge 或 Google Chrome

## Browser Detection

`scripts/check_edge.py` 检测系统 Edge/Chrome：
1. Windows: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
2. macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`

Mona 不再单独下载 Chrome；缺少系统浏览器时，视频导出会提示用户先安装 Edge 或 Chrome。

## Render Command

```bash
python ${SKILL_DIR}/scripts/render.py <project_path>
```

## Output

- 中间帧: `<project_path>/frames/`
- 最终视频: `<project_path>/output/video.mp4`
