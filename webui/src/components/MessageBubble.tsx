import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ArrowUpToLine, Check, ChevronRight, Copy, CornerDownLeft, Download, FolderOpen, GitFork, Loader2, MoreHorizontal, Share2, Sparkles, SquareTerminal, Wrench, BookmarkCheck, Bookmark } from "lucide-react";
import { FileSystemIcon } from "@/components/ui/file-system-icon";
import { useTranslation } from "react-i18next";

import { ImageLightbox } from "@/components/ImageLightbox";
import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import { DeliveredFileCardList } from "@/components/deliver/DeliveredFileCard";
import { ConversationFileContext } from "@/components/deliver/ConversationFileContext";
import { ConversationBrowserContext } from "@/components/deliver/ConversationBrowserContext";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { copyImageToClipboard } from "@/lib/copy-image";
import { formatTurnLatency } from "@/lib/format";
import { deriveNoteTitle } from "@/lib/note-title";
import { saveReplyImageAsNote } from "@/lib/reply-image-note";
import { formatToolCallTrace, isCommandTrace } from "@/lib/tool-traces";
import { createNoteFromChat, downloadMediaUrl, isTauri, openExternalUrl, revealItemInDir } from "@/lib/tauri";
import type { QuoteMessageHandler, UIImage, UIMediaAttachment, UIMessage } from "@/lib/types";
import { InlineWidget } from "@/components/visualizer/InlineWidget";
import { fetchGeneratedMedia, isGeneratedMediaUrl } from "@/hosted-work/generated-media";
import { duplicateGeneratedImageSources } from "@/hosted-work/duplicate-generated-images";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/** Suggest a filename (with extension) from a media URL and optional name. */
function suggestMediaFilename(
  url: string,
  name: string | undefined,
  fallbackBase: string,
): string {
  if (name && /\.[a-zA-Z0-9]{2,5}$/.test(name)) return name;
  try {
    const seg = new URL(url).pathname.split("/").pop();
    if (seg && /\.[a-zA-Z0-9]{2,5}$/.test(seg)) return decodeURIComponent(seg);
  } catch {
    // not an http URL
  }
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)/.exec(url);
    if (m && MIME_TO_EXT[m[1].toLowerCase()]) return `${fallbackBase}.${MIME_TO_EXT[m[1]]}`;
  }
  return fallbackBase;
}

interface MessageBubbleProps {
  message: UIMessage;
  widgetImages?: UIMediaAttachment[];
  /** Render assistant turns as left-aligned IM bubbles for collaboration groups. */
  isGroupChat?: boolean;
  partnerChat?: boolean;
  /** Queue this message as the source for a follow-up reply. */
  onQuote?: QuoteMessageHandler;
  /** User-visible author name for a quoted assistant turn. */
  authorName?: string;
  /** Start a new task using this reply as its branch context. */
  onBranch?: (message: UIMessage, author: string) => void;
  onWidgetPrompt?: (text: string) => void;
  onJumpToReplyStart?: (target: HTMLElement) => void;
  showTurnActions?: boolean;
}

const LONG_REPLY_CHAR_THRESHOLD = 1_600;
const LONG_REPLY_LINE_THRESHOLD = 24;
const LEGACY_ATTACHED_FILES_PREFIX = "\n\n[已附文件: ";
const PARTNER_BUBBLE = "rounded-xl border border-border/70 bg-muted px-4 py-3";

function visibleUserContent(message: UIMessage, media: UIMediaAttachment[]): string {
  const content = message.displayContent ?? message.content;
  if (!media.some((item) => item.kind === "file") || !content.endsWith("]")) {
    return content;
  }
  const markerIndex = content.lastIndexOf(LEGACY_ATTACHED_FILES_PREFIX);
  return markerIndex >= 0 ? content.slice(0, markerIndex) : content;
}

function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function formatMessageTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(value);
}

function QuotedMessagePreview({ quote }: { quote: NonNullable<UIMessage["quote"]> }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 border-l-2 border-foreground/15 bg-background/35 px-2.5 py-1.5 text-left">
      <div className="text-caption font-medium text-muted-foreground">
        {t("message.quotedMessage", { author: quote.author })}
      </div>
      <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-caption leading-relaxed text-muted-foreground">
        {quote.content}
      </div>
    </div>
  );
}

function selectedTextWithin(element: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!element.contains(selection.getRangeAt(0).commonAncestorContainer)) return null;
  const text = selection.toString();
  return text.trim() ? text : null;
}

function MessageContextMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [selectedText, setSelectedText] = useState("");

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const text = selectedTextWithin(event.currentTarget);
    if (!text) {
      event.preventDefault();
      return;
    }
    setSelectedText(text);
  }, []);

  const handleCopy = useCallback(() => {
    if (!selectedText || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(selectedText);
  }, [selectedText]);

  return (
    <ContextMenu onOpenChange={(open) => !open && setSelectedText("")}>
      <ContextMenuTrigger asChild onContextMenuCapture={handleContextMenu}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleCopy}>
          <Copy className="h-4 w-4" aria-hidden />
          {t("message.copyMessage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MessageActionTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Render a single message. Following agent-chat-ui: user turns are a rounded
 * "pill" right-aligned with a muted fill; direct assistant turns use open
 * markdown while group-chat assistant turns use a neutral bubble.
 * Each turn fades+slides in for a touch of motion polish.
 *
 * Trace rows (tool-call hints, progress breadcrumbs) render as a subdued
 * collapsible group so intermediate steps never masquerade as replies.
 */
export function MessageBubble({
  message,
  widgetImages,
  isGroupChat = false,
  partnerChat = false,
  onQuote,
  authorName,
  onBranch,
  onWidgetPrompt,
  onJumpToReplyStart,
  showTurnActions = true,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const openConversationBrowser = useContext(ConversationBrowserContext);
  const duplicateImageSources = useMemo(
    () => message.role === "assistant" && !message.isStreaming
      ? duplicateGeneratedImageSources(message.inlineMediaFiles ?? message.deliveredFiles, message.media) : [],
    [message.role, message.isStreaming, message.deliveredFiles, message.inlineMediaFiles, message.media],
  );
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharingImage, setSharingImage] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const copyResetRef = useRef<number | null>(null);
  const saveResetRef = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const empty = message.content.trim().length === 0;
  const resolvedMedia = useResolvedMessageMedia(
    message.role !== "user" && message.kind !== "trace" && (!empty || !message.isStreaming)
      ? message.media : undefined,
  );
  const media = resolvedMedia.media;
  const singleReplyImage = message.role === "assistant" && empty && media.length === 1 && media[0].kind === "image"
    ? media[0] : undefined;
  const replyImage = singleReplyImage?.url ? singleReplyImage : undefined;
  const imageActions = useImageActions(replyImage);
  const baseAnim = "animate-in fade-in-0 slide-in-from-bottom-1 duration-300";

  useEffect(() => {
    setExpanded(false);
  }, [message.id, message.isStreaming]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      if (saveResetRef.current !== null) {
        window.clearTimeout(saveResetRef.current);
      }
    };
  }, []);

  const onCopyMessage = useCallback(() => {
    if (!navigator.clipboard) return;
    const content = message.role === "user"
      ? visibleUserContent(message, message.media ?? [])
      : message.content;
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 1_500);
    });
  }, [message]);

  const onSaveAsNote = useCallback(() => {
    if (message.role !== "assistant" || !isTauri() || saved || saving) return;
    setSaving(true);
    const imageUrl = replyImage?.url;
    const note = imageUrl
      ? saveReplyImageAsNote(imageUrl, replyImage.name, t("message.imageAttachment"))
      : createNoteFromChat(deriveNoteTitle(message.content), message.content);
    note
      .then(() => {
        setSaved(true);
        if (saveResetRef.current !== null) {
          window.clearTimeout(saveResetRef.current);
        }
        saveResetRef.current = window.setTimeout(() => {
          setSaved(false);
          saveResetRef.current = null;
        }, 2_000);
      })
      .catch((err) => {
        window.alert(imageUrl ? t("message.saveImageAsNoteFailed") : `保存笔记失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setSaving(false));
  }, [message.content, message.role, replyImage, saved, saving, t]);

  const onShareAsImage = useCallback(async () => {
    const target = messageContentRef.current;
    if (!target || sharingImage) return;
    setSharingImage(true);
    try {
      const { toBlob } = await import("html-to-image");
      const blob = await toBlob(target, {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        cacheBust: true,
        pixelRatio: 2,
      });
      if (!blob) throw new Error("image render failed");
      const fileName = `mona-message-${Date.now()}.png`;
      if (isTauri()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const savePath = await save({
          defaultPath: fileName,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (!savePath) return;
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        await writeFile(savePath, new Uint8Array(await blob.arrayBuffer()));
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        window.alert(t("message.shareImageFailed"));
      }
    } finally {
      setSharingImage(false);
    }
  }, [sharingImage, t]);

  const quoteAuthor = authorName ?? (message.role === "user" ? t("message.you") : "Mona");
  const canQuote = !message.isStreaming && (!empty || replyImage);
  const quoteMessage = onQuote && canQuote ? () => {
    if (replyImage?.url) onQuote(message, quoteAuthor, { url: replyImage.url, name: replyImage.name });
    else onQuote(message, quoteAuthor);
  } : undefined;
  const canSaveAsNote = message.role === "assistant" && !message.isStreaming && (!empty || replyImage) && isTauri();
  const hasCopied = replyImage ? imageActions.copied : copied;
  const copyLabel = t(replyImage ? "message.copyImage" : "message.copyMessage");
  const copyAction = (
    <MessageActionTooltip label={copyLabel}>
      <button
        type="button"
        onClick={replyImage ? imageActions.handleCopy : onCopyMessage}
        disabled={replyImage && imageActions.busy}
        aria-label={hasCopied ? t(replyImage ? "message.imageCopied" : "message.copiedMessage") : copyLabel}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {hasCopied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      </button>
    </MessageActionTooltip>
  );
  const quoteAction = partnerChat && quoteMessage ? (
    <MessageActionTooltip label={t("message.quoteMessage")}>
      <Button type="button" variant="ghost" size="icon" aria-label={t("message.quoteMessage")}
        className="h-7 w-7" onClick={quoteMessage}>
        <CornerDownLeft className="h-4 w-4" aria-hidden />
      </Button>
    </MessageActionTooltip>
  ) : null;

  if (message.kind === "trace") {
    return <TraceGroup message={message} animClass={baseAnim} />;
  }

  if (message.role === "user") {
    const images = message.images ?? [];
    const media = message.media ?? [];
    const hasImages = images.length > 0;
    const visibleMedia = hasImages
      ? media.filter((item) => item.kind !== "image")
      : media;
    const displayContent = visibleUserContent(message, media);
    const hasText = displayContent.trim().length > 0;
    return (
      <MessageContextMenu>
        <div
          data-testid={`message-bubble-${message.id}`}
        className={cn(
          "group ml-auto flex max-w-[min(85%,36rem)] min-w-0 flex-col items-end gap-1.5",
          baseAnim,
        )}
        >
          {hasImages ? <MessageImages images={images} align="right" /> : null}
        {visibleMedia.length > 0 ? <MessageMedia media={visibleMedia} align="right" /> : null}
        {hasText ? (
          <div
            className={cn(
              "ml-auto max-w-full select-text text-left",
              partnerChat ? PARTNER_BUBBLE : "rounded-2xl bg-secondary/70 px-4 py-2",
            )}
          >
            {message.quote ? <QuotedMessagePreview quote={message.quote} /> : null}
            <p className="text-[16px]/[1.75] whitespace-pre-wrap break-words">
            {/* IMPORTANT: Use displayContent (short label) when available, fallback to content.
                DO NOT change to just message.content — displayContent ensures user messages
                show the original input, not the enriched prompt with terminal/DB context.
                This is persisted to the server for history replay. */}
            {displayContent}
            </p>
          </div>
        ) : null}
        {message.isInjected && (
          <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary/60">
            <CornerDownLeft className="h-3 w-3" aria-hidden />
            {t("thread.composer.pendingQueue.injectedBadge")}
          </span>
        )}
        {partnerChat && hasText ? (
          <TooltipProvider delayDuration={250}>
            <div className="flex min-h-7 items-center gap-0.5 text-muted-foreground">
              {copyAction}
              {quoteAction}
            </div>
          </TooltipProvider>
        ) : null}
        </div>
      </MessageContextMenu>
    );
  }

  if (message.kind === "widget" && message.widget) {
    if (widgetImages?.length) return <MessageMedia media={widgetImages} align="left" />;
    const widget = message.widget;
    return <InlineWidget id={message.id} title={widget.title} code={widget.code}
      loadingMessages={widget.loadingMessages} streaming={widget.status === "streaming"}
      error={widget.error} onSendPrompt={onWidgetPrompt}
      onOpenLink={(url) => {
        if (!/^https?:\/\//i.test(url)) return;
        if (isTauri() && openConversationBrowser) openConversationBrowser(url);
        else void openExternalUrl(url);
      }} />;
  }

  const hasDeliveredFiles = !!(message.deliveredFiles && message.deliveredFiles.length > 0);
  const showDeliveredFiles = hasDeliveredFiles && !message.isStreaming;
  const reasoning = message.role === "assistant" ? message.reasoning ?? "" : "";
  const reasoningStreaming = !!(message.role === "assistant" && message.reasoningStreaming);
  const hasReasoning = reasoning.length > 0 || reasoningStreaming;
  const isAssistantBubble = (isGroupChat || partnerChat) && message.role === "assistant";
  const showDirectActions =
    !isGroupChat
    && message.role === "assistant"
    && showTurnActions
    && !message.isStreaming
    && (!empty || showDeliveredFiles || media.length > 0);

  const latencyMs = message.latencyMs;
  const showLatencyFooter =
    isGroupChat
    && message.role === "assistant"
    && latencyMs != null
    && !message.isStreaming
    && (!empty || hasReasoning || media.length > 0);
  const canCollapseReply =
    isGroupChat
    && message.role === "assistant"
    && !message.isStreaming
    && !empty
    && (
      message.content.length > LONG_REPLY_CHAR_THRESHOLD
      || message.content.split(/\r?\n/).length > LONG_REPLY_LINE_THRESHOLD
    );
  const replyCollapsed = canCollapseReply && !expanded;
  const renderedContent = <MarkdownText streaming={!!message.isStreaming}
    duplicateImageSources={duplicateImageSources}>{message.content}</MarkdownText>;
  return (
    <MessageContextMenu>
      <div
      data-testid={`message-bubble-${message.id}`}
      className={cn(
        "group/message w-full min-w-0",
        partnerChat ? "text-body-lg" : "text-[15px]",
        isAssistantBubble && "w-fit max-w-[min(85%,48rem)] self-start",
        baseAnim,
      )}
      style={{ lineHeight: "var(--cjk-line-height)" }}
    >
      <div
        ref={messageContentRef}
        tabIndex={showDirectActions && onJumpToReplyStart ? -1 : undefined}
        className={cn(
          isAssistantBubble && (partnerChat
            ? cn(PARTNER_BUBBLE, "w-fit max-w-full")
            : "rounded-2xl border border-border/70 bg-muted/55 px-4 py-3"),
        )}
      >
      {hasReasoning ? (
        <ReasoningBubble text={reasoning} streaming={reasoningStreaming} hasBodyBelow={!empty} />
      ) : null}
      {empty && message.isStreaming && !hasReasoning ? (
        <TypingDots />
      ) : empty && message.isStreaming ? null : (
        <>
          <div className={cn("relative", replyCollapsed && "max-h-96 overflow-hidden")}>
            {renderedContent}
            {replyCollapsed ? (
              <div
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background via-background/90 to-transparent",
                  isAssistantBubble && "from-muted via-muted/90",
                )}
              />
            ) : null}
          </div>
          {showDeliveredFiles ? (
            <DeliveredFileCardList
              files={message.deliveredFiles!}
              className="mt-2"
            />
          ) : null}
          {media.length > 0 ? <ResolvedMessageMedia {...resolvedMedia} align="left" /> : null}
          {canCollapseReply ? (
            <button
              type="button"
              aria-expanded={!replyCollapsed}
              onClick={() => setExpanded((value) => !value)}
              className="mt-2 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {replyCollapsed ? t("message.showAll") : t("message.collapse")}
            </button>
          ) : null}
          {showLatencyFooter ? (
            <div className="mt-2 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
              <span
                className="text-[11px] leading-none text-muted-foreground/70 tabular-nums"
                title={t("message.turnLatencyTitle")}
              >
                {formatTurnLatency(latencyMs)}
              </span>
            </div>
          ) : null}
        </>
      )}
      </div>
      {showDirectActions ? (
        <TooltipProvider delayDuration={250}>
        <div
          data-testid="direct-message-actions"
          className={cn(
            "mt-1 flex min-h-7 items-center gap-0.5 text-muted-foreground transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100",
            partnerChat || moreActionsOpen ? "opacity-100" : "opacity-0",
          )}
        >
          {!empty || replyImage ? copyAction : null}
          {quoteAction}
          <MessageActionTooltip label={t("message.shareAsImage")}>
          <button
            type="button"
            onClick={() => void onShareAsImage()}
            disabled={sharingImage || Boolean(singleReplyImage && !replyImage)}
            aria-label={t("message.shareAsImage")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Share2 className="h-4 w-4" aria-hidden />
          </button>
          </MessageActionTooltip>
          {onBranch && (!empty || singleReplyImage) ? (
            <MessageActionTooltip label={t("message.branchTask")}>
            <button
              type="button"
              onClick={() => onBranch(message, quoteAuthor)}
              aria-label={t("message.branchTask")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <GitFork className="h-4 w-4" aria-hidden />
            </button>
            </MessageActionTooltip>
          ) : null}
          {quoteMessage || canSaveAsNote ? <DropdownMenu open={moreActionsOpen} onOpenChange={setMoreActionsOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("message.moreActions")}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>{t("message.moreActions")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" sideOffset={4}>
              {quoteMessage ? (
                <DropdownMenuItem onSelect={quoteMessage}>
                  <CornerDownLeft className="h-4 w-4" aria-hidden />
                  {t("message.quoteMessage")}
                </DropdownMenuItem>
              ) : null}
              {canSaveAsNote ? (
                <DropdownMenuItem disabled={saving} onSelect={onSaveAsNote}>
                  {saved ? <BookmarkCheck className="h-4 w-4" aria-hidden /> : <Bookmark className="h-4 w-4" aria-hidden />}
                  {saved ? t("message.savedAsNote") : t("message.saveAsNote")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu> : null}
          <ImageActionErrorDialog error={imageActions.actionError} onDismiss={imageActions.dismissError} />
          {partnerChat ? null : (
            <span className="ml-1 text-[11px] tabular-nums text-muted-foreground/70">
              {formatMessageTime(message.createdAt)}
            </span>
          )}
          {message.tokenUsage?.totalTokens ? (
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {t("message.tokenUsage", {
                count: formatMessageTokenCount(message.tokenUsage.totalTokens),
              })}
            </span>
          ) : null}
          {onJumpToReplyStart ? (
            <MessageActionTooltip label={t("message.jumpToReplyStart")}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="ml-auto h-7 w-7 shrink-0 hover:bg-muted/60"
                aria-label={t("message.jumpToReplyStart")}
                onClick={() => {
                  if (messageContentRef.current) onJumpToReplyStart(messageContentRef.current);
                }}
              >
                <ArrowUpToLine className="h-4 w-4" aria-hidden />
              </Button>
            </MessageActionTooltip>
          ) : null}
        </div>
        </TooltipProvider>
      ) : null}
      </div>
    </MessageContextMenu>
  );
}

export function MessageMedia({
  media,
  align,
}: {
  media: UIMediaAttachment[];
  align: "left" | "right";
}) {
  const resolvedMedia = useResolvedMessageMedia(media);
  return <ResolvedMessageMedia {...resolvedMedia} align={align} />;
}

function useResolvedMessageMedia(media: UIMediaAttachment[] = []) {
  const sessionKey = useContext(ConversationFileContext)?.sessionKey ?? "";
  const generatedKey = JSON.stringify({ sessionKey, sources: [...new Set(media
    .filter((item) => item.kind === "image" && isGeneratedMediaUrl(item.url))
    .map((item) => item.url!))] });
  const [generated, setGenerated] = useState<{ key: string; urls: Record<string, string>; failed: string[] }>(
    { key: "", urls: {}, failed: [] },
  );
  useEffect(() => {
    const { sessionKey: sourceSession, sources } = JSON.parse(generatedKey) as { sessionKey: string; sources: string[] };
    if (sources.length === 0) return;
    const controller = new AbortController();
    const created = new Set<string>();
    let active = true;
    let cursor = 0;
    const revoke = () => { for (const url of created) URL.revokeObjectURL(url); created.clear(); };
    const accountChanged = () => {
      active = false; controller.abort(); revoke();
      setGenerated({ key: generatedKey, urls: {}, failed: [] });
    };
    window.addEventListener("mona-account-changed", accountChanged);
    const worker = async () => {
      while (active && cursor < sources.length) {
        const source = sources[cursor++];
        try {
          const blob = await fetchGeneratedMedia(source, sourceSession, controller.signal);
          if (!active) return;
          const url = URL.createObjectURL(blob);
          created.add(url);
          setGenerated((previous) => ({ key: generatedKey,
            urls: { ...(previous.key === generatedKey ? previous.urls : {}), [source]: url },
            failed: previous.key === generatedKey ? previous.failed : [] }));
        } catch {
          if (active) setGenerated((previous) => ({ key: generatedKey,
            urls: previous.key === generatedKey ? previous.urls : {},
            failed: [...(previous.key === generatedKey ? previous.failed : []), source] }));
        }
      }
    };
    for (let i = 0; i < Math.min(4, sources.length); i++) void worker();
    return () => {
      active = false; controller.abort(); revoke();
      window.removeEventListener("mona-account-changed", accountChanged);
    };
  }, [generatedKey]);
  const current = generated.key === generatedKey ? generated : undefined;
  return {
    media: media.map((item) => item.kind === "image" && item.url && isGeneratedMediaUrl(item.url)
      ? { ...item, url: current?.urls[item.url] } : item),
    hasFailedImages: Boolean(current?.failed.length),
  };
}

function ResolvedMessageMedia({
  media,
  hasFailedImages,
  align,
}: ReturnType<typeof useResolvedMessageMedia> & { align: "left" | "right" }) {
  if (media.length === 0) return null;
  const images = media.filter((item) => item.kind === "image");
  const nonImages = media.filter((item) => item.kind !== "image");

  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap gap-2",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {images.length > 0 ? (
        <MessageImages images={images} align={align} />
      ) : null}
      {hasFailedImages && (
        <span role="status" className="text-caption text-muted-foreground">图片暂时无法查看，请刷新会话后重试。</span>
      )}
      {nonImages.map((item, i) => (
        <MediaCell key={`${item.url ?? item.name ?? item.kind}-${i}`} media={item} />
      ))}
    </div>
  );
}

function MediaCell({ media }: { media: UIMediaAttachment }) {
  const { t } = useTranslation();
  const hasUrl = typeof media.url === "string" && media.url.length > 0;

  if (media.kind === "video" && hasUrl) {
    return (
      <figure className="max-w-[min(100%,32rem)] overflow-hidden rounded-xl border border-border/60 bg-muted/40">
        <video
          src={media.url}
          controls
          preload="metadata"
          className="block max-h-[26rem] w-full bg-black"
          aria-label={media.name ? `${t("message.videoAttachment", { defaultValue: "Video attachment" })}: ${media.name}` : t("message.videoAttachment", { defaultValue: "Video attachment" })}
        />
        {media.name ? (
          <figcaption className="truncate px-3 py-1.5 text-[11.5px] text-muted-foreground">
            {media.name}
          </figcaption>
        ) : null}
      </figure>
    );
  }

  const label =
    media.kind === "video"
      ? t("message.videoAttachment", { defaultValue: "Video attachment" })
      : t("message.fileAttachment", { defaultValue: "File attachment" });

  const inner = (
    <>
      <FileSystemIcon name={media.name ?? (media.kind === "video" ? "video.mp4" : "file")} />
      <span className="truncate">{media.name ?? label}</span>
    </>
  );

  if (hasUrl) {
    return (
      <a
        href={media.url}
        download={media.name ?? label}
        title={media.name ?? undefined}
        aria-label={label}
        className="flex max-w-[18rem] items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground hover:underline"
      >
        {inner}
      </a>
    );
  }

  return (
    <div
      className="flex max-w-[18rem] items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      title={media.name ?? undefined}
      aria-label={label}
    >
      {inner}
    </div>
  );
}

function MessageImages({
  images,
  align,
}: {
  images: UIImage[];
  align: "left" | "right";
}) {
  const { t } = useTranslation();
  const [imageIndex, setImageIndex] = useState(0);
  const [openedIndex, setOpenedIndex] = useState<number | null>(null);
  const preview = align === "left";
  const showThumbnails = preview && images.length > 1;
  const selectedIndex = Math.min(imageIndex, images.length - 1);
  const viewableIndexes = images.flatMap((image, index) => image.url ? [index] : []);
  const lightboxIndex = openedIndex === null ? -1 : viewableIndexes.indexOf(openedIndex);

  useEffect(() => {
    if (openedIndex !== null && lightboxIndex < 0) setOpenedIndex(null);
  }, [lightboxIndex, openedIndex]);

  const displayedIndexes = preview ? [selectedIndex] : images.map((_, index) => index);
  const attachmentLabel = t("message.imageAttachment");

  return (
    <>
      <div
        className={cn(
          preview ? "grid min-w-0 max-w-full" : "ml-auto flex flex-wrap items-end justify-end gap-2",
          showThumbnails ? "w-96 grid-cols-[minmax(0,1fr)_3.5rem] gap-2" : preview && "w-80",
        )}
        data-image-gallery={showThumbnails ? "true" : undefined}
      >
        {displayedIndexes.map((index) => {
          const image = images[index];
          return (
            <div key={preview ? "preview" : index} className="group/image relative min-w-0">
              <MessageImageCell
                image={image}
                size={preview ? "preview" : "compact"}
                placeholderLabel={attachmentLabel}
                openLabel={t("lightbox.open")}
                showActions={preview}
                onOpen={() => setOpenedIndex(index)}
              />
            </div>
          );
        })}
        {showThumbnails ? (
          <div role="group" aria-label={t("message.imageThumbnails")}
            className="scrollbar-none flex h-60 min-w-0 flex-col gap-2 overflow-y-auto overflow-x-hidden overscroll-contain">
            {images.map((image, index) => (
              <Button
                key={index}
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("message.selectImage", { number: index + 1, name: image.name || attachmentLabel })}
                aria-pressed={selectedIndex === index}
                onClick={() => setImageIndex(index)}
                className={cn(
                  "h-12 w-12 shrink-0 overflow-hidden rounded-lg border-2 bg-muted/40 p-0 focus-visible:ring-inset",
                  selectedIndex === index ? "border-primary" : "border-transparent hover:border-border",
                )}
              >
                {image.url ? <img src={image.url} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" />
                  : <FileSystemIcon name={image.name ?? "image.png"} />}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <ImageLightbox
        images={viewableIndexes.map((index) => images[index])}
        index={lightboxIndex < 0 ? null : lightboxIndex}
        onIndexChange={(index) => setOpenedIndex(viewableIndexes[index] ?? null)}
        onOpenChange={(open) => {
          if (!open) setOpenedIndex(null);
        }}
      />
    </>
  );
}

type ImageActionError = "copy" | "export";

function useImageActions(image?: UIImage) {
  const url = image?.url;
  const name = image?.name;
  const [busy, setBusy] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ImageActionError | null>(null);
  const copyResetRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
  }, []);

  const handleSave = useCallback(
    async (reveal: boolean) => {
      if (!url || busy) return;
      setBusy(true);
      try {
        const filename = suggestMediaFilename(url, name, "image");
        const saved = await downloadMediaUrl(url, filename);
        if (reveal && saved) await revealItemInDir(saved);
      } catch (error) {
        console.error("[MessageBubble] image export failed:", error instanceof Error ? error.name : "Error");
        setActionError("export");
      } finally {
        setBusy(false);
      }
    },
    [busy, name, url],
  );

  const handleCopy = useCallback(async () => {
    if (!url || busy) return;
    setBusy(true);
    try {
      await copyImageToClipboard(url);
      setCopiedUrl(url);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopiedUrl(null), 2000);
    } catch (error) {
      console.error("[MessageBubble] image copy failed:", error instanceof Error ? error.name : "Error");
      setActionError("copy");
    } finally {
      setBusy(false);
    }
  }, [busy, url]);

  return { busy, copied: copiedUrl === url, actionError, handleSave, handleCopy, dismissError: () => setActionError(null) };
}

function ImageActionErrorDialog({ error, onDismiss }: { error: ImageActionError | null; onDismiss: () => void }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t(error === "copy" ? "message.copyImageFailed" : "message.exportImageFailed")}</AlertDialogTitle>
          <AlertDialogDescription>{t("message.imageActionRetry")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter><AlertDialogAction>{t("common.dismiss")}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MessageImageCell({
  image,
  size,
  placeholderLabel,
  openLabel,
  onOpen,
  showActions = false,
}: {
  image: UIImage;
  size: "compact" | "preview";
  placeholderLabel: string;
  openLabel: string;
  onOpen: () => void;
  showActions?: boolean;
}) {
  const { t } = useTranslation();
  const hasUrl = typeof image.url === "string" && image.url.length > 0;
  const { busy, copied, actionError, handleSave, handleCopy, dismissError } = useImageActions(image);
  const tileClasses = cn(
    "relative overflow-hidden bg-muted/40",
    size === "preview" ? "h-60 w-full rounded-2xl" : "h-24 w-24 rounded-xl border border-border/60 shadow-sm",
  );

  if (hasUrl) {
    return (
      <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label={image.name ? `${openLabel}: ${image.name}` : openLabel}
            className={cn(
              tileClasses,
              "block cursor-zoom-in p-0",
              size === "compact" && "transition-transform duration-150 hover:scale-[1.01] hover:ring-2 hover:ring-primary/25 motion-reduce:transition-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
            )}
          >
            <img
              src={image.url}
              alt={image.name ?? ""}
              loading="lazy"
              decoding="async"
              draggable={false}
              className={cn(
                "block h-full w-full",
                size === "preview" ? "object-contain" : "object-cover",
              )}
            />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={busy}
            onSelect={() => handleSave(false)}
          >
            <Download className="h-4 w-4" aria-hidden />
            {t("message.downloadImage", { defaultValue: "Download image" })}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={busy}
            onSelect={() => handleSave(true)}
          >
            <FolderOpen className="h-4 w-4" aria-hidden />
            {t("message.openInFolder", { defaultValue: "Show in folder" })}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {showActions ? (
        <TooltipProvider delayDuration={250}>
          <div className="absolute right-2 top-2 z-10 flex items-center rounded-md border border-border/60 bg-background/95 p-0.5 text-foreground opacity-0 shadow-sm transition-opacity group-hover/image:opacity-100 group-focus-within/image:opacity-100">
            <MessageActionTooltip label={t(copied ? "message.imageCopied" : "message.copyImage")}>
              <button type="button" disabled={busy} onClick={() => void handleCopy()}
                aria-label={t(copied ? "message.imageCopied" : "message.copyImage")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
                {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              </button>
            </MessageActionTooltip>
            <MessageActionTooltip label={t("message.exportImage")}>
              <button type="button" disabled={busy} onClick={() => void handleSave(false)}
                aria-label={t("message.exportImage")}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50">
                <Download className="h-4 w-4" aria-hidden />
              </button>
            </MessageActionTooltip>
          </div>
        </TooltipProvider>
      ) : null}
      <ImageActionErrorDialog error={actionError} onDismiss={dismissError} />
      </>
    );
  }

  return (
    <div className={tileClasses} title={image.name ?? undefined}>
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-[11px] text-muted-foreground"
        aria-label={placeholderLabel}
      >
        <FileSystemIcon name={image.name ?? "image.png"} />
        <span className="line-clamp-2 text-center leading-tight">
          {image.name ?? placeholderLabel}
        </span>
      </div>
    </div>
  );
}

/** Pre-token-arrival placeholder: three bouncing dots. */
function TypingDots() {
  const { t } = useTranslation();
  return (
    <span
      aria-label={t("message.assistantTyping")}
      className="inline-flex items-center gap-1 py-1"
    >
      <Dot delay="0ms" />
      <Dot delay="150ms" />
      <Dot delay="300ms" />
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      style={{ animationDelay: delay }}
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/60",
        "animate-bounce",
      )}
    />
  );
}

/** L→R sheen on the glyphs themselves; inactive labels stay solid muted text. */
export function StreamingLabelSheen({
  children,
  active,
  className,
}: {
  children: ReactNode;
  active: boolean;
  className?: string;
}) {
  const sheenText =
    typeof children === "string" || typeof children === "number"
      ? String(children)
      : undefined;
  return (
    <span className={cn("block min-w-0 overflow-hidden py-px", className)}>
      <span
        data-sheen-text={active ? sheenText : undefined}
        className={cn(
          "block w-fit max-w-full truncate font-medium leading-normal",
          active ? "streaming-text-sheen" : "text-muted-foreground",
        )}
      >
        {children}
      </span>
    </span>
  );
}

interface ReasoningBubbleProps {
  text: string;
  streaming: boolean;
  hasBodyBelow: boolean;
  /** When true, skip the slide-in wrapper (used inside ``AgentActivityCluster``). */
  embeddedInCluster?: boolean;
}

const LIVE_REASONING_PREVIEW_CHARS = 6_000;

/**
 * Subordinate "thinking" trace shown above an assistant turn.
 *
 * Lifecycle:
 *   - While ``streaming`` is true (``reasoning_delta`` frames still arriving),
 *     the bubble starts open, then collapses after the live preview limit so
 *     long model traces cannot monopolize the WebView main thread.
 *   - Expanded reasoning uses the same Markdown pipeline as assistant replies
 *     (deferred while streaming to reduce parser thrash), so headings and
 *     emphasis render instead of leaking raw ``###`` / ``**``.
 *   - On ``reasoning_end`` the bubble auto-collapses for prose density —
 *     the user can re-expand to inspect the chain of thought. The local
 *     toggle persists once the user interacts.
 */
export function ReasoningBubble({
  text,
  streaming,
  hasBodyBelow,
  embeddedInCluster = false,
}: ReasoningBubbleProps) {
  const { t } = useTranslation();
  const [userToggled, setUserToggled] = useState(false);
  const [openLocal, setOpenLocal] = useState(true);
  const open = userToggled
    ? openLocal
    : streaming && text.length <= LIVE_REASONING_PREVIEW_CHARS;
  const visibleText = streaming && text.length > LIVE_REASONING_PREVIEW_CHARS
    ? `…\n\n${text.slice(-LIVE_REASONING_PREVIEW_CHARS)}`
    : text;
  const onToggle = () => {
    setUserToggled(true);
    setOpenLocal((v) => (userToggled ? !v : !open));
  };
  useEffect(() => {
    if (open && text.length > 0) {
      preloadMarkdownText();
    }
  }, [open, text.length]);
  return (
    <div
      className={cn(
        "w-full",
        !embeddedInCluster && "animate-in fade-in-0 slide-in-from-top-1 duration-200",
        hasBodyBelow && "mb-2",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "group flex items-center gap-2 rounded-md py-1.5 text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          embeddedInCluster ? "max-w-full text-caption hover:text-foreground" : "w-full px-2 text-xs hover:bg-muted/45",
        )}
        aria-expanded={open}
        aria-live={streaming ? "polite" : undefined}
      >
        <Sparkles
          className={cn("shrink-0", embeddedInCluster ? "h-4 w-4" : "h-3.5 w-3.5", streaming && "animate-pulse")}
          aria-hidden
        />
        <StreamingLabelSheen active={streaming} className={cn("min-w-0 text-left", !embeddedInCluster && "flex-1")}>
          {streaming
            ? t("message.reasoningStreaming", { defaultValue: "Thinking…" })
            : t("message.reasoning", { defaultValue: "Thinking" })}
        </StreamingLabelSheen>
        <ChevronRight
          aria-hidden
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
            !embeddedInCluster && "ml-auto",
            open && "rotate-90",
          )}
        />
      </button>
      {open && visibleText.length > 0 && (
        <div
          className={cn(
            "mt-1 min-w-0 border-l border-muted-foreground/20 pl-3",
            !embeddedInCluster && "animate-in fade-in-0 slide-in-from-top-1 duration-200",
          )}
        >
          <MarkdownText
            streaming={streaming}
            className={cn(
              "text-[12.5px] italic text-muted-foreground/88",
              "prose-p:my-1.5 prose-li:my-0.5",
              "prose-headings:mt-2 prose-headings:mb-1 prose-headings:font-medium",
              "prose-headings:text-muted-foreground/92 prose-strong:text-muted-foreground",
              "prose-h1:text-[15px] prose-h2:text-[13.5px] prose-h3:text-[12.5px] prose-h4:text-[12px]",
              "prose-a:text-muted-foreground/95 prose-a:underline hover:prose-a:opacity-90",
              "prose-code:text-[0.92em]",
            )}
          >
            {visibleText}
          </MarkdownText>
        </div>
      )}
    </div>
  );
}

interface TraceGroupProps {
  message: UIMessage | UIMessage[];
  animClass: string;
  inline?: boolean;
  active?: boolean;
}

/**
 * Collapsible group of tool-call / progress breadcrumbs. Defaults to
 * collapsed because tool traces are supporting evidence, not the answer.
 * A single click expands the exact calls when the user wants details.
 */
export function TraceGroup({ message, animClass, inline = false, active = false }: TraceGroupProps) {
  const { t } = useTranslation();
  const messages = Array.isArray(message) ? message : [message];
  const lines = messages.flatMap((message) => message.traces ?? [message.content]);
  const count = lines.length;
  const [open, setOpen] = useState(false);
  if (inline) {
    const groups: { lines: string[]; phase?: string; error?: unknown; groupable: boolean }[] = [];
    for (const message of messages) {
      const events = message.toolEvents?.slice().reverse();
      for (const line of message.traces ?? [message.content]) {
        if (!line.trim()) continue;
        const event = events?.find((item) => formatToolCallTrace(item) === line);
        if (event?.call_id && message.fileEdits?.some((edit) => edit.call_id === event.call_id)) continue;
        const groupable = event?.phase !== "error" && !isCommandTrace(line) && /^[\w.:/-]+\s*\(/.test(line.trim());
        const previous = groups[groups.length - 1];
        if (groupable && previous?.groupable && previous.phase === event?.phase) previous.lines.push(line);
        else groups.push({ lines: [line], phase: event?.phase, error: event?.error, groupable });
      }
    }
    if (groups.length === 0) return null;
    return <ul className="space-y-2">
      {groups.map((group, index) => <TraceActivityRow key={index} lines={group.lines}
        phase={group.phase === "start" && !active ? undefined : group.phase} error={group.error} />)}
    </ul>;
  }
  return (
    <div className={cn("w-full", animClass)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5",
          "text-xs text-muted-foreground transition-colors hover:bg-muted/45",
        )}
        aria-expanded={open}
      >
        <Wrench className="h-3.5 w-3.5" aria-hidden />
        <span className="font-medium">
          {count === 1
            ? t("message.toolSingle")
            : t("message.toolMany", { count })}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <ul
          className={cn(
            "mt-1 space-y-0.5 border-l border-muted-foreground/20 pl-3",
            "animate-in fade-in-0 slide-in-from-top-1 duration-200",
          )}
        >
          {lines.map((line, i) => (
            <li
              key={i}
              className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted-foreground/90"
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TraceActivityRow({ lines, phase, error }: { lines: string[]; phase?: string; error?: unknown }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const line = lines[0];
  const command = isCommandTrace(line);
  const Icon = phase === "start" ? Loader2 : command ? SquareTerminal : Wrench;
  const label = lines.length > 1
    ? t(phase === "start" ? "message.activityToolRunningMany" : "message.activityToolMany", { count: lines.length })
    : !phase && !/^[\w.:/-]+\s*\(/.test(line.trim())
      ? line
      : t(`message.activity${command ? "Command" : "Tool"}${phase === "error" ? "Failed" : phase === "end" ? "Completed" : phase === "start" ? "Running" : ""}`);
  return <li className="text-caption text-muted-foreground">
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
      className="flex max-w-full items-center gap-2 py-1.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
      <Icon className={cn("h-4 w-4 shrink-0", phase === "start" && "motion-safe:animate-spin")} aria-hidden />
      <span>{label}</span>
      {lines.length > 1 && <ChevronRight aria-hidden className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} />}
    </button>
    {open && <pre className="mt-1 whitespace-pre-wrap break-words text-micro">{lines.join("\n")}{typeof error === "string" && error ? `\n${error}` : ""}</pre>}
  </li>;
}
