import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Send, Square } from "lucide-react";

import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { cn } from "@/lib/utils";
import { uploadReferenceImage } from "./threeState";

interface ThreeChatPanelProps {
  chatId: string | null;
  projectName: string | null;
  onStreamingChange?: (streaming: boolean) => void;
  onReferenceUploaded?: () => void;
}

export interface ThreeChatPanelHandle {
  send: (content: string, displayContent?: string) => void;
}

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isImageFile(file: File): boolean {
  if (file.type && ACCEPTED_IMAGE_TYPES.has(file.type)) return true;
  const lower = file.name.toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].some((ext) => lower.endsWith(ext));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const ThreeChatPanel = forwardRef<ThreeChatPanelHandle, ThreeChatPanelProps>(function ThreeChatPanel(
  { chatId, projectName, onStreamingChange, onReferenceUploaded },
  ref,
) {
  const [draft, setDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const historyKey = chatId ? `websocket:${chatId}` : null;
  const {
    messages: historical,
    loading,
    error: historyError,
    hasPendingToolCalls,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const {
    messages,
    isStreaming,
    send,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current !== isStreaming) {
      onStreamingChange?.(isStreaming);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
    }
  }, [chatId, setMessages]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      return historical;
    });
  }, [chatId, historical, historyVersion, loading, setMessages]);

  const messagesLen = messages.length;
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesLen]);

  const sendDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !chatId || isStreaming) return;
    setDraft("");
    send(trimmed);
  }, [chatId, draft, isStreaming, send]);

  const uploadImages = useCallback(
    async (files: File[]) => {
      if (!projectName || !chatId || files.length === 0) return;
      const images = files.filter(isImageFile);
      if (images.length === 0) return;
      setUploading(true);
      setUploadError(null);
      try {
        const uploadedPaths: string[] = [];
        for (const file of images) {
          const dataUrl = await readFileAsDataUrl(file);
          const result = await uploadReferenceImage(projectName, dataUrl, file.name);
          uploadedPaths.push(result.path);
        }
        onReferenceUploaded?.();
        const projectPath = `three_projects/${projectName}`;
        const fullPaths = uploadedPaths.map((p) => `${projectPath}/${p}`);
        const prompt = images.length === 1
          ? `项目「${projectName}」（project_path: ${projectPath}）已上传参考图：${fullPaths[0]}。请开始 img2threejs 流程：先用 mona_pipeline.py intake 分析参考图生成 assessment.json，再编写 object-sculpt-spec.json 并通过 mona_pipeline.py validate 严格校验，最后用 mona_pipeline.py build-current-pass 生成 Three.js 模型代码。`
          : `项目「${projectName}」（project_path: ${projectPath}）已上传 ${images.length} 张参考图：${fullPaths.join(", ")}。请以第一张为主参考图，用 mona_pipeline.py 开始 img2threejs 流程。`;
        send(prompt);
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "上传参考图失败");
      } finally {
        setUploading(false);
      }
    },
    [projectName, chatId, send, onReferenceUploaded],
  );

  const onPickImages = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) void uploadImages(files);
    event.target.value = "";
  }, [uploadImages]);

  const onPaste = useCallback((event: React.ClipboardEvent) => {
    const items = Array.from(event.clipboardData.items ?? []);
    const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) void uploadImages(files);
  }, [uploadImages]);

  useImperativeHandle(ref, () => ({
    send: (content: string, displayContent?: string) => {
      if (!chatId) return;
      send(content, undefined, displayContent ? { displayContent } : undefined);
    },
  }), [chatId, send]);

  if (!chatId) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        创建项目后开始对话
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-thin" onPaste={onPaste}>
        <div className="space-y-3">
          {historyError ? (
            <div className="text-[11px] text-destructive">会话历史加载失败：{historyError}</div>
          ) : null}
          {streamError ? (
            <div className="flex items-center justify-between text-[11px] text-destructive">
              <span>消息过大或连接异常，请缩短内容后重试。</span>
              <button
                type="button"
                onClick={dismissStreamError}
                className="text-foreground/65 hover:text-foreground"
              >
                关闭
              </button>
            </div>
          ) : null}
          {uploadError ? (
            <div className="flex items-center justify-between text-[11px] text-destructive">
              <span>参考图上传失败：{uploadError}</span>
              <button
                type="button"
                onClick={() => setUploadError(null)}
                className="text-foreground/65 hover:text-foreground"
              >
                关闭
              </button>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>正在加载会话...</span>
            </div>
          ) : null}

          <ThreadMessages messages={messages} isStreaming={isStreaming} />

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={onPickImages}
          />
          <button
            type="button"
            aria-label="上传参考图"
            disabled={!chatId || isStreaming || uploading || !projectName}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
              "text-muted-foreground hover:bg-accent hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImagePlus className="h-3.5 w-3.5" />
            )}
          </button>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            onPaste={onPaste}
            disabled={!chatId || isStreaming}
            className="min-h-[36px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={2}
            placeholder="输入消息或上传参考图..."
          />
          <button
            type="button"
            aria-label={isStreaming ? "停止生成" : "发送"}
            disabled={!isStreaming && (!chatId || !draft.trim())}
            onClick={isStreaming ? stop : sendDraft}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
              isStreaming
                ? "text-destructive hover:bg-destructive/10"
                : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground",
            )}
          >
            {isStreaming ? (
              <Square className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
