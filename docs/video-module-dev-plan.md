# Mona Video 模块开发计划

> 基于 [改造方案](./video-module-redesign.md) 制定，覆盖 P1-P4 全部阶段。

## 总览

| 阶段 | 名称 | 核心交付 | 依赖 |
|---|---|---|---|
| P1 | 分镜审阅 | storyboard 解析 + 场景 CRUD + 分镜审阅 UI | 无 |
| P2 | 逐场景制作 | 单场景 HTML 生成 + 预览 + 状态机 | P1 |
| P3 | 导出 | Hyperframes render.py + MP4 导出 + 音轨 mux | P2 |
| P4 | 增强 | 风格预设 + 参考链接 + 缩略图 | P3 |

## P1：分镜审阅

### P1.1 后端：storyboard 解析与场景 CRUD

**目标**：把 storyboard.md 解析成结构化 JSON，支持场景增删改查。

**任务**：
- 新增 `mona/skills/mona-video/scripts/parse_storyboard.py`：解析 storyboard.md 返回 `[{index, title, duration, visual, animation, narration, assets}]` JSON
- 新增 `mona/skills/mona-video/scripts/write_storyboard.py`：把结构化 JSON 写回 storyboard.md
- `mona/api/server.py` 新增路由：
  - `GET /api/video/project/storyboard?name=` → 调 parse_storyboard.py
  - `PUT /api/video/project/scene` → 改 meta.json + 重写 storyboard.md
  - `DELETE /api/video/project/scene?name=&index=` → 同上
  - `POST /api/video/project/scene/add` → 同上
  - `POST /api/video/project/scene/reorder` → 同上
  - `POST /api/video/project/lock-storyboard` → 写 storyboard_lock.md + 更新 meta.phase
- meta.json 扩展：`phase`、`storyboardLocked`、`scenes` 数组、`targetDuration`、`stylePreset`、`audience`、`referenceUrl`
- `handle_video_project_create` 扩展接收新字段

**验收**：curl 能完成场景 CRUD，meta.json 与 storyboard.md 保持同步。

### P1.2 后端：单场景 TTS 试听

**目标**：分镜阶段用户可试听单场景旁白，无需等批量合成。

**任务**：
- `mona/api/server.py` 新增 `POST /api/video/project/scene/narration`：body `{name, index}`，读 storyboard 该场景 narration 文本，调 `mona.providers.tts` 合成到临时文件，返回 mp3 路径或直接流式返回 bytes
- 复用 `synthesize_narration.py` 的解析逻辑，但只处理单场景
- 前端通过 `<audio>` 标签播放

**验收**：分镜审阅界面点「试听旁白」能播放该场景的 TTS 音频。

### P1.3 前端：阶段路由与 Sidebar 改造

**目标**：把当前 config/history 双 tab 改为四阶段切换器。

**任务**：
- `VideoMakerView.tsx` 重构：引入 `phase` 状态（planning/storyboard/producing/export），根据 phase 渲染不同阶段组件
- 新增 `VideoSidebar.tsx`：顶部四阶段切换器（带 gate 逻辑）+ 中部场景列表（阶段 ②③ 显示）+ 底部历史项目折叠
- 阶段 gate：① 未完成不能进 ②；② 未确认不能进 ③；③ 未全部确认不能进 ④
- 现有配置面板（画面比例/帧率/质量/TTS）移入 `PlanningPhase.tsx`
- 新增 `VideoProject` 类型扩展：`phase`、`scenes`、`storyboardLocked`

**验收**：阶段切换正常，gate 生效，历史项目仍可打开。

### P1.4 前端：分镜审阅界面

**目标**：实现分镜卡片列表 + 详情编辑。

**任务**：
- 新增 `phases/StoryboardPhase.tsx`：主容器，左 SceneCardList + 右 SceneDetailEditor
- 新增 `scenes/SceneCardList.tsx`：场景卡片列表，支持选中/上移/下移/删除/新增
- 新增 `scenes/SceneDetailEditor.tsx`：选中场景的详情编辑（标题/时长滑块/画面描述/动画描述/旁白 Textarea）
- 新增「试听旁白」按钮：调 `/api/video/project/scene/narration`，用 `<audio>` 播放
- 新增「确认分镜」按钮：调 `/api/video/project/lock-storyboard`，成功后跳阶段 ③
- 接 `GET /api/video/project/storyboard` 加载场景列表
- 编辑后自动调 `PUT /api/video/project/scene` 保存

**验收**：可编辑/增删/重排场景，试听旁白，确认分镜后进入阶段 ③。

### P1.5 SKILL：分镜停止点

**目标**：AI 生成 storyboard 草稿后停止，不自动进入编码。

**任务**：
- `mona/skills/mona-video/SKILL.md` 修改 Step 4：明确 storyboard 草稿生成后**停止**，不写 storyboard_lock.md，告知用户在 UI 审阅
- `references/strategist.md` 补充：草稿生成后输出"分镜草稿已就绪，请在右侧审阅"提示
- `buildVideoPrompt()` 调整：去掉"开始生成"后直接写 HTML 的指令，改为"生成分镜草稿后停止等待用户审阅"

**验收**：AI 生成 storyboard 后停在阶段 ②，不自动写 HTML。

### P1.6 数据迁移与兼容

**目标**：现有项目（无 scenes 数组）打开时自动迁移。

**任务**：
- `GET /api/video/project?name=` 检测 meta.json 无 `scenes` 字段时，自动调 parse_storyboard.py 填充
- meta.json 无 `phase` 字段时，根据 `storyboardLocked` / `hasVideo` 推断阶段
- 现有 chatId 关联保留

**验收**：旧项目打开后能正常显示分镜列表。

### P1 验收总览

- [ ] AI 生成 storyboard 后停在阶段 ②，不自动进入编码
- [ ] 用户可编辑任意场景的标题/时长/画面/旁白
- [ ] 用户可增删/重排场景
- [ ] 用户可试听单场景旁白
- [ ] 「确认分镜」后 storyboard_lock.md 落盘，解锁阶段 ③
- [ ] 现有项目向后兼容

---

## P2：逐场景制作

### P2.1 后端：单场景 HTML 生成

**目标**：单场景 HTML 生成走独立 LLM 请求，不污染主会话。

**任务**：
- `mona/api/server.py` 新增 `POST /api/video/ai/scene-html`：body `{name, index}`，读 storyboard 该场景 + storyboard_lock 风格约束，调 LLM 生成 HTML，写入 `scenes/scene_NN.html`，更新 meta.json 该场景 htmlStatus
- 新增 `mona/skills/mona-video/references/scene-html.md`：单场景 HTML 生成的 prompt 模板（含 GSAP 约束、data-start/data-duration、风格一致性要求）
- LLM 调用复用现有 provider 机制，不走 DocumentAgentLoop
- 生成是同步阻塞的（单场景 HTML 几秒内完成），返回生成结果摘要

**验收**：单场景 HTML 文件生成，内容符合 storyboard 描述。

### P2.2 后端：单场景预览

**目标**：点左侧场景 → 右侧立即预览该场景 HTML。

**任务**：
- `mona/api/server.py` 新增 `GET /api/video/project/scene/preview?name=&index=`：返回该场景 HTML 内容，或返回 previewPort + scene 路径让 WebView2 加载
- 复用现有 previewPort 机制，单场景预览不占新端口
- 若场景 htmlStatus 为 pending，返回提示让前端触发生成

**验收**：点击场景卡片立即预览。

### P2.3 后端：场景状态机

**目标**：跟踪每个场景的 HTML 制作状态。

**任务**：
- meta.json 每个场景新增 `htmlStatus`：`pending | generating | previewing | confirmed`
- `POST /api/video/project/scene/confirm`：body `{name, index}`，标记 confirmed，更新 meta.json
- `POST /api/video/project/scene/regenerate`：body `{name, index}`，重置 htmlStatus 为 pending，触发 P2.1 重生成
- 全部场景 confirmed 后，更新 meta.phase 为 `exportable`

**验收**：场景状态正确流转，全部确认后解锁阶段 ④。

### P2.4 后端：单场景 TTS 重合成

**目标**：制作阶段可对单场景重新合成旁白。

**任务**：
- `POST /api/video/project/scene/narration` 扩展：支持 `regenerate=true` 参数，强制重新合成并覆盖 `audio/scene_NN.mp3`
- 复用 P1.2 的逻辑

**验收**：重新生成旁白后播放新版本。

### P2.5 前端：逐场景制作界面

**目标**：实现场景状态列表 + 单场景预览 + 迭代操作。

**任务**：
- 新增 `phases/ProducingPhase.tsx`：主容器，左 SceneStateList + 右 ScenePreview
- 新增 `scenes/SceneStateList.tsx`：带状态图标的场景列表（✓ 已确认 / ⟳ 预览中 / · 待制作），点击切换预览
- 新增 `scenes/ScenePreview.tsx`：WebView2 预览该场景 HTML + 状态信息 + 操作按钮
- 操作按钮：「查看 HTML」「试听旁白」「重新生成本场景」「确认通过」
- 新增 `dialogs/HtmlSourceDialog.tsx`：弹窗展示 HTML 源码（只读）
- 整体进度条：`confirmed / total`
- 全部确认后显示「进入导出」按钮

**验收**：可预览单场景、重新生成、确认通过、查看 HTML。

### P2.6 前端：单场景重写分镜（阶段 ② 增强）

**目标**：分镜审阅阶段支持 AI 重写单场景。

**任务**：
- `mona/api/server.py` 新增 `POST /api/video/ai/scene-rewrite`：body `{name, index, requirement}`，调 LLM 重写该场景分镜，返回新内容
- 新增 `mona/skills/mona-video/references/scene-rewrite.md`：单场景分镜重写 prompt 模板
- 新增 `dialogs/SceneRewriteDialog.tsx`：输入重写需求，调用 API，返回后更新场景详情
- SceneDetailEditor 增加「本场景重写」按钮

**验收**：AI 重写单场景分镜，其他场景不变。

### P2 验收总览

- [ ] 点左侧场景 → 右侧立即预览该场景 HTML
- [ ] 「重新生成本场景」只重做当前场景，其他不变
- [ ] 「确认通过」标记 ✓，全部确认后解锁阶段 ④
- [ ] 单场景旁白可试听、重合成
- [ ] 分镜审阅阶段支持 AI 重写单场景

---

## P3：导出

### P3.1 Hyperframes render.py 实现

**目标**：实现 headless Chromium 录屏 → MP4 的渲染管线。

**任务**：
- `mona/skills/mona-video/scripts/render.py` 完善：调用 headless Chromium 按 scene 顺序播放 HTML + GSAP，录屏为 MP4
- 支持分辨率/帧率参数
- 输出到 `renders/output.mp4`
- 错误处理：Chromium 未安装 / 场景 HTML 错误 / 录屏超时

**验收**：能生成完整 MP4 文件。

### P3.2 音轨 mux

**目标**：把 narration.mp3 混入最终 MP4。

**任务**：
- `render.py` 或 `postprocess.py` 新增音轨 mux 逻辑：检测 `audio/narration.mp3` 存在时，FFmpeg 合成
- 支持 BGM 混音（可选）
- 输出到 `output/video.mp4`

**验收**：导出的 MP4 包含旁白音轨。

### P3.3 前端：导出界面

**目标**：实现整片串预览 + 导出按钮。

**任务**：
- 新增 `phases/ExportPhase.tsx`：
  - 当前状态（Phase 3 完成前显示「场景已就绪，MP4 导出待 Phase 3」）
  - 整片串预览按钮：按场景顺序在 WebView2 连续播放
  - 导出 MP4 按钮（P3 完成后启用）
  - 下载 MP4 / 打开项目目录按钮
- 移除 SKILL.md 的 Phase 3 限制标注

**验收**：能预览整片、导出 MP4、下载。

### P3 验收总览

- [ ] render.py 能生成完整 MP4
- [ ] 导出的 MP4 包含旁白音轨
- [ ] 前端可触发导出、预览整片、下载 MP4

---

## P4：增强

### P4.1 风格预设生效

**目标**：风格预设（科技/教育/商务/文艺）实际影响 AI 生成。

**任务**：
- `references/strategist.md` 增加风格预设对应配色、字体、动效风格约束
- `references/scene-html.md` 同步风格约束
- `buildVideoPrompt()` 注入风格预设

**验收**：不同风格预设产生视觉差异。

### P4.2 参考链接抓取

**目标**：用户提供参考 URL，AI 抓取作为风格参考。

**任务**：
- `PlanningPhase.tsx` 参考链接输入框
- 后端抓取 URL 内容（走 validate_url_target）
- 注入 storyboard 生成 prompt

**验收**：参考链接影响生成结果。

### P4.3 分镜卡片缩略图

**目标**：场景卡片显示 HTML 缩略图。

**任务**：
- 场景 HTML 生成后用 WebView2 截图存为 `scenes/scene_NN.png`
- SceneCardList 显示缩略图

**验收**：场景列表有视觉缩略图。

### P4.4 整片串预览增强

**目标**：连续播放控制（暂停/跳转场景/进度条）。

**任务**：
- ExportPhase 整片串预览增加播放控制
- 场景切换指示器

**验收**：整片预览可交互控制。

---

## 执行顺序

```
P1.1 后端 storyboard 解析与场景 CRUD
  ↓
P1.2 后端 单场景 TTS 试听
  ↓
P1.3 前端 阶段路由与 Sidebar 改造
  ↓
P1.4 前端 分镜审阅界面
  ↓
P1.5 SKILL 分镜停止点
  ↓
P1.6 数据迁移与兼容
  ↓
P1 验收 → P2
  ↓
P2.1-P2.6 并行/串行
  ↓
P2 验收 → P3
  ↓
P3.1-P3.3
  ↓
P3 验收 → P4（可选）
```

## 约束遵守

- 不复制 mona-ppt 的 tts_backends（复用 mona/providers/tts.py）
- 路径校验走 `_resolve_path`
- 出站 HTTP 走 `validate_url_target`
- 配置走 Pydantic schema
- TTS 配置仍为项目级（meta.json），不污染 ChannelsConfig
- 单场景 AI 调用走独立 LLM 请求，不污染主会话
- 现有项目向后兼容

## 不做的事

- 不做视频编辑器（裁剪/拼接/字幕编辑）
- 不做实时协作
- 不做模板市场
- 不做 AI 自动配 BGM（P3 后再考虑）
