# PPT 制作功能产品设计方案

> **目标：** 在 Mona WebUI 侧边栏新增"PPT制作"入口，提供独立的产品化页面，用户选择模板/风格/上传源文件后，自动发起 agent 会话执行 PPT Master skill 生成 PPTX，页面内展示实时预览和下载。

---

## 1. 产品交互流程

### 1.1 完整用户旅程

```
用户点击侧边栏"PPT制作"
  → 进入 PPT 制作页面
  → 选择模板/风格（可视化卡片）
  → 上传源文件或输入主题
  → 点击"开始生成"
  → 页面自动创建 agent 会话（不出现在会话列表）
  → 页面内嵌聊天面板，显示 agent 执行进度
  → agent 自动启动 live-preview 服务
  → 页面内嵌 iframe 展示 SVG 预览
  → 生成完成，显示 PPTX 下载按钮
  → 用户可继续在聊天面板中修改（"改第3页标题"）
```

### 1.2 页面布局

```
┌─────────────────────────────────────────────────────────────┐
│  ← 返回    PPT 制作                              [设置]     │
├─────────────────────────┬───────────────────────────────────┤
│                         │                                   │
│   配置面板（左侧）       │   预览 + 聊天面板（右侧）          │
│                         │                                   │
│   ┌─────────────────┐   │   ┌───────────────────────────┐   │
│   │ 1. 选择模板      │   │   │                           │   │
│   │   [卡片网格]     │   │   │   SVG 实时预览            │   │
│   │                 │   │   │   (iframe localhost:5050)  │   │
│   │ 2. 画布格式     │   │   │                           │   │
│   │   [16:9] [4:3]  │   │   │                           │   │
│   │   [小红书] ...  │   │   └───────────────────────────┘   │
│   │                 │   │                                   │
│   │ 3. 风格偏好     │   │   ┌───────────────────────────┐   │
│   │   配色/图标/排版 │   │   │  聊天面板                  │   │
│   │                 │   │   │  agent: 正在分析源文档...    │   │
│   │ 4. 源文件       │   │   │  agent: 设计规范已确认      │   │
│   │   [拖拽上传]     │   │   │  user: 改第3页标题         │   │
│   │   或输入主题     │   │   │  [输入框]          [发送]   │   │
│   │                 │   │   └───────────────────────────┘   │
│   │ [开始生成]       │   │                                   │
│   └─────────────────┘   │   ┌───────────────────────────┐   │
│                         │   │ 📥 下载 PPTX              │   │
│   生成历史（底部）       │   └───────────────────────────┘   │
│   - 项目A  5/30 16:9    │                                   │
│   - 项目B  5/29 小红书  │                                   │
│                         │                                   │
└─────────────────────────┴───────────────────────────────────┘
```

---

## 2. 前端组件设计

### 2.1 新增文件

| 文件 | 职责 |
|------|------|
| `webui/src/components/ppt/PptMakerView.tsx` | PPT 制作主页面 |
| `webui/src/components/ppt/TemplateSelector.tsx` | 模板选择卡片组件 |
| `webui/src/components/ppt/StyleOptions.tsx` | 风格/画布选项组件 |
| `webui/src/components/ppt/SourceInput.tsx` | 源文件上传/主题输入组件 |
| `webui/src/components/ppt/PptPreview.tsx` | SVG 实时预览 iframe 组件 |
| `webui/src/components/ppt/PptChatPanel.tsx` | 内嵌聊天面板组件 |
| `webui/src/components/ppt/PptHistory.tsx` | 生成历史列表组件 |

### 2.2 修改文件

| 文件 | 修改内容 |
|------|----------|
| `webui/src/App.tsx` | ShellView 类型新增 "ppt"；新增 PptMakerView 懒加载和渲染 |
| `webui/src/components/Sidebar.tsx` | TOOLBOX_ITEMS 新增 "PPT制作"；新增 onOpenPpt 回调 |
| `webui/src/lib/api.ts` | 新增 PPT 相关 API 函数 |

### 2.3 PptMakerView 组件设计

```tsx
// PptMakerView.tsx — 主页面
interface PptMakerViewProps {
  onBack: () => void;
}

// 页面状态
type PptMakerPhase = "config" | "generating" | "preview";

function PptMakerView({ onBack }: PptMakerViewProps) {
  const [phase, setPhase] = useState<PptMakerPhase>("config");
  const [config, setConfig] = useState<PptConfig>({
    template: null,        // 选中的模板路径
    canvasFormat: "ppt169", // 画布格式
    stylePreference: "",    // 风格偏好描述
    sourceFiles: [],        // 上传的源文件路径
    topic: "",              // 主题（无源文件时）
  });
  const [chatId, setChatId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // 生成时：创建隐藏会话 → 发送 prompt → 监听进度
}
```

### 2.4 TemplateSelector 组件设计

模板选择卡片，展示 PPT Master 内置的所有模板：

**布局模板（7 套）**：
- academic_defense、ai_ops、government_blue、government_red、medical_university、pixel_retro、psychology_attachment

**品牌套件（7 套）**：
- 中国电信、中国电建_常规、中国电建_现代、中汽研_商务、中汽研_常规、中汽研_现代、招商银行、重庆大学

每张卡片显示：
- 模板封面 SVG 缩略图（读取 `01_cover.svg` 渲染）
- 模板名称
- 适用场景摘要（来自 `layouts_index.json` / `decks_index.json`）
- 主色标识

```tsx
interface TemplateCard {
  key: string;           // 如 "government_red" 或 "招商银行"
  kind: "layout" | "deck";
  name: string;          // 显示名称
  summary: string;       // 适用场景
  primaryColor: string;  // 主色
  coverSvgPath: string;  // 封面 SVG 路径
}
```

### 2.5 StyleOptions 组件设计

画布格式选择（来自 `canvas-formats.md`）：

| 格式 | viewBox | 适用场景 |
|------|---------|----------|
| PPT 16:9 | 1280×720 | 商务演示、会议 |
| PPT 4:3 | 1024×768 | 传统投影仪 |
| 小红书 | 1242×1660 | 图文分享 |
| 方形海报 | 1080×1080 | 朋友圈、品牌展示 |
| 竖屏故事 | 1080×1920 | 抖音封面 |

### 2.6 PptPreview 组件设计

嵌入 PPT Master 的 live-preview 服务：

```tsx
function PptPreview({ projectPath }: { projectPath: string }) {
  // agent 执行时会启动 svg_editor/server.py 在 localhost:5050
  // 前端通过 iframe 嵌入预览
  return (
    <iframe
      src="http://localhost:5050"
      className="h-full w-full border-0"
      title="PPT Preview"
    />
  );
}
```

**关键点**：
- live-preview 服务由 agent 在执行 Step 6 时自动启动（`--live` 模式）
- 前端只需在 iframe 中嵌入 `http://localhost:5050`
- 需要轮询检测服务是否已启动（首次加载前服务可能还未就绪）

### 2.7 PptChatPanel 组件设计

内嵌聊天面板，复用现有的 WebSocket 通信机制：

```tsx
function PptChatPanel({ chatId }: { chatId: string }) {
  // 复用 Mona 现有的 WebSocket 消息收发
  // 显示 agent 的执行进度消息
  // 允许用户输入修改指令
  // 不使用完整的 ThreadShell，而是精简版聊天界面
}
```

---

## 3. 会话隐藏机制

### 3.1 设计方案

参考现有功能模块（笔记、终端等）的模式，PPT 制作的会话**不出现在侧边栏会话列表**中。

**实现方式**：

1. **后端**：创建会话时添加 `internal: true` 标记
   - 在 `ChatSummary` 类型中新增 `internal?: boolean` 字段
   - 后端创建 PPT 会话时设置此标记

2. **前端**：`ChatList` 组件过滤掉 `internal: true` 的会话
   - 修改 `useSessions` hook 或 `ChatList` 组件的过滤逻辑

3. **替代方案（更轻量）**：不修改后端，前端通过 `activeKey` 管理状态
   - PPT 页面自己管理 chatId，不通过 `useSessions` 暴露
   - 类似笔记模块的 `onSendNoteToAgent` 模式——创建会话后跳转聊天
   - 但 PPT 页面不跳转，而是自己持有 chatId 并内嵌聊天

**推荐方案 3**（不修改后端），因为：
- 不需要修改 `ChatSummary` 类型和后端 API
- PPT 页面自己管理会话状态，与会话列表完全解耦
- 与笔记模块的 `onSendNoteToAgent` 模式一致

### 3.2 会话创建流程

```typescript
// PptMakerView 内部
const handleStartGeneration = async () => {
  // 1. 创建新会话（不设置 activeKey，不触发侧边栏显示）
  const chatId = await createChat();

  // 2. 构建 prompt
  const prompt = buildPptPrompt(config);

  // 3. 发送消息到会话
  await sendUserMessage(chatId, prompt);

  // 4. 切换到生成阶段
  setChatId(chatId);
  setPhase("generating");
};
```

---

## 4. 后端 API 设计

### 4.1 新增 API

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/ppt/templates` | GET | 获取可用模板列表（layouts + decks） |
| `/api/ppt/projects` | GET | 获取 PPT 项目列表（生成历史） |
| `/api/ppt/projects/:name` | GET | 获取项目详情（含导出文件路径） |
| `/api/ppt/upload` | POST | 上传源文件到 PPT 项目目录 |
| `/api/ppt/download/:name` | GET | 下载生成的 PPTX 文件 |

### 4.2 `/api/ppt/templates` 响应格式

```json
{
  "layouts": [
    {
      "key": "government_red",
      "name": "政务红",
      "summary": "Government briefings, policy interpretation...",
      "primaryColor": "#C00000",
      "coverSvgUrl": "/api/ppt/templates/government_red/cover.svg"
    }
  ],
  "decks": [
    {
      "key": "招商银行",
      "name": "招商银行",
      "summary": "交易银行产品介绍、销售收款方案汇报...",
      "primaryColor": "#C8152D",
      "coverSvgUrl": "/api/ppt/templates/招商银行/cover.svg"
    }
  ],
  "canvasFormats": [
    { "key": "ppt169", "label": "PPT 16:9", "description": "商务演示、会议" },
    { "key": "ppt43", "label": "PPT 4:3", "description": "传统投影仪" },
    { "key": "xhs", "label": "小红书", "description": "图文分享" }
  ]
}
```

### 4.3 后端实现位置

新增 `mona/channels/web/ppt_api.py`，在 Web channel 的路由中注册。

---

## 5. Prompt 构建逻辑

用户在配置面板选择后，前端自动构建一条结构化 prompt 发送给 agent：

```typescript
function buildPptPrompt(config: PptConfig): string {
  const parts: string[] = [];

  parts.push("请制作一份 PPT。");

  if (config.template) {
    parts.push(`使用模板：${config.template.kind === "deck" ? "品牌套件" : "布局模板"} ${config.template.key}（路径：${config.template.path}）`);
  }

  parts.push(`画布格式：${config.canvasFormat}`);

  if (config.stylePreference) {
    parts.push(`风格偏好：${config.stylePreference}`);
  }

  if (config.sourceFiles.length > 0) {
    parts.push(`源文件：${config.sourceFiles.join(", ")}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}（请先进行主题研究）`);
  }

  return parts.join("\n");
}
```

示例输出：
```
请制作一份 PPT。
使用模板：品牌套件 招商银行（路径：scripts/templates_full/decks/招商银行）
画布格式：ppt169
风格偏好：深色商务风
源文件：ppt-projects/my-project/sources/report.pdf
```

---

## 6. 实时预览集成

### 6.1 工作原理

PPT Master 的 live-preview 是一个 Flask 服务器（`svg_editor/server.py`），运行在 `localhost:5050`：
- 提供 SVG 页面浏览和注解编辑
- Agent 在 Step 6 自动以 `--live` 模式启动
- 支持双语 UI（中/英）

### 6.2 前端集成方式

```tsx
function PptPreview({ projectPath }: { projectPath: string }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // 轮询检测预览服务是否就绪
    const check = setInterval(async () => {
      try {
        const res = await fetch("http://localhost:5050", { mode: "no-cors" });
        setReady(true);
        clearInterval(check);
      } catch {
        // 服务未启动，继续轮询
      }
    }, 2000);
    return () => clearInterval(check);
  }, []);

  if (!ready) {
    return <div className="flex items-center justify-center text-muted-foreground">等待预览服务启动...</div>;
  }

  return (
    <iframe
      src="http://localhost:5050"
      className="h-full w-full border-0"
      title="PPT Preview"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}
```

### 6.3 注意事项

- **CORS**：Flask 服务器需要允许 iframe 嵌入（`X-Frame-Options` 头）
- **端口冲突**：如果 5050 被占用，agent 会使用 `--port <other>`，前端需要获取实际端口
- **Tauri 桌面端**：iframe 嵌入 localhost 在 Tauri webview 中可能需要额外配置

---

## 7. 下载功能

### 7.1 实现方式

PPTX 文件生成在 `<workspace>/ppt-projects/<name>/exports/` 目录下。

后端新增下载接口：
```python
# mona/channels/web/ppt_api.py
@router.get("/api/ppt/download/{project_name}")
async def download_pptx(project_name: str, request: Request):
    workspace = get_workspace(request)
    export_dir = Path(workspace) / "ppt-projects" / project_name / "exports"
    pptx_files = sorted(export_dir.glob("*.pptx"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not pptx_files:
        raise HTTPException(status_code=404, detail="No PPTX found")
    return FileResponse(pptx_files[0], media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation", filename=pptx_files[0].name)
```

前端下载按钮：
```tsx
<Button onClick={() => window.open(`/api/ppt/download/${projectName}?token=${token}`)}>
  📥 下载 PPTX
</Button>
```

---

## 8. 生成历史

### 8.1 数据来源

扫描 `<workspace>/ppt-projects/` 目录，每个子目录是一个项目：

```
ppt-projects/
├── my-report/
│   ├── sources/           # 源文件
│   ├── svg_output/        # SVG 页面
│   ├── svg_final/         # 后处理 SVG
│   └── exports/           # PPTX 导出
│       └── my_report_20260530.pptx
└── product-launch/
    └── ...
```

### 8.2 历史列表展示

```tsx
interface PptProject {
  name: string;
  createdAt: string;
  format: string;          // ppt169 / xhs / ...
  hasExport: boolean;      // 是否有 PPTX 导出
  exportPath?: string;     // PPTX 文件路径
}
```

---

## 9. 实施计划

### Phase 1：基础框架（1 天）

1. **ShellView 扩展**：新增 "ppt" 类型，PptMakerView 懒加载
2. **Sidebar 扩展**：新增 "PPT制作" 导航项 + `Presentation` 图标
3. **PptMakerView 骨架**：配置面板 + 预览/聊天面板布局

### Phase 2：配置面板（1 天）

4. **TemplateSelector**：读取模板索引，渲染卡片网格
5. **StyleOptions**：画布格式选择
6. **SourceInput**：文件上传 + 主题输入

### Phase 3：生成与预览（1 天）

7. **会话创建 + Prompt 构建**：创建隐藏会话，发送结构化 prompt
8. **PptChatPanel**：内嵌精简聊天面板
9. **PptPreview**：iframe 嵌入 live-preview

### Phase 4：下载与历史（0.5 天）

10. **后端下载 API**：`/api/ppt/download/:name`
11. **PptHistory**：项目列表 + 下载按钮
12. **后端模板 API**：`/api/ppt/templates`

---

## 10. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| iframe 嵌入 localhost:5050 的 CORS 问题 | 修改 `svg_editor/server.py` 添加 `X-Frame-Options: ALLOWALL` |
| Tauri webview 中 iframe 限制 | 配置 Tauri CSP 允许 localhost |
| live-preview 服务启动延迟 | 前端轮询检测 + 加载状态提示 |
| 端口 5050 被占用 | agent 会自动选择其他端口，前端需获取实际端口 |
| 大型 SVG 预览性能 | iframe 内的预览由 Flask 服务处理，前端无需额外优化 |
