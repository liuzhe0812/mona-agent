# Mona 官网动效规范

## 状态机

| 状态 | 触发 | 建议素材 | 建议时长 |
|---|---|---|---|
| `WELCOME` | 首次进入首屏 | `mona-welcome.png` | 900–1200ms |
| `IDLE` | 无交互 600ms 后 | `mona-idle.png` | 3.6s 呼吸循环 |
| `THINK` | 功能切换或读取上下文 | `mona-thinking.png` | 600–900ms |
| `WORK` | 场景演示执行中 | `mona-working.png` | 1.8–2.6s 循环 |
| `RUN` | 章节转场 | `mona-run-loop.webp` | 800–1100ms |
| `CONFIRM` | 等待关键操作确认 | `mona-confirm.png` | 保持至用户操作 |
| `GUARD` | 阻止或提示高风险动作 | `mona-guard.png` | 500ms 进入 |
| `SUCCESS` | 任务完成 | `mona-success.png` | 700–900ms |
| `SLEEP` | 页脚或长时间空闲 | `mona-sleep.png` | 6–8s 微呼吸循环 |

## 动作节奏

- 微交互：160–240ms
- 组件切换：420–650ms
- 场景转场：800–1200ms
- 尾巴待机循环：2.4s
- 身体呼吸循环：3.6s
- 眨眼间隔：4–7s，随机
- 头部视差：最大 `±6°`

## 奔跑关键帧

`mona-run-01` → `02` → `03` → `04`，建议 10–12fps。现成 `mona-run-loop.webp` 使用透明背景，可直接用于转场预演。角色位移与尾巴划屏由页面动画控制，帧素材本身不要再增加运动模糊。

## Rive/Spine 绑定顺序

```text
tail
back_arm
back_leg
torso
front_leg
front_arm
head
status_diamond
face_expression
```

建议旋转中心：

- 头部：颈部中心
- 上臂：肩关节内侧
- 前臂：肘部
- 上腿：胯部
- 下腿：膝部
- 尾巴：靠近身体的一端
- 状态灯：几何中心

所有关节保持 8–14px 的图形重叠，防止旋转时出现透明缝隙。

## 页面配合

- Three.js 只负责背景空间、数据轨道和粒子；Mona 保持在前景 2D/Rive 层。
- 工作轮盘每次只切换一个 Mona 状态，避免角色、轮盘、粒子同时抢夺注意力。
- 尾巴转场先绘制路径，再用同一路径作为章节揭示遮罩。
- 移动端关闭复杂粒子碰撞，保留角色、尾巴轨迹和卡片切换。
- `prefers-reduced-motion` 下使用 `mona-idle.png`、`mona-confirm.png` 等静态关键姿势，不播放奔跑循环。
