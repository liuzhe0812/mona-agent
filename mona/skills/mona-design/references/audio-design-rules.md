# 音效设计规则 · Mona Design

> 动画音效的设计和混音建议。和 `sfx-library.md`（音效资产清单）配套使用。

---

## 核心原则

默认不铺持续的背景音乐。只有当某个动作或信息节点需要声音反馈时才添加音效；旁白只在内容需要讲解时使用。声音要和画面同步、音量克制，避免为了填满时间轴而增加声音。

### 音量与混合
- 音效以清楚、舒适为准，避免削波或突然刺耳。
- 多个音效叠加时使用 `amix=normalize=0`，保留音量变化。
- 音效需要淡入淡出时按素材本身的起止点处理，避免突然截断。

---

## SFX cue 设计规则

### 密度（每10秒多少个SFX）
实测 Anthropic 三支片子的 SFX 密度有三档：

| 片子 | 每10s SFX 数 | 产品性格 | 场景 |
|---|---|---|---|
| Artifacts（ref-1） | **~9个/10s** | 功能密集、信息多 | 复杂工具演示 |
| Code Desktop（ref-2） | **0个** | 纯氛围、冥想感 | 开发工具专注状态 |
| Word（ref-3） | **~4个/10s** | 平衡、办公节奏 | 生产力工具 |

**启发式**：
- 冷静/专注的内容 → 少量音效或不加音效
- 动作明确、信息密集的内容 → 只在关键动作加入音效
- **不要填满每个视觉 beat**——留白比密集更高级。**删掉 30-50% 的 cue 会让剩下的更有戏剧性**。

### Cue 选择优先级
每个视觉 beat 不都要配 SFX。按这个优先级选：

**P0 必配**（省略会有违和感）：
- 打字（终端/输入）
- 点击/选择（用户决策时刻）
- 焦点切换（视觉主角转移）
- Logo reveal（品牌收束）

**P1 推荐配**：
- 元素入场/离场（modal / card）
- 完成/成功反馈
- AI 生成开始/结束
- 重大过渡（scene 切换）

**P2 选配**（多了会乱）：
- hover / focus-in
- 进度 tick
- 装饰性 ambient

### 时间戳对齐精度
- **同帧对齐**（0ms 误差）：点击/焦点切换/Logo 落定
- **前置 1-2 帧**（-33ms）：快速 whoosh（给观众心理预期）
- **后置 1-2 帧**（+33ms）：物体落地/impact（符合真实物理）

---

## 场景配方（开箱即用）

### 配方 A · 产品发布 hero（huashu-design v9 同款）
```
时长：25 秒
SFX 密度：~6个/10s

cue：
  终端打字 → type × 4（间隔0.6s）
  回车     → enter
  卡片汇聚 → card × 4（错峰 0.2s）
  选中     → click
  Ripple   → whoosh
  4次焦点  → focus × 4
  Logo     → thud（1.5s）

音量：音效清楚但不过响 · amix normalize=0
```

### 配方 B · 工具功能演示（参考 Anthropic Code Desktop）
```
时长：30-45 秒
SFX 密度：0-2个/10s（极少）

策略：让旁白讲清内容，SFX 只在**决定性时刻**（文件保存/命令执行完成）
```

### 配方 C · AI 生成演示
```
时长：15-20 秒
SFX 密度：~8个/10s（高密度）

cue：
  用户输入 → type + enter
  AI 开始处理 → magic/ai-process（1.2s 循环）
  生成完成 → feedback/complete-done
  结果呈现 → magic/sparkle
  
亮点：ai-process 可以循环 2-3 次贯穿整个生成过程
```

### 配方 D · 纯氛围长镜头（参考 Artifacts）
```
时长：10-15 秒
SFX：单独使用 3-5 个精心设计的 cue

策略：每个 SFX 都服务一个明确动作，留出安静间隔。
适合：单产品慢镜头、特写展示
```

---

## ffmpeg 合成模板

### 模板 1 · 单 SFX 叠加到视频
```bash
ffmpeg -y -i video.mp4 -itsoffset 2.5 -i sfx.mp3 \
  -filter_complex "[0:a][1:a]amix=inputs=2:normalize=0[a]" \
  -map 0:v -map "[a]" output.mp4
```

### 模板 2 · 多 SFX 时间轴合成（按cue时间对齐）
```bash
ffmpeg -y \
  -i sfx-type.mp3 -i sfx-enter.mp3 -i sfx-click.mp3 -i sfx-thud.mp3 \
  -filter_complex "\
[0:a]adelay=1100|1100[a0];\
[1:a]adelay=3200|3200[a1];\
[2:a]adelay=7000|7000[a2];\
[3:a]adelay=21800|21800[a3];\
[a0][a1][a2][a3]amix=inputs=4:duration=longest:normalize=0[mixed]" \
  -map "[mixed]" -t 25 sfx-track.mp3
```
**关键参数**：
- `adelay=N|N`：前面是左声道延迟(ms)，后面是右声道，写两遍保证立体声对齐
- `normalize=0`：保留动态范围，关键！
- `-t 25`：截断到指定时长

## 失败模式速查

| 症状 | 根因 | 修复 |
|---|---|---|
| SFX 听不见 | 音效增益过低或被旁白遮住 | 调整音效增益与 cue 时机，优先保证口播清楚 |
| 音效过响刺耳 | 音效绝对音量太大 | 降低该音效音量，避免削波 |
| SFX 重叠成糊 | cue 太密 + 每个 SFX 时长太长 | SFX 时长控到 0.5s 以内，cue 间隔 ≥ 0.2s |
| 公众号 mp4 没声音 | 公众号有时会 mute auto-play | 不用担心，用户点开会有声音；gif 本来就没声音 |

---

## 和视觉的联动（高级）

### SFX 音色要和视觉风格匹配
- 暖米/纸张感视觉 → SFX 用**木质/柔和**音色（Morse, paper snap, soft click）
- 冷黑科技视觉 → SFX 用**金属/数字**音色（beep, pulse, glitch）
- 手绘/童趣视觉 → SFX 用**卡通/夸张**音色（boing, pop, zap）

我们当前 `apple-gallery-showcase.md` 的暖米底色 → 搭配 `keyboard/type.mp3`（mechanical）+ `container/card-snap.mp3`（soft）+ `impact/logo-reveal-v2.mp3`（cinematic bass）

### SFX 可以引导视觉节奏
高级技巧：**先设计 SFX 时间轴，然后调整视觉动画去对齐 SFX**（不是反过来）。
因为 SFX 每个 cue 都是一个「钟表 tick」，视觉动画适配 SFX 节奏会非常稳——反之 SFX 去追视觉，常常 ±1 帧对不上就有违和感。

---

## 质量检查清单（发布前自检）

- [ ] 音频无削波，音效音量舒适？
- [ ] 旁白清楚，音效没有遮住口播？
- [ ] amix normalize=0（保留动态范围）？
- [ ] SFX 数量是否合适（按场景性格选密度）？
- [ ] 每个 SFX 和视觉 beat 同帧对齐（±1 帧内）？
- [ ] Logo reveal 音效时长够（建议 1.5s）？
- [ ] 静音试听画面节奏是否仍然清楚？
- [ ] 音效与视觉 beat 同步，且没有无意义的填充？

音效应当独立服务画面；若旁白存在，确保二者不会互相遮盖。

---

## 参考

- SFX 资产清单：`sfx-library.md`
- 视觉风格参考：`apple-gallery-showcase.md`
- Anthropic 三支片子深度音频分析：AUDIO-BEST-PRACTICES.md（作者本地资料，未随仓库分发）
- huashu-design v9 实战案例：hero-animation-v9-final.mp4（作者本地样本，未随仓库分发）
