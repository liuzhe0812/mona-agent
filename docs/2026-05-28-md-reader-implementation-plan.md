# 多标签 Markdown 文档阅读器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当用户从操作系统打开 .md 文件时，Mona 以多标签阅读器模式启动，支持可视化编辑和 Markdown 源码编辑，复用现有 Tiptap 编辑器。

**Architecture:** 从 NoteEditor 中抽取通用 MarkdownEditor 组件（Tiptap + 双模式切换），新建 MdReaderView 作为独立视图管理多文件标签。Rust 端通过 Tauri 的 `file-open` 事件接收 OS 文件打开请求，通过 emit 传递路径到前端。前端通过 `@tauri-apps/plugin-fs` 读写文件，Ctrl+S 直接写回原文件。

**Tech Stack:** Tauri v2 / React / Tiptap / Zustand / @tauri-apps/plugin-fs / @tauri-apps/plugin-dialog

---

## 文件结构

| 操作 | 路径 | 职责 |
|------|------|------|
| 新建 | `webui/src/components/md-reader/MdReaderView.tsx` | 多标签 Markdown 阅读器主视图 |
| 新建 | `webui/src/components/md-reader/MdReaderTabs.tsx` | 标签栏组件 |
| 新建 | `webui/src/components/md-reader/MdFileEditor.tsx` | 单文件编辑器（基于通用 MarkdownEditor） |
| 新建 | `webui/src/components/md-reader/mdReaderStore.ts` | Zustand store：管理打开的文件列表、活跃标签、dirty 状态 |
| 新建 | `webui/src/components/md-reader/useFileOpen.ts` | Hook：监听 Tauri file-open 事件 + 内部打开文件逻辑 |
| 新建 | `webui/src/components/common/MarkdownEditor.tsx` | 通用 Markdown 编辑器组件（从 NoteEditor 抽取） |
| 修改 | `webui/src/components/notes/NoteEditor.tsx` | 改用通用 MarkdownEditor，NoteEditor 变为薄包装层 |
| 修改 | `webui/src/App.tsx` | 新增 `"md-reader"` 视图类型，集成 MdReaderView |
| 修改 | `src-tauri/tauri.conf.json` | 添加 fileAssociations 配置 |
| 修改 | `src-tauri/src/lib.rs` | 监听 file-open 事件并 emit 到前端 |
| 修改 | `src-tauri/capabilities/default.json` | 添加 fs:allow-read-text-file 等权限（如需） |

---

### Task 1: 抽取通用 MarkdownEditor 组件

**Files:**
- Create: `webui/src/components/common/MarkdownEditor.tsx`
- Modify: `webui/src/components/notes/NoteEditor.tsx`

- [ ] **Step 1: 创建通用 MarkdownEditor 组件**

将 NoteEditor 中的 Tiptap 编辑器核心逻辑抽取为独立组件。接口设计：

```tsx
// webui/src/components/common/MarkdownEditor.tsx
import { useEffect, useMemo, useRef } from "react";
import type { JSONContent } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  CheckSquare,
  Code2,
  FileCode2,
  Heading2,
  Italic,
  Link2,
  ListChecks,
  ListOrdered,
  Quote,
  Redo2,
  Table2,
  Type,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type EditorMode = "visual" | "markdown";

export interface MarkdownEditorProps {
  content: string;
  mode?: EditorMode;
  onModeChange?: (mode: EditorMode) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => void;
  placeholder?: string;
  showToolbar?: boolean;
  showStats?: boolean;
  statsExtra?: React.ReactNode;
  className?: string;
  editorClassName?: string;
}

export function MarkdownEditor({
  content,
  mode = "visual",
  onModeChange,
  onContentChange,
  placeholder = "记录想法、资料、处理过程或 Agent 输出...",
  showToolbar = true,
  showStats = true,
  statsExtra,
  className,
  editorClassName,
}: MarkdownEditorProps) {
  const settingContentRef = useRef(false);
  const lastMarkdownRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          class: "text-[#2f7fca] underline underline-offset-2",
        },
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({ placeholder }),
      Markdown.configure({
        indentation: { style: "space", size: 2 },
      }),
    ],
    [placeholder],
  );

  const editor = useEditor({
    extensions,
    content,
    contentType: "markdown",
    editorProps: {
      attributes: {
        class: "notes-prosemirror",
      },
    },
    onUpdate: ({ editor }) => {
      if (settingContentRef.current) return;
      const contentMarkdown = editor.getMarkdown();
      lastMarkdownRef.current = contentMarkdown;
      onContentChangeRef.current({
        contentMarkdown,
        contentJson: editor.getJSON(),
        plainText: editor.getText(),
      });
    },
  });

  useEffect(() => {
    if (!editor) return;
    const editorMarkdown = editor.getMarkdown();
    const externalChange =
      content !== lastMarkdownRef.current &&
      content !== editorMarkdown;
    if (!externalChange) return;

    settingContentRef.current = true;
    editor.commands.setContent(content, { contentType: "markdown" });
    settingContentRef.current = false;
    lastMarkdownRef.current = content;
  }, [editor, content]);

  const handleMarkdownChange = (value: string) => {
    if (!editor) return;
    settingContentRef.current = true;
    editor.commands.setContent(value, { contentType: "markdown" });
    settingContentRef.current = false;
    lastMarkdownRef.current = value;
    onContentChange({
      contentMarkdown: value,
      contentJson: editor.getJSON(),
      plainText: editor.getText(),
    });
  };

  const charCount = content.replace(/\s/g, "").length;
  const lineCount = content.split(/\r?\n/).length;

  return (
    <section className={cn("flex min-w-0 flex-1 flex-col bg-background", className)}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        {showToolbar ? <EditorToolbar editor={editor} /> : <div />}
        <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/30 p-0.5">
          <button
            type="button"
            title="可视化编辑"
            aria-label="可视化编辑"
            onClick={() => onModeChange?.("visual")}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-md transition-colors",
              mode === "visual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Type className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="MD 源码"
            aria-label="MD 源码"
            onClick={() => onModeChange?.("markdown")}
            className={cn(
              "grid h-6 w-6 place-items-center rounded-md transition-colors",
              mode === "markdown"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FileCode2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {mode === "visual" ? (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className={cn("mx-auto w-full max-w-[700px] px-5 py-5", editorClassName)}>
            <EditorContent
              editor={editor}
              className="mt-4 text-[13.5px] leading-6 text-foreground [&_.ProseMirror]:min-h-[380px] [&_.ProseMirror]:outline-none [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:border-border [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_h2]:mb-2 [&_.ProseMirror_h2]:mt-5 [&_.ProseMirror_h2]:text-[18px] [&_.ProseMirror_h2]:font-semibold [&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-4 [&_.ProseMirror_h3]:text-[15px] [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_li]:my-0.5 [&_.ProseMirror_ol]:ml-5 [&_.ProseMirror_p]:my-1.5 [&_.ProseMirror_pre]:my-2.5 [&_.ProseMirror_pre]:overflow-x-auto [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:border [&_.ProseMirror_pre]:border-border/70 [&_.ProseMirror_pre]:bg-muted/45 [&_.ProseMirror_pre]:p-2.5 [&_.ProseMirror_table]:my-2.5 [&_.ProseMirror_table]:w-full [&_.ProseMirror_table]:border-collapse [&_.ProseMirror_td]:border [&_.ProseMirror_td]:border-border [&_.ProseMirror_td]:px-2 [&_.ProseMirror_td]:py-1.5 [&_.ProseMirror_th]:border [&_.ProseMirror_th]:border-border [&_.ProseMirror_th]:bg-muted/45 [&_.ProseMirror_th]:px-2 [&_.ProseMirror_th]:py-1.5 [&_.ProseMirror_ul]:ml-5"
            />
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className={cn("mx-auto flex h-full w-full max-w-[700px] flex-col px-5 py-5", editorClassName)}>
            <textarea
              value={content}
              onChange={(event) => handleMarkdownChange(event.target.value)}
              className="mt-4 min-h-[380px] flex-1 resize-none rounded-lg border border-border/70 bg-background px-3 py-2.5 font-mono text-[12.5px] leading-6 text-foreground outline-none scrollbar-thin focus:border-[#6aa7ff]/65"
              spellCheck={false}
            />
          </div>
        </div>
      )}

      {showStats ? (
        <div className="flex h-7 shrink-0 items-center justify-between border-t border-border/65 px-3 text-[11px] text-muted-foreground">
          <span>{statsExtra}</span>
          <span>
            {charCount} 字 · {lineCount} 行
          </span>
        </div>
      ) : null}
    </section>
  );
}

function EditorToolbar({ editor }: { editor: Editor | null }) {
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-thin">
      <ToolbarButton
        label="正文"
        active={editor?.isActive("paragraph") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().setParagraph().run()}
      >
        <Type className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="标题"
        active={editor?.isActive("heading", { level: 2 }) ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="加粗"
        active={editor?.isActive("bold") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="斜体"
        active={editor?.isActive("italic") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="任务清单"
        active={editor?.isActive("taskList") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleTaskList().run()}
      >
        <CheckSquare className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="项目列表"
        active={editor?.isActive("bulletList") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <ListChecks className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="编号列表"
        active={editor?.isActive("orderedList") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="引用"
        active={editor?.isActive("blockquote") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="代码块"
        active={editor?.isActive("codeBlock") ?? false}
        disabled={!editor}
        onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
      >
        <Code2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="表格"
        disabled={!editor}
        onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Table2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="链接"
        active={editor?.isActive("link") ?? false}
        disabled={!editor}
        onClick={() => {
          const url = window.prompt("输入链接地址");
          if (!url) return;
          editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        }}
      >
        <Link2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border/70" />
      <ToolbarButton
        label="撤销"
        disabled={!editor || !editor.can().chain().focus().undo().run()}
        onClick={() => editor?.chain().focus().undo().run()}
      >
        <Undo2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        label="重做"
        disabled={!editor || !editor.can().chain().focus().redo().run()}
        onClick={() => editor?.chain().focus().redo().run()}
      >
        <Redo2 className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  label,
  active = false,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "h-[26px] w-[26px] rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </Button>
  );
}
```

- [ ] **Step 2: 重构 NoteEditor 使用通用 MarkdownEditor**

将 `NoteEditor.tsx` 改为使用 `MarkdownEditor` 的薄包装层，保持对外接口不变：

```tsx
// webui/src/components/notes/NoteEditor.tsx
import { useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { ArrowLeft } from "lucide-react";

import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";

import type { OperationNote } from "./notes-data";

interface NoteEditorProps {
  note: OperationNote;
  saveStatus?: "idle" | "saving" | "saved" | "error";
  knowledgeReturnTitle?: string;
  onReturnToKnowledge?: () => void;
  onTitleChange: (title: string) => void;
  onContentChange: (next: {
    contentMarkdown: string;
    contentJson?: JSONContent;
    plainText: string;
  }) => void;
}

export function NoteEditor({
  note,
  saveStatus = "idle",
  knowledgeReturnTitle,
  onReturnToKnowledge,
  onTitleChange,
  onContentChange,
}: NoteEditorProps) {
  const [mode, setMode] = useState<EditorMode>("visual");

  const stats = useMemo(() => {
    const plainText = (note.plainText ?? "").trim();
    const markdownText = note.contentMarkdown
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[#>*_`|[\]-]/g, " ")
      .trim();
    const readableText = plainText || markdownText;
    const charCount = readableText.replace(/\s/g, "").length;
    const lineCount = note.contentMarkdown.split(/\r?\n/).length;

    return {
      charCount,
      lineCount,
    };
  }, [note.contentMarkdown, note.plainText]);

  const saveLabel =
    saveStatus === "saving"
      ? "正在保存..."
      : saveStatus === "error"
        ? "保存失败"
        : "已自动保存";

  return (
    <MarkdownEditor
      content={note.contentMarkdown}
      mode={mode}
      onModeChange={setMode}
      onContentChange={onContentChange}
      statsExtra={
        <span className={saveStatus === "error" ? "text-destructive" : undefined}>
          {saveLabel}
        </span>
      }
      editorClassName="relative"
    >
      {/* NoteEditor 的特殊 UI：标题输入框、知识库返回横幅等通过 children slot 或额外 prop 注入 */}
    </MarkdownEditor>
  );
}
```

注意：由于 MarkdownEditor 目前不支持在编辑区域上方插入标题输入框和知识库返回横幅，需要给 MarkdownEditor 添加一个 `children` slot（在编辑区域上方渲染）。更新 MarkdownEditor 的 props：

```tsx
// 在 MarkdownEditorProps 中添加
children?: React.ReactNode;
```

在 MarkdownEditor 的渲染中，在 `mode === "visual"` 和 `mode === "markdown"` 分支的编辑区域内部、`<div className="mx-auto ...">` 内、EditorContent/textarea 之前插入：

```tsx
{children}
```

然后 NoteEditor 中传入：

```tsx
<MarkdownEditor
  content={note.contentMarkdown}
  mode={mode}
  onModeChange={setMode}
  onContentChange={onContentChange}
  statsExtra={...}
>
  {knowledgeReturnTitle && onReturnToKnowledge ? (
    <KnowledgeReturnBanner
      title={knowledgeReturnTitle}
      onReturn={onReturnToKnowledge}
    />
  ) : null}
  <NoteTitleBlock note={note} onTitleChange={onTitleChange} />
</MarkdownEditor>
```

保留 `KnowledgeReturnBanner` 和 `NoteTitleBlock` 辅助组件在 NoteEditor.tsx 中不变。

- [ ] **Step 3: 验证笔记功能未受影响**

启动开发服务器，打开笔记视图，确认：
- 可视化编辑模式正常工作
- MD 源码模式正常工作
- 模式切换正常
- 工具栏按钮正常
- 自动保存正常
- 标题编辑正常
- 知识库返回横幅正常

Run: `cd webui && npm run dev`

- [ ] **Step 4: 提交**

```bash
git add webui/src/components/common/MarkdownEditor.tsx webui/src/components/notes/NoteEditor.tsx
git commit -m "refactor: extract MarkdownEditor from NoteEditor as reusable component"
```

---

### Task 2: 创建 MdReader Zustand Store

**Files:**
- Create: `webui/src/components/md-reader/mdReaderStore.ts`

- [ ] **Step 1: 创建 store**

```ts
// webui/src/components/md-reader/mdReaderStore.ts
import { create } from "zustand";
import type { EditorMode } from "@/components/common/MarkdownEditor";

export interface MdFileTab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  originalContent: string;
  mode: EditorMode;
  dirty: boolean;
  loading: boolean;
  error: string | null;
}

interface MdReaderState {
  tabs: MdFileTab[];
  activeTabId: string | null;

  openFile: (filePath: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  updateTabMode: (tabId: string, mode: EditorMode) => void;
  saveTab: (tabId: string) => Promise<void>;
  saveActiveTab: () => Promise<void>;
}

async function readMdFile(filePath: string): Promise<string> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(filePath);
}

async function writeMdFile(filePath: string, content: string): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(filePath, content);
}

function fileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "untitled.md";
}

export const useMdReaderStore = create<MdReaderState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: async (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    const existing = get().tabs.find((t) => t.filePath.replace(/\\/g, "/") === normalized);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    const tabId = crypto.randomUUID();
    const newTab: MdFileTab = {
      id: tabId,
      filePath,
      fileName: fileNameFromPath(filePath),
      content: "",
      originalContent: "",
      mode: "visual",
      dirty: false,
      loading: true,
      error: null,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }));

    try {
      const content = await readMdFile(filePath);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, content, originalContent: content, loading: false }
            : t,
        ),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, loading: false, error: message }
            : t,
        ),
      }));
    }
  },

  closeTab: (tabId: string) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      let nextActiveId = state.activeTabId;
      if (state.activeTabId === tabId) {
        nextActiveId = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null;
      }
      return { tabs: nextTabs, activeTabId: nextActiveId };
    });
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId });
  },

  updateTabContent: (tabId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, content, dirty: content !== t.originalContent }
          : t,
      ),
    }));
  },

  updateTabMode: (tabId: string, mode: EditorMode) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, mode } : t,
      ),
    }));
  },

  saveTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.dirty) return;
    try {
      await writeMdFile(tab.filePath, tab.content);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, originalContent: t.content, dirty: false }
            : t,
        ),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to save ${tab.filePath}:`, message);
      throw err;
    }
  },

  saveActiveTab: async () => {
    const { activeTabId, saveTab } = get();
    if (activeTabId) {
      await saveTab(activeTabId);
    }
  },
}));
```

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/md-reader/mdReaderStore.ts
git commit -m "feat(md-reader): add Zustand store for multi-tab file management"
```

---

### Task 3: 创建 MdReaderTabs 组件

**Files:**
- Create: `webui/src/components/md-reader/MdReaderTabs.tsx`

- [ ] **Step 1: 创建标签栏组件**

```tsx
// webui/src/components/md-reader/MdReaderTabs.tsx
import { FileText, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";

import type { MdFileTab } from "./mdReaderStore";

interface MdReaderTabsProps {
  tabs: MdFileTab[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onOpenFile: () => void;
}

export function MdReaderTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onOpenFile,
}: MdReaderTabsProps) {
  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border/75 bg-sidebar/95">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden scrollbar-thin">
        {tabs.map((tab) => (
          <MdTabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
        <button
          type="button"
          aria-label="打开文件"
          title="打开 Markdown 文件"
          onClick={onOpenFile}
          className="flex h-9 w-9 shrink-0 items-center justify-center border-r border-border/70 text-muted-foreground transition-colors hover:bg-sidebar-accent/75 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function MdTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: MdFileTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-9 min-w-0 shrink-0 items-center border-r border-border/70 text-[12.5px] font-medium transition-colors w-[152px]",
        active
          ? "bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--background))]"
          : "bg-sidebar/80 text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left"
      >
        <FileText
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active && "text-[#eba45d]",
          )}
        />
        <span className="min-w-0 truncate">
          {tab.dirty ? `${tab.fileName} ●` : tab.fileName}
        </span>
      </button>
      <button
        type="button"
        aria-label={`关闭 ${tab.fileName}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="mr-2 grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground/55 opacity-70 transition-colors hover:bg-foreground/8 hover:text-foreground group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/md-reader/MdReaderTabs.tsx
git commit -m "feat(md-reader): add tab bar component"
```

---

### Task 4: 创建 MdFileEditor 组件

**Files:**
- Create: `webui/src/components/md-reader/MdFileEditor.tsx`

- [ ] **Step 1: 创建单文件编辑器组件**

```tsx
// webui/src/components/md-reader/MdFileEditor.tsx
import { MarkdownEditor, type EditorMode } from "@/components/common/MarkdownEditor";

import type { MdFileTab } from "./mdReaderStore";

interface MdFileEditorProps {
  tab: MdFileTab;
  onContentChange: (content: string) => void;
  onModeChange: (mode: EditorMode) => void;
}

export function MdFileEditor({ tab, onContentChange, onModeChange }: MdFileEditorProps) {
  if (tab.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        正在加载 {tab.fileName}...
      </div>
    );
  }

  if (tab.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-sm font-medium text-destructive">加载失败</p>
        <p className="text-[12px] text-muted-foreground">{tab.error}</p>
      </div>
    );
  }

  return (
    <MarkdownEditor
      content={tab.content}
      mode={tab.mode}
      onModeChange={onModeChange}
      onContentChange={(next) => onContentChange(next.contentMarkdown)}
      placeholder="Markdown 文档内容..."
      showStats
      statsExtra={
        tab.dirty ? (
          <span className="text-[#eba45d]">未保存</span>
        ) : (
          <span>已保存</span>
        )
      }
    />
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/md-reader/MdFileEditor.tsx
git commit -m "feat(md-reader): add per-file editor component"
```

---

### Task 5: 创建 useFileOpen Hook

**Files:**
- Create: `webui/src/components/md-reader/useFileOpen.ts`

- [ ] **Step 1: 创建 Hook**

```ts
// webui/src/components/md-reader/useFileOpen.ts
import { useEffect } from "react";

import { isTauri } from "@/lib/tauri";

import { useMdReaderStore } from "./mdReaderStore";

export function useFileOpen() {
  const openFile = useMdReaderStore((s) => s.openFile);

  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<string>("md-file-open", (event) => {
          const filePath = event.payload;
          if (filePath) {
            openFile(filePath);
          }
        });

        if (cancelled) {
          unlisten();
          return;
        }

        return () => {
          unlisten();
        };
      } catch (err) {
        console.error("Failed to listen for md-file-open event:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [openFile]);
}
```

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/md-reader/useFileOpen.ts
git commit -m "feat(md-reader): add useFileOpen hook for Tauri event listener"
```

---

### Task 6: 创建 MdReaderView 主视图

**Files:**
- Create: `webui/src/components/md-reader/MdReaderView.tsx`

- [ ] **Step 1: 创建主视图组件**

```tsx
// webui/src/components/md-reader/MdReaderView.tsx
import { useCallback, useEffect } from "react";
import { FileText, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";

import { MdFileEditor } from "./MdFileEditor";
import { MdReaderTabs } from "./MdReaderTabs";
import { useMdReaderStore } from "./mdReaderStore";
import { useFileOpen } from "./useFileOpen";

interface MdReaderViewProps {
  onBack?: () => void;
}

export function MdReaderView({ onBack }: MdReaderViewProps) {
  const tabs = useMdReaderStore((s) => s.tabs);
  const activeTabId = useMdReaderStore((s) => s.activeTabId);
  const setActiveTab = useMdReaderStore((s) => s.setActiveTab);
  const closeTab = useMdReaderStore((s) => s.closeTab);
  const updateTabContent = useMdReaderStore((s) => s.updateTabContent);
  const updateTabMode = useMdReaderStore((s) => s.updateTabMode);
  const saveActiveTab = useMdReaderStore((s) => s.saveActiveTab);
  const openFile = useMdReaderStore((s) => s.openFile);

  useFileOpen();

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveActiveTab().catch((err) => {
          console.error("Save failed:", err);
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [saveActiveTab]);

  const handleOpenFile = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Markdown",
            extensions: ["md", "markdown", "mdx"],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const p of paths) {
        await openFile(p);
      }
    } catch (err) {
      console.error("Failed to open file dialog:", err);
    }
  }, [openFile]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.dirty) {
        const confirmed = window.confirm(
          `"${tab.fileName}" 有未保存的更改，确定关闭吗？`,
        );
        if (!confirmed) return;
      }
      closeTab(tabId);
    },
    [tabs, closeTab],
  );

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background">
        <FileText className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">打开 Markdown 文件开始阅读或编辑</p>
        <Button variant="outline" onClick={handleOpenFile}>
          <FolderOpen className="mr-2 h-4 w-4" />
          打开文件
        </Button>
        {onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack}>
            返回主界面
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <MdReaderTabs
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={setActiveTab}
        onClose={handleCloseTab}
        onOpenFile={handleOpenFile}
      />
      {activeTab ? (
        <MdFileEditor
          key={activeTab.id}
          tab={activeTab}
          onContentChange={(content) => updateTabContent(activeTab.id, content)}
          onModeChange={(mode) => updateTabMode(activeTab.id, mode)}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add webui/src/components/md-reader/MdReaderView.tsx
git commit -m "feat(md-reader): add main MdReaderView component"
```

---

### Task 7: 集成到 App.tsx

**Files:**
- Modify: `webui/src/App.tsx`

- [ ] **Step 1: 添加 md-reader 视图**

在 `App.tsx` 中：

1. 扩展 `ShellView` 类型：

```ts
type ShellView = "chat" | "settings" | "note" | "ssh" | "db" | "kb" | "md-reader";
```

2. 添加 lazy import（与其他 lazy 导入放在一起）：

```ts
const MdReaderView = lazy(() =>
  import("@/components/md-reader/MdReaderView").then((module) => ({
    default: module.MdReaderView,
  })),
);
```

3. 在 Shell 组件中添加 `onOpenMdReader` 回调：

```ts
const onOpenMdReader = useCallback(() => {
  setView("md-reader");
  setMobileSidebarOpen(false);
}, []);
```

4. 在视图渲染区域添加 md-reader 视图（在 `{view === "kb" && ...}` 之后）：

```tsx
{view === "md-reader" && (
  <div className="absolute inset-0 flex flex-col">
    <Suspense fallback={<ModuleLoading title="正在打开 Markdown 阅读器" />}>
      <MdReaderView onBack={onBackToChat} />
    </Suspense>
  </div>
)}
```

5. 在 sidebar props 中传入 `onOpenMdReader`（如果 Sidebar 需要导航入口的话）。

- [ ] **Step 2: 验证视图切换**

启动开发服务器，确认可以在不同视图间切换，md-reader 视图显示空状态。

Run: `cd webui && npm run dev`

- [ ] **Step 3: 提交**

```bash
git add webui/src/App.tsx
git commit -m "feat(md-reader): integrate MdReaderView into App shell"
```

---

### Task 8: Tauri 端 - 文件关联配置

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`（如需）

- [ ] **Step 1: 配置文件关联**

在 `src-tauri/tauri.conf.json` 的 `bundle` 对象中添加：

```json
"fileAssociations": [
  {
    "ext": ["md", "markdown"],
    "name": "Markdown Document",
    "role": "Editor",
    "mimeType": "text/markdown"
  }
]
```

- [ ] **Step 2: Rust 端监听 file-open 事件**

在 `src-tauri/src/lib.rs` 的 `setup` 闭包中添加文件打开事件监听：

```rust
// 在 setup 闭包中，tray::setup_tray(app)?; 之后添加：

use tauri::Listener;
let app_handle = app.handle().clone();
app.listen("tauri://file-open", move |event| {
    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
        if let Some(paths) = payload.get("paths").and_then(|p| p.as_array()) {
            for path in paths {
                if let Some(path_str) = path.as_str() {
                    let _ = app_handle.emit("md-file-open", path_str);
                }
            }
        }
    }
});
```

注意：Tauri v2 的 `file-open` 事件在应用已运行时通过 `tauri://file-open` 事件触发。首次启动时文件路径通过命令行参数传入，需要额外处理。

在 `setup` 闭包中添加命令行参数处理：

```rust
// 处理首次启动时的命令行文件参数
for arg in std::env::args().skip(1) {
    let lower = arg.to_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        let _ = app_handle.emit("md-file-open", arg);
    }
}
```

- [ ] **Step 3: 检查并更新 capabilities**

检查 `src-tauri/capabilities/default.json` 是否已有 `fs:allow-read-text-file` 权限。当前有 `fs:allow-read-file`（读取二进制），但 `readTextFile` 可能需要额外权限。查看 Tauri v2 的 fs 插件权限模型，`fs:default` 通常已包含基本读写。如果 `readTextFile` 不在默认权限中，需要添加：

```json
"fs:allow-read-text-file"
```

- [ ] **Step 4: 提交**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat(md-reader): add file association and file-open event handling"
```

---

### Task 9: 端到端集成测试

**Files:**
- 无新文件

- [ ] **Step 1: 构建并测试**

1. 构建 Tauri 应用：

Run: `cd webui && npm run build:tauri`

2. 安装构建产物，验证：
   - 右键 .md 文件 → "打开方式" → 选择 Mona
   - Mona 启动后自动进入 md-reader 视图并显示文件内容
   - 可视化编辑和 MD 源码模式切换正常
   - Ctrl+S 保存后文件内容更新
   - 修改后标签显示 ● 标记
   - 关闭 dirty 标签时弹出确认对话框
   - 打开多个文件时标签切换正常
   - 从应用内通过"打开文件"按钮选择 .md 文件

- [ ] **Step 2: 修复发现的问题**

根据测试结果修复任何问题。

- [ ] **Step 3: 最终提交**

```bash
git add -A
git commit -m "feat(md-reader): multi-tab markdown document reader with file association"
```

---

## 自检清单

**1. Spec 覆盖度：**
- ✅ OS 文件关联 → Task 8
- ✅ 多标签管理 → Task 2 (store) + Task 3 (tabs) + Task 6 (view)
- ✅ 可视化编辑 + MD 源码编辑 → Task 1 (通用 MarkdownEditor)
- ✅ Ctrl+S 直接写回原文件 → Task 2 (saveTab) + Task 6 (键盘监听)
- ✅ 复用现有编辑器 → Task 1 (抽取通用组件)
- ✅ 从应用内打开文件 → Task 6 (handleOpenFile + dialog)

**2. 占位符扫描：** 无 TBD/TODO/占位符

**3. 类型一致性：**
- `MdFileTab.mode` 类型为 `EditorMode`（从 MarkdownEditor 导出）
- `openFile` 在 store 和 useFileOpen 中签名一致
- `onContentChange` 回调在 MdFileEditor 和 MarkdownEditor 间正确桥接
