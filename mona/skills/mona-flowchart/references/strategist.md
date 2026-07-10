# Flowchart Strategist — Logical Graph(占位,Phase 4 完善)

## Logical Graph Schema

`graph.json` 结构:

```json
{
  "metadata": {
    "title": "图表标题",
    "direction": "TB | LR | BT | RL",
    "canvas": { "width": 1200, "height": 800 }
  },
  "nodes": [
    {
      "id": "n1",
      "label": "节点标签",
      "type": "process | decision | start | end | data | document",
      "level": 0,
      "style": { "fill": "#ffffff", "stroke": "#333333" }
    }
  ],
  "edges": [
    {
      "from": "n1",
      "to": "n2",
      "label": "边标签(可选)",
      "style": { "dashed": false, "arrow": "classic" }
    }
  ]
}
```

## Node Types

| type | 形状 | 用途 |
|------|------|------|
| start | 圆角矩形 | 起点 |
| end | 圆角矩形 | 终点 |
| process | 矩形 | 处理步骤 |
| decision | 菱形 | 判断 |
| data | 平行四边形 | 数据 |
| document | 文档形状 | 文档 |

## Hierarchy Rules

- `level` 表示层级(0 = 顶层)
- 同层节点水平排列
- 层级决定 dagre/elkjs 布局的方向
