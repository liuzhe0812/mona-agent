# Mona Video 模块改造方案

## 1. 背景与问题

### 1.1 当前形态

VideoMakerView = 配置面板 + DocChatPanel（聊天框）+ VideoPreview。用户填表单 → AI 在聊天框里跑完整 SKILL 流程 → 渲染 MP4。

### 1.2 核心问题

**界面没有创造增量价值**。AI 在聊天框里一次性完成「分镜 + 编码 + 渲染」，用户只在起点填表单、终点看结果。这与"SKILL + 对话框"无本质区别，单独做界面没有意义。

具体表现：
- **分镜黑盒**：AI 一次性生成 8 个场景，用户只能整体接受或推翻重来
- **迭代不可控**：用户说"第三场景不好"，AI 可能改全局
- **预览滞后**：必须全部渲染完才能看效果
- **进度不可见**：用户只能盯聊天滚动条
- **配音无试听**：TTS 整批合成，无法单句调整

### 1.3 独立界面的真正价值

界面应介入 AI 最易跑偏、用户最需掌控的环节：**分镜**和**逐场景迭代**。把"一锤子对话"改成"分阶段协作"，每阶段都有用户决策点。

## 2. 设计原则

1. **分阶段协作，非一锤子**：策划 → 分镜审阅 → 逐场景制作 → 导出，每阶段都有用户决策点
2. **关键步骤 UI 化**：分镜卡片、场景状态机、单场景预览，不让 AI 自由发挥
3. **单场景粒度操作**：重生 / 试听 / 编辑 / 删除都以单场景为单元
4. **AI 退居协作位**：从"全流程执行者"变为"分镜草稿生成器 + 单场景执行器"
5. **渐进式 Phase 3 兼容**：导出阶段标注未实现，不阻塞前三阶段

## 3. 目标交互架构

四阶段流程，左侧 Sidebar 顶部新增阶段切换器（替代当前的 config/history 双 tab）：

```
┌─ Sidebar ──────┬─ 主内容区 ───────────────────────────┐
│ [① 策划]       │                                       │
│ [② 分镜]       │           当前阶段内容                │
│ [③ 制作]       │                                       │
│ [④ 导出]       │                                       │
│                │                                       │
│ 历史项目列表   │                                       │
└────────────────┴───────────────────────────────────────┘
```

阶段间有 gate：① 未完成不能进 ②；② 未确认分镜不能进 ③；③ 未全部确认不能进 ④。

## 4. 各阶段详解

### 阶段 ① 策划（现有 Config 面板增强）

**保留**：主题、画面比例、帧率、质量、TTS 配置（已实现）

**新增**：
- 目标时长：滑块 30s ~ 5min（影响 AI 推荐的场景数和时长分配）
- 风格预设：科技 / 教育 / 商务 / 文艺（影响配色、动效风格、字体）
- 参考链接：可选 URL（AI 抓取后作为风格参考）
- 受众：可选（影响文案口吻）

**交互**：填完点「开始策划」→ 创建项目 + 发起 AI 对话生成 storyboard 草稿 → 完成后自动跳到阶段 ②。

**AI 任务边界**：只生成分镜草稿，不写 HTML，不渲染。

### 阶段 ② 分镜审阅（核心新增）⭐

AI 生成 storyboard 后**停在 这里**让用户审阅，不进入编码。

**布局**：左侧分镜卡片列表 + 右侧选中场景详情编辑

```
┌─ 主内容区 ─────────────────────────────────────────────┐
│  场景 3 / 共 8 场                    [整体重排] [确认]  │
│  ┌─────────────────────────────────────────────────┐  │
│  │ 标题: 产品演示                                   │  │
│  │ 时长: [5s] ━━●━━━━━━                            │  │
│  │ 画面: 渐入 logo + 粒子动效                       │  │
│  │ ┌─────────────────────────────────────────────┐ │  │
│  │ │ 旁白文本（可编辑 Textarea）                  │ │  │
│  │ │ "接下来展示核心功能..."                      │ │  │
│  │ └─────────────────────────────────────────────┘ │  │
│  │ [试听旁白] [本场景重写...] [删除]                │  │
│  └─────────────────────────────────────────────────┘  │
│  [+ 新增场景]  [上移][下移]                            │
│  ─────────────────────────────────                    │
│  [确认分镜，进入制作 →]                                │
└────────────────────────────────────────────────────────┘
```

左侧 Sidebar 显示场景列表（替代当前的历史列表，历史项目折叠到底部）：
```
① 策划  ✓
② 分镜  ●  ← 当前
③ 制作
④ 导出
─────────
场景列表:
● 1 开场        5s
● 2 痛点        4s
● 3 产品演示    5s  ← 选中
● 4 功能1       6s
● 5 功能2       6s
● 6 客户案例    8s
● 7 价值总结    5s
● 8 CTA         3s
─────────
历史项目 ▾
```

**用户操作**：
- 选中场景 → 右侧编辑详情（标题/时长/画面/旁白）
- 上移/下移 → 重排场景顺序
- 「本场景重写」→ 弹小框输入需求，AI 只重写这一场景的分镜
- 「试听旁白」→ 用当前 TTS 配置合成这一句播放
- 「新增场景」→ 在末尾追加空场景
- 「删除场景」→ 移除（至少保留 1 个）
- 「确认分镜」→ storyboard_lock.md 落盘，解锁阶段 ③

**AI 任务边界**：只做单场景分镜重写，不写 HTML。

### 阶段 ③ 逐场景制作（核心改造）⭐

左侧场景状态列表 + 右侧当前场景预览。

```
┌─ 主内容区 ─────────────────────────────────────────────┐
│  场景 3: 产品演示            [WebView2 预览]            │
│  ┌─────────────────────────────────────────────────┐  │
│  │                                                 │  │
│  │         [HTML 预览渲染中...]                     │  │
│  │                                                 │  │
│  └─────────────────────────────────────────────────┘  │
│  状态: 已预览 · 时长 5.2s/5s                           │
│  ─────────────────────────────────                    │
│  [查看 HTML] [试听旁白] [重新生成本场景] [确认通过]    │
│  ─────────────────────────────────                    │
│  整体进度: ▓▓▓░░░░░ 3/8                               │
│  [全部确认后进入导出 →]                                │
└────────────────────────────────────────────────────────┘
```

Sidebar 场景列表带状态：
```
③ 制作  ●  ← 当前
─────────
✓ 1 开场        已确认
✓ 2 痛点        已确认
⟳ 3 产品演示    预览中  ← 选中
· 4 功能1       待制作
· 5 功能2       待制作
· 6 客户案例    待制作
· 7 价值总结    待制作
· 8 CTA         待制作
─────────
[全部确认 → 导出]
```

**场景状态机**：
```
pending → generating → previewing → confirmed
                ↑           │
                └───────────┘
                  (重新生成)
```

**关键能力**：
- 点左侧场景 → 右侧立即预览该场景 HTML（不等全部渲染）
- 「重新生成本场景」→ AI 只重做这一个，其他状态不变
- 「确认通过」→ 标记 ✓，全部 confirmed 后解锁导出
- 「试听旁白」→ 单场景 TTS 合成播放
- 「查看 HTML」→ 弹窗展示 HTML 源码（只读）

**AI 任务边界**：一次只处理一个场景，用户触发才执行。

### 阶段 ④ 导出（Phase 3）

**当前状态**（Phase 3 未完成）：
- 显示「场景已就绪，MP4 自动导出待 Phase 3」
- 提供「整片串预览」按钮：按场景顺序在 WebView2 里连续播放（无 MP4）
- 提供「手动录屏指引」文案

**Phase 3 完成后**：
- 整片串预览
- 导出 MP4 按钮（调 render.py）
- 含音轨导出（mux narration.mp3）
- 下载 MP4 / 打开项目目录

## 5. 数据模型

### 5.1 meta.json 扩展

```json
{
  "name": "video-xxx",
  "resolution": "1920x1080@30fps",
  "fps": 30,
  "quality": "standard",
  "aspectRatio": "16:9",
  "targetDuration": 60,
  "stylePreset": "tech",
  "audience": "",
  "referenceUrl": "",

  "narrationEnabled": true,
  "ttsProvider": "edge",
  "ttsVoice": "zh-CN-XiaoyiNeural",
  "ttsRate": "+0%",

  "phase": "storyboard",
  "storyboardLocked": false,
  "scenes": [
    {
      "index": 1,
      "title": "开场",
      "duration": 5,
      "visual": "渐入 logo + 粒子动效",
      "animation": "GSAP timeline: logo scale 0→1, particles fade",
      "narration": "欢迎来到...",
      "assets": [],
      "htmlStatus": "pending",
      "htmlPath": "scenes/scene_01.html",
      "narrationPath": "audio/scene_01.mp3",
      "confirmedAt": null
    }
  ]
}
```

### 5.2 阶段流转

```
planning → storyboard → producing → exportable
   │          │              │
   └──────────┴──────────────┘
      用户可回退到任意前一阶段
```

回退规则：从 ③ 回到 ② 会清除所有 htmlStatus（HTML 作废）；从 ② 回到 ① 会清除 scenes 数组。

## 6. API 设计

### 6.1 现有 API（保留）

- `POST /api/video/project/create` — 创建项目（扩展字段）
- `GET /api/video/projects` — 列表
- `GET /api/video/project?name=` — 详情
- `POST /api/video/project/save-chat-id` — 关联会话
- `GET /api/video/delete-project?name=` — 删除
- `GET /api/video/download?name=` — 下载 MP4
- `GET /api/video/project-file?name=&path=` — 读文件

### 6.2 新增 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/video/project/storyboard?name=` | 读 storyboard.md 解析成结构化 JSON |
| PUT | `/api/video/project/scene` | 编辑场景（标题/时长/画面/旁白） |
| POST | `/api/video/project/scene/regenerate` | AI 重写指定场景分镜（body: name, index, requirement） |
| DELETE | `/api/video/project/scene?name=&index=` | 删除场景 |
| POST | `/api/video/project/scene/reorder` | 重排顺序（body: name, indices[]） |
| POST | `/api/video/project/scene/add` | 新增空场景 |
| POST | `/api/video/project/scene/render` | 单场景 HTML 渲染（body: name, index） |
| POST | `/api/video/project/scene/narration` | 单场景 TTS 合成（body: name, index） → 返回 mp3 bytes 或路径 |
| POST | `/api/video/project/lock-storyboard` | 锁定分镜，进入制作阶段 |
| POST | `/api/video/project/scene/confirm` | 确认单场景通过（body: name, index） |
| GET | `/api/video/project/scene/preview?name=&index=` | 单场景预览（返回 HTML 或 previewPort） |

### 6.3 单场景 AI 调用模式

单场景重写 / 单场景 HTML 生成 不走主聊天会话，走独立的轻量 LLM 调用（避免污染主对话上下文）。后端新增 `/api/video/ai/scene-rewrite` 和 `/api/video/ai/scene-html`，直接调 provider 生成，结果写入 meta.json + 文件。

## 7. 前端组件结构

```
webui/src/components/doc/video/
├── VideoMakerView.tsx          # 主容器，阶段路由
├── VideoSidebar.tsx            # 阶段切换 + 场景列表 + 历史项目
├── VideoPreview.tsx            # 预览组件（保留）
├── VideoRuntimeDialog.tsx      # 依赖安装（保留）
├── phases/
│   ├── PlanningPhase.tsx       # 阶段①：策划面板（现 Config 面板增强）
│   ├── StoryboardPhase.tsx     # 阶段②：分镜审阅 ⭐
│   ├── ProducingPhase.tsx      # 阶段③：逐场景制作 ⭐
│   └── ExportPhase.tsx         # 阶段④：导出
├── scenes/
│   ├── SceneCardList.tsx       # 左侧场景卡片列表
│   ├── SceneDetailEditor.tsx   # 阶段② 右侧详情编辑
│   ├── ScenePreview.tsx        # 阶段③ 右侧 HTML 预览
│   └── SceneStateList.tsx      # 阶段③ 左侧带状态的场景列表
└── dialogs/
    ├── SceneRewriteDialog.tsx  # 单场景重写需求输入
    └── HtmlSourceDialog.tsx    # 查看 HTML 源码
```

## 8. SKILL 改造

### 8.1 mona-video SKILL.md 调整

当前 SKILL 是"全流程执行者"，改为"分阶段协作"：

- **Step 1-4 保留**：source intake → project setup → analysis → storyboard 草稿生成
- **Step 4.5 新增**：storyboard 草稿生成后**停止**，等待用户在 UI 审阅。不主动写 storyboard_lock.md，由 UI 的「确认分镜」触发
- **Step 5 改造**：从"for each scene 写 HTML"改为"单场景 HTML 生成"，由 UI 单场景触发调用
- **Step 6-7 标注 Phase 3**：不在 SKILL 里执行，由 UI 触发或待 Phase 3

### 8.2 新增 SKILL：单场景 HTML 生成

`references/scene-html.md`：定义单场景 HTML 生成的 prompt 模板和约束，供 `/api/video/ai/scene-html` 调用。

### 8.3 新增 SKILL：单场景分镜重写

`references/scene-rewrite.md`：定义单场景分镜重写的 prompt 模板，输入当前场景内容 + 用户需求，输出新场景内容。

## 9. 实施分期

### P1：分镜审阅（阶段 ②）⭐ 先做

**价值**：把 AI 最易跑偏的分镜环节交还用户，一步就能让模块价值翻倍。

**范围**：
- 后端：storyboard 解析 + 场景 CRUD + 锁定接口
- 前端：StoryboardPhase + SceneCardList + SceneDetailEditor
- SKILL：Step 4.5 停止点 + storyboard 草稿生成约束
- 数据：meta.json 扩展 scenes 数组 + phase 字段

**不含**：单场景 AI 重写（P2 做）、单场景 HTML 生成（P2 做）

**验收标准**：
- AI 生成 storyboard 后停在阶段 ②，不自动进入编码
- 用户可编辑任意场景的标题/时长/画面/旁白
- 用户可增删/重排场景
- 用户可试听单场景旁白
- 「确认分镜」后 storyboard_lock.md 落盘，解锁阶段 ③

### P2：逐场景制作（阶段 ③）

**价值**：把"一锤子"改成"逐场景迭代"，彻底改变模块性质。

**范围**：
- 后端：单场景 HTML 生成 + 单场景预览 + 状态机 + 确认接口
- 前端：ProducingPhase + ScenePreview + SceneStateList
- SKILL：scene-html.md + scene-rewrite.md
- AI：单场景调用走独立 LLM 请求，不污染主会话

**不含**：MP4 导出（Phase 3）

**验收标准**：
- 点左侧场景 → 右侧立即预览该场景 HTML
- 「重新生成本场景」只重做当前场景，其他不变
- 「确认通过」标记 ✓，全部确认后解锁阶段 ④
- 单场景旁白可试听、重合成

### P3：导出（Phase 3 原计划）

**范围**：
- Hyperframes render.py 实现
- 整片串预览
- MP4 导出 + 音轨 mux
- 下载 MP4 / 打开项目目录

### P4：增强（可选）

- 风格预设的实际生效（影响 AI prompt）
- 参考链接抓取
- 整片串预览的连续播放控制
- 分镜卡片缩略图（用 WebView2 截图）

## 10. 风险与约束

### 10.1 兼容性

- 现有项目（无 scenes 数组）打开时自动迁移：从 storyboard.md 解析填充
- 现有 chatId 关联保留：阶段 ② 的 storyboard 草稿生成仍走主会话
- meta.json schema 向后兼容：新字段可选

### 10.2 性能

- 单场景预览用现有 previewPort 机制，无需新端口
- 单场景 HTML 生成走独立 LLM 请求，避免主会话膨胀
- storyboard 解析在后端做，前端拿结构化 JSON

### 10.3 约束遵守

- 不复制 mona-ppt 的 tts_backends（复用 mona/providers/tts.py）
- 路径校验走 _resolve_path
- 出站 HTTP 走 validate_url_target
- 配置走 Pydantic schema（如新增全局配置）
- TTS 配置仍为项目级（meta.json），不污染 ChannelsConfig

### 10.4 不做的事

- 不做视频编辑器（裁剪/拼接/字幕编辑）——这不是模块定位
- 不做实时协作（多人同时编辑）——桌面应用单人场景
- 不做模板市场——超出当前范围
- 不做 AI 自动配 BGM——Phase 3 后再考虑

## 11. 决策记录

- **为何分阶段而非全流程 UI**：全流程 UI 等于重写一个视频编辑器，超出模块定位；分阶段只在关键节点介入，平衡 AI 效率和用户掌控
- **为何单场景 AI 调用走独立请求**：避免主会话上下文膨胀（8 场景 HTML 会撑爆 token），且单场景重生不应影响其他场景
- **为何 P1 不含单场景 AI 重写**：P1 先验证分镜审阅的核心价值（编辑/增删/重排），AI 重写是锦上添花，放 P2 一起做
- **为何保留主会话生成 storyboard 草稿**：storyboard 需要全局视角（场景数/时长分配/叙事节奏），主会话有上下文；单场景重写才走独立请求
- **为何阶段 ② 不直接展示 HTML 预览**：分镜阶段还没写 HTML，预览是阶段 ③ 的事；阶段 ② 只看文字描述
