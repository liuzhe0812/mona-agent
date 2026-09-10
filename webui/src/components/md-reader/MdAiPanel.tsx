import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Sparkles, Square, X } from "lucide-react";

import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { useClientOptional } from "@/providers/ClientProvider";
import { cn } from "@/lib/utils";
import type { UIMessage } from "@/lib/types";

interface MdAiPanelProps {
  filePath: string;
  fileName: string;
  content: string;
  chatId: string | undefined;
  onChatIdChange: (chatId: string) => void;
  width: number;
  onClose: () => void;
  onStreamingChange?: (streaming: boolean) => void;
  onFileEdited: () => void;
  /** AI 编辑前先把编辑器里未保存的内容落盘，避免 reloadTab 丢失用户输入 */
  onPrepareEdit: () => Promise<void>;
}

export function MdAiPanel({
  filePath,
  fileName,
  content,
  chatId,
  onChatIdChange,
  width,
  onClose,
  onStreamingChange,
  onFileEdited,
  onPrepareEdit,
}: MdAiPanelProps) {
  const { client } = useClientOptional();
  const [draft, setDraft] = useState("");
  const [creatingChat, setCreatingChat] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingPromptRef = useRef<string | null>(null);

  const historyKey = chatId ? `websocket:${chatId}` : null;
  const {
    messages: historical,
    loading,
    hasPendingToolCalls,
    version: historyVersion,
  } = useSessionHistory(historyKey);

  // 用 ref 让 turn_end 回调能读到最新 messages，避免回调依赖 messages 导致频繁重建
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const messagesRef = useRef<UIMessage[]>([]);
  const lastTurnEndRef = useRef<number>(0);

  const handleTurnEnd = useCallback(() => {
    const now = Date.now();
    if (now - lastTurnEndRef.current < 500) return;
    lastTurnEndRef.current = now;

    // 只有 AI 在本回合确实修改了当前文件，才触发 reload
    const currentPath = filePathRef.current.replace(/\\/g, "/");
    let touched = false;
    for (const m of messagesRef.current) {
      if (!m.fileEdits) continue;
      for (const edit of m.fileEdits) {
        const editPath = (edit.absolute_path || edit.path || "").replace(/\\/g, "/");
        if (editPath && currentPath === editPath) {
          touched = true;
          break;
        }
      }
      if (touched) break;
    }
    if (touched) onFileEdited();
  }, [onFileEdited]);

  const {
    messages,
    isStreaming,
    send,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId ?? null, historical, hasPendingToolCalls, handleTurnEnd);

  messagesRef.current = messages;

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // 切换文件时重置状态
  const lastFileRef = useRef(filePath);
  useEffect(() => {
    if (lastFileRef.current === filePath) return;
    lastFileRef.current = filePath;
    setDraft("");
    setNotice(null);
    if (!chatId) setMessages([]);
  }, [filePath, chatId, setMessages]);

  // 同步历史消息
  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      return historical;
    });
  }, [chatId, historical, historyVersion, loading, setMessages]);

  // 发送待处理的 prompt
  useEffect(() => {
    if (!chatId || loading || creatingChat) return;
    const pending = pendingPromptRef.current;
    if (!pending) return;
    pendingPromptRef.current = null;
    send(pending);
  }, [chatId, creatingChat, loading, send]);

  // 自动消失 notice
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // turn_end 检测逻辑已上移到 useMonaStream 初始化之前（用 ref 读取最新 messages）

  const sendDraft = useCallback(async () => {
    const text = draft.trim();
    if (!text || creatingChat) return;
    if (isStreaming) {
      setNotice("AI 正在处理，请稍候");
      return;
    }

    // AI 编辑前先把编辑器里未保存的内容落盘，避免 reloadTab 丢失用户输入
    try {
      await onPrepareEdit();
    } catch (err) {
      console.error("prepare edit failed:", err);
      setNotice("保存当前内容失败，请重试");
      return;
    }

    setDraft("");

    // 引导 AI 直接调用文件工具改磁盘上的 .md 文件：
    // - edit_file：精准替换一处文本，适合小改（改词、加句、补链接）
    // - write_file：整文件覆盖，适合大重构（段落重排、整段重写、全文重构）
    // 不要在回复中复制修改后的内容；完成后简要说明做了什么。
    const prompt = `当前正在查看 Markdown 文件：${fileName}\n文件路径：${filePath}\n\n文件内容：\n${content}\n\n用户要求：${text}\n\n你可以使用以下工具直接修改该文件：\n- edit_file(path, old_string, new_string)：精准替换一处唯一匹配的文本，适合小改\n- write_file(path, content)：整文件覆盖，适合大重构（段落重排、整段重写）\n\n文件路径已提供，请直接调用工具修改文件，不要在回复中输出修改后的内容。完成编辑后简要说明你做了什么修改。`;

    if (chatId) {
      send(prompt, undefined, { displayContent: text });
      return;
    }

    if (!client) {
      setNotice("运行时未就绪，请稍后再试");
      return;
    }

    setCreatingChat(true);
    setNotice("正在创建会话");
    pendingPromptRef.current = prompt;
    // 把 .md 文件所在目录绑定为会话 workspace，使 edit_file/write_file 的
    // restrict_to_workspace 校验通过——AI 才能直接修改该文件
    const fileDir = filePath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    try {
      const nextChatId = await client.newChat(5_000, true, fileDir || null);
      onChatIdChange(nextChatId);
    } catch {
      pendingPromptRef.current = null;
      setNotice("创建会话失败");
    } finally {
      setCreatingChat(false);
    }
  }, [draft, chatId, client, creatingChat, isStreaming, send, content, fileName, filePath, onChatIdChange, onPrepareEdit]);

  const handleReset = useCallback(() => {
    setMessages([]);
    onChatIdChange("");
  }, [setMessages, onChatIdChange]);

  const hasMessages = messages.length > 0;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-border/70 bg-card"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-ui font-semibold text-foreground">Mona</h2>
        </div>
        <div className="flex items-center gap-1">
          {notice ? (
            <span className="max-w-28 truncate text-micro text-muted-foreground">{notice}</span>
          ) : null}
          {chatId ? (
            <Button
              type="button"
              variant="ghost"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={handleReset}
              className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {isStreaming ? (
            <Button
              type="button"
              variant="ghost"
              aria-label="停止生成"
              title="停止生成"
              onClick={stop}
              className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Square className="h-3 w-3" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            aria-label="关闭面板"
            onClick={onClose}
            className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 scrollbar-hover">
        {streamError ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-caption leading-relaxed text-muted-foreground">
            <span className="min-w-0 flex-1">消息过大或连接异常，请缩短内容后重试。</span>
            <Button
              type="button"
              variant="ghost"
              onClick={dismissStreamError}
              className="h-auto shrink-0 p-0 text-caption text-foreground/65 hover:bg-transparent hover:text-foreground"
            >
              关闭
            </Button>
          </div>
        ) : null}

        {!hasMessages && !loading ? (
          <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5" />
              输入消息让 AI 编辑文档
            </span>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-caption text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取会话历史...
            </span>
          </div>
        ) : null}

        <ThreadMessages messages={messages} isStreaming={isStreaming} />

        {creatingChat ? (
          <div className="flex items-center justify-center py-4 text-caption text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在创建会话...
            </span>
          </div>
        ) : null}
        {isStreaming ? (
          <div className="flex items-center justify-center py-4 text-caption text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              AI 正在处理...
            </span>
          </div>
        ) : null}
      </div>

      {/* Input */}
      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendDraft();
              }
            }}
            disabled={creatingChat}
            placeholder="输入消息让 AI 编辑..."
            rows={2}
            className="min-h-[36px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-caption leading-5 shadow-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <Button
            type="button"
            variant="ghost"
            aria-label="发送"
            onClick={sendDraft}
            disabled={!draft.trim() || creatingChat || isStreaming}
            className={cn(
              "h-6 w-6 shrink-0 rounded-lg p-0",
              isStreaming
                ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
                : "bg-action text-white hover:bg-action-hover hover:text-white disabled:bg-muted disabled:text-muted-foreground",
            )}
          >
            {creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isStreaming ? (
              <Square className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>
    </aside>
  );
}
