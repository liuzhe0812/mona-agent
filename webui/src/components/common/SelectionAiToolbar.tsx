import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { Loader2, Languages, Minimize2, Wand2, Check, X } from "lucide-react";
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
      // Only show for text selections (not node selections like images)
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

      // Compute toolbar position relative to wrapper
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      try {
        const coords = editor.view.coordsAtPos(from);
        const rect = wrapper.getBoundingClientRect();
        setToolbarPos({
          top: coords.top - rect.top - 40,
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

  // Hide toolbar when editor loses focus (slight delay to allow button clicks)
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
    // Validate current selection still matches
    const { from, to } = result;
    const currentText = editor.state.doc.textBetween(from, to, "\n");
    if (currentText !== result.originalText) {
      // Selection changed, don't replace
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

  // Don't render anything if no selection or editor missing
  if (!editor || (!selection && !pendingAction && !result)) return null;
  if (!toolbarPos && !pendingAction && !result) return null;

  const showResult = result && !pendingAction;
  const showActions = selection && !pendingAction && !result && !isStreaming;

  return (
    <>
      {/* Floating action toolbar */}
      {showActions && toolbarPos ? (
        <div
          style={{ top: toolbarPos.top, left: toolbarPos.left }}
          className="absolute z-50 flex items-center gap-0.5 rounded-lg border border-border/70 bg-popover p-0.5 shadow-lg"
          onMouseDown={(e) => e.preventDefault()}
        >
          <ToolbarActionButton
            label="润色"
            icon={<Wand2 className="h-3.5 w-3.5" />}
            onClick={() => void runAction("polish")}
          />
          <ToolbarActionButton
            label="缩写"
            icon={<Minimize2 className="h-3.5 w-3.5" />}
            onClick={() => void runAction("shorten")}
          />
          <ToolbarActionButton
            label="翻译"
            icon={<Languages className="h-3.5 w-3.5" />}
            onClick={() => void runAction("translate")}
          />
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

function ToolbarActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
      <span>{label}</span>
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
