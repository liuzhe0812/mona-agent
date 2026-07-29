import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, FileText, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DocChatPanel } from "@/components/doc/DocChatPanel";
import { useClient } from "@/providers/ClientProvider";
import { OfficeDocChip } from "@/components/doc/office/OfficeDocChip";
import { SplitPane } from "@/components/deliver/SplitPane";
import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import {
  DOC_EXTENSIONS,
  readFileAsDataUrl,
  useDocDrop,
} from "@/components/doc/office/useDocDrop";
import {
  downloadOfficeRuntime,
  fetchOfficeHealth,
  type OfficeHealthStatus,
} from "@/lib/api";
import type { DeliveredFile } from "@/lib/types";

interface UploadedDoc {
  name: string;
  path: string; // workspace-relative
  size?: number;
  mime?: string;
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DOC_ACCEPT_ATTR = DOC_EXTENSIONS.join(",");

export function OfficeWorkbenchView() {
  const { client, token } = useClient();
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatIdCreating, setChatIdCreating] = useState(false);
  const [docs, setDocs] = useState<UploadedDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // OfficeCLI runtime health (for AI-driven document modification).
  const [officeHealth, setOfficeHealth] = useState<OfficeHealthStatus | null>(null);
  const [officeInstalling, setOfficeInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await fetchOfficeHealth(token);
        if (!cancelled) setOfficeHealth(status);
      } catch {
        // Silently ignore — health check is best-effort. The agent will
        // surface a clear error if OfficeCLI is needed but missing.
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const installOfficeRuntime = useCallback(async () => {
    setOfficeInstalling(true);
    try {
      const result = await downloadOfficeRuntime(token);
      if (result.ok) {
        const status = await fetchOfficeHealth(token);
        setOfficeHealth(status);
      } else {
        setUploadError(result.error ?? "OfficeCLI 安装失败");
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "OfficeCLI 安装失败");
    } finally {
      setOfficeInstalling(false);
    }
  }, [token]);

  // Ensure a chat session exists before the user can upload or send.
  const ensureChat = useCallback(async (): Promise<string | null> => {
    if (chatId) return chatId;
    if (chatIdCreating) return null;
    setChatIdCreating(true);
    try {
      const id = await client.newChat(5_000, false, null, null);
      setChatId(id);
      return id;
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "创建会话失败");
      return null;
    } finally {
      setChatIdCreating(false);
    }
  }, [chatId, chatIdCreating, client]);

  // Listen for doc_upload_result events from the server.
  useEffect(() => {
    const unsub = client.onDocUploadResult((result) => {
      setUploading(false);
      if (!result.ok) {
        setUploadError(result.error ?? "文档上传失败");
        return;
      }
      if (result.files && result.files.length > 0) {
        setDocs((prev) => [...prev, ...result.files!.map((f) => ({
          name: f.name,
          path: f.path,
          size: f.size,
          mime: f.mime,
        }))]);
      }
      setUploadError(null);
    });
    return unsub;
  }, [client]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploadError(null);
      const id = await ensureChat();
      if (!id) return;
      setUploading(true);
      try {
        const pending = await Promise.all(
          files.map(async (f) => ({
            name: f.name,
            data_url: await readFileAsDataUrl(f),
          })),
        );
        client.sendDocUpload(id, pending);
      } catch (err) {
        setUploading(false);
        setUploadError(err instanceof Error ? err.message : "读取文件失败");
      }
    },
    [client, ensureChat],
  );

  const { isDragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useDocDrop(uploadFiles);

  const onPickFiles = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) void uploadFiles(files);
    // Reset input value so the same file can be picked again.
    event.target.value = "";
  }, [uploadFiles]);

  const removeDoc = useCallback((path: string) => {
    setDocs((prev) => prev.filter((d) => d.path !== path));
  }, []);

  const onSend = useCallback(
    (content: string): string => {
      if (!chatId) return content;
      const docPaths = docs.map((d) => d.path);
      // Build a display string that mentions the attached documents so the
      // user can see in history which docs were attached to this turn. The
      // actual content sent to the model is just ``content`` — the backend
      // appends extracted document text via extract_documents().
      const displayContent =
        docPaths.length > 0
          ? `${content}\n\n[已附文档: ${docs.map((d) => d.name).join(", ")}]`
          : content;
      client.sendMessage(chatId, content, undefined, {
        displayContent,
        ...(docPaths.length > 0 ? { docPaths } : {}),
      });
      // Clear docs after the message is sent — they've been attached.
      setDocs([]);
      return displayContent;
    },
    [chatId, client, docs],
  );

  const hasDocs = docs.length > 0;
  const isEmpty = !chatId && !hasDocs && !uploading;

  // File preview state (shared across the workbench session).
  const previewFile = useFilePreviewStore((s) => s.file);
  const splitRatio = useFilePreviewStore((s) => s.splitRatio);
  const setSplitRatio = useFilePreviewStore((s) => s.setSplitRatio);
  const openPreview = useFilePreviewStore((s) => s.open);

  const openDocPreview = useCallback(
    (doc: UploadedDoc) => {
      const file: DeliveredFile = {
        path: doc.path,
        absolute_path: "",
        name: doc.name,
        size: doc.size ?? 0,
        size_human: formatSize(doc.size),
        mime: doc.mime ?? "application/octet-stream",
      };
      openPreview(file, "shared");
    },
    [openPreview],
  );

  return (
    <div
      className="relative flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isEmpty ? (
        <OfficeWorkbenchEmpty
          uploading={uploading}
          uploadError={uploadError}
          isDragging={isDragging}
          onPick={() => fileInputRef.current?.click()}
          officeHealth={officeHealth}
          officeInstalling={officeInstalling}
          onInstallOffice={installOfficeRuntime}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Document chips + upload button */}
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-3 py-2">
            {hasDocs ? (
              docs.map((d) => (
                <OfficeDocChip
                  key={d.path}
                  name={d.name}
                  size={d.size}
                  onRemove={() => removeDoc(d.path)}
                  onClick={() => openDocPreview(d)}
                />
              ))
            ) : (
              <span className="text-[12px] text-muted-foreground">
                尚未导入文档
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 rounded-md px-2 text-[12px]"
              disabled={uploading || chatIdCreating}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {uploading ? "上传中..." : "添加文档"}
            </Button>
          </div>

          {uploadError ? (
            <div className="border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-[11px] text-destructive">
              {uploadError}
            </div>
          ) : null}

          {isDragging ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm">
              <div className="rounded-2xl border-2 border-dashed border-primary/60 px-8 py-6 text-center">
                <FileText className="mx-auto mb-2 h-8 w-8 text-primary" />
                <div className="text-[13px] font-medium">放下文件以导入</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  支持 PDF / Word / Excel / PPT / CSV / Markdown / JSON
                </div>
              </div>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            <SplitPane
              left={
                <DocChatPanel
                  chatId={chatId}
                  onSend={onSend}
                  placeholder="拖入文档后提问，或点击上方文档芯片预览..."
                />
              }
              right={<FilePreviewPanel />}
              ratio={splitRatio}
              onRatioChange={setSplitRatio}
              rightVisible={!!previewFile}
            />
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={DOC_ACCEPT_ATTR}
        multiple
        className="hidden"
        onChange={onPickFiles}
      />
    </div>
  );
}

interface OfficeWorkbenchEmptyProps {
  uploading: boolean;
  uploadError: string | null;
  isDragging: boolean;
  onPick: () => void;
  officeHealth: OfficeHealthStatus | null;
  officeInstalling: boolean;
  onInstallOffice: () => void;
}

function OfficeWorkbenchEmpty({
  uploading,
  uploadError,
  isDragging,
  onPick,
  officeHealth,
  officeInstalling,
  onInstallOffice,
}: OfficeWorkbenchEmptyProps) {
  const examples = useMemo(
    () => [
      "总结这份文档",
      "提取关键条款",
      "对比两个版本",
      "按部门汇总费用并画图",
    ],
    [],
  );

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div
          className={
            "rounded-2xl border-2 border-dashed p-8 text-center transition-colors " +
            (isDragging
              ? "border-primary bg-primary/5"
              : "border-border/60 bg-background/50")
          }
        >
          <FileText className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
          <div className="mb-1 text-[14px] font-medium">
            拖入文档，立即开始
          </div>
          <div className="mb-4 text-[12px] text-muted-foreground">
            支持 PDF / Word / Excel / PPT / CSV / Markdown / JSON
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-8 gap-1.5 rounded-md px-3 text-[13px]"
            disabled={uploading}
            onClick={onPick}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {uploading ? "正在上传..." : "选择文件"}
          </Button>
          {uploadError ? (
            <div className="mt-3 text-[11px] text-destructive">{uploadError}</div>
          ) : null}
        </div>

        <div className="mt-4">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            示例指令
          </div>
          <div className="flex flex-wrap gap-1.5">
            {examples.map((ex) => (
              <span
                key={ex}
                className="rounded-md border border-border/50 bg-background px-2 py-1 text-[11px] text-muted-foreground"
              >
                {ex}
              </span>
            ))}
          </div>
        </div>

        {/* OfficeCLI dependency detection (lazy check on first visit). */}
        <div className="mt-3">
          <OfficeRuntimeBanner
            health={officeHealth}
            installing={officeInstalling}
            onInstall={onInstallOffice}
          />
        </div>
      </div>
    </div>
  );
}

function OfficeRuntimeBanner({
  health,
  installing,
  onInstall,
}: {
  health: OfficeHealthStatus | null;
  installing: boolean;
  onInstall: () => void;
}) {
  // Still loading — show a subtle placeholder to reserve space.
  if (health === null) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>正在检测文档编辑依赖...</span>
      </div>
    );
  }
  // Installed and working — keep quiet.
  if (health.ok) return null;
  // Platform not supported — show a read-only warning.
  if (!health.supported) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span>AI 修改文档功能不支持当前系统，仍可拖入文档提问</span>
      </div>
    );
  }
  // Not installed — offer one-click install.
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-foreground/70">
        <AlertCircle className="h-3 w-3 shrink-0 text-primary" />
        <span>安装 OfficeCLI 后可让 AI 直接修改 Word/Excel/PPT 文档</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6 gap-1 rounded-md px-2 text-[11px]"
        disabled={installing}
        onClick={onInstall}
      >
        {installing ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <CheckCircle2 className="h-3 w-3" />
        )}
        {installing ? "安装中..." : "安装"}
      </Button>
    </div>
  );
}
