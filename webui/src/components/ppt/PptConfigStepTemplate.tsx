import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, LayoutTemplate, Loader2, Presentation, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadPptOfficeCli, fetchPptOfficeCliCheck, getApiBase, pptAddSources, type PptOfficeCliStatus } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptTemplate } from "@/lib/types";
import type { PptConfig } from "./PptMakerView";
import type { ActionError } from "./PptConfigWizard";
import { PptTemplateDialog } from "./PptTemplateDialog";

interface PptConfigStepTemplateProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  readOnly: boolean;
  selectedTemplate: PptTemplate | null;
  setSelectedTemplate: (tpl: PptTemplate | null) => void;
  onActionError: (error: ActionError | null) => void;
  /** 向导向父级报告本步骤的阻塞原因；null 表示可继续 */
  onTemplateIssueChange: (issue: string | null) => void;
}

const TEMPLATE_KIND_LABELS: Record<string, string> = {
  layout: "内置版式",
  brand: "品牌模板",
};

/** 向导第 3 步：模板选择（从内容生成）或编辑组件 + 模版上传（沿用现有 PPT） */
export function PptConfigStepTemplate({
  config,
  setConfig,
  readOnly,
  selectedTemplate,
  setSelectedTemplate,
  onActionError,
  onTemplateIssueChange,
}: PptConfigStepTemplateProps) {
  const { client, token } = useClient();
  const isTemplateMode = config.mode === "template";

  // --- Template mode (PPT 编辑组件) ---
  const [engineStatus, setEngineStatus] = useState<PptOfficeCliStatus | null>(null);
  const [engineChecking, setEngineChecking] = useState(false);
  const [engineDownloading, setEngineDownloading] = useState(false);
  const [engineProgress, setEngineProgress] = useState(0);
  const [templateUploading, setTemplateUploading] = useState(false);
  const templateInputRef = useRef<HTMLInputElement>(null);

  // --- 从内容生成：内置版式 / 品牌 / 自定义模板选择 ---
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [apiBase, setApiBase] = useState("");

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

  // 向向导报告本步骤阻塞原因（从内容生成模式始终可继续）
  useEffect(() => {
    if (!isTemplateMode) {
      onTemplateIssueChange(null);
      return;
    }
    onTemplateIssueChange(
      !engineOk
        ? "请先下载 PPT 编辑组件"
        : !config.templateFile
          ? "请先上传 PPT 模版"
          : null,
    );
  }, [isTemplateMode, engineOk, config.templateFile, onTemplateIssueChange]);

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
      onActionError(null);
      try {
        const res = await pptAddSources(token, [pptx]);
        const uploaded = res.files.find((f) => f.path.toLowerCase().endsWith(".pptx"));
        if (uploaded) {
          setConfig((prev) => ({ ...prev, templateFile: uploaded.path }));
        }
      } catch (e) {
        onActionError({
          message: `模版上传失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void addTemplateFile(paths),
        });
      } finally {
        setTemplateUploading(false);
      }
    },
    [token, setConfig, onActionError],
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
        onActionError({
          message: `选择模版失败：${e instanceof Error ? e.message : "未知错误"}`,
          retry: () => void handlePickTemplate(),
        });
      }
    } else {
      templateInputRef.current?.click();
    }
  }, [readOnly, templateUploading, addTemplateFile, onActionError]);

  const handleWebTemplateSelected = useCallback(
    async (file: File) => {
      const path = (file as File & { path?: string }).path;
      if (isTauri() && typeof path === "string") {
        await addTemplateFile([path]);
        return;
      }
      setTemplateUploading(true);
      onActionError(null);
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
          onActionError({ message, retry: null });
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
            onActionError({
              message: `模版上传失败：${result.error ?? "未知错误"}`,
              retry: null,
            });
          }
        });
        client.sendPptUpload([{ name: file.name, data_url }]);
      };
      reader.onerror = () => {
        setTemplateUploading(false);
        onActionError({ message: "模版读取失败，请重试", retry: null });
      };
      reader.readAsDataURL(file);
    },
    [client, setConfig, addTemplateFile, onActionError],
  );

  if (!isTemplateMode) {
    // 从内容生成：版式（可选）+ 页数（可选）
    return (
      <div className="space-y-4">
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

        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">
            页数
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">（可选，留空则 AI 推荐）</span>
          </h3>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={3}
              max={50}
              className="w-20 text-[11px]"
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
      </div>
    );
  }

  // 沿用现有 PPT：编辑组件 + .pptx 模版
  return (
    <div className="space-y-4">
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
            await handleWebTemplateSelected(file);
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
    </div>
  );
}
