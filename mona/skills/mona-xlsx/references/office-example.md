# Excel Office 操作示例

下面示例创建一份月度销售表，展示实时读取、分批写入原始数据、写入公式、设置格式、复核和导出。尖括号表示必须用上一步真实返回值替换的变量；不要猜测版本、工作表名或公式结果。

## 1. 打开并读取工作簿

新建时先打开空白 XLSX：

```json
{
  "action": "open",
  "document_type": "sheets",
  "display_name": "月度销售表"
}
```

`open` 回执已提供当前 `selection`、工作表尺寸和 `version`。按任务选择一个入口：需要工作表名或规模时读摘要，已知目标区域时直接读 `range`，用户已选中单元格时使用回执中的 `selection`；已完整返回的内容不再换入口重复读取。以下示例入口按任务选择，不是固定流水线。

需要工作表名或规模时，读取摘要：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "summary" }
}
```

只有选区需要刷新时才读取真实选区；该查询返回 `sheet` 和 `range`，不返回假定的默认选区：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "selection" }
}
```

已有文件使用：

```json
{
  "action": "open",
  "path": "reports/sales.xlsx"
}
```

已知目标区域时读取目标范围，公式和样式按需打开：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": {
    "mode": "range",
    "sheet": "<sheet_name_from_summary>",
    "range": "A1:D12",
    "include_formula": true,
    "include_style": true
  }
}
```

## 2. 分批写入数据和公式

先写入标题、原始数据和空的计算列。数据值来自用户或源表；示例中的数字只是操作结构示例，实际任务必须使用真实输入：

```json
{
  "action": "apply",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<editor_epoch>",
    "modelRevision": 0
  },
  "operations": [
    {
      "op": "set_range",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "range": "A1:D3",
        "values": [
          ["月份", "收入（元）", "成本（元）", "毛利率"],
          ["一月", 100000, 60000, null],
          ["二月", 120000, 72000, null]
        ]
      }
    }
  ]
}
```

用上一步返回的最新版本写入公式，不把预期的 40% 写成静态结果：

```json
{
  "action": "apply",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<new_editor_epoch>",
    "modelRevision": 1
  },
  "operations": [
    {
      "op": "set_formula",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "cell": "D2",
        "formula": "=(B2-C2)/B2"
      }
    },
    {
      "op": "set_formula",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "cell": "D3",
        "formula": "=(B3-C3)/B3"
      }
    }
  ]
}
```

## 3. 设置必要格式并检查

对表头和不同含义的数字列分别设置格式；字段名使用当前 wire schema 的 camelCase：

```json
{
  "action": "apply",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 2
  },
  "operations": [
    {
      "op": "set_style",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "range": "A1:D1",
        "style": {
          "bold": true,
          "fontFamily": "Aptos",
          "fontSize": 11,
          "backgroundColor": "EAF2F8",
          "horizontalAlign": "center",
          "verticalAlign": "center",
          "wrapText": true,
          "borderBottom": { "style": "thin", "color": "#9DC3E6" }
        }
      }
    },
    {
      "op": "set_style",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "range": "B2:C3",
        "style": { "numberFormat": "#,##0" }
      }
    },
    {
      "op": "set_style",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "range": "D2:D3",
        "style": { "numberFormat": "0.0%" }
      }
    }
  ]
}
```

`include_style: true` 的范围结果还包含 `columnWidths`（字符宽度）和 `rowHeights`（磅），可用于检查尺寸是否符合内容。需要调整列宽或行高时，使用 1-based 的 `index` 和 `count`，并在独立批次后重新读取：

```json
{
  "action": "apply",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 2
  },
  "operations": [
    {
      "op": "set_column_width",
      "payload": { "sheet": "<sheet_name_from_summary>", "index": 1, "count": 1, "size": 14 }
    },
    {
      "op": "set_row_height",
      "payload": { "sheet": "<sheet_name_from_summary>", "index": 1, "count": 1, "size": 24 }
    }
  ]
}
```

若上一步回执没有完整提供验收所需内容，再读取同一范围，核对输入值、公式字符串、真实计算值和样式；明确 `partial` 时只补读缺失的行列：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": {
    "mode": "range",
    "sheet": "<sheet_name_from_summary>",
    "range": "A1:D3",
    "include_formula": true,
    "include_style": true
  }
}
```

结构和范围检查完成后，按版式验收需要再检查当前实际可见区域：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "visual" }
}
```

该 PNG 只代表当前 Excel viewport，并且响应带有同一 `version`。跨屏表格必须继续用 `range` 分块核对；如果用户滚动到其它区域并需要视觉确认，再针对新的当前 viewport 重新执行 `visual`。视觉检查发生版本冲突时，重新读取结构和画面。

对需要滚动、筛选和动态标记异常的长表，可以在一个相关批次中提交下面的操作；紧凑表格不必照搬：

```json
{
  "action": "apply",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 4
  },
  "operations": [
    {
      "op": "set_auto_filter",
      "payload": { "sheet": "<sheet_name_from_summary>", "range": "A1:D12" }
    },
    {
      "op": "set_freeze_panes",
      "payload": { "sheet": "<sheet_name_from_summary>", "rows": 1, "columns": 0 }
    },
    {
      "op": "set_conditional_format",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "range": "D2:D12",
        "rule": {
          "kind": "number",
          "operator": "lessThan",
          "value": 0,
          "format": { "fillColor": "#FDE9E7", "fontColor": "#B42318", "bold": true }
        }
      }
    }
  ]
}
```

移除筛选用 `set_auto_filter` 的 `range: null`；取消冻结使用 `rows: 0, columns: 0`。条件格式还支持 `colorScale`，字段为 `minColor`、`maxColor` 和可选 `midColor`，只用于连续数值确实需要看分布的区域。提交后通过 `summary` 或 `range` 复核 `autoFilter`、`freeze` 和 `conditionalFormatCount`。

## 4. 结构操作和交付

确有结构需要时使用 1-based 的索引。例如在第 4 行前插入两行，然后重新读取受影响区域：

```json
{
  "action": "apply",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 2
  },
  "operations": [
    {
      "op": "insert_rows",
      "payload": {
        "sheet": "<sheet_name_from_summary>",
        "index": 4,
        "count": 2
      }
    }
  ]
}
```

工作表结构操作的 payload 形状如下，只有用户确有需求才使用：

```json
[
  { "op": "add_sheet", "payload": { "name": "汇总" } },
  { "op": "rename_sheet", "payload": { "sheet": "汇总", "newName": "年度汇总" } },
  { "op": "move_sheet", "payload": { "sheet": "年度汇总", "position": 1 } },
  { "op": "merge_cells", "payload": { "sheet": "年度汇总", "range": "A1:D1" } }
]
```

完成后保存工作副本，或导出新的原生文件：

```json
{
  "action": "save",
  "session_id": "<session_id>",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 3
  }
}
```

```json
{
  "action": "export",
  "session_id": "<session_id>",
  "output": "deliverables/monthly-sales.xlsx",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 3
  }
}
```

如果 `apply` 因版本冲突失败，重新读取受影响的 `range`，以用户当前数据为基准重建操作；不要用旧版本强行重试。会话断开或暂时失败时，用 `office` 的 `open` 携带原 `session_id` 恢复同一会话，不要新建会话或重建工作簿。

> 可迁移原则参考 Codex 内置 Spreadsheets 26.904.11930；示例仍只使用 Mona 实时 `office` 工具。
