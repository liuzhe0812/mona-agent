import { useCallback, useRef, useState } from "react";
import { FileText, Loader2, Upload, X } from "lucide-react";

import { pptAddSources } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptConfig } from "./PptMakerView";
import type { ActionError } from "./PptConfigWizard";

interface PptConfigStepSourcesProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  readOnly: boolean;
  onActionError: (error: ActionError | null) => void;
}

const WEB_MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 向导第 2 步：源文件上传（可跳过） */
export function PptConfigStepSources({
  config,
  setConfig,
  readOnly,
  onActionError,
}: PptConfigStepSourcesProps) {
  const { client, token } = useClient();
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadSourcePaths = useCallback(
    async (paths: string[]) => {
      setUploading(true);
      onActionError(null);
      try {
        const res = await pptAddSources(token, paths);
        const newPaths = res.files.map((f) => f.path);
        setConfig((prev) => ({
          ...prev,
          sourceFiles: [...prev.sourceFiles, ...newPaths.filter((p) => !prev.sourceFiles.includes(p))],
        }));
      } catch (e) {
        onActionError({
          message: `文件上传失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void uploadSourcePaths(paths),
        });
      } finally {
        setUploading(false);
      }
    },
    [token, setConfig, onActionError],
  );

  // Web 端上传：FileReader 读为 data_url 后经 WebSocket 上传
  const uploadWebFiles = useCallback(
    async (files: File[]) => {
      setUploading(true);
      onActionError(null);
      const readPromises = files.map(
        (file) =>
          new Promise<{ name: string; data_url: string } | null>((resolve) => {
            const ext = "." + file.name.split(".").pop()?.toLowerCase();
            const mime = WEB_MIME_MAP[ext];
            if (!mime) {
              resolve(null);
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              const b64 = reader.result as string;
              resolve({ name: file.name, data_url: b64 });
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
          }),
      );
      const results = (await Promise.all(readPromises)).filter(
        (r): r is { name: string; data_url: string } => r !== null,
      );
      if (results.length === 0) {
        setUploading(false);
        return;
      }
      let handled = false;
      const fail = (message: string) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);
        unsub();
        setUploading(false);
        onActionError({ message, retry: null });
      };
      const timeout = setTimeout(() => {
        fail("文件上传超时，请重试");
      }, 30_000);
      const unsub = client.onPptUploadResult((result) => {
        if (handled) return;
        handled = true;
        clearTimeout(timeout);
        unsub();
        setUploading(false);
        if (result.ok && result.files) {
          const newPaths = result.files.map((f) => f.path);
          setConfig((prev) => ({
            ...prev,
            sourceFiles: [...prev.sourceFiles, ...newPaths.filter((p) => !prev.sourceFiles.includes(p))],
          }));
        } else {
          onActionError({
            message: `文件上传失败：${result.error ?? "未知错误"}`,
            retry: null,
          });
        }
      });
      client.sendPptUpload(results);
    },
    [client, setConfig, onActionError],
  );

  const handlePickFiles = useCallback(async () => {
    if (readOnly || uploading) return;

    if (isTauri()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: true,
          directory: false,
          title: "选择源文件",
          filters: [
            {
              name: "文档",
              extensions: ["pdf", "doc", "docx", "txt", "md", "pptx", "csv", "json", "xls", "xlsx"],
            },
          ],
        });
        if (!selected) return;
        const paths = Array.isArray(selected)
          ? selected.map(String)
          : [String(selected)];
        if (paths.length === 0) return;
        await uploadSourcePaths(paths);
      } catch (e) {
        onActionError({
          message: `选择文件失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void handlePickFiles(),
        });
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [readOnly, uploading, uploadSourcePaths, onActionError]);

  const handleWebFilesSelected = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      if (isTauri()) {
        const paths = files
          .map((f) => (f as File & { path?: string }).path)
          .filter((p): p is string => typeof p === "string");
        if (paths.length === 0) return;
        await uploadSourcePaths(paths);
      } else {
        await uploadWebFiles(files);
      }
    },
    [uploadSourcePaths, uploadWebFiles],
  );

  const handleDropFiles = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (readOnly || uploading) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      await handleWebFilesSelected(files);
    },
    [readOnly, uploading, handleWebFilesSelected],
  );

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".pdf,.doc,.docx,.txt,.md,.pptx,.csv,.json,.xls,.xlsx"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          await handleWebFilesSelected(files);
        }}
      />
      <button
        type="button"
        className={cn(
          "flex min-h-[80px] w-full items-center justify-center rounded-lg border border-dashed text-[11px] transition-colors",
          uploading
            ? "border-border/50 bg-muted/20 text-muted-foreground"
            : "border-border/70 text-muted-foreground hover:border-border hover:bg-muted/30",
          readOnly && "cursor-default",
        )}
        onClick={handlePickFiles}
        disabled={readOnly || uploading}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={handleDropFiles}
      >
        {uploading ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            正在添加文件...
          </>
        ) : (
          <>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            点击选择文件或拖拽到此处
          </>
        )}
      </button>
      <p className="text-[10px] text-muted-foreground">
        文件将复制到工作区，AI 将直接读取文件内容
      </p>
      {config.sourceFiles.length > 0 && (
        <div className="space-y-1">
          {config.sourceFiles.map((path, i) => (
            <div
              key={`${path}-${i}`}
              className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px]"
            >
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{path}</span>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`移除文件 ${path}`}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setConfig((prev) => ({
                      ...prev,
                      sourceFiles: prev.sourceFiles.filter((_, idx) => idx !== i),
                    }))
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
