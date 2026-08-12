import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileText, FolderOpen, LayoutTemplate, Loader2, Presentation, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { downloadPptOfficeCli, fetchPptOfficeCliCheck, getApiBase, pptAddSources, type PptOfficeCliStatus } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptTemplate } from "@/lib/types";
import type {
  PptConfig,
  PptMode,
  PptPhase,
} from "./PptMakerView";
import { PptTemplateDialog } from "./PptTemplateDialog";

interface PptConfigPanelProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  phase: PptPhase;
  onStart: () => void;
}

type SourceTab = "topic" | "files";

/** 配置页统一错误区域：携带原动作的重试入口 */
interface ActionError {
  message: string;
  retry: (() => void) | null;
}

const TEMPLATE_KIND_LABELS: Record<string, string> = {
  layout: "内置版式",
  brand: "品牌模板",
};

/**
 * @deprecated PPT-401：配置面板已重构为四步向导式（PptConfigWizard），
 * 新需求请使用 ./PptConfigWizard。本组件仅保留用于向后兼容与既有测试。
 */
export function PptConfigPanel({ config, setConfig, phase, onStart }: PptConfigPanelProps) {
  const { client, token } = useClient();
  const readOnly = phase !== "config";

  const [sourceTab, setSourceTab] = useState<SourceTab>("topic");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 统一错误区域：上传、选择文件和模板加载失败都写入这里
  const [actionError, setActionError] = useState<ActionError | null>(null);

  // --- Template mode (PPT 编辑组件) ---
  const [engineStatus, setEngineStatus] = useState<PptOfficeCliStatus | null>(null);
  const [engineChecking, setEngineChecking] = useState(false);
  const [engineDownloading, setEngineDownloading] = useState(false);
  const [engineProgress, setEngineProgress] = useState(0);
  const [templateUploading, setTemplateUploading] = useState(false);
  const templateInputRef = useRef<HTMLInputElement>(null);

  // --- 从内容生成：内置版式 / 品牌 / 自定义模板选择 ---
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<PptTemplate | null>(null);
  const [apiBase, setApiBase] = useState("");

  const isTemplateMode = config.mode === "template";
  const engineOk = Boolean(engineStatus?.ok);

  useEffect(() => {
    getApiBase().then(setApiBase).catch(() => {});
  }, []);

  const refreshEngineStatus = useCallback(async (): Promise<boolean> => {
    setEngineChecking(true);
    try {
      const status = await fetchPptOfficeCliCheck(token);
      setEngineStatus(status);
      return status.ok;
    } catch {
      setEngineStatus(null);
      return false;
    } finally {
      setEngineChecking(false);
    }
  }, [token]);

  useEffect(() => {
    if (!isTemplateMode || readOnly || engineStatus || engineChecking) return;
    refreshEngineStatus();
  }, [isTemplateMode, readOnly, engineStatus, engineChecking, refreshEngineStatus]);

  const handleDownloadEngine = useCallback(async () => {
    if (engineDownloading) return;
    setEngineDownloading(true);
    setEngineProgress(0);
    const timer = setInterval(() => {
      setEngineProgress((prev) => Math.min(prev + 4, 90));
    }, 300);
    try {
      const result = await downloadPptOfficeCli(token);
      clearInterval(timer);
      if (result.ok) {
        setEngineProgress(100);
        await refreshEngineStatus();
      } else {
        setEngineStatus((prev) =>
          prev
            ? { ...prev, ok: false, error: result.error ?? "下载失败" }
            : { ok: false, version: null, path: null, error: result.error ?? "下载失败", supported: true },
        );
      }
    } catch (e) {
      clearInterval(timer);
      setEngineStatus((prev) =>
        prev
          ? { ...prev, ok: false, error: e instanceof Error ? e.message : "下载失败" }
          : { ok: false, version: null, path: null, error: "下载失败", supported: true },
      );
    } finally {
      setEngineDownloading(false);
    }
  }, [engineDownloading, token, refreshEngineStatus]);

  const addTemplateFile = useCallback(
    async (paths: string[]) => {
      const pptx = paths.find((p) => p.toLowerCase().endsWith(".pptx"));
      if (!pptx) return;
      setTemplateUploading(true);
      setActionError(null);
      try {
        const res = await pptAddSources(token, [pptx]);
        const uploaded = res.files.find((f) => f.path.toLowerCase().endsWith(".pptx"));
        if (uploaded) {
          setConfig((prev) => ({ ...prev, templateFile: uploaded.path }));
        }
      } catch (e) {
        setActionError({
          message: `模版上传失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void addTemplateFile(paths),
        });
      } finally {
        setTemplateUploading(false);
      }
    },
    [token, setConfig],
  );

  const handlePickTemplate = useCallback(async () => {
    if (readOnly || templateUploading) return;
    if (isTauri()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          directory: false,
          title: "选择 PPT 模版",
          filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
        });
        if (!selected) return;
        await addTemplateFile([String(selected)]);
      } catch (e) {
        setActionError({
          message: `选择模版失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void handlePickTemplate(),
        });
      }
    } else {
      templateInputRef.current?.click();
    }
  }, [readOnly, templateUploading, addTemplateFile]);

  const uploadSourcePaths = useCallback(
    async (paths: string[]) => {
      setUploading(true);
      setActionError(null);
      try {
        const res = await pptAddSources(token, paths);
        const newPaths = res.files.map((f) => f.path);
        setConfig((prev) => ({
          ...prev,
          sourceFiles: [...prev.sourceFiles, ...newPaths.filter((p) => !prev.sourceFiles.includes(p))],
        }));
      } catch (e) {
        setActionError({
          message: `文件上传失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void uploadSourcePaths(paths),
        });
      } finally {
        setUploading(false);
      }
    },
    [token, setConfig],
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
        setActionError({
          message: `选择文件失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void handlePickFiles(),
        });
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [readOnly, uploading, uploadSourcePaths]);

  const handleDropFiles = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (readOnly || uploading) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      if (isTauri()) {
        const paths: string[] = [];
        for (const file of files) {
          if ("path" in file && typeof (file as File & { path?: string }).path === "string") {
            paths.push((file as File & { path: string }).path);
          }
        }
        if (paths.length === 0) return;
        await uploadSourcePaths(paths);
      } else {
        setUploading(true);
        setActionError(null);
        const mimeMap: Record<string, string> = {
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
        const readPromises = files.map(
          (file) =>
            new Promise<{ name: string; data_url: string } | null>((resolve) => {
              const ext = "." + file.name.split(".").pop()?.toLowerCase();
              const mime = mimeMap[ext];
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
          setActionError({ message, retry: null });
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
            setActionError({
              message: `文件上传失败：${result.error ?? "未知错误"}`,
              retry: null,
            });
          }
        });
        client.sendPptUpload(results);
      }
    },
    [readOnly, uploading, uploadSourcePaths, setConfig, client],
  );

  // 主按钮禁用原因（PPT-102：不可用必须给出原因）
  const missingContent = !config.topic.trim() && config.sourceFiles.length === 0;
  const startDisabledReason = missingContent
    ? "请先填写主题或添加源文件"
    : isTemplateMode && !engineOk
      ? "请先下载 PPT 编辑组件"
      : isTemplateMode && !config.templateFile
        ? "请先上传 PPT 模版"
        : null;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
        {/* 制作方式 */}
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">制作方式</h3>
          <div className="grid grid-cols-2 gap-1">
            {(
              [
                { value: "design", label: "从内容生成", title: "输入主题或上传素材，AI 从 0 生成高质量 PPT，可选内置版式" },
                { value: "template", label: "沿用现有 PPT", title: "上传 .pptx，保留原有母版样式填充内容" },
              ] as Array<{ value: PptMode; label: string; title: string }>
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                title={item.title}
                aria-pressed={config.mode === item.value}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  config.mode === item.value
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
                onClick={() => setConfig((prev) => ({ ...prev, mode: item.value }))}
                disabled={readOnly}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        {/* PPT 编辑组件 + PPT 模版（仅沿用现有 PPT 模式） */}
        {isTemplateMode && (
          <section>
            <h3 className="mb-2 text-[12px] font-medium text-foreground">PPT 编辑组件</h3>
            {engineChecking && !engineStatus ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 p-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在检测 PPT 编辑组件...
              </div>
            ) : engineOk ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/30 p-2 text-[11px]">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  PPT 编辑组件已就绪{engineStatus?.version ? `（${engineStatus.version}）` : ""}
                </span>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-border/70 p-2">
                <div className="text-[11px] text-muted-foreground">
                  {engineStatus && !engineStatus.supported
                    ? "当前系统平台暂不支持沿用现有 PPT"
                    : "沿用现有 PPT 需要 PPT 编辑组件（约 33 MB，仅首次下载）"}
                </div>
                {engineStatus?.error && engineStatus.supported && (
                  <div className="text-[10px] text-destructive">{engineStatus.error}</div>
                )}
                {engineStatus?.supported !== false && (
                  <>
                    {engineDownloading && (
                      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${engineProgress}%` }}
                        />
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-[11px]"
                      onClick={handleDownloadEngine}
                      disabled={engineDownloading || readOnly}
                    >
                      {engineDownloading ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          正在下载 {engineProgress}%
                        </>
                      ) : (
                        <>
                          <Download className="mr-1.5 h-3.5 w-3.5" />
                          {engineStatus?.error ? "重试下载" : "下载 PPT 编辑组件"}
                        </>
                      )}
                    </Button>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {isTemplateMode && (
          <section>
            <h3 className="mb-2 text-[12px] font-medium text-foreground">PPT 模版</h3>
            <input
              ref={templateInputRef}
              type="file"
              className="hidden"
              accept=".pptx"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const path = (file as File & { path?: string }).path;
                if (isTauri() && typeof path === "string") {
                  await addTemplateFile([path]);
                } else {
                  setTemplateUploading(true);
                  setActionError(null);
                  const reader = new FileReader();
                  reader.onload = () => {
                    const data_url = reader.result as string;
                    let handled = false;
                    const fail = (message: string) => {
                      if (handled) return;
                      handled = true;
                      clearTimeout(timeout);
                      unsub();
                      setTemplateUploading(false);
                      setActionError({ message, retry: null });
                    };
                    const timeout = setTimeout(() => {
                      fail("模版上传超时，请重试");
                    }, 30_000);
                    const unsub = client.onPptUploadResult((result) => {
                      if (handled) return;
                      handled = true;
                      clearTimeout(timeout);
                      unsub();
                      setTemplateUploading(false);
                      const uploaded = result.files?.find((f) =>
                        f.path.toLowerCase().endsWith(".pptx"),
                      );
                      if (result.ok && uploaded) {
                        setConfig((prev) => ({ ...prev, templateFile: uploaded.path }));
                      } else {
                        setActionError({
                          message: `模版上传失败：${result.error ?? "未知错误"}`,
                          retry: null,
                        });
                      }
                    });
                    client.sendPptUpload([{ name: file.name, data_url }]);
                  };
                  reader.onerror = () => {
                    setTemplateUploading(false);
                    setActionError({ message: "模版读取失败，请重试", retry: null });
                  };
                  reader.readAsDataURL(file);
                }
              }}
            />
            {config.templateFile ? (
              <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-[11px]">
                <Presentation className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{config.templateFile}</span>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label="清除已上传的模版"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setConfig((prev) => ({ ...prev, templateFile: null }))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                className={cn(
                  "flex min-h-[60px] w-full items-center justify-center rounded-lg border border-dashed text-[11px] transition-colors",
                  templateUploading
                    ? "border-border/50 bg-muted/20 text-muted-foreground"
                    : "border-border/70 text-muted-foreground hover:border-border hover:bg-muted/30",
                  (!engineOk || readOnly) && "cursor-not-allowed opacity-50",
                )}
                onClick={handlePickTemplate}
                disabled={!engineOk || readOnly || templateUploading}
              >
                {templateUploading ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    正在上传模版...
                  </>
                ) : (
                  <>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    选择 .pptx 模版文件
                  </>
                )}
              </button>
            )}
            <p className="mt-1 text-[10px] text-muted-foreground">
              保留模版的母版、版式与配色，AI 仅填充内容
            </p>
          </section>
        )}

        {/* 版式选择（仅从内容生成模式） */}
        {!isTemplateMode && (
          <section>
            <h3 className="mb-2 text-[12px] font-medium text-foreground">
              版式
              <span className="ml-1 text-[10px] font-normal text-muted-foreground">（可选，不选则由 AI 推荐）</span>
            </h3>
            {config.templateKey ? (
              <div className="flex items-center gap-2 rounded-lg border border-border/70 p-2">
                <div className="h-10 w-[72px] shrink-0 overflow-hidden rounded-md bg-muted">
                  {selectedTemplate?.coverSvgUrl && apiBase ? (
                    <img
                      src={`${apiBase}${selectedTemplate.coverSvgUrl}${selectedTemplate.coverSvgUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`}
                      alt={selectedTemplate.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-full w-full items-center justify-center"
                      style={{ backgroundColor: selectedTemplate?.primaryColor || "#e5e5e5" }}
                    >
                      <LayoutTemplate className="h-4 w-4 text-white/80" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-foreground">
                    {selectedTemplate?.name ?? config.templateKey}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {config.templateKind ? TEMPLATE_KIND_LABELS[config.templateKind] : ""}
                  </div>
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/10"
                      onClick={() => setTemplateDialogOpen(true)}
                    >
                      更换
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      onClick={() => {
                        setSelectedTemplate(null);
                        setConfig((prev) => ({ ...prev, templateKey: null, templateKind: null }));
                      }}
                    >
                      清除
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                className={cn(
                  "flex min-h-[48px] w-full items-center justify-center rounded-lg border border-dashed text-[11px] transition-colors",
                  "border-border/70 text-muted-foreground hover:border-border hover:bg-muted/30",
                  readOnly && "cursor-default opacity-60",
                )}
                onClick={() => setTemplateDialogOpen(true)}
                disabled={readOnly}
              >
                <LayoutTemplate className="mr-1.5 h-3.5 w-3.5" />
                选择内置版式或品牌模板
              </button>
            )}
            <PptTemplateDialog
              open={templateDialogOpen}
              onOpenChange={setTemplateDialogOpen}
              selectedKey={config.templateKey}
              selectedKind={config.templateKind === "native" ? null : config.templateKind}
              token={token}
              onSelect={(tpl) => {
                setSelectedTemplate(tpl);
                setConfig((prev) => ({ ...prev, templateKey: tpl.key, templateKind: tpl.kind }));
              }}
            />
          </section>
        )}

        {/* 页数（仅从内容生成模式） */}
        {!isTemplateMode && (
          <section>
            <h3 className="mb-2 text-[12px] font-medium text-foreground">
              页数
              <span className="ml-1 text-[10px] font-normal text-muted-foreground">（可选，留空则 AI 推荐）</span>
            </h3>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={3}
                max={50}
                className="w-20 rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[11px] outline-none focus:border-primary"
                placeholder="自动"
                value={config.pageCount ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setConfig((prev) => ({
                    ...prev,
                    pageCount: v === "" ? null : Math.max(3, Math.min(50, parseInt(v) || 3)),
                  }));
                }}
                disabled={readOnly}
              />
              <span className="text-[10px] text-muted-foreground">3-50 页</span>
            </div>
          </section>
        )}

        {/* 输入来源/主题 */}
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">
            {isTemplateMode ? "主题" : "输入来源"}
          </h3>
          {isTemplateMode ? (
            <Textarea
              className="min-h-[80px] resize-none text-[12px]"
              placeholder="描述你想在模版上制作的内容..."
              value={config.topic}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, topic: e.target.value }))
              }
              disabled={readOnly}
            />
          ) : (
          <>
          <div className="mb-2 flex gap-1 rounded-lg bg-muted p-1">
            <button
              type="button"
              aria-pressed={sourceTab === "topic"}
              className={cn(
                "flex-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
                sourceTab === "topic"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSourceTab("topic")}
              disabled={readOnly}
            >
              <FileText className="mr-1 inline h-3 w-3" />
              输入主题
            </button>
            <button
              type="button"
              aria-pressed={sourceTab === "files"}
              className={cn(
                "flex-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
                sourceTab === "files"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSourceTab("files")}
              disabled={readOnly}
            >
              <FolderOpen className="mr-1 inline h-3 w-3" />
              源文件
            </button>
          </div>
          {sourceTab === "topic" && (
            <Textarea
              className="min-h-[80px] resize-none text-[12px]"
              placeholder="描述你想要制作的 PPT 主题..."
              value={config.topic}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, topic: e.target.value }))
              }
              disabled={readOnly}
            />
          )}
          {sourceTab === "files" && (
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
                  if (files.length === 0) return;

                  if (isTauri()) {
                    const paths = files
                      .map((f) => (f as File & { path?: string }).path)
                      .filter((p): p is string => typeof p === "string");
                    if (paths.length === 0) return;
                    await uploadSourcePaths(paths);
                  } else {
                    setUploading(true);
                    setActionError(null);
                    const mimeMap: Record<string, string> = {
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
                    const readPromises = files.map(
                      (file) =>
                        new Promise<{ name: string; data_url: string } | null>((resolve) => {
                          const ext = "." + file.name.split(".").pop()?.toLowerCase();
                          const mime = mimeMap[ext];
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
                    const timeout = setTimeout(() => {
                      if (handled) return;
                      handled = true;
                      unsub();
                      setUploading(false);
                      setActionError({ message: "文件上传超时，请重试", retry: null });
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
                          sourceFiles: [
                            ...prev.sourceFiles,
                            ...newPaths.filter((p) => !prev.sourceFiles.includes(p)),
                          ],
                        }));
                      } else {
                        setActionError({
                          message: `文件上传失败：${result.error ?? "未知错误"}`,
                          retry: null,
                        });
                      }
                    });
                    client.sendPptUpload(results);
                  }
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
          )}
          </>
          )}
        </section>
      </div>

      {!readOnly && (
        <div className="shrink-0 border-t border-border/70 p-3">
          {actionError && (
            <div className="mb-2 flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1">{actionError.message}</span>
              {actionError.retry && (
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
                  onClick={() => {
                    const retry = actionError.retry;
                    setActionError(null);
                    retry?.();
                  }}
                >
                  重试
                </button>
              )}
              <button
                type="button"
                aria-label="关闭错误提示"
                className="shrink-0 rounded px-1 hover:bg-destructive/10"
                onClick={() => setActionError(null)}
              >
                ×
              </button>
            </div>
          )}
          <Button
            className="w-full"
            disabled={
              missingContent ||
              (isTemplateMode && (!engineOk || !config.templateFile))
            }
            onClick={onStart}
          >
            开始生成
          </Button>
          {startDisabledReason && (
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
              {startDisabledReason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
