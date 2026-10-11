/**
 * 笔记 Agent 侧边栏的通用输入组件：支持文本、文件选择/拖放和图片粘贴。
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
import { ImageIcon, Loader2, Plus, Send, Square, X } from "lucide-react";

import { OfficeDocChip } from "@/components/doc/office/OfficeDocChip";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useAttachedImages,
  isInlineImage,
  MAX_IMAGES_PER_MESSAGE,
  type AttachedImage,
  type AttachmentError,
} from "@/hooks/useAttachedImages";
import { useAttachedDocuments } from "@/hooks/useAttachedDocuments";
import { useClipboardAndDrop } from "@/hooks/useClipboardAndDrop";
import type { SendImage, SendOptions } from "@/hooks/useMonaStream";

interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string, images?: SendImage[], options?: SendOptions) => void;
  chatId?: string | null;
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
  chatId,
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

  const { images, enqueue, remove, clear, encoding } = useAttachedImages();
  const {
    documents,
    uploading: documentsUploading,
    error: documentUploadError,
    add: addDocuments,
    remove: removeDocument,
    clear: clearDocuments,
  } = useAttachedDocuments(chatId);

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
    !disabled
    && !encoding
    && !documentsUploading
    && !hasErrors
    && (value.trim().length > 0 || readyImages.length > 0 || documents.length > 0);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0 || disabled || documentsUploading) return;
      const imageFiles = files.filter(isInlineImage);
      const documentFiles = files.filter((file) => !isInlineImage(file));
      const { rejected } = enqueue(imageFiles);
      if (rejected.length > 0) {
        setInlineError(formatRejection(rejected[0].reason));
      } else {
        setInlineError(null);
      }
      if (documentFiles.length > 0) void addDocuments(documentFiles);
    },
    [addDocuments, disabled, documentsUploading, enqueue],
  );

  const addDroppedFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0 && !disabled && !documentsUploading) void addDocuments(files);
    },
    [addDocuments, disabled, documentsUploading],
  );

  const { isDragging, onPaste, onDragEnter, onDragOver, onDragLeave, onDrop } =
    useClipboardAndDrop(addFiles, { acceptAllFiles: true, onDropFiles: addDroppedFiles });

  const submit = useCallback(() => {
    if (!canSend) return;
    const payload: SendImage[] | undefined =
      readyImages.length > 0
        ? readyImages.map((img) => ({
            media: { data_url: img.dataUrl, name: img.file.name },
            preview: { url: img.dataUrl, name: img.file.name },
          }))
        : undefined;
    onSend(
      value.trim(),
      payload,
      documents.length > 0
        ? {
            docPaths: documents.map((document) => document.path),
            documentNames: documents.map((document) => document.name),
          }
        : undefined,
    );
    onChange("");
    clear();
    clearDocuments();
    setInlineError(null);
  }, [canSend, clear, clearDocuments, documents, onChange, onSend, readyImages, value]);

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
    if (files.length > 0) void addDocuments(files);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "relative flex min-h-[52px] w-full flex-col gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm",
        isDragging && "ring-2 ring-primary/40",
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={onFilePick}
      />

      {images.length > 0 || documents.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
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
          {documents.map((document) => (
            <OfficeDocChip
              key={document.path}
              name={document.name}
              size={document.size}
              onRemove={() => removeDocument(document.path)}
            />
          ))}
        </div>
      ) : null}

      {inlineError || documentUploadError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/8 px-2 py-0.5 text-micro text-destructive">
          {inlineError ?? documentUploadError}
        </div>
      ) : null}

      <div className="flex items-end gap-1.5">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          rows={2}
          placeholder={placeholder}
          className="min-h-[36px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-caption leading-5 shadow-none focus-visible:ring-0 disabled:opacity-60"
        />
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || documentsUploading}
          aria-label="添加文件"
          title="添加文件"
          onClick={() => fileInputRef.current?.click()}
          className="h-6 w-6 shrink-0 rounded-md p-0 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {encoding || documentsUploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
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
