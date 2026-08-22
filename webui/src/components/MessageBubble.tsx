import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronRight, Copy, CornerDownLeft, Download, FileIcon, FolderOpen, ImageIcon, PlaySquare, Sparkles, Wrench, BookmarkCheck, Bookmark } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ImageLightbox } from "@/components/ImageLightbox";
import { MarkdownText, preloadMarkdownText } from "@/components/MarkdownText";
import { DeliveredFileCardList } from "@/components/deliver/DeliveredFileCard";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { formatTurnLatency } from "@/lib/format";
import { createNoteFromChat, downloadMediaUrl, isTauri, revealItemInDir } from "@/lib/tauri";
import type { UIImage, UIMediaAttachment, UIMessage } from "@/lib/types";

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
  /** When false, hide the assistant reply copy button (mid-turn text before more agent activity). Default true. */
  showAssistantCopyAction?: boolean;
  /** Render assistant turns as left-aligned IM bubbles for collaboration groups. */
  isGroupChat?: boolean;
}

const LONG_REPLY_CHAR_THRESHOLD = 1_600;
const LONG_REPLY_LINE_THRESHOLD = 24;

/** 确认卡标记行协议（T22d，design §10.4）：
 *  `[[stock-deep-research XSHG:600519 名称?]]`，A股分析师在私聊中
 *  输出该标记行，客户端渲染为「启动深度投研」确认卡。 */
const STOCK_CONFIRM_RE =
  /^\[\[stock-deep-research (XSHG|XSHE|BJSE):(\d{6})(?:\s+([^\]\n]+?))?\]\]$/;

type StockConfirmSegment =
  | { type: "text"; text: string }
  | { type: "card"; instrumentId: string; name: string };

function parseStockConfirmSegments(content: string): StockConfirmSegment[] {
  const segments: StockConfirmSegment[] = [];
  let buf: string[] = [];
  for (const line of content.split("\n")) {
    const match = STOCK_CONFIRM_RE.exec(line.trim());
    if (match) {
      if (buf.length > 0) {
        segments.push({ type: "text", text: buf.join("\n") });
        buf = [];
      }
      segments.push({
        type: "card",
        instrumentId: `${match[1]}:${match[2]}`,
        name: match[3]?.trim() || `${match[1]}:${match[2]}`,
      });
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) segments.push({ type: "text", text: buf.join("\n") });
  return segments;
}

/** 「启动深度投研」确认卡：点击经 mona-open-stock 事件跳转股票工作台
 *  并自动启动单股研究（与 mona-stock-settings-changed 同模式）。 */
function StockConfirmCard({
  instrumentId,
  name,
}: {
  instrumentId: string;
  name: string;
}) {
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-ui">{name}</div>
        <div className="text-micro text-muted-foreground">
          将由 6 个 Agent 协作完成深度研究（3 位分析师 → 多空辩论 → 主席汇总）
        </div>
      </div>
      <Button
        size="sm"
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("mona-open-stock", {
              detail: { symbol: instrumentId },
            }),
          )
        }
      >
        启动深度投研
      </Button>
    </div>
  );
}

/**
 * Render a single message. Following agent-chat-ui: user turns are a rounded
 * "pill" right-aligned with a muted fill; direct assistant turns render as
 * bare markdown while group-chat turns use a neutral left-aligned bubble.
 * Each turn fades+slides in for a touch of motion polish.
 *
 * Trace rows (tool-call hints, progress breadcrumbs) render as a subdued
 * collapsible group so intermediate steps never masquerade as replies.
 */
export function MessageBubble({
  message,
  showAssistantCopyAction = true,
  isGroupChat = false,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const saveResetRef = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
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

  const onCopyAssistantReply = useCallback(() => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      if (copyResetRef.current !== null) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false);
        copyResetRef.current = null;
      }, 1_500);
    });
  }, [message.content]);

  const onSaveAsNote = useCallback(() => {
    if (!isTauri() || saved) return;
    const title = message.content.split("\n").find((line) => line.trim().length > 0)?.slice(0, 60) ?? "未命名笔记";
    createNoteFromChat(title, message.content)
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
        console.error("[MessageBubble] save as note failed:", err);
      });
  }, [message.content, saved]);

  if (message.kind === "trace") {
    return <TraceGroup message={message} animClass={baseAnim} />;
  }

  if (message.role === "user") {
    const images = message.images ?? [];
    const media = message.media ?? [];
    const hasImages = images.length > 0;
    const hasMedia = media.length > 0;
    const hasText = message.content.trim().length > 0;
    return (
      <div
        className={cn(
          "group ml-auto flex max-w-[min(85%,36rem)] min-w-0 flex-col items-end gap-1.5",
          baseAnim,
        )}
      >
        {hasImages ? <UserImages images={images} align="right" /> : null}
        {!hasImages && hasMedia ? (
          <MessageMedia media={media} align="right" />
        ) : null}
        {hasText ? (
          <p
            className={cn(
              "ml-auto max-w-full rounded-2xl bg-secondary/70 px-4 py-2",
              "text-left text-[16px]/[1.75] whitespace-pre-wrap break-words select-text",
            )}
          >
            {/* IMPORTANT: Use displayContent (short label) when available, fallback to content.
                DO NOT change to just message.content — displayContent ensures user messages
                show the original input, not the enriched prompt with terminal/DB context.
                This is persisted to the server for history replay. */}
            {message.displayContent ?? message.content}
          </p>
        ) : null}
        {message.isInjected && (
          <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary/60">
            <CornerDownLeft className="h-3 w-3" aria-hidden />
            {t("thread.composer.pendingQueue.injectedBadge")}
          </span>
        )}
      </div>
    );
  }

  const empty = message.content.trim().length === 0;
  const hasDeliveredFiles = !!(message.deliveredFiles && message.deliveredFiles.length > 0);
  const showDeliveredFiles = hasDeliveredFiles && !message.isStreaming;
  const media = message.media ?? [];
  const reasoning = message.role === "assistant" ? message.reasoning ?? "" : "";
  const reasoningStreaming = !!(message.role === "assistant" && message.reasoningStreaming);
  const hasReasoning = reasoning.length > 0 || reasoningStreaming;

  const showAssistantActions = message.role === "assistant" && !message.isStreaming && !empty;
  const showCopyButton = showAssistantCopyAction && showAssistantActions;
  const showSaveButton = showAssistantActions && isTauri();
  const latencyMs = message.latencyMs;
  const showLatencyFooter =
    message.role === "assistant"
    && latencyMs != null
    && !message.isStreaming
    && (!empty || hasReasoning || media.length > 0);
  const showAssistantFooterRow = showCopyButton || showSaveButton || showLatencyFooter;
  const stockConfirmSegments = message.content.includes("[[stock-deep-research")
    ? parseStockConfirmSegments(message.content)
    : null;
  const hasStockConfirmCard = stockConfirmSegments?.some((segment) => segment.type === "card") ?? false;
  const canCollapseReply =
    isGroupChat
    && message.role === "assistant"
    && !message.isStreaming
    && !empty
    && !hasStockConfirmCard
    && (
      message.content.length > LONG_REPLY_CHAR_THRESHOLD
      || message.content.split(/\r?\n/).length > LONG_REPLY_LINE_THRESHOLD
    );
  const replyCollapsed = canCollapseReply && !expanded;
  const renderedContent = stockConfirmSegments ? (
    stockConfirmSegments.map((seg, i) =>
      seg.type === "card" ? (
        <StockConfirmCard
          key={`card-${i}`}
          instrumentId={seg.instrumentId}
          name={seg.name}
        />
      ) : seg.text.trim() ? (
        <MarkdownText key={`text-${i}`} streaming={!!message.isStreaming}>
          {seg.text}
        </MarkdownText>
      ) : null,
    )
  ) : (
    <MarkdownText streaming={!!message.isStreaming}>{message.content}</MarkdownText>
  );
  return (
    <div
      className={cn(
        "w-full min-w-0 text-[15px]",
        isGroupChat && "w-fit max-w-[min(85%,48rem)] self-start",
        baseAnim,
      )}
      style={{ lineHeight: "var(--cjk-line-height)" }}
    >
      <div
        className={cn(
          isGroupChat && "relative rounded-2xl rounded-tl-md border border-border/70 bg-card/80 px-4 py-3 shadow-sm",
        )}
      >
      {isGroupChat ? (
        <span
          aria-hidden
          data-testid="group-bubble-tail"
          className="pointer-events-none absolute -left-1.5 top-3 h-3 w-3 rotate-45 border-b border-l border-border/70 bg-card/80"
        />
      ) : null}
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
                  isGroupChat && "from-card via-card/90",
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
          {media.length > 0 ? <MessageMedia media={media} align="left" /> : null}
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
          {showAssistantFooterRow ? (
            <div className="mt-2 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
              {showCopyButton ? (
                <button
                  type="button"
                  onClick={onCopyAssistantReply}
                  aria-label={copied ? t("message.copiedReply") : t("message.copyReply")}
                  title={copied ? t("message.copiedReply") : t("message.copyReply")}
                  className={cn(
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    "transition-colors hover:bg-muted/55 hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {copied ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden />
                  )}
                </button>
              ) : null}
              {showSaveButton ? (
                <button
                  type="button"
                  onClick={onSaveAsNote}
                  disabled={saved}
                  aria-label={saved ? t("message.savedAsNote") : t("message.saveAsNote")}
                  title={saved ? t("message.savedAsNote") : t("message.saveAsNote")}
                  className={cn(
                    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                    "transition-colors hover:bg-muted/55 hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    saved && "text-[#1f9d7a]",
                  )}
                >
                  {saved ? (
                    <BookmarkCheck className="h-4 w-4" aria-hidden />
                  ) : (
                    <Bookmark className="h-4 w-4" aria-hidden />
                  )}
                </button>
              ) : null}
              {showLatencyFooter ? (
                <span
                  className="text-[11px] leading-none text-muted-foreground/70 tabular-nums"
                  title={t("message.turnLatencyTitle")}
                >
                  {formatTurnLatency(latencyMs)}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      </div>
    </div>
  );
}

function MessageMedia({
  media,
  align,
}: {
  media: UIMediaAttachment[];
  align: "left" | "right";
}) {
  if (media.length === 0) return null;
  const images: UIImage[] = [];
  const nonImages: UIMediaAttachment[] = [];
  for (const item of media) {
    if (item.kind === "image") {
      images.push({ url: item.url, name: item.name });
    } else {
      nonImages.push(item);
    }
  }

  return (
    <div
      className={cn(
        "mt-2 flex flex-wrap gap-2",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {images.length > 0 ? (
        <UserImages images={images} align={align} size={align === "left" ? "large" : "compact"} />
      ) : null}
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
  const Icon = media.kind === "video" ? PlaySquare : FileIcon;

  const inner = (
    <>
      <Icon className="h-4 w-4 flex-none" aria-hidden />
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

/**
 * Right-aligned preview row for images attached to a user turn.
 *
 * Visual follows agent-chat-ui: a single wrapping row of fixed-size square
 * thumbnails that stay modest next to the text pill regardless of how many
 * images are attached.
 *
 * The URL is expected to be a self-contained ``data:`` URL (the Composer
 * hands the normalized base64 payload to the optimistic bubble so that the
 * preview survives React StrictMode double-mount — blob URLs would be
 * revoked by the Composer's cleanup before remount). Historical replays
 * have no URL (the backend strips data URLs before persisting), so we
 * render a labelled placeholder tile instead of a broken ``<img>``.
 */
function UserImages({
  images,
  align = "right",
  size = "compact",
}: {
  images: UIImage[];
  align?: "left" | "right";
  size?: "compact" | "large";
}) {
  const { t } = useTranslation();
  // Only real-URL images can open in the lightbox; historical-replay
  // placeholders (no URL) have nothing to zoom into.
  const viewableImages: UIImage[] = [];
  const originalToViewable = new Map<number, number>();
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    if (typeof img.url !== "string" || img.url.length === 0) continue;
    originalToViewable.set(i, viewableImages.length);
    viewableImages.push(img);
  }

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <>
      <div
        className={cn(
          "flex flex-wrap items-end gap-2",
          size === "large" && "gap-3",
          align === "right" ? "ml-auto justify-end" : "mr-auto justify-start",
        )}
      >
        {images.map((img, i) => (
          <UserImageCell
            key={`${img.url ?? "placeholder"}-${i}`}
            image={img}
            size={size}
            placeholderLabel={t("message.imageAttachment")}
            openLabel={t("lightbox.open")}
            onOpen={
              originalToViewable.has(i)
                ? () => setLightboxIndex(originalToViewable.get(i)!)
                : undefined
            }
          />
        ))}
      </div>
      <ImageLightbox
        images={viewableImages}
        index={lightboxIndex}
        onIndexChange={setLightboxIndex}
        onOpenChange={(open) => {
          if (!open) setLightboxIndex(null);
        }}
      />
    </>
  );
}

function UserImageCell({
  image,
  size,
  placeholderLabel,
  openLabel,
  onOpen,
}: {
  image: UIImage;
  size: "compact" | "large";
  placeholderLabel: string;
  openLabel: string;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const hasUrl = typeof image.url === "string" && image.url.length > 0;
  const [busy, setBusy] = useState(false);
  const tileClasses = cn(
    "relative overflow-hidden border border-border/60 bg-muted/40",
    size === "large"
      ? "w-[min(100%,34rem)] rounded-2xl bg-transparent"
      : "h-24 w-24 rounded-xl",
    "shadow-sm",
  );

  const handleSave = useCallback(
    (reveal: boolean) => {
      if (!image.url || busy) return;
      setBusy(true);
      const filename = suggestMediaFilename(image.url, image.name, "image");
      downloadMediaUrl(image.url, filename)
        .then((saved) => (reveal && saved ? revealItemInDir(saved) : Promise.resolve()))
        .catch((err) => console.error("[MessageBubble] image save failed:", err))
        .finally(() => setBusy(false));
    },
    [busy, image.name, image.url],
  );

  if (hasUrl && onOpen) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onOpen}
            aria-label={image.name ? `${openLabel}: ${image.name}` : openLabel}
            className={cn(
              tileClasses,
              "block cursor-zoom-in p-0 transition-transform duration-150 motion-reduce:transition-none",
              "hover:scale-[1.01] hover:ring-2 hover:ring-primary/25",
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
                "block",
                size === "large"
                  ? "h-auto max-h-[36rem] w-full rounded-[inherit] object-contain"
                  : "h-full w-full object-cover",
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
    );
  }

  return (
    <div className={tileClasses} title={image.name ?? undefined}>
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-[11px] text-muted-foreground"
        aria-label={placeholderLabel}
      >
        <ImageIcon className="h-4 w-4 flex-none" aria-hidden />
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

/**
 * Subordinate "thinking" trace shown above an assistant turn.
 *
 * Lifecycle:
 *   - While ``streaming`` is true (``reasoning_delta`` frames still arriving),
 *     the bubble defaults to open and the header shows a sheen + pulse so
 *     the user sees the model "thinking out loud" in real time.
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
  const open = userToggled ? openLocal : streaming;
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
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5",
          "text-xs text-muted-foreground transition-colors hover:bg-muted/45",
        )}
        aria-expanded={open}
        aria-live={streaming ? "polite" : undefined}
      >
        <Sparkles
          className={cn("h-3.5 w-3.5", streaming && "animate-pulse")}
          aria-hidden
        />
        <StreamingLabelSheen active={streaming} className="min-w-0 flex-1 text-left">
          {streaming
            ? t("message.reasoningStreaming", { defaultValue: "Thinking…" })
            : t("message.reasoning", { defaultValue: "Thinking" })}
        </StreamingLabelSheen>
        <ChevronRight
          aria-hidden
          className={cn(
            "ml-auto h-3.5 w-3.5 transition-transform duration-200",
            open && "rotate-90",
          )}
        />
      </button>
      {open && text.length > 0 && (
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
            {text}
          </MarkdownText>
        </div>
      )}
    </div>
  );
}

interface TraceGroupProps {
  message: UIMessage;
  animClass: string;
}

/**
 * Collapsible group of tool-call / progress breadcrumbs. Defaults to
 * collapsed because tool traces are supporting evidence, not the answer.
 * A single click expands the exact calls when the user wants details.
 */
export function TraceGroup({ message, animClass }: TraceGroupProps) {
  const { t } = useTranslation();
  const lines = message.traces ?? [message.content];
  const count = lines.length;
  const [open, setOpen] = useState(false);
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
