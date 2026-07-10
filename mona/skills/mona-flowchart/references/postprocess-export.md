# Flowchart Postprocess & Export(占位,Phase 4 完善)

## Export Pipeline

1. 读取 `diagram.drawio`(mxGraph XML)
2. 调用 draw.io CLI 或 headless 浏览器渲染
3. 输出 SVG / PNG 到 `output/`

## Export Command

```bash
python ${SKILL_DIR}/scripts/export_svg.py <project_path> [--format svg|png]
```

## Output

- SVG: `<project_path>/output/diagram.svg`(矢量,推荐)
- PNG: `<project_path>/output/diagram.png`(位图,高分辨率)

## draw.io CLI(参考)

如果安装了 draw.io desktop CLI:

```bash
draw.io --export --format svg --output output/diagram.svg diagram.drawio
```

## Headless Render(备选)

无 draw.io CLI 时,使用 headless 浏览器加载 draw.io web 版导出。

## Validation

导出前必须通过 `validate_xml.py` 校验:
- XML 语法正确
- 所有节点有 geometry
- 所有边有 source 和 target
