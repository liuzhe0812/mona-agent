# PPT Master 集成增强实施计划（修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 PPT Master 的核心差异化能力（实时预览、注解交互、断点续执行、配音旁白）从"壳子到位、灵魂缺失"提升到完整产品化集成。

**Architecture:** 前端预生成项目名并通过 prompt 传入 Agent，消除正则提取的脆弱性；PptPreview 通过 iframe 嵌入 live-preview 服务（含静态回退）；PptMakerView 通过 `fetchPptExportStatus` API 精确检测生成状态；PptConfigPanel 保留画布格式选择作为八项确认的预填建议；新增 Split Mode 恢复入口和 TTS 配音按钮（同会话追加指令）。

**Tech Stack:** React + TypeScript（前端），Python + Flask（live-preview 服务），WebSocket（Agent 通信），aiohttp（后端 REST API）

**修订记录：**
- 修复 CORS Task 中 `X-Frame-Options: ALLOWALL` 非标准值问题
- 修复 PptPreview 中 `mode` 闭包过期和双重轮询 bug
- 新增"前端预生成项目名"Task，替代正则提取方案
- 修复后端状态判断中旧 pptx 干扰问题（引入 `.generating` 标记文件）
- 提取 `_get_ppt_project_status()` 共享函数消除代码重复
- 保留画布格式选择作为"预填建议"，不再移除
- TTS 改为同会话追加指令，不开新会话
- PPT 转换 prompt 只声明意图，不指定脚本名
- 新增生成超时机制
- 调整 Task 执行顺序，确保依赖关系正确

---

## File Structure

### 修改文件

| 文件 | 职责 |
|------|------|
| `mona/channels/websocket.py` | 新增 `/api/ppt/export-status` API；改进 `/api/ppt/projects`；提取共享函数 |
| `webui/src/lib/types.ts` | 更新 PptProject 类型，增加 `hasSvgOutput` / `hasSpecLock` / `status` 字段 |
| `webui/src/lib/api.ts` | 新增 `fetchPptExportStatus` API |
| `webui/src/components/ppt/PptMakerView.tsx` | 预生成项目名；修复状态检测；增加 Split Mode / TTS / 超时 |
| `webui/src/components/ppt/PptConfigPanel.tsx` | 移除风格偏好（保留画布格式作为预填建议） |
| `webui/src/components/ppt/PptChatPanel.tsx` | 增大面板高度 |
| `mona/skills/mona-ppt/scripts/svg_editor/server.py` | 添加 CORS 头，允许 iframe 嵌入 |
| `webui/src/components/ppt/PptPreview.tsx` | 重写为 iframe 嵌入 live-preview + 静态回退 |
| `webui/src/components/ppt/PptHistory.tsx` | 增加 Split Mode 恢复入口 + 状态标签 |

### 不修改文件

| 文件 | 原因 |
|------|------|
| `mona/skills/mona-ppt/SKILL.md` | 完整 Fork 原则，不做删减 |
| `mona/agent/skills.py` | SkillsLoader 机制无需改动 |
| `mona/config/schema.py` | 现有 PPTMasterConfig 已够用 |

---

## Task 1: 后端 — 提取共享状态函数 + 改进项目列表 + 新增 export-status API

**Files:**
- Modify: `mona/channels/websocket.py`

当前 `/api/ppt/projects` 只返回 `hasExport`，没有区分"正在生成"和"已完成"。需要：
1. 提取 `_get_ppt_project_status()` 共享函数，消除 `_handle_ppt_projects` 和 `_handle_ppt_export_status` 的代码重复
2. 引入 `.generating` 标记文件机制，解决旧 pptx 干扰状态判断的问题
3. 改进 `/api/ppt/projects` 返回更多状态字段
4. 新增 `/api/ppt/export-status` API

- [ ] **Step 1: 在 `_handle_ppt_projects` 方法之前添加共享函数**

在 `websocket.py` 中，`_handle_ppt_projects` 方法定义之前，添加模块级函数：

```python
def _get_ppt_project_status(project_dir: Path) -> dict:
    svg_output_dir = project_dir / "svg_output"
    svg_final_dir = project_dir / "svg_final"
    spec_lock = project_dir / "spec_lock.md"
    generating_marker = project_dir / ".generating"
    export_dir = project_dir / "exports"

    svg_count = (
        len(list(svg_output_dir.glob("*.svg"))) if svg_output_dir.is_dir() else 0
    )
    svg_final_count = (
        len(list(svg_final_dir.glob("*.svg"))) if svg_final_dir.is_dir() else 0
    )
    pptx_files = (
        sorted(
            export_dir.glob("*.pptx"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if export_dir.exists()
        else []
    )

    if generating_marker.exists():
        project_status = "generating"
    elif pptx_files:
        project_status = "done"
    elif svg_count > 0 or svg_final_count > 0:
        project_status = "generating"
    elif spec_lock.exists():
        project_status = "planning"
    else:
        project_status = "init"

    return {
        "status": project_status,
        "slideCount": max(svg_count, svg_final_count),
        "hasExport": len(pptx_files) > 0,
        "hasSvgOutput": svg_count > 0 or svg_final_count > 0,
        "hasSpecLock": spec_lock.exists(),
        "exportFile": pptx_files[0].name if pptx_files else None,
    }
```

注意：`.generating` 标记文件优先级最高——当它存在时，即使有旧 pptx 也判定为 `generating`。这个标记文件由 Agent 在 Step 6 开始时创建、Step 7 完成后删除（需要在 SKILL.md 工作流中配合，但当前计划不修改 SKILL.md，所以标记文件的创建/删除由前端在 `handleStartGeneration` / `handleResume` 中通过后端 API 完成）。

- [ ] **Step 2: 改进 `_handle_ppt_projects` 使用共享函数**

将 `_handle_ppt_projects` 方法中从 `svg_dir = d / "svg_final"` 到 `projects.append({...})` 的整段替换为：

```python
            status_info = _get_ppt_project_status(d)
            stat = d.stat()
            projects.append({
                "name": d.name,
                "createdAt": stat.st_ctime,
                "format": "ppt169",
                "slideCount": status_info["slideCount"],
                "hasExport": status_info["hasExport"],
                "hasSvgOutput": status_info["hasSvgOutput"],
                "hasSpecLock": status_info["hasSpecLock"],
                "status": status_info["status"],
            })
```

- [ ] **Step 3: 新增 `/api/ppt/export-status` API**

在 `_handle_ppt_preview_port` 方法之后添加：

```python
    def _handle_ppt_export_status(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            query = _parse_query(request.path)
            project_name = _query_first(query, "project") or ""
            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt-projects" / project_name
            if not project_dir.is_dir():
                return _http_json_response({"status": "not_found"})

            status_info = _get_ppt_project_status(project_dir)
            return _http_json_response({
                "status": status_info["status"],
                "slideCount": status_info["slideCount"],
                "hasExport": status_info["hasExport"],
                "exportFile": status_info["exportFile"],
            })
        except Exception as e:
            logger.exception("ppt export status error")
            return _http_error(500, str(e))
```

- [ ] **Step 4: 新增 `/api/ppt/mark-generating` API**

用于前端在开始生成时创建 `.generating` 标记文件。在 `_handle_ppt_export_status` 之后添加：

```python
    def _handle_ppt_mark_generating(self, request: WsRequest) -> Response:
        if not self._check_api_token(request):
            return _http_error(401, "Unauthorized")
        try:
            from mona.config.paths import get_workspace_path

            body = json.loads(request.body) if request.body else {}
            project_name = body.get("project") or ""
            action = body.get("action") or "start"

            if (
                not project_name
                or "/" in project_name
                or "\\" in project_name
                or ".." in project_name
            ):
                return _http_error(400, "invalid project name")

            workspace = get_workspace_path()
            project_dir = workspace / "ppt-projects" / project_name
            marker = project_dir / ".generating"

            if action == "start":
                project_dir.mkdir(parents=True, exist_ok=True)
                marker.write_text("1", encoding="utf-8")
            elif action == "finish":
                marker.unlink(missing_ok=True)

            return _http_json_response({"ok": True})
        except Exception as e:
            logger.exception("ppt mark generating error")
            return _http_error(500, str(e))
```

- [ ] **Step 5: 注册路由**

在 `_handle_http_request` 方法中，`/api/ppt/project-slides` 路由之前添加：

```python
        if got == "/api/ppt/export-status":
            return self._handle_ppt_export_status(request)
        if got == "/api/ppt/mark-generating":
            return self._handle_ppt_mark_generating(request)
```

- [ ] **Step 6: 验证后端**

Run: `cd d:\liuzhe\Desktop\code\Mona && python -c "from mona.channels.websocket import WsChannel; print('OK')"`
Expected: OK

- [ ] **Step 7: Commit**

```bash
git add mona/channels/websocket.py
git commit -m "feat(ppt): add export-status/mark-generating APIs, extract shared status function"
```

---

## Task 2: 前端类型和 API 更新

**Files:**
- Modify: `webui/src/lib/types.ts`
- Modify: `webui/src/lib/api.ts`

- [ ] **Step 1: 更新 PptProject 类型**

在 `types.ts` 中找到 `PptProject` interface，替换为：

```typescript
export interface PptProject {
  name: string;
  createdAt: number;
  format: string;
  slideCount: number;
  hasExport: boolean;
  hasSvgOutput: boolean;
  hasSpecLock: boolean;
  status: "init" | "planning" | "generating" | "done";
}
```

- [ ] **Step 2: 新增 fetchPptExportStatus 和 markPptGenerating API**

在 `api.ts` 中 `fetchPptPreviewPort` 函数之后添加：

```typescript
export interface PptExportStatus {
  status: "not_found" | "init" | "planning" | "generating" | "done";
  slideCount: number;
  hasExport: boolean;
  exportFile: string | null;
}

export async function fetchPptExportStatus(
  token: string,
  project: string,
  base?: string,
): Promise<PptExportStatus> {
  const effectiveBase = base ?? (await getApiBase());
  const query = new URLSearchParams();
  query.set("project", project);
  return request<PptExportStatus>(
    `${effectiveBase}/api/ppt/export-status?${query}`,
    token,
  );
}

export async function markPptGenerating(
  token: string,
  project: string,
  action: "start" | "finish",
  base?: string,
): Promise<{ ok: boolean }> {
  const effectiveBase = base ?? (await getApiBase());
  return request<{ ok: boolean }>(
    `${effectiveBase}/api/ppt/mark-generating`,
    token,
    { project, action },
  );
}
```

- [ ] **Step 3: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add webui/src/lib/types.ts webui/src/lib/api.ts
git commit -m "feat(ppt): add PptExportStatus/markPptGenerating types and APIs"
```

---

## Task 3: PptMakerView — 预生成项目名 + 修复状态检测 + 超时机制

**Files:**
- Modify: `webui/src/components/ppt/PptMakerView.tsx`

这是最核心的 Task。改动包括：
1. 预生成项目名（替代正则提取）
2. 用 `fetchPptExportStatus` 精确检测状态（替代轮询项目列表）
3. 用 `markPptGenerating` 管理标记文件
4. 增加生成超时机制（30 分钟）
5. 移除 `knownProjectsRef`

- [ ] **Step 1: 更新 PptConfig 类型，移除 stylePreference**

在 `PptMakerView.tsx` 中，将 `PptConfig` interface 和 `DEFAULT_CONFIG` 替换为：

```typescript
export interface PptConfig {
  templateKey: string | null;
  templateKind: "layout" | "deck" | null;
  canvasFormat: string;
  sourceFiles: string[];
  topic: string;
}

export const DEFAULT_CONFIG: PptConfig = {
  templateKey: null,
  templateKind: null,
  canvasFormat: "ppt169",
  sourceFiles: [],
  topic: "",
};
```

- [ ] **Step 2: 添加项目名生成函数**

在 `PptMakerView.tsx` 中 `buildPptPrompt` 函数之前添加：

```typescript
function generateProjectName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `ppt-${ts}-${rand}`;
}
```

- [ ] **Step 3: 重构 handleStartGeneration**

将 `handleStartGeneration` 替换为：

```typescript
  const handleStartGeneration = useCallback(async () => {
    try {
      const name = generateProjectName();
      setProjectName(name);
      const prompt = buildPptPrompt(config, name);
      await markPptGenerating(token, name, "start");
      const newChatId = await client.newChat(5_000, true);
      setChatId(newChatId);
      client.sendMessage(newChatId, prompt);
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to start PPT generation", e);
    }
  }, [client, config, token]);
```

- [ ] **Step 4: 添加 generationStartRef 和超时状态**

在 `PptMakerView` 组件中，`knownProjectsRef` 之后添加：

```typescript
  const generationStartRef = useRef<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
```

删除 `knownProjectsRef`。

- [ ] **Step 5: 重构状态检测 useEffect**

将现有的 `useEffect`（第 59-95 行，轮询 `fetchPptProjects` 的那个）替换为：

```typescript
  useEffect(() => {
    if (phase !== "generating" || !projectName) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setTimedOut(false);

    async function poll() {
      if (cancelled) return;

      if (generationStartRef.current) {
        const elapsed = Date.now() - generationStartRef.current;
        if (elapsed > 30 * 60 * 1000) {
          setTimedOut(true);
          return;
        }
      }

      try {
        const res = await fetchPptExportStatus(token, projectName!);
        if (cancelled) return;
        if (res.status === "done" && res.hasExport) {
          await markPptGenerating(token, projectName!, "finish").catch(() => {});
          setPhase("done");
          setHistoryKey((k) => k + 1);
          generationStartRef.current = null;
          return;
        }
      } catch {}
      if (!cancelled) {
        timer = setTimeout(poll, 3000);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, projectName, token]);
```

- [ ] **Step 6: 更新 buildPptPrompt 接收项目名参数**

将 `buildPptPrompt` 函数替换为：

```typescript
function buildPptPrompt(config: PptConfig, projectName: string): string {
  const parts: string[] = [];
  const hasPptxSource = config.sourceFiles.some((f) =>
    f.toLowerCase().endsWith(".pptx"),
  );

  if (hasPptxSource) {
    parts.push("请将现有 PPT 转换为网页版 PPT，保留原有内容和设计意图。");
  } else {
    parts.push("请制作一份 PPT。");
  }

  parts.push(`项目名使用：${projectName}`);
  if (config.templateKey && config.templateKind) {
    const kindLabel = config.templateKind === "deck" ? "品牌套件" : "布局模板";
    const subdir = config.templateKind === "deck" ? "decks" : "layouts";
    parts.push(`使用模板：${kindLabel} ${config.templateKey}（路径：scripts/templates_full/${subdir}/${config.templateKey}）`);
  }
  if (config.canvasFormat && config.canvasFormat !== "ppt169") {
    parts.push(`画布格式偏好：${config.canvasFormat}（请在八项确认中优先采用此格式）`);
  }
  if (config.sourceFiles.length > 0) {
    const filePaths = config.sourceFiles.map((p) => `  - ${p}`).join("\n");
    parts.push(`源文件（请先读取以下文件内容再制作）：\n${filePaths}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}（请先进行主题研究）`);
  }
  return parts.join("\n");
}
```

关键设计决策：
- `项目名使用：${projectName}` 让 Agent 直接用前端预生成的项目名初始化，不需要从消息中提取
- 画布格式只在非默认值时才传入 prompt，并标注"偏好"和"请在八项确认中优先采用"，尊重 Agent 的八项确认流程
- PPT 转换只声明意图"保留原有内容和设计意图"，不指定具体脚本

- [ ] **Step 7: 更新 import**

将 `PptMakerView.tsx` 顶部的 import 替换为：

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Mic, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import { fetchPptExportStatus, markPptGenerating, getApiBase } from "@/lib/api";
import { PptConfigPanel } from "./PptConfigPanel";
import { PptChatPanel } from "./PptChatPanel";
import { PptPreview } from "./PptPreview";
import { PptHistory } from "./PptHistory";
```

- [ ] **Step 8: 在顶部栏添加超时提示**

在 `PptMakerView` 的 return JSX 中，`{phase === "done" && projectName && (` 下载按钮块之前，添加超时提示：

```tsx
          {timedOut && phase === "generating" && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              生成超时，请检查聊天面板
            </span>
          )}
```

- [ ] **Step 9: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 可能有 PptChatPanel props 不匹配的警告（Task 5 会修复）

- [ ] **Step 10: Commit**

```bash
git add webui/src/components/ppt/PptMakerView.tsx
git commit -m "feat(ppt): pre-generate project name, fix state detection, add timeout"
```

---

## Task 4: PptConfigPanel — 移除风格偏好，保留画布格式

**Files:**
- Modify: `webui/src/components/ppt/PptConfigPanel.tsx`

只移除"风格偏好"文本框（与八项确认第 4-7 项重叠），保留画布格式选择（作为八项确认的预填建议）。

- [ ] **Step 1: 从 PptConfigPanel 移除风格偏好 section**

在 `PptConfigPanel.tsx` 中：
1. 删除"风格偏好"整个 `<section>` 块（包含 `<Palette>` 图标和 `<Textarea>` 的部分）
2. 从 import 中移除 `Palette`（如果不再使用）
3. 从 props / state 中移除 `stylePreference` 相关逻辑

- [ ] **Step 2: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 可能有 stylePreference 相关的类型错误（PptConfig 已在 Task 3 中移除该字段）

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/ppt/PptConfigPanel.tsx
git commit -m "refactor(ppt): remove style preference from config panel, keep canvas format as pre-fill"
```

---

## Task 5: PptChatPanel — 增大面板高度

**Files:**
- Modify: `webui/src/components/ppt/PptChatPanel.tsx`
- Modify: `webui/src/components/ppt/PptMakerView.tsx`

不再需要 `onProjectDetected` prop（项目名已预生成），只需增大面板高度。

- [ ] **Step 1: 增大聊天面板高度**

在 `PptMakerView.tsx` 中，将 PptChatPanel 容器的高度从 `h-[240px]` 改为 `h-[320px]`：

```tsx
<div className="shrink-0 h-[320px] border-t border-border/70">
  <PptChatPanel chatId={chatId} />
</div>
```

- [ ] **Step 2: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/ppt/PptChatPanel.tsx webui/src/components/ppt/PptMakerView.tsx
git commit -m "feat(ppt): enlarge chat panel height for better eight-confirmations readability"
```

---

## Task 6: Live Preview 服务端 CORS 适配

**Files:**
- Modify: `mona/skills/mona-ppt/scripts/svg_editor/server.py`

Flask live-preview 服务需要允许 iframe 嵌入。注意：
- 不设置 `X-Frame-Options`（Flask 默认不设置，浏览器默认允许同源 iframe；`ALLOWALL` 是非标准值，某些浏览器会当作 `DENY` 处理）
- 添加 CORS 头以支持未来前端直接调用 Flask API 的场景
- 添加 OPTIONS 预检请求处理

- [ ] **Step 1: 在 `create_app` 函数中添加 after_request 钩子**

在 `server.py` 的 `create_app` 函数中，`@app.before_request` 装饰器之后，添加：

```python
    @app.after_request
    def _add_cors_headers(response):
        response.headers['Access-Control-Allow-Origin'] = 'http://localhost:*'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response
```

注意：没有设置 `X-Frame-Options`。Flask 默认不设置此头，浏览器对没有此头的响应允许 iframe 嵌入。`Access-Control-Allow-Origin` 使用 `http://localhost:*` 限制来源（但注意：CORS 规范中 `*` 不能与 `credentials` 共存，且部分浏览器不支持带端口的通配；如果遇到问题，回退为 `*`）。

- [ ] **Step 2: 验证修改**

Run: `python -c "import ast; ast.parse(open('mona/skills/mona-ppt/scripts/svg_editor/server.py', encoding='utf-8').read()); print('syntax OK')"`

Expected: syntax OK

- [ ] **Step 3: Commit**

```bash
git add mona/skills/mona-ppt/scripts/svg_editor/server.py
git commit -m "feat(ppt): add CORS headers to live-preview Flask server for iframe embedding"
```

---

## Task 7: 重写 PptPreview — iframe 嵌入 live-preview + 静态回退

**Files:**
- Modify: `webui/src/components/ppt/PptPreview.tsx`

核心改动：
1. 通过 `fetchPptPreviewPort` API 获取 live-preview 端口
2. 用 `useRef` 跟踪 mode 避免闭包过期
3. 用 `setTimeout` 递归轮询（不用 `setInterval`，避免双重轮询）
4. live-preview 可用时 iframe 嵌入；不可用时回退到静态 SVG 浏览

- [ ] **Step 1: 重写 PptPreview 组件**

将 `PptPreview.tsx` 完整替换为：

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchPptPreviewPort, fetchPptProjectSlides, getApiBase, type PptSlide } from "@/lib/api";
import { useClient } from "@/providers/ClientProvider";

interface PptPreviewProps {
  projectName: string | null;
}

type PreviewMode = "loading" | "live" | "static" | "unavailable";

export function PptPreview({ projectName }: PptPreviewProps) {
  const { token } = useClient();
  const [mode, setMode] = useState<PreviewMode>("loading");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [slides, setSlides] = useState<PptSlide[]>([]);
  const [index, setIndex] = useState(0);
  const [apiBase, setApiBase] = useState<string>("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const modeRef = useRef<PreviewMode>(mode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  useEffect(() => {
    if (!projectName) {
      setMode("loading");
      setPreviewUrl(null);
      setSlides([]);
      setIndex(0);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tryConnectLive(): Promise<void> {
      if (cancelled) return;
      try {
        const res = await fetchPptPreviewPort(token, projectName!);
        if (cancelled) return;
        const port = res.port;
        if (!port) {
          if (modeRef.current !== "static") {
            setMode("unavailable");
          }
          return;
        }
        const liveUrl = `http://localhost:${port}`;
        const configUrl = `http://localhost:${port}/api/config`;
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 3000);
        try {
          await fetch(configUrl, { mode: "cors", signal: ctrl.signal });
          clearTimeout(timeout);
          if (!cancelled) {
            setPreviewUrl(liveUrl);
            setMode("live");
          }
          return;
        } catch {
          clearTimeout(timeout);
        }
      } catch {}
      if (!cancelled) {
        await loadStaticSlides();
      }
    }

    async function loadStaticSlides(): Promise<void> {
      if (cancelled) return;
      try {
        const res = await fetchPptProjectSlides(token, projectName!);
        if (cancelled) return;
        if (res.slides.length > 0) {
          setSlides(res.slides);
          setIndex(0);
          setMode("static");
        } else {
          setMode("unavailable");
        }
      } catch {
        setMode("unavailable");
      }
    }

    setMode("loading");
    tryConnectLive();

    function schedulePoll() {
      timer = setTimeout(async () => {
        if (cancelled) return;
        const current = modeRef.current;
        if (current === "loading" || current === "unavailable") {
          await tryConnectLive();
        }
        if (!cancelled) {
          schedulePoll();
        }
      }, 5000);
    }
    schedulePoll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectName, token]);

  const handleRetryLive = useCallback(() => {
    setMode("loading");
    setPreviewUrl(null);
  }, []);

  const goPrev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setIndex((i) => Math.min(slides.length - 1, i + 1)), [slides.length]);

  if (!projectName) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        开始生成后将在此展示预览
      </div>
    );
  }

  if (mode === "loading") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>等待预览服务启动…</span>
      </div>
    );
  }

  if (mode === "live" && previewUrl) {
    return (
      <div className="flex h-full flex-col">
        <iframe
          ref={iframeRef}
          src={previewUrl}
          className="min-h-0 flex-1 w-full border-0"
          title="PPT Live Preview"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </div>
    );
  }

  if (mode === "static" && slides.length > 0) {
    const slide = slides[index];
    const svgUrl = `${apiBase}${slide.url}&token=${encodeURIComponent(token)}`;
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
          <img
            src={svgUrl}
            alt={slide.name}
            className="max-h-full max-w-full rounded shadow-md"
            draggable={false}
          />
        </div>
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-border/70 py-1.5 text-[12px] text-muted-foreground">
          <button onClick={goPrev} disabled={index === 0} className="rounded p-1 hover:bg-muted disabled:opacity-30">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span>{index + 1} / {slides.length}</span>
          <button onClick={goNext} disabled={index === slides.length - 1} className="rounded p-1 hover:bg-muted disabled:opacity-30">
            <ChevronRight className="h-4 w-4" />
          </button>
          <Button variant="ghost" size="sm" onClick={handleRetryLive} className="h-6 gap-1 text-[11px]">
            <RefreshCw className="h-3 w-3" />
            连接实时预览
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
      <span>暂无预览</span>
      <Button variant="ghost" size="sm" onClick={handleRetryLive} className="h-6 gap-1 text-[11px]">
        <RefreshCw className="h-3 w-3" />
        重试连接预览
      </Button>
    </div>
  );
}
```

关键修复：
- 用 `modeRef` 跟踪 mode 当前值，避免闭包捕获过期值
- 用 `setTimeout` 递归替代 `setInterval`，消除双重轮询
- `tryConnectLive` 失败后自动回退 `loadStaticSlides`，而不是无条件调用

- [ ] **Step 2: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add webui/src/components/ppt/PptPreview.tsx
git commit -m "feat(ppt): rewrite PptPreview with iframe live-preview and static fallback"
```

---

## Task 8: PptHistory — 增加 Split Mode 恢复入口 + 状态标签

**Files:**
- Modify: `webui/src/components/ppt/PptHistory.tsx`
- Modify: `webui/src/components/ppt/PptMakerView.tsx`

- [ ] **Step 1: 更新 PptHistory 组件**

替换 `PptHistory.tsx` 为：

```tsx
import { useEffect, useState } from "react";
import { Download, Presentation, Play } from "lucide-react";

import { fetchPptProjects } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptProject } from "@/lib/types";

interface PptHistoryProps {
  onSelect: (name: string) => void;
  onDownload: (name: string) => void;
  onResume: (name: string) => void;
}

function formatRelativeTime(epoch: number): string {
  const ms = epoch > 1e12 ? epoch : epoch * 1000;
  const diff = Date.now() - ms;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 0) return "刚刚";
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

const STATUS_LABELS: Record<string, string> = {
  init: "初始化",
  planning: "规划中",
  generating: "生成中",
  done: "已完成",
};

export function PptHistory({ onSelect, onDownload, onResume }: PptHistoryProps) {
  const { token } = useClient();
  const [projects, setProjects] = useState<PptProject[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchPptProjects(token).then((res) => {
      if (!cancelled) setProjects(res.projects);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (projects.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        暂无历史项目
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
        历史项目
      </div>
      {projects.map((p) => {
        const canResume = p.status === "generating" || p.status === "planning";
        return (
          <button
            key={p.name}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1.5 text-left",
              "hover:bg-accent",
            )}
            onClick={() => onSelect(p.name)}
          >
            <Presentation className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px]">{p.name}</div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{STATUS_LABELS[p.status] || p.status}</span>
                <span>·</span>
                <span>{p.slideCount}页</span>
                <span>·</span>
                <span>{formatRelativeTime(p.createdAt)}</span>
              </div>
            </div>
            {canResume && (
              <span
                role="button"
                tabIndex={0}
                className="shrink-0 rounded p-0.5 hover:bg-accent text-emerald-600 dark:text-emerald-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onResume(p.name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onResume(p.name);
                  }
                }}
                title="继续生成"
              >
                <Play className="h-3 w-3" />
              </span>
            )}
            {p.hasExport && (
              <span
                role="button"
                tabIndex={0}
                className="shrink-0 rounded p-0.5 hover:bg-accent"
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload(p.name);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onDownload(p.name);
                  }
                }}
              >
                <Download className="h-3 w-3 text-muted-foreground" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 在 PptMakerView 中添加 handleResume**

在 `PptMakerView.tsx` 中添加 `handleResume` 回调：

```typescript
  const handleResume = useCallback(async (name: string) => {
    try {
      await markPptGenerating(token, name, "start");
      const newChatId = await client.newChat(5_000, true);
      setChatId(newChatId);
      setProjectName(name);
      client.sendMessage(
        newChatId,
        `继续生成 projects/${name}\n\n请先读取 skills/mona-ppt/SKILL.md 了解 resume-execute 工作流，然后继续执行。`,
      );
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to resume PPT generation", e);
    }
  }, [client, token]);
```

关键设计决策：
- resume 时在 prompt 中明确引导 Agent 读取 SKILL.md，确保新会话能理解 `继续生成` 指令
- 调用 `markPptGenerating(token, name, "start")` 重新创建 `.generating` 标记文件

- [ ] **Step 3: 更新 PptHistory props**

将 `<PptHistory>` 组件的 props 更新为：

```tsx
<PptHistory
  key={historyKey}
  onSelect={handleSelectProject}
  onDownload={handleDownload}
  onResume={handleResume}
/>
```

- [ ] **Step 4: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add webui/src/components/ppt/PptHistory.tsx webui/src/components/ppt/PptMakerView.tsx
git commit -m "feat(ppt): add resume generation entry and status labels in PptHistory"
```

---

## Task 9: 增加 TTS 配音按钮（同会话追加）

**Files:**
- Modify: `webui/src/components/ppt/PptMakerView.tsx`

在 PPT 生成完成后，增加"生成配音"按钮。**在同会话中追加指令**（不开新会话），这样 Agent 有完整的项目上下文。

- [ ] **Step 1: 在 PptMakerView 顶部栏添加 TTS 按钮**

在 `PptMakerView.tsx` 的 return JSX 中，下载按钮之后添加：

```tsx
          {phase === "done" && projectName && chatId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleGenerateAudio}
              className="h-7 gap-1.5 rounded-lg text-[12px] text-muted-foreground"
            >
              <Mic className="h-3.5 w-3.5" />
              生成配音
            </Button>
          )}
```

- [ ] **Step 2: 添加 handleGenerateAudio 回调**

在 `PptMakerView.tsx` 中添加：

```typescript
  const handleGenerateAudio = useCallback(async () => {
    if (!projectName || !chatId) return;
    try {
      await markPptGenerating(token, projectName, "start");
      client.sendMessage(
        chatId,
        `请为当前 PPT 项目生成配音旁白。使用 Edge TTS 默认语音，生成后重新导出带配音的 PPTX。`,
      );
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to start TTS generation", e);
    }
  }, [client, chatId, projectName, token]);
```

关键设计决策：
- 使用 `chatId`（当前会话）而非 `newChat`，Agent 有完整上下文
- 按钮仅在 `chatId` 存在时显示（如果从历史项目进入，没有 chatId 则不显示）
- 调用 `markPptGenerating` 重新设置生成标记

- [ ] **Step 3: 验证编译**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add webui/src/components/ppt/PptMakerView.tsx
git commit -m "feat(ppt): add TTS narration button using same-session message"
```

---

## Task 10: 端到端验证和打磨

**Files:**
- All PPT-related files

- [ ] **Step 1: 运行前端类型检查**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx tsc --noEmit 2>&1 | head -30`
Expected: 无类型错误

- [ ] **Step 2: 运行前端 lint**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npx eslint src/components/ppt/ src/lib/api.ts src/lib/types.ts --max-warnings=0 2>&1 | head -30`
Expected: 无 lint 错误

- [ ] **Step 3: 运行后端 ruff check**

Run: `cd d:\liuzhe\Desktop\code\Mona && python -m ruff check mona/channels/websocket.py 2>&1 | head -20`
Expected: 无 ruff 错误

- [ ] **Step 4: 验证后端 import**

Run: `cd d:\liuzhe\Desktop\code\Mona && python -c "from mona.channels.websocket import WsChannel; print('OK')"`
Expected: OK

- [ ] **Step 5: 修复发现的问题**

根据 lint 和类型检查结果修复问题。

- [ ] **Step 6: 启动开发服务器验证 UI**

Run: `cd d:\liuzhe\Desktop\code\Mona\webui && npm run dev`

手动验证：
1. 侧边栏"PPT制作"入口正常
2. 配置面板显示模板选择 + 画布格式 + 源文件/主题输入（无风格偏好）
3. 输入主题后"开始生成"可点击
4. 生成中预览区显示"等待预览服务启动…"
5. 历史项目显示状态标签和"继续生成"按钮
6. 完成后显示"下载 PPTX"和"生成配音"按钮
7. 超时 30 分钟后显示超时提示

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "chore(ppt): end-to-end validation and polish for PPT Master integration enhancement"
```
