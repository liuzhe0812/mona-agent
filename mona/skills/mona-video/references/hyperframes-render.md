# Hyperframes Render Guide(占位,Phase 3 完善)

## Prerequisites

- Node.js 22+
- FFmpeg
- Chromium(系统 Edge 或 Chrome Headless Shell)

## Browser Detection

`scripts/check_edge.py` 检测系统 Edge/Chrome:
1. Windows: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
2. macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
3. Fallback: `<userData>/runtime/chrome-headless-shell/`

## Render Command

```bash
python ${SKILL_DIR}/scripts/render.py <project_path>
```

## Output

- 中间帧: `<project_path>/frames/`
- 最终视频: `<project_path>/output/video.mp4`
