---
name: mona-visualizer
description: "为解释、比较、架构讨论或数据探索生成聊天内嵌视觉内容时使用；原型图、模拟图和线框图走图像生成，Office 文档或可编辑画布走相应专用 Skill。"
---

# Mona Visualizer

用于在普通对话中呈现有助于理解的 SVG、HTML 图形或互动图表。文字解释留在聊天正文，widget 只呈现视觉内容；图中文字使用用户的语言。

绘制前只读取当前任务需要的指南：[core](references/core.md) 是基础；按需读取 [colors](references/colors.md)、[svg](references/svg.md)、[diagram](references/diagram.md)、[ui](references/ui.md)、[interactive](references/interactive.md)、[chart](references/chart.md)、[maps](references/maps.md) 或 [art](references/art.md)。地理图表同时参考 `maps.md`。

第一次绘图前，从 `diagram`、`mockup`、`interactive`、`chart`、`art` 中选择当前需要的模块调用 `read_me(modules=[...])`，再调用 `show_widget(title, widget_code, loading_messages)`。只选择相关模块；切换到另一个模块时再次读取相应指南。不要把整套指南常驻到系统提示词。

用户要求原型图、模拟图或线框图时，使用图像生成能力；已有可编辑画布、Office 文件或文档任务交给相应专用 Skill。
