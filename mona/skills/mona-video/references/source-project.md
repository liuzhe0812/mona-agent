# Source Project Setup(占位,Phase 3 完善)

## Project Directory Structure

```
video_projects/<project_name>/
├── source.md          # 源材料
├── storyboard.md      # 分镜脚本(草稿)
├── storyboard_lock.md # 分镜脚本(锁定)
├── scenes/            # HTML 场景文件
│   ├── scene_01.html
│   ├── scene_02.html
│   └── ...
├── assets/            # 图片、图标等资源
├── frames/            # 渲染中间帧
└── output/            # 最终 MP4
```

## Source Conversion

- PDF → Markdown: `pdf_to_md.py`
- DOCX → Markdown: `doc_to_md.py`
- URL → Markdown: `web_to_md.py`
- 纯主题描述:直接写入 `source.md`
