# PPT 制作功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Mona WebUI 侧边栏新增"PPT制作"入口，提供独立的产品化页面，用户选择模板/风格/上传源文件后，自动发起 ephemeral agent 会话执行 PPT Master skill 生成 PPTX，页面内展示实时 SVG 预览和下载。

**Architecture:** 前端新增 PptMakerView 独立页面（ShellView="ppt"），内含配置面板、iframe 预览、内嵌聊天面板（复用 useMonaStream + ephemeral 会话）。后端在 websocket.py 中新增 6 个 REST API 提供模板列表、SVG 缩略图、项目列表、下载、上传、预览端口查询。

**Tech Stack:** React + TypeScript（前端），Python + aiohttp（后端 REST），Flask（ppt-master live-preview），WebSocket（ephemeral 会话）

---

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `webui/src/components/ppt/PptMakerView.tsx` | PPT 制作主页面，管理 phase/config/chatId/preview 状态 |
| `webui/src/components/ppt/PptConfigPanel.tsx` | 左侧配置面板：模板选择 + 画布格式 + 源文件输入 |
| `webui/src/components/ppt/PptPreview.tsx` | SVG 实时预览（iframe 嵌入 live-preview） |
| `webui/src/components/ppt/PptChatPanel.tsx` | 内嵌聊天面板（复用 useMonaStream + useSessionHistory） |
| `webui/src/components/ppt/PptHistory.tsx` | 生成历史列表 |

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `webui/src/App.tsx` | ShellView 扩展 "ppt"；PptMakerView 懒加载；onOpenPpt 回调；渲染 PptMakerView |
| `webui/src/components/Sidebar.tsx` | TOOLBOX_ITEMS 新增 "PPT制作"；Presentation 图标；onOpenPpt prop |
| `webui/src/lib/api.ts` | 新增 fetchPptTemplates / fetchPptProjects / fetchPptPreviewPort |
| `mona/channels/websocket.py` | 新增 6 个 /api/ppt/* handler |

---

## Task 1: Sidebar 新增 PPT制作 导航项

**Files:**
- Modify: `webui/src/components/Sidebar.tsx`

- [ ] **Step 1: 添加 Presentation 图标导入和 TOOLBOX_ITEMS 条目**

在 `Sidebar.tsx` 中：
1. 在 lucide-react import 中添加 `Presentation`
2. 在 `TOOLBOX_ITEMS` 数组的 "笔记" 后面插入 `{ label: "PPT制作", icon: <Presentation className="h-4 w-4" /> }`

- [ ] **Step 2: 添加 onOpenPpt prop 到 SidebarProps**

在 `SidebarProps` interface 中添加 `onOpenPpt?: () => void;`

- [ ] **Step 3: 传递 onOpenPpt 到 ToolboxNavigation**

在 `Sidebar` 组件中，将 `onOpenPpt={props.onOpenPpt ?? (() => {})}` 传给 `ToolboxNavigation`。

在 `ToolboxNavigation` 的 props 中添加 `onOpenPpt: () => void;`。

在 `ToolboxNavigation` 的 onClick 映射中添加：
```tsx
const onClick = item.label === "笔记"
    ? onOpenNote
  : item.label === "PPT制作"
    ? onOpenPpt
  : item.label === "终端"
    ? onOpenSSH
  : item.label === "数据库"
    ? onOpenDb
  : item.label === "知识库"
    ? onOpenKb
  : onGoHome;
```

- [ ] **Step 4: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 可能有 PptMakerView 相关的未定义错误（因为还没创建），但 Sidebar 本身不应有类型错误

---

## Task 2: App.tsx 扩展 ShellView 和 PptMakerView 懒加载

**Files:**
- Modify: `webui/src/App.tsx`

- [ ] **Step 1: 扩展 ShellView 类型**

将 `type ShellView = "chat" | "settings" | "note" | "ssh" | "db" | "kb";` 改为：
```tsx
type ShellView = "chat" | "settings" | "note" | "ssh" | "db" | "kb" | "ppt";
```

- [ ] **Step 2: 添加 PptMakerView 懒加载**

在 `KnowledgeBaseView` 懒加载之后添加：
```tsx
const PptMakerView = lazy(() =>
  import("@/components/ppt/PptMakerView").then((module) => ({
    default: module.PptMakerView,
  })),
);
```

- [ ] **Step 3: 添加 onOpenPpt 回调**

在 `Shell` 组件中，`onOpenKb` 回调之后添加：
```tsx
const onOpenPpt = useCallback(() => {
  setView("ppt");
  setMobileSidebarOpen(false);
}, []);
```

- [ ] **Step 4: 传递 onOpenPpt 到 sidebarProps**

在 `sidebarProps` 对象中添加 `onOpenPpt,`。

- [ ] **Step 5: 更新 ThreadShell 隐藏条件**

将 ThreadShell 容器的 `invisible pointer-events-none` 条件中添加 `view === "ppt"`：
```tsx
(view === "settings" || view === "note" || view === "ssh" || view === "db" || view === "kb" || view === "ppt")
```

- [ ] **Step 6: 添加 PptMakerView 渲染**

在 `KnowledgeBaseView` 渲染之后添加：
```tsx
{view === "ppt" && (
  <div className="absolute inset-0 flex flex-col">
    <Suspense fallback={<ModuleLoading title="正在打开 PPT 制作" />}>
      <PptMakerView onBack={onBackToChat} />
    </Suspense>
  </div>
)}
```

- [ ] **Step 7: 验证编译**

此时会报 PptMakerView 模块不存在的错误，这是预期的。先跳过，等 Task 3 创建后验证。

---

## Task 3: 创建 PptMakerView 骨架

**Files:**
- Create: `webui/src/components/ppt/PptMakerView.tsx`

- [ ] **Step 1: 创建 PptMakerView 组件**

创建 `webui/src/components/ppt/PptMakerView.tsx`，包含：
- 三阶段状态管理（config / generating / done）
- 左右布局骨架
- onBack 回调
- 基础的页面头部

```tsx
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import { cn } from "@/lib/utils";

type PptPhase = "config" | "generating" | "done";

interface PptConfig {
  templateKey: string | null;
  templateKind: "layout" | "deck" | null;
  canvasFormat: string;
  stylePreference: string;
  sourceFiles: string[];
  topic: string;
}

const DEFAULT_CONFIG: PptConfig = {
  templateKey: null,
  templateKind: null,
  canvasFormat: "ppt169",
  stylePreference: "",
  sourceFiles: [],
  topic: "",
};

interface PptMakerViewProps {
  onBack: () => void;
}

export function PptMakerView({ onBack }: PptMakerViewProps) {
  const { client } = useClient();
  const [phase, setPhase] = useState<PptPhase>("config");
  const [config, setConfig] = useState<PptConfig>(DEFAULT_CONFIG);
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (chatId) {
        client.deleteChat(chatId);
      }
    };
  }, []);

  const handleStartGeneration = useCallback(async () => {
    try {
      const newChatId = await client.newChat(5_000, true);
      setChatId(newChatId);
      const prompt = buildPptPrompt(config);
      client.sendMessage(newChatId, prompt);
      setPhase("generating");
    } catch (e) {
      console.error("Failed to start PPT generation", e);
    }
  }, [client, config]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 rounded-lg">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-[14px] font-semibold">PPT 制作</h1>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground">
          <Settings className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border/70">
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <p className="text-[12px] text-muted-foreground">
              {phase === "config" && "选择模板和输入主题后开始生成"}
              {phase === "generating" && "正在生成 PPT..."}
              {phase === "done" && "PPT 已生成完成"}
            </p>
          </div>
          {phase === "config" && (
            <div className="shrink-0 border-t border-border/70 p-3">
              <Button
                className="w-full"
                disabled={!config.topic && config.sourceFiles.length === 0}
                onClick={handleStartGeneration}
              >
                开始生成
              </Button>
            </div>
          )}
        </aside>

        <div className="flex min-h-0 flex-1 flex-col">
          {phase === "config" ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              选择模板和输入主题后开始生成
            </div>
          ) : phase === "genering" ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在生成 PPT...
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              PPT 已生成完成
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildPptPrompt(config: PptConfig): string {
  const parts: string[] = [];
  parts.push("请制作一份 PPT。");
  if (config.templateKey && config.templateKind) {
    const kindLabel = config.templateKind === "deck" ? "品牌套件" : "布局模板";
    const subdir = config.templateKind === "deck" ? "decks" : "layouts";
    parts.push(`使用模板：${kindLabel} ${config.templateKey}（路径：scripts/templates_full/${subdir}/${config.templateKey}）`);
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

- [ ] **Step 2: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误（PptMakerView 已创建）

- [ ] **Step 3: 修复 typo**

在 PptMakerView.tsx 中，`phase === "genering"` 应为 `phase === "generating"`。修复此 typo。

- [ ] **Step 4: 验证开发服务器**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npm run dev`
Expected: 编译成功，可以在浏览器中看到侧边栏新增的"PPT制作"入口，点击后进入 PPT 制作页面骨架

---

## Task 4: 后端 PPT API — 模板和 SVG

**Files:**
- Modify: `mona/channels/websocket.py`

- [ ] **Step 1: 在 HTTP handler 路由中添加 PPT API 路由**

在 `websocket.py` 的 `_handle_http_request` 方法中，在 KB API 路由之后添加：
```python
        if got == "/api/ppt/templates":
            return self._handle_ppt_templates(request)

        if got == "/api/ppt/template-svg":
            return self._handle_ppt_template_svg(request)

        if got == "/api/ppt/projects":
            return self._handle_ppt_projects(request)

        if got == "/api/ppt/download":
            return self._handle_ppt_download(request)

        if got == "/api/ppt/preview-port":
            return self._handle_ppt_preview_port(request)
```

- [ ] **Step 2: 实现 _handle_ppt_templates**

在 `WsChannel` 类中添加方法：
```python
    def _handle_ppt_templates(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path
            from mona.agent.skills import BUILTIN_SKILLS_DIR

            skill_dir = BUILTIN_SKILLS_DIR / "ppt-master"
            layouts_index = skill_dir / "scripts" / "templates_full" / "layouts" / "layouts_index.json"
            decks_index = skill_dir / "scripts" / "templates_full" / "decks" / "decks_index.json"

            layouts = []
            if layouts_index.exists():
                raw = json.loads(layouts_index.read_text(encoding="utf-8"))
                for key, info in raw.items():
                    layouts.append({
                        "key": key,
                        "kind": "layout",
                        "name": key.replace("_", " ").title(),
                        "summary": info.get("summary", ""),
                        "pageCount": info.get("page_count", 0),
                        "canvasFormat": info.get("canvas_format", "ppt169"),
                        "coverSvgUrl": f"/api/ppt/template-svg?kind=layout&key={key}&file=01_cover.svg",
                    })

            decks = []
            if decks_index.exists():
                raw = json.loads(decks_index.read_text(encoding="utf-8"))
                for key, info in raw.items():
                    decks.append({
                        "key": key,
                        "kind": "deck",
                        "name": key,
                        "summary": info.get("summary", ""),
                        "pageCount": info.get("page_count", 0),
                        "canvasFormat": info.get("canvas_format", "ppt169"),
                        "primaryColor": info.get("primary_color", ""),
                        "coverSvgUrl": f"/api/ppt/template-svg?kind=deck&key={key}&file=01_cover.svg",
                    })

            canvas_formats = [
                {"key": "ppt169", "label": "PPT 16:9", "viewBox": "1280x720", "desc": "商务演示"},
                {"key": "ppt43", "label": "PPT 4:3", "viewBox": "1024x768", "desc": "传统投影"},
                {"key": "xhs", "label": "小红书", "viewBox": "1242x1660", "desc": "图文分享"},
                {"key": "square", "label": "方形海报", "viewBox": "1080x1080", "desc": "朋友圈"},
                {"key": "story", "label": "竖屏故事", "viewBox": "1080x1920", "desc": "抖音封面"},
            ]

            return _http_json_response({
                "layouts": layouts,
                "decks": decks,
                "canvasFormats": canvas_formats,
            })
        except Exception as e:
            logger.exception("ppt templates error")
            return _http_error(500, str(e))
```

- [ ] **Step 3: 实现 _handle_ppt_template_svg**

```python
    def _handle_ppt_template_svg(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.agent.skills import BUILTIN_SKILLS_DIR

            query = _parse_query(request.path)
            kind = _query_first(query, "kind") or ""
            key = _query_first(query, "key") or ""
            file = _query_first(query, "file") or "01_cover.svg"

            if "/" in key or "\\" in key or ".." in key:
                return _http_error(400, "invalid key")
            if "/" in file or "\\" in file or ".." in file:
                return _http_error(400, "invalid file")

            skill_dir = BUILTIN_SKILLS_DIR / "ppt-master"
            subdir = "layouts" if kind == "layout" else "decks"
            svg_path = skill_dir / "scripts" / "templates_full" / subdir / key / file

            if not svg_path.exists():
                return _http_error(404, "svg not found")

            content = svg_path.read_bytes()
            return _http_response(
                content,
                content_type="image/svg+xml",
                extra_headers=[("Cache-Control", "public, max-age=3600")],
            )
        except Exception as e:
            logger.exception("ppt template svg error")
            return _http_error(500, str(e))
```

- [ ] **Step 4: 实现 _handle_ppt_projects**

```python
    def _handle_ppt_projects(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            workspace = get_workspace_path()
            projects_dir = workspace / "ppt-projects"
            if not projects_dir.exists():
                return _http_json_response({"projects": []})

            projects = []
            for d in sorted(projects_dir.iterdir()):
                if not d.is_dir():
                    continue
                svg_dir = d / "svg_output"
                export_dir = d / "exports"
                slide_count = len(list(svg_dir.glob("*.svg"))) if svg_dir.exists() else 0
                pptx_files = sorted(export_dir.glob("*.pptx"), key=lambda p: p.stat().st_mtime, reverse=True) if export_dir.exists() else []
                stat = d.stat()
                projects.append({
                    "name": d.name,
                    "createdAt": stat.st_ctime,
                    "format": "ppt169",
                    "slideCount": slide_count,
                    "hasExport": len(pptx_files) > 0,
                })

            return _http_json_response({"projects": projects})
        except Exception as e:
            logger.exception("ppt projects error")
            return _http_error(500, str(e))
```

- [ ] **Step 5: 实现 _handle_ppt_download**

```python
    def _handle_ppt_download(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if not project_name or "/" in project_name or "\\" in project_name or ".." in project_name:
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            export_dir = workspace / "ppt-projects" / project_name / "exports"
            if not export_dir.exists():
                return _http_error(404, "exports not found")

            pptx_files = sorted(export_dir.glob("*.pptx"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not pptx_files:
                return _http_error(404, "no pptx found")

            content = pptx_files[0].read_bytes()
            filename = pptx_files[0].name
            return _http_response(
                content,
                content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                extra_headers=[
                    ("Content-Disposition", f'attachment; filename="{filename}"'),
                    ("Cache-Control", "no-cache"),
                ],
            )
        except Exception as e:
            logger.exception("ppt download error")
            return _http_error(500, str(e))
```

- [ ] **Step 6: 实现 _handle_ppt_preview_port**

```python
    def _handle_ppt_preview_port(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if not project_name or "/" in project_name or "\\" in project_name or ".." in project_name:
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            lock_file = workspace / "ppt-projects" / project_name / ".live_preview.lock"

            if not lock_file.exists():
                return _http_json_response({"port": None})

            data = json.loads(lock_file.read_text(encoding="utf-8"))
            port = data.get("port")
            return _http_json_response({"port": port})
        except Exception as e:
            logger.exception("ppt preview port error")
            return _http_json_response({"port": None})
```

- [ ] **Step 7: 验证后端启动**

Run: `cd d:\liuzhe\Desktop\code\Mona && python -c "from mona.channels.websocket import WsChannel; print('OK')"`
Expected: OK（无 import 错误）

---

## Task 5: 前端 API 函数

**Files:**
- Modify: `webui/src/lib/api.ts`

- [ ] **Step 1: 添加 PPT 相关类型和 API 函数**

在 `api.ts` 文件末尾添加：

```typescript
export interface PptTemplate {
  key: string;
  kind: "layout" | "deck";
  name: string;
  summary: string;
  pageCount: number;
  canvasFormat: string;
  primaryColor?: string;
  coverSvgUrl: string;
}

export interface PptCanvasFormat {
  key: string;
  label: string;
  viewBox: string;
  desc: string;
}

export interface PptTemplatesResponse {
  layouts: PptTemplate[];
  decks: PptTemplate[];
  canvasFormats: PptCanvasFormat[];
}

export interface PptProject {
  name: string;
  createdAt: number;
  format: string;
  slideCount: number;
  hasExport: boolean;
}

export async function fetchPptTemplates(
  token: string,
  base?: string,
): Promise<PptTemplatesResponse> {
  const effectiveBase = base ?? (await getApiBase());
  return request<PptTemplatesResponse>(`${effectiveBase}/api/ppt/templates`, token);
}

export async function fetchPptProjects(
  token: string,
  base?: string,
): Promise<{ projects: PptProject[] }> {
  const effectiveBase = base ?? (await getApiBase());
  return request(`${effectiveBase}/api/ppt/projects`, token);
}

export async function fetchPptPreviewPort(
  token: string,
  project: string,
  base?: string,
): Promise<{ port: number | null }> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request(`${effectiveBase}/api/ppt/preview-port?${query}`, token);
}
```

- [ ] **Step 2: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

---

## Task 6: PptConfigPanel — 配置面板

**Files:**
- Create: `webui/src/components/ppt/PptConfigPanel.tsx`

- [ ] **Step 1: 创建 PptConfigPanel 组件**

创建 `webui/src/components/ppt/PptConfigPanel.tsx`，包含模板选择（Tab 切换 Layout/Deck）、画布格式选择、源文件/主题输入、风格偏好输入。

组件接收 `config` 和 `setConfig` 作为 props，内部通过 `fetchPptTemplates` 获取模板数据。

模板卡片展示 SVG 封面缩略图（通过 `<img src={coverSvgUrl}>` 渲染）、名称、摘要、主色标识。

画布格式为横向滚动选择器。源文件输入支持"输入主题"和"上传文件"两种模式。

底部有"开始生成"按钮，disabled 条件为 `(!config.topic && config.sourceFiles.length === 0)`。

- [ ] **Step 2: 将 PptConfigPanel 集成到 PptMakerView**

在 PptMakerView 的左侧 aside 中，替换占位内容为 `<PptConfigPanel config={config} setConfig={setConfig} phase={phase} onStart={handleStartGeneration} />`。

- [ ] **Step 3: 验证编译和 UI**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

---

## Task 7: PptChatPanel — 内嵌聊天面板

**Files:**
- Create: `webui/src/components/ppt/PptChatPanel.tsx`

- [ ] **Step 1: 创建 PptChatPanel 组件**

创建 `webui/src/components/ppt/PptChatPanel.tsx`，完全复用 NoteAgentPanel 的模式：
- 使用 `useSessionHistory(historyKey)` 获取历史消息
- 使用 `useMonaStream(chatId, historical, hasPendingToolCalls)` 获取实时流
- 渲染消息列表（简化版 ChatBubble，不需要 apply/replace 功能）
- 底部输入框 + 发送/停止按钮

Props: `{ chatId: string | null; onCreatingChat?: () => void }`

- [ ] **Step 2: 将 PptChatPanel 集成到 PptMakerView**

在 PptMakerView 的右侧面板中，当 `phase === "generating" || phase === "done"` 时显示 PptChatPanel。

- [ ] **Step 3: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

---

## Task 8: PptPreview — SVG 实时预览

**Files:**
- Create: `webui/src/components/ppt/PptPreview.tsx`

- [ ] **Step 1: 创建 PptPreview 组件**

创建 `webui/src/components/ppt/PptPreview.tsx`：
- Props: `{ projectName: string | null }`
- 轮询 `/api/ppt/preview-port?project=xxx` 获取端口
- 检测 `http://localhost:{port}/api/config` 是否可访问
- 就绪后 iframe 嵌入 `http://localhost:{port}`
- 未就绪时显示加载状态

- [ ] **Step 2: 将 PptPreview 集成到 PptMakerView**

在 PptMakerView 的右侧面板中，PptChatPanel 上方显示 PptPreview。

- [ ] **Step 3: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

---

## Task 9: PptHistory — 生成历史

**Files:**
- Create: `webui/src/components/ppt/PptHistory.tsx`

- [ ] **Step 1: 创建 PptHistory 组件**

创建 `webui/src/components/ppt/PptHistory.tsx`：
- 通过 `fetchPptProjects` 获取项目列表
- 渲染为紧凑列表，每项显示项目名、格式、页数、创建时间
- 有导出文件的项目显示下载图标
- 点击项目可切换到该项目的预览

- [ ] **Step 2: 将 PptHistory 集成到 PptMakerView**

在 PptMakerView 的左侧面板底部（配置面板下方）显示 PptHistory。

- [ ] **Step 3: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

---

## Task 10: 下载功能集成

**Files:**
- Modify: `webui/src/components/ppt/PptMakerView.tsx`

- [ ] **Step 1: 在 PptMakerView 中添加下载按钮**

当 `phase === "done"` 时，在右侧面板中 PptPreview 下方显示下载按钮：
```tsx
<Button onClick={handleDownload} className="gap-2">
  <Download className="h-4 w-4" />
  下载 PPTX
</Button>
```

`handleDownload` 实现：
```tsx
const handleDownload = useCallback(async () => {
  if (!projectName) return;
  const base = await getApiBase();
  window.open(`${base}/api/ppt/download?project=${encodeURIComponent(projectName)}&token=${token}`, "_blank");
}, [projectName, token]);
```

- [ ] **Step 2: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

---

## Task 11: 端到端验证和打磨

**Files:**
- All PPT-related files

- [ ] **Step 1: 启动开发服务器验证**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npm run dev`
验证：
1. 侧边栏显示"PPT制作"入口
2. 点击进入 PPT 制作页面
3. 配置面板正常显示模板和画布格式
4. 输入主题后"开始生成"按钮可点击
5. 点击后切换到 generating 阶段
6. 返回按钮可回到聊天页面

- [ ] **Step 2: 运行 lint**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx eslint src/components/ppt/ src/lib/api.ts --max-warnings=0 2>&1 | head -30`
Expected: 无 lint 错误

- [ ] **Step 3: 运行 ruff check**

Run: `cd d:\liuzhe\Desktop\code\Mona && python -m ruff check mona/channels/websocket.py 2>&1 | head -20`
Expected: 无 ruff 错误

- [ ] **Step 4: 修复发现的问题**

根据 lint 和类型检查结果修复问题。
