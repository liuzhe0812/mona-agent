# Mona Animation Asset Pack v1

本素材包用于 Mona 官网的角色动画、工作轮盘、页面转场和状态反馈。它不包含网页代码。

## 目录

- `01-reference/`：角色概念板与四视图母版。
- `02-poses/`：8 个透明完整姿势、透明姿势合集、12 个可绑定部件。
- `03-run/`：4 个透明奔跑关键帧、精灵图和可直接预览的透明动画 WebP。
- `04-expressions/`：6 个透明表情头像和表情合集。
- `05-effects/`：尾巴转场、轨道、状态灯及六个模块图标。
- `06-handoff/`：状态机、时间参数、图层和使用规范。
- `sources/`：保留的绿色背景生成源文件，便于重新抠图或调整边缘。

## 品牌基准

- Ink Navy：`#0B1020`
- Warm Ivory：`#F4F0E5`
- Electric Blue：`#2F80FF`
- Signal Yellow：`#F4E84A`
- Warning Orange：`#FF9B42`

权威角色参考为 `01-reference/mona-master-turnaround.png`；现有 Mona LOGO 的脸型、眼睛和配色优先级高于其他姿势稿。

## 直接使用建议

- 首页待机：`02-poses/individual/mona-welcome.png` 进入后切换 `mona-idle.png`。
- 工作轮盘：使用 `mona-working.png`、`mona-thinking.png` 和六个模块 SVG 图标。
- 页面转场：使用 `03-run/mona-run-loop.webp` 叠加 `05-effects/mona-tail-swipe.svg`。
- 高风险确认：使用 `mona-confirm.png` 或 `mona-guard.png`。
- 完成反馈：使用 `mona-success.png`。
- 页脚：使用 `mona-sleep.png`。

## 已知边界

透明 PNG、精灵图和动画 WebP 可直接用于网站；`rig-parts/` 是 Rive/Spine 绑定源，不是已经绑定完成的 `.riv` 工程。生成稿保留了细微的姿势间绘制差异，正式品牌注册或超大幅印刷前建议由插画师基于母版做一次矢量统一。
