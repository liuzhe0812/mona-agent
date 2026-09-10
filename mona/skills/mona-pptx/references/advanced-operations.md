# 原生高级操作：表格、图表和段落

仅在任务确实需要可编辑表格、原生数据图表、SmartArt 形状组或段落格式时阅读本文件。这里的操作放在 `office.apply.operations` 的 `slide_apply_txn` 中，`payload.ops` 每批 1–50 个注册表操作；字段来自当前 GenOffice 注册表和引擎测试。

## 坐标和 ID

高级注册表操作的 `target.slide`、`target.el` 和 `offset` 使用底层模型地址：页面/元素优先使用 `inspect` 返回的稳定 ID，`offset` 使用 EMU。直接 `slide_add_*`/`slide_set_geometry` 操作使用 `slides` 结果里的预览像素，不能混用。

优先使用 `open` 回执中的页面尺寸和 `version`；只有回执缺少 EMU 尺寸时才用 `summary`，只有需要规划具体页面时才用 `slides`。按轴换算：

```text
xEmu = round(xPx * slideWidthEmu / slideWidthPx)
yEmu = round(yPx * slideHeightEmu / slideHeightPx)
cxEmu = round(widthPx * slideWidthEmu / slideWidthPx)
cyEmu = round(heightPx * slideHeightEmu / slideHeightPx)
```

新增表格、图表或 SmartArt 后优先使用成功回执中的稳定 `id`；回执缺少 ID 时再 `inspect slides` 找新元素。不要猜测新元素 ID，也不要在同一批里用尚未存在的 ID 做后续编辑。

## 1. 新增表格

`addTable` 只负责结构和位置，`rows`/`cols` 必须为正整数。下面的 EMU 示例对应 4 列 × 3 行、约 5×2 英寸的区域：

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 4
  },
  "operations": [
    {
      "op": "slide_apply_txn",
      "payload": {
        "ops": [
          {
            "op": "addTable",
            "target": { "slide": "<stable-slide-id>" },
            "rows": 3,
            "cols": 4,
            "offset": {
              "x": 914400,
              "y": 914400,
              "cx": 4572000,
              "cy": 1828800
            }
          }
        ]
      }
    }
  ]
}
```

提交后优先使用回执返回的稳定表格 `elementId`；缺少时再 `inspect slides`，然后填入下面的单元格操作。`setTableCell` 的真实字段是 `row`、`col` 和 `paragraphs`，不是自由文本字段；`row`/`col` 从 0 开始。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 5
  },
  "operations": [
    {
      "op": "slide_apply_txn",
      "payload": {
        "ops": [
          {
            "op": "setTableCell",
            "target": {
              "slide": "<stable-slide-id>",
              "el": "<stable-table-element-id>"
            },
            "row": 0,
            "col": 0,
            "paragraphs": [
              {
                "align": "center",
                "runs": [
                  {
                    "text": "季度",
                    "bold": true,
                    "fontSize": 14,
                    "fontFamily": "Microsoft YaHei",
                    "color": "#172033"
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  ]
}
```

## 2. 表格样式和段落格式

`setTableStyle` 接收真实的 `edit: TableStyleEdit`。下面只使用有引擎测试覆盖的基础字段；`borderWidthEmu: 12700` 等于 1pt。`stylePart` 只有在已有应用预设同时提供可信 `styleId` 和 `styleDefXml` 时才可附带，不能自行拼接 XML。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 6
  },
  "operations": [
    {
      "op": "slide_apply_txn",
      "payload": {
        "ops": [
          {
            "op": "setTableStyle",
            "target": {
              "slide": "<stable-slide-id>",
              "el": "<stable-table-element-id>"
            },
            "edit": {
              "firstRow": true,
              "bandRow": true,
              "shadingColor": "#F2F2F2",
              "borderPreset": "all",
              "borderColor": "#D9D9D9",
              "borderWidthEmu": 12700,
              "clearDirectFormatting": true
            }
          }
        ]
      }
    }
  ]
}
```

`setParagraphFormat` 的 `format` 字段来自 `ParagraphFormatPatch`，适用于文本框、形状或表格文本。它处理段落对齐、项目符号、行距和段前/段后距离；字体仍使用 `setFont` 或新增文本的 `font` 字段。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 7
  },
  "operations": [
    {
      "op": "slide_apply_txn",
      "payload": {
        "ops": [
          {
            "op": "setParagraphFormat",
            "target": {
              "slide": "<stable-slide-id>",
              "el": "<stable-text-element-id>"
            },
            "format": {
              "align": "left",
              "bullet": "char",
              "bulletChar": "•",
              "lineSpacingPct": 115,
              "spaceAfterPt": 6
            }
          }
        ]
      }
    }
  ]
}
```

## 3. 新增原生数据图表

`addChart` 的 `kind` 允许：`bar`、`barStacked`、`barPercentStacked`、`line`、`area`、`pie`、`doughnut`、`scatter`、`radar`、`comboBarLine`、`pie3D`、`bar3D`。`series` 必须是 `{name: string, values: number[]}` 数组；每组 `values` 长度应与 `categories` 一致。`offset` 仍是 EMU。

下面只示范字段结构。示例数据明确表示“2025 季度收入，单位：千美元”；实际调用必须把数字替换为用户资料、检索结果或其他已核对来源中的值，并在页面来源说明或备注中记录来源。不要把示例数字当成事实，也不要让接口自动替你决定图表是否美观。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 8
  },
  "operations": [
    {
      "op": "slide_apply_txn",
      "payload": {
        "ops": [
          {
            "op": "addChart",
            "target": { "slide": "<stable-slide-id>" },
            "kind": "bar",
            "title": "2025 季度收入（千美元）",
            "categories": ["Q1", "Q2", "Q3"],
            "series": [
              {
                "name": "收入（千美元）",
                "values": [1200, 1450, 1610]
              }
            ],
            "offset": {
              "x": 914400,
              "y": 914400,
              "cx": 5486400,
              "cy": 2743200
            },
            "legendPos": "none",
            "gridlines": true,
            "dataLabels": false,
            "valAxisTitle": "千美元"
          }
        ]
      }
    }
  ]
}
```

图表添加后优先使用回执中的稳定图表 ID，缺少时再 `inspect slides`；用 `inspect visual` 检查轴、单位、标签、裁切和阅读顺序。数据趋势适合图表，精确查值适合表格；原生图表仍需要视觉复核。

## 4. 修改原生图表文字颜色

图表文字颜色使用 `slide_set_chart_style` 的 `style` 字段，支持 `textColor`、`titleColor`、`axisLabelColor`、`axisTitleColor`、`legendColor` 和 `dataLabelColor`；颜色必须是 `#RRGGBB` 或 6 位 HEX。`textColor` 先统一设置全部图表文字，局部字段再覆盖对应角色。已知图表稳定 ID 时直接提交一次局部操作：

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<latest-editor-epoch>",
    "modelRevision": 9
  },
  "operations": [
    {
      "op": "slide_set_chart_style",
      "payload": {
        "slideId": "<stable-slide-id>",
        "elementId": "<stable-chart-element-id>",
        "style": {
          "textColor": "#FFFFFF",
          "axisLabelColor": "D9D9D9"
        }
      }
    }
  ]
}
```

也可以在 `slide_apply_txn` 中使用已验证的 `setChart` payload：

```json
{
  "op": "slide_apply_txn",
  "payload": {
    "ops": [
      {
        "op": "setChart",
        "target": {
          "slide": "<stable-slide-id>",
          "el": "<stable-chart-element-id>"
        },
        "patch": {
          "textColor": "#FFFFFF",
          "axisLabelColor": "D9D9D9"
        }
      }
    ]
  }
}
```

`setChart.patch` 的未知字段、空 patch、错误类型、非有限数字和数据维度不匹配都会拒绝，并返回可用字段与实际 payload；不要猜字段。若提交后实际内容没有变化，结果为 `unchanged`，不算新编辑。普通文本使用 `slide_set_font` 的 `font.color`，不要用图表样式操作。

## 5. SmartArt 形状组

`addSmartArt` 的布局是 `list`、`process`、`cycle`、`hierarchy`、`pyramid`、`matrix` 或 `venn`，`items` 是 1–8 个字符串，`offset` 使用 EMU。当前引擎生成可编辑的形状组来表达 SmartArt 结构；它仍要按普通图文关系做视觉审核。

```json
{
  "action": "apply",
  "session_id": "<session-id>",
  "expected_version": {
    "editorEpoch": "<editor-epoch>",
    "modelRevision": 9
  },
  "operations": [
    {
      "op": "slide_apply_txn",
      "payload": {
        "ops": [
          {
            "op": "addSmartArt",
            "target": { "slide": "<stable-slide-id>" },
            "layout": "process",
            "items": ["准备", "执行", "复盘"],
            "offset": {
              "x": 914400,
              "y": 914400,
              "cx": 5486400,
              "cy": 1828800
            }
          }
        ]
      }
    }
  ]
}
```

高级操作提交后统一遵循：使用回执或按需 `inspect` 取得稳定 ID → `inspect review` 确定待观察页 → 用当前版本视觉复核 → 必要时小批次微调。不要把注册表字段扩展成自定义 JavaScript，也不要把 SVG/PNG 图表当成原生数据图表。
