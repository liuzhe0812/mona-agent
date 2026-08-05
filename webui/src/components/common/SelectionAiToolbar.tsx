import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import {
  Loader2,
  Languages,
  Minimize2,
  Wand2,
  Check,
  X,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link2,
  Sparkles,
  Quote,
  List,
  ListOrdered,
  CheckSquare,
  Code2,
  ExternalLink,
} from "lucide-react";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useClientOptional } from "@/providers/ClientProvider";

type SelectionAction = "polish" | "shorten" | "translate";

interface SelectionInfo {
  text: string;
  from: number;
  to: number;
}

interface PendingResult {
  action: SelectionAction;
  originalText: string;
  from: number;
  to: number;
  content: string;
}

const ACTION_LABELS: Record<SelectionAction, string> = {
  polish: "润色",
  shorten: "缩写",
  translate: "翻译",
};

const ACTION_PROMPTS: Record<SelectionAction, string> = {
  polish: "请润色以下文本，使其更通顺、专业。保持原意不变，保持原文的语言。只输出润色后的结果，不要解释。",
  shorten: "请缩写以下文本，保留核心信息，压缩到原文的 50% 以内。保持原文的语言。只输出缩写结果，不要解释。",
  translate: "请翻译以下文本。规则：中文译英文，其他语言译中文。保持原文的格式。只输出译文，不要解释。",
};

function buildPrompt(action: SelectionAction, noteTitle: string, selectedText: string): string {
  return [
    `笔记标题: ${noteTitle}`,
    "",
    "选中文本:",
    selectedText,
    "",
    ACTION_PROMPTS[action],
  ].join("\n");
}

interface Props {
  editor: Editor | null;
  getNoteTitle: () => string;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}

export function SelectionAiToolbar({ editor, getNoteTitle, wrapperRef }: Props) {
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);
  const [pendingAction, setPendingAction] = useState<SelectionAction | null>(null);
  const [result, setResult] = useState<PendingResult | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [applied, setApplied] = useState(false);
  const [showAISubmenu, setShowAISubmenu] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const aiSubmenuRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayRef = useRef<string | null>(null);
  const pendingActionRef = useRef<SelectionAction | null>(null);
  const pendingSelectionRef = useRef<SelectionInfo | null>(null);
  const { client } = useClientOptional();
  const { messages, isStreaming, send } = useMonaStream(chatId);

  // Track selection changes in the editor
  useEffect(() => {
    if (!editor) return;
    const handleSelectionUpdate = () => {
      const { from, to, empty } = editor.state.selection;
      if (empty || from === to) {
        setSelection(null);
        setToolbarPos(null);
        return;
      }
      if (!(editor.state.selection instanceof TextSelection)) {
        setSelection(null);
        setToolbarPos(null);
        return;
      }
      const text = editor.state.doc.textBetween(from, to, "\n");
      if (!text || text.trim().length === 0) {
        setSelection(null);
        setToolbarPos(null);
        return;
      }
      setSelection({ text, from, to });

      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      try {
        const coords = editor.view.coordsAtPos(from);
        const rect = wrapper.getBoundingClientRect();
        setToolbarPos({
          top: coords.top - rect.top - 48,
          left: coords.left - rect.left,
        });
      } catch {
        setToolbarPos(null);
      }
    };
    editor.on("selectionUpdate", handleSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", handleSelectionUpdate);
    };
  }, [editor, wrapperRef]);

  // Hide toolbar when editor loses focus
  useEffect(() => {
    if (!editor) return;
    const handleBlur = () => {
      setTimeout(() => {
        if (!pendingActionRef.current) {
          setSelection(null);
          setToolbarPos(null);
        }
      }, 200);
    };
    editor.on("blur", handleBlur);
    return () => {
      editor.off("blur", handleBlur);
    };
  }, [editor]);

  // Close AI submenu on outside click
  useEffect(() => {
    if (!showAISubmenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (aiSubmenuRef.current && !aiSubmenuRef.current.contains(event.target as Node)) {
        setShowAISubmenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAISubmenu]);

  // Send pending prompt when chatId becomes available
  useEffect(() => {
    if (!chatId || isStreaming || creatingChat) return;
    const prompt = pendingPromptRef.current;
    if (!prompt) return;
    const display = pendingDisplayRef.current;
    pendingPromptRef.current = null;
    pendingDisplayRef.current = null;
    const opts: SendOptions | undefined = display ? { displayContent: display } : undefined;
    send(prompt, undefined, opts);
  }, [chatId, creatingChat, isStreaming, send]);

  // Extract result when streaming completes
  useEffect(() => {
    if (pendingActionRef.current === null || isStreaming || creatingChat) return;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.trim().length > 0);
    if (!lastAssistant) return;

    const sel = pendingSelectionRef.current;
    if (!sel) return;

    setResult({
      action: pendingActionRef.current,
      originalText: sel.text,
      from: sel.from,
      to: sel.to,
      content: lastAssistant.content.trim(),
    });
    setPendingAction(null);
    pendingActionRef.current = null;
    pendingSelectionRef.current = null;
  }, [messages, isStreaming, creatingChat]);

  const runAction = useCallback(
    async (action: SelectionAction) => {
      if (!editor || !selection || isStreaming) return;
      const { from, to, text } = selection;
      const prompt = buildPrompt(action, getNoteTitle(), text);
      pendingActionRef.current = action;
      pendingSelectionRef.current = { text, from, to };
      pendingPromptRef.current = prompt;
      pendingDisplayRef.current = `${ACTION_LABELS[action]}选区`;
      setPendingAction(action);
      setResult(null);
      setApplied(false);
      setShowAISubmenu(false);

      if (chatId) {
        const opts: SendOptions = { displayContent: pendingDisplayRef.current };
        send(prompt, undefined, opts);
        return;
      }

      if (!client) return;
      setCreatingChat(true);
      try {
        const nextChatId = await client.newChat(5_000, true);
        setChatId(nextChatId);
      } catch {
        pendingActionRef.current = null;
        pendingSelectionRef.current = null;
        pendingPromptRef.current = null;
        pendingDisplayRef.current = null;
        setPendingAction(null);
      } finally {
        setCreatingChat(false);
      }
    },
    [editor, selection, isStreaming, chatId, client, send, getNoteTitle],
  );

  const handleReplace = useCallback(() => {
    if (!editor || !result) return;
    const { from, to } = result;
    const currentText = editor.state.doc.textBetween(from, to, "\n");
    if (currentText !== result.originalText) {
      return;
    }
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContentAt(from, result.content)
      .run();
    setApplied(true);
    setTimeout(() => {
      setResult(null);
      setSelection(null);
      setToolbarPos(null);
    }, 800);
  }, [editor, result]);

  const handleInsertAfter = useCallback(() => {
    if (!editor || !result) return;
    const { to } = result;
    editor.chain().focus().insertContentAt(to, `\n\n${result.content}\n`).run();
    setApplied(true);
    setTimeout(() => {
      setResult(null);
      setSelection(null);
      setToolbarPos(null);
    }, 800);
  }, [editor, result]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.content);
      setApplied(true);
      setTimeout(() => {
        setResult(null);
        setSelection(null);
        setToolbarPos(null);
      }, 800);
    } catch {}
  }, [result]);

  const handleCancel = useCallback(() => {
    setResult(null);
    setPendingAction(null);
    pendingActionRef.current = null;
    pendingSelectionRef.current = null;
  }, []);

  const handleToggleLink = useCallback(() => {
    if (!editor) return;
    if (showLinkInput) {
      if (linkUrl === "") {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
      } else {
        editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl }).run();
      }
      setShowLinkInput(false);
      setLinkUrl("");
    } else {
      const previousUrl = editor.getAttributes("link").href;
      setLinkUrl(previousUrl || "");
      setShowLinkInput(true);
    }
  }, [editor, linkUrl, showLinkInput]);

  if (!editor || (!selection && !pendingAction && !result)) return null;
  if (!toolbarPos && !pendingAction && !result) return null;

  const showResult = result && !pendingAction;
  const showActions = selection && !pendingAction && !result && !isStreaming;
  const currentLinkHref = editor.getAttributes("link").href as string | undefined;

  return (
    <>
      {/* Floating action toolbar */}
      {showActions && toolbarPos ? (
        <div
          ref={menuRef}
          style={{ top: toolbarPos.top, left: toolbarPos.left }}
          className="absolute z-50 flex items-center gap-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* AI 按钮 + 子菜单 */}
          <div className="relative">
            <FormatToggleButton
              label="AI"
              icon={<Sparkles className="h-4 w-4" />}
              active={showAISubmenu}
              onClick={() => setShowAISubmenu((v) => !v)}
              accent
            />
            {showAISubmenu ? (
              <div
                ref={aiSubmenuRef}
                className="absolute left-0 top-full mt-1 min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
              >
                <SubmenuItem
                  icon={<Wand2 className="h-4 w-4" />}
                  label={ACTION_LABELS.polish}
                  onClick={() => void runAction("polish")}
                />
                <SubmenuItem
                  icon={<Minimize2 className="h-4 w-4" />}
                  label={ACTION_LABELS.shorten}
                  onClick={() => void runAction("shorten")}
                />
                <SubmenuItem
                  icon={<Languages className="h-4 w-4" />}
                  label={ACTION_LABELS.translate}
                  onClick={() => void runAction("translate")}
                />
              </div>
            ) : null}
          </div>

          <ToolbarSeparator />

          {/* 文本格式化 */}
          <FormatToggleButton
            label="加粗"
            icon={<Bold className="h-4 w-4" />}
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          />
          <FormatToggleButton
            label="斜体"
            icon={<Italic className="h-4 w-4" />}
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          />
          <FormatToggleButton
            label="删除线"
            icon={<Strikethrough className="h-4 w-4" />}
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
          />
          <FormatToggleButton
            label="行内代码"
            icon={<Code className="h-4 w-4" />}
            active={editor.isActive("code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
          />

          <ToolbarSeparator />

          {/* 链接输入框 */}
          {showLinkInput ? (
            <div className="flex items-center gap-1 px-1">
              <input
                type="url"
                autoFocus
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleToggleLink();
                  else if (e.key === "Escape") {
                    setShowLinkInput(false);
                    setLinkUrl("");
                  }
                }}
                placeholder="链接地址"
                className="h-7 w-32 rounded-md border border-border/70 bg-background px-2 text-[11.5px] outline-none focus:border-primary"
              />
              <LinkConfirmButton onClick={handleToggleLink} />
              <LinkCancelButton
                onClick={() => {
                  setShowLinkInput(false);
                  setLinkUrl("");
                }}
              />
            </div>
          ) : (
            <FormatToggleButton
              label="链接"
              icon={<Link2 className="h-4 w-4" />}
              active={editor.isActive("link")}
              onClick={handleToggleLink}
            />
          )}

          <ToolbarSeparator />

          {/* 块级元素 */}
          <FormatToggleButton
            label="引用"
            icon={<Quote className="h-4 w-4" />}
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          />
          <FormatToggleButton
            label="项目列表"
            icon={<List className="h-4 w-4" />}
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          />
          <FormatToggleButton
            label="编号列表"
            icon={<ListOrdered className="h-4 w-4" />}
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
          />
          <FormatToggleButton
            label="任务清单"
            icon={<CheckSquare className="h-4 w-4" />}
            active={editor.isActive("taskList")}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
          />
          <FormatToggleButton
            label="代码块"
            icon={<Code2 className="h-4 w-4" />}
            active={editor.isActive("codeBlock")}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          />

          {currentLinkHref ? (
            <>
              <ToolbarSeparator />
              <FormatToggleButton
                label="打开链接"
                icon={<ExternalLink className="h-4 w-4" />}
                onClick={() => {
                  if (currentLinkHref) window.open(currentLinkHref, "_blank");
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {/* Loading indicator */}
      {pendingAction ? (
        <div
          style={toolbarPos ? { top: toolbarPos.top, left: toolbarPos.left } : undefined}
          className="absolute z-50 flex items-center gap-1.5 rounded-lg border border-border/70 bg-popover px-2.5 py-1.5 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <span className="text-[11.5px] text-muted-foreground">
            {ACTION_LABELS[pendingAction]}中…
          </span>
        </div>
      ) : null}

      {/* Result preview */}
      {showResult && toolbarPos ? (
        <div
          style={{ top: toolbarPos.top, left: toolbarPos.left }}
          className="absolute z-50 flex max-h-[300px] w-[320px] flex-col rounded-lg border border-border/70 bg-popover shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5">
            <span className="text-[11px] font-medium text-foreground">
              {ACTION_LABELS[result.action]}结果
            </span>
            {applied ? (
              <span className="inline-flex items-center gap-1 text-[10.5px] text-[#1f9d7a]">
                <Check className="h-3 w-3" />
                已应用
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-2.5 py-2">
            <p className="whitespace-pre-wrap text-[12px] leading-5 text-foreground">
              {result.content}
            </p>
          </div>
          {!applied ? (
            <div className="flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1.5">
              <ResultButton label="替换选区" onClick={handleReplace} />
              <ResultButton label="插入其后" onClick={handleInsertAfter} />
              <ResultButton label="复制" onClick={() => void handleCopy()} />
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3 w-3" />
                取消
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ToolbarSeparator() {
  return <div className="mx-0.5 h-5 w-px bg-border/70" />;
}

function FormatToggleButton({
  label,
  icon,
  active = false,
  onClick,
  accent = false,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  accent?: boolean;
}) {
  const base =
    "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors";
  const activeCls = active
    ? accent
      ? "bg-primary/15 text-primary"
      : "bg-accent text-foreground"
    : accent
      ? "text-primary hover:bg-accent hover:text-primary"
      : "text-foreground/82 hover:bg-accent hover:text-foreground";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className={`${base} ${activeCls}`}
    >
      {icon}
    </button>
  );
}

function SubmenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function LinkConfirmButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="确认"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/82 hover:bg-accent hover:text-foreground"
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  );
}

function LinkCancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="取消"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-foreground/82 hover:bg-accent hover:text-foreground"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

function ResultButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-6 items-center rounded-md border border-border/70 bg-background px-2 text-[10.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground"
    >
      {label}
    </button>
  );
}
