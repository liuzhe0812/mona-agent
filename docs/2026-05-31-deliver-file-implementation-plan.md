# Deliver File 提交产物工具 + FileCard + 预览面板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `deliver_file` 后端工具，AI 创建新文件后可主动提交产物，前端在对话中渲染 FileCard，左键点击打开右侧可拖拽分割的预览面板，右键菜单支持预览/系统打开/打开目录。

**Architecture:** 后端新增 `DeliverFileTool`，通过 `OutboundMessage` 的 `metadata._deliver_files` 标记发送文件信息，WebSocket 通道识别后推送 `deliver_files` 事件。前端新增 `DeliveredFileCard` 组件渲染卡片，`FilePreviewPanel` 组件渲染右侧预览面板，`SplitPane` 组件实现可拖拽分割。右键菜单使用已有的 `@radix-ui/react-context-menu`。

**Tech Stack:** Python (mona agent tools), TypeScript/React (webui), Tauri opener plugin, Radix UI Context Menu, WebSocket events

---

## File Structure

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| Create | `mona/agent/tools/deliver_file.py` | 后端 deliver_file 工具实现 |
| Modify | `mona/channels/websocket.py` | 识别 `_deliver_files` 元数据，推送 `deliver_files` 事件 |
| Modify | `webui/src/lib/types.ts` | 新增 `DeliveredFile` 类型、`InboundEvent` 新增 `deliver_files` |
| Modify | `webui/src/hooks/useMonaStream.ts` | 处理 `deliver_files` 事件，更新 UIMessage |
| Create | `webui/src/components/deliver/DeliveredFileCard.tsx` | FileCard 组件（文件名+大小+右键菜单） |
| Create | `webui/src/components/deliver/FilePreviewPanel.tsx` | 右侧预览面板（按文件类型渲染） |
| Create | `webui/src/components/deliver/SplitPane.tsx` | 可拖拽分割面板 |
| Create | `webui/src/components/deliver/filePreviewStore.ts` | 预览面板状态管理（zustand） |
| Modify | `webui/src/components/MessageBubble.tsx` | 渲染 deliveredFiles 为 FileCard 列表 |
| Modify | `webui/src/components/thread/ThreadShell.tsx` | 集成 SplitPane + FilePreviewPanel |
| Modify | `mona/templates/` | system prompt 中添加 deliver_file 工具指引 |

---

### Task 1: 后端 — 新增 DeliverFileTool

**Files:**
- Create: `mona/agent/tools/deliver_file.py`

- [ ] **Step 1: 创建 deliver_file.py 工具文件**

```python
"""Deliver file tool for submitting generated files as deliverables."""

from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.context import ContextAware, RequestContext
from mona.agent.tools.path_utils import resolve_workspace_path
from mona.agent.tools.schema import ArraySchema, StringSchema, tool_parameters_schema
from mona.bus.events import OutboundMessage
from mona.config.paths import get_workspace_path


def _human_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    if size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"


def _mime_from_ext(path: Path) -> str:
    import mimetypes
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


@tool_parameters(
    tool_parameters_schema(
        paths=ArraySchema(
            StringSchema("Absolute or workspace-relative file path"),
            description="File paths to deliver to the user as deliverables.",
        ),
        summary=StringSchema(
            "Optional brief description of what was created.",
        ),
        required=["paths"],
    )
)
class DeliverFileTool(Tool, ContextAware):
    """Submit generated files as deliverables shown prominently in chat."""

    def __init__(
        self,
        send_callback=None,
        workspace=None,
        restrict_to_workspace=False,
    ):
        self._send_callback = send_callback
        self._workspace = (
            Path(workspace).expanduser() if workspace is not None else get_workspace_path()
        )
        self._restrict_to_workspace = restrict_to_workspace
        self._default_channel = ""
        self._default_chat_id = ""

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        send_callback = ctx.bus.publish_outbound if ctx.bus else None
        return cls(
            send_callback=send_callback,
            workspace=ctx.workspace,
            restrict_to_workspace=ctx.config.restrict_to_workspace,
        )

    def set_context(self, ctx: RequestContext) -> None:
        self._default_channel = ctx.channel
        self._default_chat_id = ctx.chat_id

    @property
    def name(self) -> str:
        return "deliver_file"

    @property
    def description(self) -> str:
        return (
            "Submit generated files as deliverables shown prominently in chat. "
            "Call this after creating new files (reports, images, data exports, etc.) "
            "that the user should be aware of. Do NOT call this for temporary or "
            "intermediate files. The files will appear as clickable cards in the "
            "conversation that the user can preview or open."
        )

    async def execute(
        self,
        paths: list[str],
        summary: str = "",
        **kwargs: Any,
    ) -> str:
        if not self._send_callback:
            return "Error: Message sending not configured"
        if not self._default_channel or not self._default_chat_id:
            return "Error: No active chat context"

        files: list[dict[str, Any]] = []
        allowed_dir = self._workspace if self._restrict_to_workspace else None

        for raw_path in paths:
            if self._restrict_to_workspace:
                try:
                    resolved = resolve_workspace_path(raw_path, self._workspace, allowed_dir)
                except (OSError, PermissionError, ValueError) as e:
                    return f"Error: path not allowed: {e}"
            else:
                p = Path(raw_path).expanduser()
                resolved = p if p.is_absolute() else self._workspace / p

            if not resolved.is_file():
                return f"Error: file not found: {resolved}"

            try:
                size = resolved.stat().st_size
            except OSError:
                size = 0

            try:
                display_path = resolved.relative_to(self._workspace).as_posix()
            except ValueError:
                display_path = resolved.as_posix()

            files.append({
                "path": display_path,
                "absolute_path": str(resolved),
                "name": resolved.name,
                "size": size,
                "size_human": _human_size(size),
                "mime": _mime_from_ext(resolved),
                "summary": summary,
            })

        if not files:
            return "Error: no valid files to deliver"

        msg = OutboundMessage(
            channel=self._default_channel,
            chat_id=self._default_chat_id,
            content="",
            metadata={"_deliver_files": files},
        )

        try:
            await self._send_callback(msg)
            return f"Delivered {len(files)} file(s) to user"
        except Exception as e:
            return f"Error delivering files: {e}"
```

- [ ] **Step 2: 验证工具被自动发现**

ToolLoader 会扫描 `mona/agent/tools/` 下所有非 `_SKIP_MODULES` 的模块，`deliver_file` 不在跳过列表中，`DeliverFileTool` 继承 `Tool` + `ContextAware`，无 `__abstractmethods__`，会被自动注册。无需修改 loader。

---

### Task 2: 后端 — WebSocket 通道处理 deliver_files 事件

**Files:**
- Modify: `mona/channels/websocket.py` (约 L2209 附近，`_handle_outbound` 方法中)

- [ ] **Step 1: 在 `_handle_outbound` 方法中添加 `_deliver_files` 分支**

在现有的 `_file_edit_events` 分支之后、`text = msg.content` 行之前，添加：

```python
        if msg.metadata.get("_deliver_files"):
            payload: dict[str, Any] = {
                "event": "deliver_files",
                "chat_id": msg.chat_id,
                "files": msg.metadata["_deliver_files"],
            }
            self._try_append_webui_transcript(msg.chat_id, payload)
            raw = json.dumps(payload, ensure_ascii=False)
            for connection in conns:
                await self._safe_send_to(connection, raw, label=" ")
            return
```

注意：这段代码插入位置在 `_file_edit_events` 分支的 `return` 之后、`text = msg.content` 行之前。

---

### Task 3: 前端 — 类型定义

**Files:**
- Modify: `webui/src/lib/types.ts`

- [ ] **Step 1: 新增 DeliveredFile 接口**

在 `UIMediaAttachment` 接口之后添加：

```typescript
export interface DeliveredFile {
  path: string;
  absolute_path: string;
  name: string;
  size: number;
  size_human: string;
  mime: string;
  summary?: string;
}
```

- [ ] **Step 2: UIMessage 新增 deliveredFiles 字段**

在 `UIMessage` 接口中，`media` 字段之后添加：

```typescript
  /** Files delivered via deliver_file tool, rendered as FileCards. */
  deliveredFiles?: DeliveredFile[];
```

- [ ] **Step 3: InboundEvent 新增 deliver_files 事件类型**

在 `InboundEvent` 联合类型中，`file_edit` 分支之后添加：

```typescript
  | {
      event: "deliver_files";
      chat_id: string;
      files: DeliveredFile[];
    }
```

---

### Task 4: 前端 — useMonaStream 处理 deliver_files 事件

**Files:**
- Modify: `webui/src/hooks/useMonaStream.ts`

- [ ] **Step 1: 在事件处理 switch 中添加 deliver_files 分支**

在 `if (ev.event === "file_edit")` 分支之后添加：

```typescript
      if (ev.event === "deliver_files") {
        const files = Array.isArray(ev.files) ? ev.files : [];
        if (files.length === 0) return;
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && !last.isStreaming) {
            return [
              ...prev.slice(0, -1),
              { ...last, deliveredFiles: [...(last.deliveredFiles ?? []), ...files] },
            ];
          }
          return [
            ...prev,
            {
              id: `deliver-${Date.now()}`,
              role: "assistant" as const,
              content: "",
              deliveredFiles: files,
              createdAt: Date.now(),
            },
          ];
        });
        return;
      }
```

---

### Task 5: 前端 — 预览面板状态管理

**Files:**
- Create: `webui/src/components/deliver/filePreviewStore.ts`

- [ ] **Step 1: 创建 zustand store**

```typescript
import { create } from "zustand";
import type { DeliveredFile } from "@/lib/types";

interface FilePreviewState {
  file: DeliveredFile | null;
  splitRatio: number;
  open: (file: DeliveredFile) => void;
  close: () => void;
  setSplitRatio: (ratio: number) => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  file: null,
  splitRatio: 0.45,
  open: (file) => set({ file }),
  close: () => set({ file: null }),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
}));
```

---

### Task 6: 前端 — SplitPane 可拖拽分割组件

**Files:**
- Create: `webui/src/components/deliver/SplitPane.tsx`

- [ ] **Step 1: 创建 SplitPane 组件**

```tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  rightVisible: boolean;
}

const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;
const DIVIDER_WIDTH = 6;

export function SplitPane({ left, right, ratio, onRatioChange, rightVisible }: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = (e.clientX - rect.left) / rect.width;
      onRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)));
    },
    [onRatioChange],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!rightVisible) {
    return <>{left}</>;
  }

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div style={{ width: `${ratio * 100}%` }} className="min-w-0 overflow-hidden">
        {left}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className={cn(
          "z-10 flex shrink-0 cursor-col-resize items-center justify-center",
          "bg-border/40 hover:bg-primary/25 active:bg-primary/35",
          "transition-colors",
        )}
        style={{ width: DIVIDER_WIDTH }}
      >
        <div className="h-8 w-0.5 rounded-full bg-muted-foreground/30" />
      </div>
      <div style={{ width: `${(1 - ratio) * 100}%` }} className="min-w-0 overflow-hidden">
        {right}
      </div>
    </div>
  );
}
```

---

### Task 7: 前端 — FilePreviewPanel 预览面板

**Files:**
- Create: `webui/src/components/deliver/FilePreviewPanel.tsx`

- [ ] **Step 1: 创建 FilePreviewPanel 组件**

```tsx
import { useCallback } from "react";
import { X, FileText, Image, FileCode, File } from "lucide-react";
import { useFilePreviewStore } from "./filePreviewStore";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

const PREVIEWABLE_TEXT_EXTS = new Set([
  ".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".sh", ".bash", ".zsh", ".css", ".scss", ".html",
  ".htm", ".xml", ".sql", ".csv", ".log", ".env", ".gitignore", ".rs", ".go",
  ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".swift", ".kt",
]);

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function isPreviewableText(file: DeliveredFile): boolean {
  return PREVIEWABLE_TEXT_EXTS.has(extOf(file.name))
    || file.mime.startsWith("text/")
    || file.mime === "application/json";
}

function isPreviewableImage(file: DeliveredFile): boolean {
  return IMAGE_EXTS.has(extOf(file.name)) || file.mime.startsWith("image/");
}

function FileIcon({ file }: { file: DeliveredFile }) {
  const ext = extOf(file.name);
  if (IMAGE_EXTS.has(ext)) return <Image className="h-4 w-4" />;
  if ([".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go"].includes(ext))
    return <FileCode className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

export function FilePreviewPanel() {
  const file = useFilePreviewStore((s) => s.file);
  const close = useFilePreviewStore((s) => s.close);

  if (!file) return null;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <FileIcon file={file} />
        <span className="flex-1 truncate text-sm font-medium">{file.name}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{file.size_human}</span>
        <button
          type="button"
          onClick={close}
          className="ml-1 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {isPreviewableImage(file) ? (
          <ImagePreview file={file} />
        ) : isPreviewableText(file) ? (
          <TextPreview file={file} />
        ) : (
          <NoPreview file={file} />
        )}
      </div>
    </div>
  );
}

function TextPreview({ file }: { file: DeliveredFile }) {
  return <TextPreviewContent absolutePath={file.absolute_path} />;
}

function TextPreviewContent({ absolutePath }: { absolutePath: string }) {
  return (
    <iframe
      src={`/api/file-preview?path=${encodeURIComponent(absolutePath)}`}
      className="h-full w-full border-0"
      title="File preview"
      sandbox="allow-same-origin"
    />
  );
}

function ImagePreview({ file }: { file: DeliveredFile }) {
  const src = `/api/file-preview?path=${encodeURIComponent(file.absolute_path)}`;
  return (
    <div className="flex h-full items-center justify-center">
      <img
        src={src}
        alt={file.name}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

function NoPreview({ file }: { file: DeliveredFile }) {
  const handleOpen = useCallback(() => {
    if (isTauri()) void openPathWithSystemApp(file.absolute_path);
  }, [file.absolute_path]);

  const handleReveal = useCallback(() => {
    if (isTauri()) void revealItemInDir(file.absolute_path);
  }, [file.absolute_path]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <File className="h-12 w-12 opacity-40" />
      <p className="text-sm">此文件类型不支持预览</p>
      <div className="flex gap-2">
        {isTauri() && (
          <>
            <button
              type="button"
              onClick={handleOpen}
              className="rounded-md border border-border/70 px-3 py-1.5 text-xs hover:bg-muted"
            >
              系统程序打开
            </button>
            <button
              type="button"
              onClick={handleReveal}
              className="rounded-md border border-border/70 px-3 py-1.5 text-xs hover:bg-muted"
            >
              打开所在目录
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

---

### Task 8: 后端 — 文件预览 HTTP 端点

**Files:**
- Modify: `mona/channels/websocket.py` (HTTP 处理部分)

- [ ] **Step 1: 在 WebSocket 通道的 HTTP 处理中添加 `/api/file-preview` 路由**

在 `_handle_http_request` 方法中，`/api/media/` 路由处理之后添加：

```python
        if path == "/api/file-preview":
            return self._handle_file_preview(params)
```

- [ ] **Step 2: 添加 `_handle_file_preview` 方法**

```python
    def _handle_file_preview(self, params: dict[str, str]) -> Response:
        import mimetypes as _mimetypes
        raw_path = params.get("path", "")
        if not raw_path:
            return _http_error(400, "missing path")
        try:
            target = Path(raw_path).resolve()
        except Exception:
            return _http_error(400, "invalid path")
        if not target.is_file():
            return _http_error(404, "file not found")
        try:
            data = target.read_bytes()
        except OSError:
            return _http_error(500, "read error")
        mime, _ = _mimetypes.guess_type(str(target))
        if not mime:
            mime = "application/octet-stream"
        safe_mimes = {
            "text/plain", "text/html", "text/css", "text/javascript",
            "application/json", "application/xml", "text/xml",
            "text/markdown", "text/csv",
            "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
        }
        if mime not in safe_mimes:
            mime = "text/plain"
        headers = Headers({
            "Content-Type": f"{mime}; charset=utf-8" if mime.startswith("text/") else mime,
            "Content-Length": str(len(data)),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        })
        return Response(status_code=200, headers=headers, body=data)
```

注意：此端点不做签名验证，因为预览面板只在 Tauri 本地使用（localhost），且路径由 `deliver_file` 工具提供（已经过 workspace 安全校验）。如果需要更高安全性，可以后续添加 HMAC 签名。

---

### Task 9: 前端 — DeliveredFileCard 组件

**Files:**
- Create: `webui/src/components/deliver/DeliveredFileCard.tsx`

- [ ] **Step 1: 创建 DeliveredFileCard 组件**

```tsx
import { useCallback } from "react";
import { FileText, Image, FileCode, File as FileIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isTauri, openPathWithSystemApp, revealItemInDir } from "@/lib/tauri";
import { useFilePreviewStore } from "./filePreviewStore";
import { cn } from "@/lib/utils";
import type { DeliveredFile } from "@/lib/types";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const CODE_EXTS = new Set([
  ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java", ".c", ".cpp",
  ".html", ".css", ".scss", ".json", ".yaml", ".yml", ".toml", ".sql",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function KindIcon({ name }: { name: string }) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext))
    return <Image className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (CODE_EXTS.has(ext))
    return <FileCode className="h-4 w-4 shrink-0 text-blue-500" />;
  return <FileText className="h-4 w-4 shrink-0 text-sky-500" />;
}

interface DeliveredFileCardProps {
  file: DeliveredFile;
  className?: string;
}

export function DeliveredFileCard({ file, className }: DeliveredFileCardProps) {
  const openPreview = useFilePreviewStore((s) => s.open);

  const handleClick = useCallback(() => {
    openPreview(file);
  }, [file, openPreview]);

  const handleOpenWithSystem = useCallback(() => {
    if (isTauri()) void openPathWithSystemApp(file.absolute_path);
  }, [file.absolute_path]);

  const handleRevealInDir = useCallback(() => {
    if (isTauri()) void revealItemInDir(file.absolute_path);
  }, [file.absolute_path]);

  const card = (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30",
        "px-3 py-2 text-left transition-colors",
        "hover:bg-muted/60 hover:border-border",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <KindIcon name={file.name} />
      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
        {file.name}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {file.size_human}
      </span>
    </button>
  );

  if (!isTauri()) {
    return card;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={handleClick}>
          预览
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenWithSystem}>
          系统程序打开
        </ContextMenuItem>
        <ContextMenuItem onClick={handleRevealInDir}>
          打开所在目录
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function DeliveredFileCardList({
  files,
  className,
}: {
  files: DeliveredFile[];
  className?: string;
}) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {files.map((f, i) => (
        <DeliveredFileCard key={`${f.absolute_path}-${i}`} file={f} />
      ))}
    </div>
  );
}
```

---

### Task 10: 前端 — MessageBubble 渲染 deliveredFiles

**Files:**
- Modify: `webui/src/components/MessageBubble.tsx`

- [ ] **Step 1: 导入 DeliveredFileCardList**

在文件顶部的 import 区域添加：

```typescript
import { DeliveredFileCardList } from "@/components/deliver/DeliveredFileCard";
```

- [ ] **Step 2: 在助手消息渲染中添加 deliveredFiles**

在 `<MarkdownText>` 组件之后、`{media.length > 0 ? <MessageMedia .../> : null}` 之前，添加：

```tsx
          {message.deliveredFiles && message.deliveredFiles.length > 0 ? (
            <DeliveredFileCardList
              files={message.deliveredFiles}
              className="mt-2"
            />
          ) : null}
```

---

### Task 11: 前端 — ThreadShell 集成 SplitPane + FilePreviewPanel

**Files:**
- Modify: `webui/src/components/thread/ThreadShell.tsx`

- [ ] **Step 1: 导入 SplitPane 和 FilePreviewPanel**

在 import 区域添加：

```typescript
import { SplitPane } from "@/components/deliver/SplitPane";
import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
```

- [ ] **Step 2: 在 ThreadShell 组件中使用 SplitPane**

在 `ThreadShell` 函数体内，`return` 语句之前，添加 store 订阅：

```typescript
  const previewFile = useFilePreviewStore((s) => s.file);
  const splitRatio = useFilePreviewStore((s) => s.splitRatio);
  const setSplitRatio = useFilePreviewStore((s) => s.setSplitRatio);
```

将现有的 `<section>` 返回内容改为：

```tsx
  return (
    <SplitPane
      left={
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {showHeader ? (
            <ThreadHeader
              title={title}
              onToggleSidebar={onToggleSidebar}
              theme={theme}
              onToggleTheme={onToggleTheme}
              hideSidebarToggleOnDesktop={hideSidebarToggleOnDesktop}
              minimal={!session && !loading}
            />
          ) : null}
          <ThreadViewport
            messages={displayMessages}
            isStreaming={isStreaming}
            emptyState={emptyState}
            composer={composer}
            scrollToBottomSignal={scrollToBottomSignal}
            conversationKey={historyKey}
            showScrollToBottomButton={!!session}
          />
        </section>
      }
      right={<FilePreviewPanel />}
      ratio={splitRatio}
      onRatioChange={setSplitRatio}
      rightVisible={!!previewFile}
    />
  );
```

---

### Task 12: 后端 — System Prompt 添加 deliver_file 指引

**Files:**
- Modify: `mona/templates/` 中的系统提示词模板

- [ ] **Step 1: 在工具指引中添加 deliver_file 使用说明**

找到系统提示词模板中关于工具使用的部分，添加：

```
When you create new files that the user should be aware of (reports, images, data exports, configuration files, etc.), call the `deliver_file` tool with the file paths. This makes the files appear as clickable cards in the conversation. Do NOT call deliver_file for temporary or intermediate files.
```

---

### Task 13: 前端 — 历史消息持久化支持

**Files:**
- Modify: `webui/src/hooks/useSessions.ts` 或相关持久化逻辑

- [ ] **Step 1: 确保 deliveredFiles 在会话持久化/恢复中被保留**

检查 `useSessions` 中的消息序列化/反序列化逻辑，确保 `deliveredFiles` 字段被正确保存和恢复。由于 `UIMessage` 类型已扩展，且持久化通常使用 JSON 序列化整个消息数组，`deliveredFiles` 应该自动被包含。需要确认没有白名单过滤字段名。

---

### Task 14: 端到端验证

- [ ] **Step 1: 启动开发服务器，验证工具注册**

启动 Mona 后端，确认 `deliver_file` 工具出现在可用工具列表中。

- [ ] **Step 2: 测试 AI 调用 deliver_file**

在对话中让 AI 创建一个文件并调用 `deliver_file`，确认：
1. 对话中出现 FileCard
2. 左键点击 FileCard 打开右侧预览面板
3. 预览面板显示文件内容（文本/图片）
4. 分割线可拖拽
5. 右键 FileCard 出现菜单
6. "预览"菜单项打开预览面板
7. "系统程序打开"菜单项用系统默认程序打开文件
8. "打开所在目录"菜单项在文件管理器中定位文件
9. 关闭预览面板后对话区域恢复全宽

- [ ] **Step 3: 验证非 Tauri 环境降级**

在浏览器模式下，确认 FileCard 仍可显示但右键菜单中"系统程序打开"和"打开所在目录"不出现。
