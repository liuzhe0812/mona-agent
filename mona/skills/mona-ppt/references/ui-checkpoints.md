# V3 UI Checkpoints — Recovery Message Templates

本文件定义 `PPT_UI_CHECKPOINTS=1` 模式下，UI 侧在用户完成检查点确认后唤醒 Agent 使用的规范消息文本。UI 必须按以下模板原样发送，Agent 据此识别恢复点并继续执行管线。

## 1. 大纲确认后唤醒 Agent

触发条件：用户在 PPT 页面 UI 上完成大纲编辑（增删/重排页面、编辑每页内容）并点击"确认大纲"。

消息模板：

```
[OUTLINE_CONFIRMED]
project_path: <project_path>
outline_revision: <integer>
page_count: <integer>
next_action: rebuild_spec_lock_and_generate_first_page

用户已在 UI 上确认大纲。请按以下顺序继续：
1. 读取最终 <project_path>/page_visual_plan.json（schemaVersion=2, revision=<integer>）。
2. 按其内容同步重建 <project_path>/design_spec.md。如用户在聊天中要求过规格调整，以调整后的 design_spec.md 当前状态为准，不要回退到 Step 4 初始草稿。
3. 按 templates/spec_lock_reference.md 生成完整 <project_path>/spec_lock.md。
4. 如 design_spec.md Section VIII 有 ai/web 行，执行 Step 5 图片获取。
5. 启动 Flask live preview。
6. **仅生成第 1 页 SVG**，写入 svg_output/，输出 required trace line。
7. 对该页运行 svg_quality_checker.py，修复 error。
8. 写该页备注到 notes/。
9. 停止，告知用户"第 1 页已生成，请预览确认"。
10. 不要生成其他页，不要进入 Step 7，不要写 .review_ready。
```

字段说明：
- `outline_revision`：与 `page_visual_plan.json` 的 `revision` 字段一致，用于 Agent 校验读取的是最终版本。
- `page_count`：最终页面数，Agent 重建 `design_spec.md` 后须自检页面数匹配。

**关于 8 项确认**：用户在大纲阶段不编辑全局 8 项确认（UI 只读展示 AI 推荐规格）。如用户需要调整全局规格，会通过聊天直接告知 Agent（如「主色改成 #1a73e8」「用深色背景」），Agent 收到后更新 `design_spec.md` + `design_spec_summary.json`。因此 `[OUTLINE_CONFIRMED]` 不携带 8 项修改字段，Agent 直接以 `design_spec.md` 当前状态生成 `spec_lock.md`。

### 全部生成模式

用户点击“全部生成”时，UI 发送：

```
[OUTLINE_CONFIRMED_ALL]
project_path: <project_path>
next_action: generate_all_pages_and_export

读取最终 page_visual_plan.json 和 design_spec_summary.json，重建 design_spec.md 与 spec_lock.md，完成图片获取后一次生成全部 SVG 页面及备注。每页保留 required trace 和质量检查，随后运行全量质量门禁并依次执行 total_md_split.py、finalize_svg.py、svg_to_pptx.py，最终报告 PPTX 路径。
```

## 2. 确认当前页并请求生成下一页

触发条件：用户在 UI 上确认当前页（点击"确认通过"），请求生成下一页。

消息模板：

```
[PAGE_CONFIRMED_NEXT]
project_path: <project_path>
confirmed_page: <page_id>
confirmed_page_index: <N>
next_page_index: <N+1>
next_page_id: <page_id>
next_action: generate_next_page

第 <N> 页已确认。请生成第 <N+1> 页：
1. 读取 spec_lock.md，确认锁定参数未变。
2. 手写 svg_output/<next_page_id>.svg，输出 required trace line。
3. 对该页运行 svg_quality_checker.py，修复 error。
4. 写该页备注到 notes/。
5. 仅生成这一页，停止并告知用户"第 <N+1> 页已生成，请预览确认"。
```

字段说明：
- `confirmed_page`：已确认页的 page_id（如 P01）。
- `confirmed_page_index`：已确认页的 1-based 索引。
- `next_page_index`：待生成页的 1-based 索引。
- `next_page_id`：待生成页的 page_id（如 P02）。

## 3. 单页重做（含规格编辑）

触发条件：用户在 UI 上点击"重新生成"并可能修改了该页规格，或在聊天中提出修改意见。

消息模板：

```
[PAGE_REDO_REQUESTED]
project_path: <project_path>
page_index: <N>
page_id: <page_id>
page_spec:
  title: <new_title>
  bullets: [<bullet1>, <bullet2>]
  visual_type: <new_visual_type>
  layout: <new_layout>
  notes: <new_notes>
feedback: <user_feedback_text>
next_action: redo_single_page

用户要求重做第 <N> 页，规格可能已修改。
请按以下顺序处理：
1. 重新读取 page_visual_plan.json 中第 <N> 页的最新规格（上方 page_spec 字段即为新值）。
2. 重新读取 spec_lock.md，确认锁定的颜色/字体/图标/版式未变。
3. 如规格涉及内容或数据修改，先同步 design_spec.md 对应章节和 notes/ 中该页备注。
4. 按新规格手写 svg_output/<page_id>.svg，输出 required trace line。
5. 对该页运行 svg_quality_checker.py，修复 error。
6. 停止，告知用户"第 <N> 页已重做，请预览确认"。
7. 不要重新进入 Step 7 导出，不要改写其他页。
```

字段说明：
- `page_index`：1-based 页索引。
- `page_id`：与 `page_visual_plan.json` 中 pages 数组对应项的 id 字段一致。
- `page_spec`：修改后的页面规格。如用户未修改规格，此处为空，Agent 按原规格重做。
- `feedback`：用户原始反馈文本，保留原语言。可为空。

## 4. 跳页生成

触发条件：用户在 UI 上点击左侧列表中某个 pending 页直接生成。

消息模板：

```
[PAGE_GENERATE_REQUESTED]
project_path: <project_path>
page_index: <N>
page_id: <page_id>
next_action: generate_single_page

请生成第 <N> 页 svg_output/<page_id>.svg。
1. 读取 spec_lock.md，确认锁定参数未变。
2. 手写该页 SVG，输出 required trace line。
3. 对该页运行 svg_quality_checker.py，修复 error。
4. 写该页备注到 notes/。
5. 完成后停止，告知用户"第 <N> 页已生成，请预览确认"。
```

字段说明：
- `page_index`：1-based 页索引。
- `page_id`：待生成页的 page_id。

## 5. 全部确认后请求导出

触发条件：用户在 UI 上对所有页面逐页确认完毕，点击"全部确认导出"。

消息模板：

```
[ALL_PAGES_CONFIRMED]
project_path: <project_path>
outline_revision: <integer>
confirmed_pages: <integer>
next_action: run_step_7_export

用户已在 UI 上逐页确认所有 <integer> 页。请执行 Step 7 后处理与导出：
1. 运行全量 svg_quality_checker.py 作为最终门控。
2. 如 Step 5 留有 Needs-Manual 图片，先校验所需文件存在；缺失则暂停并列出文件名。
3. 依次运行：total_md_split.py → finalize_svg.py → svg_to_pptx.py。
4. 若 total_md_split.py 或 svg_to_pptx.py 报告无 notes 文件，返回 Step 6 重新生成备注。
5. 若 finalize_svg.py 报告图片缺失/未解析，修复 SVG href 或文件放置后重试。
6. 报告完整项目相对路径：ppt_projects/<project_name>/exports/<project_name>_<timestamp>.pptx。
7. 浏览器批注仅在导出后且用户明确要求时执行。
```

字段说明：
- `outline_revision`：与第 1 类消息中的 revision 一致，用于 Agent 校验整条链路未发生中途变更。
- `confirmed_pages`：必须等于 `page_visual_plan.json` 中 pages 数组长度，否则 Agent 应暂停并提示页面数不一致。

## 使用约束

- UI 必须原样发送模板顶部的方括号标记（`[OUTLINE_CONFIRMED]` / `[OUTLINE_CONFIRMED_ALL]` / `[PAGE_CONFIRMED_NEXT]` / `[PAGE_REDO_REQUESTED]` / `[PAGE_GENERATE_REQUESTED]` / `[ALL_PAGES_CONFIRMED]` / `[DESIGN_SPEC_UPDATED]`），Agent 据此识别消息类型。
- 字段名不得改名，值由 UI 填充。
- 模板中的 `<...>` 占位符由 UI 替换为实际值，不要保留尖括号。
- 七类消息之外的其他用户输入（如自由聊天、追问）按普通对话处理，不触发 V3 检查点恢复逻辑。

## 6. 设计规格更新

触发条件：用户在 PPT 大纲页面的"设计规格"折叠面板中修改了八项确认中的任意项（画布格式/页数/目标受众/风格模式/视觉风格/主色调/图标方案/字体方案/公式策略/图片方案）。

消息模板：

```
[DESIGN_SPEC_UPDATED]
project_path: <project_path>
next_action: update_design_spec

用户在 UI 上更新了设计规格，请同步更新 design_spec.md 中对应章节：
- 画布格式：<canvas_format>
- 页数：<page_count>
- 目标受众：<audience>
- 风格模式：<style_mode>
- 视觉风格：<style_descriptor>
- 主色调：<primary_color>
- 图标方案：<icon_approach>
- 字体方案：<title_font> / <body_font>
- 公式策略：<formula_policy>
- 图片方案：<image_approach>

要求：
1. 更新 design_spec.md 中受影响的章节（颜色/字体/图标/图片/公式策略/项目信息/画布）。
2. 同步重写 design_spec_summary.json 中对应字段，更新 updatedAt。
3. 如果 spec_lock.md 已生成，同步更新 spec_lock.md 中对应参数。
4. 如果已有 SVG 页面生成，告知用户哪些页面需要重新生成以匹配新规格。
5. 停止，告知用户设计规格已更新。
```

字段说明：
- 仅列出用户实际修改的项，未修改的项省略。
- Agent 收到后更新 `design_spec.md`、`design_spec_summary.json` 和 `spec_lock.md`（如已生成），不自动重新生成已有 SVG 页面，仅告知用户哪些页面需要重做。
- 未带 `PPT_UI_CHECKPOINTS=1` 标记的会话不发送本文件定义的任何消息模板，Agent 走原有自动管线。
