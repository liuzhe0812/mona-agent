---
name: mona-visualizer
description: "为解释、比较、架构讨论或数据探索生成聊天内嵌视觉内容时使用；原型图、模拟图和线框图走图像生成，Office 文档或可编辑画布走相应专用 Skill。"
---

# Mona Visualizer

用于在普通对话中呈现有助于理解的 SVG、HTML 图形或互动图表。文字解释留在聊天正文，widget 只呈现视觉内容；图中文字使用用户的语言。

首次绘制前，通过 `skill_reference_read(skill="mona-visualizer", ref_path="...")` 读取公共指南 [core.md](references/core.md)、[colors.md](references/colors.md)，以及当前任务需要的指南：

- 关系图：[svg.md](references/svg.md)、[diagram.md](references/diagram.md)。
- 互动内容或界面示意：[ui.md](references/ui.md)、[interactive.md](references/interactive.md)。
- 图表：[ui.md](references/ui.md)、[chart.md](references/chart.md)；地理图表还需 [maps.md](references/maps.md)。
- 插画：[svg.md](references/svg.md)、[art.md](references/art.md)。

已有指南若仍在当前上下文中，直接复用，无需为每张图重复读取；需要新的指南时只读取缺少的文件。使用 `show_widget(title, widget_code, loading_messages)` 展示图形。

用户要求原型图、模拟图或线框图时，使用图像生成能力；已有可编辑画布、Office 文件或文档任务交给相应专用 Skill。
