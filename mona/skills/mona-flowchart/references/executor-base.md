# Flowchart Executor Base — 通用执行标准(占位,Phase 4 完善)

## Graph JSON Structure

`graph.json` 是 agent 的核心产出物,定义逻辑图结构:

```json
{
  "metadata": {
    "title": "图表标题",
    "direction": "TB",
    "canvas": { "width": 1200, "height": 800 }
  },
  "nodes": [...],
  "edges": [...]
}
```

## Node ID Convention

- 格式: `n<编号>`(如 `n1`, `n2`, `n10`)
- 编号从 1 开始,连续递增
- 不使用 UUID 或随机字符串

## Style Rules

- 节点样式通过 `type` 字段映射到预设 style,不手写 style 字符串
- 边样式统一使用 `EDGE_STYLE`,特殊样式(虚线)在 `graph.json` 的 edge.style 中声明
- 颜色使用十六进制色值,不使用 RGB 函数

## Forbidden

- 禁止直接手写 mxGraph XML(必须通过 build_xml.py 生成)
- 禁止在 graph.json 中嵌入坐标(坐标由 auto_layout.py 计算)
- 禁止在 graph.json 中嵌入 style 字符串(通过 type 映射)
