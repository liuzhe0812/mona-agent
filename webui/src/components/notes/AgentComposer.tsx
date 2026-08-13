/**
 * 笔记 Agent 侧边栏的通用输入组件：支持文本、图片粘贴/拖放/选择。
 *
 * 与 ThreadComposer 保持相同图片处理语义（useAttachedImages + useClipboardAndDrop），
 * 但尺寸更紧凑，适配侧边栏宽度。
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { ImageIcon, Loader2, Send, Square, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  useAttachedImages,
  MAX_IMAGES_PER_MESSAGE,
  type AttachedImage,
  type AttachmentError,
} from "@/hooks/useAttachedImages";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import type { SendImage } from "@/hooks/useMonaStream";

/** 与服务器 MIME 白名单一致；SVG 被排除以避免 XSS。 */
const ACCEPT_ATTR = "image/png,image/jpeg,image/webp,image/gif";

interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, images?: SendImage[]) => void;
  disabled?: boolean;
  placeholder?: string;
  isStreaming?: boolean;
  creatingChat?: boolean;
  onStop?: () => void;
}

export function AgentComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = "输入消息...",
  isStreaming = false,
  creatingChat = false,
  onStop,
}: AgentComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const [inlineError, setInlineError] = useState<string | null>(null);

  const { images, enqueue, remove, clear, encoding, full } = useAttachedImages();

  const readyImages = useMemo(
    () =>
      images.filter(
        (img): img is AttachedImage & { dataUrl: string } =>
          img.status === "ready" && typeof img.dataUrl === "string",
      ),
    [images],
  );
  const hasErrors = images.some((img) => img.status === "error");

  const canSend =
    !disabled && !encoding && !hasErrors && (value.trim().length > 0 || readyImages.length > 0);

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
    [enqueue],
  );

  const { isDragging, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop } =
    useClipboardAndDrop(addFiles);

  const submit = useCallback(() => {
    if (!canSend) return;
    const payload: SendImage[] | undefined =
      readyImages.length > 0
        ? readyImages.map((img) => ({
            media: { data_url: img.dataUrl, name: img.file.name },
            preview: { url: img.dataUrl, name: img.file.name },
          }))
        : undefined;
    onSend(value.trim(), payload);
    onChange("");
    clear();
    setInlineError(null);
  }, [canSend, clear, onChange, onSend, readyImages, value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    onPaste(event);
  };

  const removeChip = useCallback(
    (id: string) => {
      const { nextFocusId } = remove(id);
      setInlineError(null);
      requestAnimationFrame(() => {
        const el = nextFocusId ? chipRefs.current.get(nextFocusId) : null;
        if (el) el.focus();
        else textareaRef.current?.focus();
      });
    },
    [remove],
  );

  const onFilePick: React.ChangeEventHandler<HTMLInputElement> = (event) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    addFiles(files);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "relative flex w-full flex-col rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm",
        isDragging && "ring-2 ring-primary/40",
      )}
    >
      <Input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_ATTR}
        multiple
        hidden
        onChange={onFilePick}
      />

      {images.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {images.map((img) => (
            <AttachmentChip
              key={img.id}
              image={img}
              onRemove={() => removeChip(img.id)}
              registerRef={(el) => {
                if (el) chipRefs.current.set(img.id, el);
                else chipRefs.current.delete(img.id);
              }}
            />
          ))}
        </div>
      ) : null}

      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={disabled}
        rows={2}
        placeholder={placeholder}
        className="min-h-[36px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-caption focus-visible:ring-0 disabled:opacity-60"
      />

      {inlineError ? (
        <div className="mb-1 rounded-md border border-destructive/40 bg-destructive/8 px-2 py-0.5 text-micro text-destructive">
          {inlineError}
        </div>
      ) : null}

      <div className="mt-1 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || full}
          aria-label="添加图片"
          title="添加图片"
          onClick={() => fileInputRef.current?.click()}
          className="h-6 w-6 shrink-0 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {encoding ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : images.length > 0 ? (
            <span className="text-micro font-medium">{images.length}</span>
          ) : (
            <ImageIcon className="h-3.5 w-3.5" />
          )}
        </Button>

        <Button
          type="button"
          variant="ghost"
          aria-label={isStreaming ? "停止生成" : "发送"}
          disabled={!isStreaming && !canSend}
          onClick={isStreaming ? onStop : submit}
          className={cn(
            "h-6 w-6 shrink-0 rounded-lg p-0",
            isStreaming
              ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
              : "bg-action text-white hover:bg-action-hover hover:text-white disabled:bg-muted disabled:text-muted-foreground",
          )}
        >
          {isStreaming ? (
            <Square className="h-3 w-3" />
          ) : creatingChat ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

function AttachmentChip({
  image,
  onRemove,
  registerRef,
}: {
  image: AttachedImage;
  onRemove: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-micro",
        image.status === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-border/70 bg-muted/60 text-foreground/80",
      )}
    >
      <div className="relative h-6 w-6 overflow-hidden rounded bg-background">
        {image.previewUrl ? (
          <img
            src={image.previewUrl}
            alt=""
            aria-hidden
            loading="eager"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-3 w-3 text-muted-foreground" />
          </div>
        )}
        {image.status === "encoding" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <Loader2 className="h-3 w-3 animate-spin" />
          </div>
        ) : null}
      </div>
      <span className="max-w-[4.5rem] truncate" title={image.file.name}>
        {image.file.name}
      </span>
      <Button
        type="button"
        variant="ghost"
        ref={registerRef}
        onClick={onRemove}
        aria-label="移除图片"
        className="h-4 w-4 rounded-full p-0 text-muted-foreground/80 hover:bg-foreground/8 hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

function formatRejection(reason: AttachmentError): string {
  switch (reason) {
    case "unsupported_type":
      return "仅支持 PNG / JPEG / WebP / GIF 图片";
    case "too_many_images":
      return `最多添加 ${MAX_IMAGES_PER_MESSAGE} 张图片`;
    case "too_large":
      return "图片过大，无法发送";
    case "decode_failed":
      return "图片解码失败";
    case "magic_mismatch":
      return "图片格式与扩展名不符";
    case "io":
      return "读取图片失败";
    default:
      return "添加图片失败";
  }
}
