# Word Office 操作示例

下面示例创建一份简短的项目周报，并展示分析已有文档、分批写入、表格复核和原生导出。尖括号表示必须用上一步真实返回值替换的变量；不要照抄旧版本号或猜测块 ID。

## 1. 打开并读取实时会话

新建时先打开空白 DOCX：

```json
{
  "action": "open",
  "document_type": "docs",
  "display_name": "项目周报"
}
```

记录返回的 `sessionId`、当前 `selection`、文档尺寸和 `version`。以下原文入口按任务三选一：需要规模和页面设置时读 `summary`，需要标题结构时读 `outline`，需要定位文本时读 `search` 后再读命中的 `blocks`；已完整返回的内容不再换入口重复读取。

如果选择 `summary`，调用：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "summary" }
}
```

如果选择 `outline`，调用：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "outline", "limit": 20 }
}
```

摘要中的 `pageSettings` 是每个文档节的真实毫米设置。若 `open` 已返回当前选择，直接使用其中的 `blockIds` 和 `text`；只有选区需要刷新时才读取当前选择：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "selection" }
}
```

已有文件的分析从同一流程开始，只把 `open` 换成：

```json
{
  "action": "open",
  "path": "reports/weekly-report.docx"
}
```

需要查找某个事实时，用 `search` 得到稳定目标，再用 `blocks` 读取尚未返回的完整块：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "search", "text": "交付日期", "limit": 20 }
}
```

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "blocks", "block_ids": ["<block_id>"] }
}
```

## 2. 分批写入内容

使用最新版本，先写标题和引言。`afterBlockId: null` 表示插入到文档末尾；新块的 ID 从 `changedTargets` 取得：

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
      "op": "insert_heading",
      "payload": { "afterBlockId": null, "text": "项目周报", "level": 1 }
    },
    {
      "op": "insert_paragraph",
      "payload": {
        "afterBlockId": null,
        "text": "本周完成接口联调，风险集中在外部验收时间。"
      }
    }
  ]
}
```

用返回的最新 `version` 和标题/正文的真实 ID 写下一批。列表使用当前实现的 `kind` 字段：

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
      "op": "insert_heading",
      "payload": { "afterBlockId": "<paragraph_id>", "text": "本周进展", "level": 2 }
    },
    {
      "op": "insert_list",
      "payload": {
        "afterBlockId": "<new_heading_id>",
        "kind": "bullet",
        "items": ["完成接口联调", "补齐验收数据", "安排下周回归"]
      }
    },
    {
      "op": "insert_table",
      "payload": {
        "afterBlockId": "<last_list_item_id>",
        "rows": [
          ["事项", "负责人", "状态"],
          ["外部验收", "项目组", "待排期"],
          ["回归测试", "研发组", "进行中"]
        ]
      }
    }
  ]
}
```

## 3. 复核和修订

对 `apply` 未完整返回的表格 ID 读取二维内容，并对标题设置语义样式。若回执已带有验收所需表格内容，不重复读取。这里的表格索引是 0-based：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "blocks", "block_ids": ["<table_id>", "<heading_id>"] }
}
```

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
      "op": "set_table_cell",
      "payload": {
        "blockId": "<table_id>",
        "rowIndex": 1,
        "columnIndex": 2,
        "text": "已完成"
      }
    },
    {
      "op": "set_block_style",
      "payload": {
        "blockId": "<heading_id>",
        "style": {
          "bold": true,
          "headingLevel": 2,
          "spaceAfter": 240
        }
      }
    },
    {
      "op": "set_table_style",
      "payload": {
        "blockId": "<table_id>",
        "columnWidths": [180, 120, 120],
        "headerRows": 1,
        "headerFill": "#D9EAF7",
        "bodyFill": "#FFFFFF",
        "borderColor": "#9DC3E6",
        "cellPadding": 8
      }
    }
  ]
}
```

若某章节必须从新页开始，把 `pageBreakBefore: true` 加在该块的 `style` 中，再检查分页效果：

```json
{
  "op": "set_block_style",
  "payload": {
    "blockId": "<heading_id>",
    "style": { "pageBreakBefore": true }
  }
}
```

如果需要调整页面，在 `summary.pageSettings` 确认节索引后，用毫米提交一个独立的小批次；未提供的字段保持原值：

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
      "op": "set_page_style",
      "payload": {
        "sectionIndex": 0,
        "widthMm": 210,
        "heightMm": 297,
        "marginTopMm": 20,
        "marginBottomMm": 20,
        "marginLeftMm": 22,
        "marginRightMm": 22
      }
    }
  ]
}
```

修改后按验收清单复核受影响块；需要页面设置或分页证据时再读 `summary`，随后用真实 PNG 检查页面。传 `pageIndex` 时 Word 页码从 0 开始；省略该字段检查当前 viewport：

```json
{
  "action": "inspect",
  "session_id": "<session_id>",
  "query": { "mode": "visual", "pageIndex": 0 }
}
```

响应同时包含 `version` 和图像内容。若视觉检查报告版本冲突，丢弃旧图像并重新 `inspect`，不要用旧图像验收。

页眉、页脚和默认页码可作为同一实时 `apply` 批次中的操作；使用最新版本提交，随后用 `summary` 和 checkpoint 导出的 DOCX 复核：

```json
{
  "op": "set_header_footer",
  "payload": {
    "kind": "footer",
    "view": "default",
    "text": "第",
    "pageNumber": true
  }
}
```

`summary` 的 `headerFooter` 只返回轻量文本和页码状态；首节、偶数页和复杂多节变体需在实际验证后再使用或报告。

## 4. 保存或导出

保存工作副本：

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

需要交付新的原生文件时导出到工作区：

```json
{
  "action": "export",
  "session_id": "<session_id>",
  "output": "deliverables/project-weekly-report.docx",
  "expected_version": {
    "editorEpoch": "<latest_editor_epoch>",
    "modelRevision": 3
  }
}
```

版本冲突时不要重试旧 `expected_version`；重新 `inspect` 受影响块，合并用户修改后再按相同格式提交。会话断开或暂时失败时，用 `office` 的 `open` 携带原 `session_id` 恢复同一会话，不要新建会话或重建文档。

> 可迁移原则参考 Codex 内置 documents 26.904.11930；示例仍只使用 Mona 实时 `office` 工具。
