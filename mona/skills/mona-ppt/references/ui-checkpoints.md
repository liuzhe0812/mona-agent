# V2 UI Checkpoints — Recovery Message Templates

本文件定义 `PPT_UI_CHECKPOINTS=1` 模式下，UI 侧在用户完成检查点确认后唤醒 Agent 使用的三类规范消息文本。UI 必须按以下模板原样发送，Agent 据此识别恢复点并继续执行管线。

## 1. 大纲确认后唤醒 Agent

触发条件：用户在 PPT 页面 UI 上完成大纲编辑（增删/重排页面）并点击"确认大纲"。

消息模板：

```
[OUTLINE_CONFIRMED]
project_path: <project_path>
outline_revision: <integer>
page_count: <integer>
next_action: rebuild_spec_lock_and_continue

用户已在 UI 上确认大纲。请按以下顺序继续：
1. 读取最终 <project_path>/page_visual_plan.json（schemaVersion=2, revision=<integer>）。
2. 按其内容同步重建 <project_path>/design_spec.md。
3. 按 templates/spec_lock_reference.md 生成完整 <project_path>/spec_lock.md。
4. 继续 Step 5（如 design_spec.md Section VIII 有 ai/web 行）和 Step 6。
5. Step 6 全部 SVG 通过质量检查且备注齐全后写入 <project_path>/.review_ready。
6. 停止在 Step 7 之前，等待用户逐页确认。
```

字段说明：
- `outline_revision`：与 `page_visual_plan.json` 的 `revision` 字段一致，用于 Agent 校验读取的是最终版本。
- `page_count`：最终页面数，Agent 重建 `design_spec.md` 后须自检页面数匹配。

## 2. 单页重做后唤醒 Agent

触发条件：用户在右侧逐页预览中对某一页提出修改意见（重做该页 SVG），并提交"重做此页"。

消息模板：

```
[PAGE_REDO_REQUESTED]
project_path: <project_path>
page_index: <integer>
page_id: <string>
feedback: <user_feedback_text>
next_action: redo_single_page

用户要求重做第 <integer> 页（page_id=<string>）。
反馈摘要：<user_feedback_text>

请按以下顺序处理：
1. 重新读取 <project_path>/spec_lock.md，确认锁定的颜色/字体/图标/版式未变。
2. 如反馈涉及内容或数据修改，先同步更新 <project_path>/design_spec.md 对应章节，并视情况更新 <project_path>/notes/total.md 中该页备注。
3. 重新手写 <project_path>/svg_output/<page_id>.svg，输出 required trace line。
4. 仅对该页运行 svg_quality_checker.py 校验（或对全量重跑），直到 0 错误。
5. 完成后告知用户"第 <integer> 页已重做，请再次确认"，等待用户在 UI 上再次确认该页或继续其他页。
6. 不要重新进入 Step 7 导出，也不要改写 .review_ready。
```

字段说明：
- `page_index`：0-based 或 1-based 由 UI 与 Agent 约定（默认 1-based，与人类阅读习惯一致）。
- `page_id`：与 `page_visual_plan.json` 中 pages 数组对应项的 id 字段一致，用于定位 SVG 文件名。
- `feedback`：用户原始反馈文本，保留原语言。

## 3. 全部确认后请求导出

触发条件：用户在 UI 上对所有页面逐页确认完毕，点击"全部确认，导出 PPTX"。

消息模板：

```
[ALL_PAGES_CONFIRMED]
project_path: <project_path>
outline_revision: <integer>
confirmed_pages: <integer>
next_action: run_step_7_export

用户已在 UI 上逐页确认所有 <integer> 页。请执行 Step 7 后处理与导出：
1. 如 Step 5 留有 Needs-Manual 图片，先校验所需文件存在；缺失则暂停并列出文件名。
2. 依次运行：total_md_split.py → finalize_svg.py → svg_to_pptx.py。
3. 若 total_md_split.py 或 svg_to_pptx.py 报告无 notes 文件，返回 Step 6 重新生成备注。
4. 若 finalize_svg.py 报告图片缺失/未解析，修复 SVG href 或文件放置后重试。
5. 报告完整项目相对路径：ppt_projects/<project_name>/exports/<project_name>_<timestamp>.pptx。
6. 浏览器批注仅在导出后且用户明确要求时执行。
```

字段说明：
- `outline_revision`：与第 1 类消息中的 revision 一致，用于 Agent 校验整条链路未发生中途变更。
- `confirmed_pages`：必须等于 `page_visual_plan.json` 中 pages 数组长度，否则 Agent 应暂停并提示页面数不一致。

## 使用约束

- UI 必须原样发送模板顶部的方括号标记（`[OUTLINE_CONFIRMED]` / `[PAGE_REDO_REQUESTED]` / `[ALL_PAGES_CONFIRMED]`），Agent 据此识别消息类型。
- 字段名（`project_path`、`outline_revision`、`page_count`、`page_index`、`page_id`、`feedback`、`confirmed_pages`、`next_action`）不得改名，值由 UI 填充。
- 模板中的 `<...>` 占位符由 UI 替换为实际值，不要保留尖括号。
- 三类消息之外的其他用户输入（如自由聊天、追问）按普通对话处理，不触发 V2 检查点恢复逻辑。
- 未带 `PPT_UI_CHECKPOINTS=1` 标记的会话不发送本文件定义的任何消息模板，Agent 走原有自动管线。
