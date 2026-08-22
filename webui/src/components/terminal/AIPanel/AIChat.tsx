import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Shield, Square, FileText, Plus, X, Loader2 } from "lucide-react";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import {
  useAttachedImages,
  type AttachedImage,
  type AttachmentError,
  MAX_IMAGES_PER_MESSAGE,
} from "@/hooks/useAttachedImages";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import { useSessionHistory } from "@/hooks/useSessions";
import { useClient } from "@/providers/ClientProvider";
import { useTerminalStore } from "../store/terminalStore";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SessionType } from "../types/terminal";

/** Same MIME whitelist as ThreadComposer (mirrors server-side). */
const ACCEPT_ATTR = "image/png,image/jpeg,image/webp,image/gif";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  sessionId: string | null;
  sessionTypeOverride?: SessionType;
  onStreamingChange?: (streaming: boolean) => void;
}

interface ReportInfo {
  title: string;
  path: string;
  fileName: string;
}

export function AIChat({ sessionId, sessionTypeOverride, onStreamingChange }: Props) {
  const [draft, setDraft] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const { client } = useClient();
  const registry = useTerminalStore((s) => s.terminalRegistry);
  const execMode = useTerminalStore((s) => s.terminalExecMode);
  const setExecMode = useTerminalStore((s) => s.setTerminalExecMode);
  const storedSessionType = useTerminalStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.type ?? null,
  );
  const sessionType = sessionTypeOverride ?? storedSessionType;
  const canExec =
    sessionType === "ssh" || sessionType === "local" || sessionType === "desktop";
  const effectiveSessionId = canExec ? sessionId : null;
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const pendingImagesRef = useRef<SendImage[] | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { images, enqueue, remove, clear, encoding, full } = useAttachedImages();

  const readyImages = useMemo(
    () => images.filter((img): img is AttachedImage & { dataUrl: string } =>
      img.status === "ready" && typeof img.dataUrl === "string",
    ),
    [images],
  );
  const hasErrors = images.some((img) => img.status === "error");

  const formatRejection = useCallback((reason: AttachmentError): string => {
    switch (reason) {
      case "unsupported_type":
        return "不支持的图片类型";
      case "too_many_images":
        return `最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`;
      case "magic_mismatch":
        return "文件内容与扩展名不匹配";
      case "decode_failed":
        return "图片解码失败";
      case "too_large":
        return "图片过大";
      case "io":
        return "文件读取失败";
      default:
        return "图片处理失败";
    }
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { rejected } = enqueue(files);
      if (rejected.length > 0) {
        setInlineError(formatRejection(rejected[0].reason));
      } else {
        setInlineError(null);
      }
    },
    [enqueue, formatRejection],
  );

  const { isDragging, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop } =
    useClipboardAndDrop(addFiles);

  const onFilePick: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    addFiles(files);
  };

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client.newChat(5_000, true).then((id) => {
      if (!cancelled) setChatId(id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<ReportInfo>("terminal-report-ready", (event) => {
        setReports((prev) => [...prev, event.payload]);
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  const historyKey = chatId ? `websocket:${chatId}` : null;
  const {
    messages: historical,
    loading,
    hasPendingToolCalls,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const {
    messages,
    isStreaming,
    send,
    stop,
    setMessages,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      return historical;
    });
  }, [chatId, historical, historyVersion, loading, setMessages]);

  useEffect(() => {
    if (!chatId || isStreaming || creatingChat) return;
    const pendingPrompt = pendingPromptRef.current;
    if (!pendingPrompt) return;
    const opts = pendingSendOptsRef.current;
    const pendingImages = pendingImagesRef.current;
    pendingPromptRef.current = null;
    pendingSendOptsRef.current = null;
    pendingImagesRef.current = undefined;
    send(pendingPrompt, pendingImages, opts ?? undefined);
  }, [chatId, creatingChat, isStreaming, send]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, reports]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text && readyImages.length === 0) return;
    setDraft("");
    const enriched = enrichWithTerminalContext(text, effectiveSessionId, registry);
    const sendOpts: SendOptions = {
      terminalSessionId: effectiveSessionId ?? undefined,
      terminalExecMode: effectiveSessionId ? execMode : undefined,
      // IMPORTANT: displayContent shows the user's original input in the message
      // bubble, not the enriched prompt with terminal context. Persisted to server
      // for history replay. DO NOT remove this field.
      displayContent: text,
    };
    const payload: SendImage[] | undefined =
      readyImages.length > 0
        ? readyImages.map((img) => ({
            media: { data_url: img.dataUrl, name: img.file.name },
            preview: { url: img.dataUrl, name: img.file.name },
          }))
        : undefined;

    if (chatId) {
      send(enriched, payload, sendOpts);
      clear();
      return;
    }

    setCreatingChat(true);
    pendingPromptRef.current = enriched;
    pendingSendOptsRef.current = sendOpts;
    pendingImagesRef.current = payload;
    client.newChat(5_000, true).then((nextChatId) => {
      setChatId(nextChatId);
      setCreatingChat(false);
    }).catch(() => {
      pendingPromptRef.current = null;
      pendingSendOptsRef.current = null;
      pendingImagesRef.current = undefined;
      setCreatingChat(false);
    });
  }, [draft, chatId, effectiveSessionId, registry, client, execMode, send, readyImages, clear]);

  const handleStop = useCallback(() => {
    stop();
  }, [stop]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  };

  const canSend =
    !isStreaming
    && !encoding
    && !hasErrors
    && (draft.trim().length > 0 || readyImages.length > 0);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 text-black">
        {messages.length === 0 && reports.length === 0 && (
          <p className="text-center text-caption text-muted-foreground py-8">
            输入问题，AI 将基于终端上下文回答
          </p>
        )}
        <ThreadMessages messages={messages} isStreaming={isStreaming} />
        {reports.map((report, i) => (
          <Button
            key={`report-${i}`}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => openPathWithSystemApp(report.path)}
            className="gap-1.5 text-caption"
          >
            <FileText className="h-3.5 w-3.5 text-info" />
            <span className="font-medium">{report.title}</span>
            <span className="text-muted-foreground">— 点击查看报告</span>
          </Button>
        ))}
      </div>
      <div className="shrink-0 p-2">
        {canExec && (
          <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
            <Shield className="h-3 w-3 text-muted-foreground" />
            <Select
              value={execMode}
              onValueChange={(v) => setExecMode(v as "auto" | "approval")}
              aria-label="执行模式"
              options={[
                { value: "auto", label: "自动模式（普通步骤自动执行，高风险单独确认）" },
                { value: "approval", label: "审批模式（变更计划确认一次）" },
              ]}
              className="h-6 min-w-0 flex-1 border-transparent bg-transparent px-1 text-micro text-muted-foreground shadow-none"
            />
          </div>
        )}
        <div
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            "flex min-h-[52px] flex-col gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm transition-all",
            isDragging && "ring-2 ring-primary/40 border-primary/40",
          )}
        >
          {images.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {images.map((img) => (
                <AttachmentChip
                  key={img.id}
                  image={img}
                  formatError={formatRejection}
                  onRemove={() => {
                    remove(img.id);
                    setInlineError(null);
                  }}
                />
              ))}
            </div>
          ) : null}
          {inlineError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-micro font-medium text-destructive"
            >
              {inlineError}
            </div>
          ) : null}
          <div className="flex items-end gap-1.5">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={onPaste}
              placeholder="输入问题，AI 将基于终端上下文回答..."
              className="min-h-[36px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-caption text-black caret-black leading-5 shadow-none focus-visible:ring-0"
              rows={2}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              hidden
              onChange={onFilePick}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={full}
              aria-label="添加图片"
              className="h-6 w-6 shrink-0 text-muted-foreground"
            >
              <Plus className="h-3 w-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={isStreaming ? handleStop : handleSend}
              disabled={!canSend}
              aria-label={isStreaming ? "停止" : "发送"}
              className={cn(
                "h-6 w-6 shrink-0",
                isStreaming
                  ? "text-destructive hover:bg-destructive/10"
                  : "bg-action text-white hover:bg-action-hover hover:text-white disabled:bg-muted disabled:text-muted-foreground",
              )}
            >
              {isStreaming ? (
                <Square className="h-3 w-3" />
              ) : encoding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface AttachmentChipProps {
  image: AttachedImage;
  formatError: (reason: AttachmentError) => string;
  onRemove: () => void;
}

function AttachmentChip({ image, formatError, onRemove }: AttachmentChipProps) {
  const sizeLabel =
    image.status === "ready" && image.normalized && image.encodedBytes
      ? `${formatBytes(image.file.size)} → ${formatBytes(image.encodedBytes)}`
      : formatBytes(image.file.size);
  const tone =
    image.status === "error"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : "border-border/70 bg-muted/60";
  return (
    <div
      className={cn(
        "group relative flex items-center gap-1.5 rounded-md border px-1.5 py-1",
        "transition-colors",
        tone,
      )}
    >
      <div className="relative h-8 w-8 overflow-hidden rounded bg-background">
        {image.previewUrl ? (
          <img
            src={image.previewUrl}
            alt=""
            aria-hidden
            loading="eager"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : null}
        {image.status === "encoding" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col text-micro">
        <span className="truncate max-w-[8rem]" title={image.file.name}>
          {image.file.name}
        </span>
        <span className="truncate text-muted-foreground">
          {image.status === "error" && image.error
            ? formatError(image.error)
            : sizeLabel}
        </span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="移除图片"
        className="ml-0.5 h-4 w-4 flex-none rounded-full text-muted-foreground/80 hover:text-foreground"
      >
        <X className="h-3 w-3" aria-hidden />
      </Button>
    </div>
  );
}

export function enrichWithTerminalContext(
  message: string,
  sessionId: string | null,
  registry: { getBuffer: (id: string) => string },
): string {
  if (!sessionId) return message;
  const data = registry.getBuffer(sessionId);
  const binding = `[当前终端会话：${sessionId}]\n涉及命令时必须使用 terminal_task、terminal_exec 和 terminal_output；禁止使用 exec，它运行在 Mona 所在的本机，不是当前 SSH 桌面终端。`;
  if (!data || data.trim().length === 0) return `${binding}\n\n${message}`;
  const tail = data.length > 4000 ? data.slice(-4000) : data;
  return `${binding}\n\n[终端上下文]\n\`\`\`\n${tail}\n\`\`\`\n\n${message}`;
}
