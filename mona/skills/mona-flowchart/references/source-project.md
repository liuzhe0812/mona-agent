# Source Project Setup(占位,Phase 4 完善)

## Project Directory Structure

```
flowchart_projects/<project_name>/
├── source.md           # 源材料
├── graph.json          # 逻辑图描述(草稿)
├── graph_lock.md       # 逻辑图描述(锁定)
├── layout.json         # 自动布局结果(坐标)
├── diagram.drawio      # mxGraph XML(draw.io 格式)
└── output/             # 导出的 SVG/PNG
    ├── diagram.svg
    └── diagram.png
```

## Source Conversion

- PDF → Markdown: 复用 mona-ppt 的 `pdf_to_md.py`
- URL → Markdown: 复用 mona-ppt 的 `web_to_md.py`
- 纯文本描述:直接写入 `source.md`
