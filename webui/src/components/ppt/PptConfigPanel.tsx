import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Download, FileText, FolderOpen, Loader2, Presentation, Upload, Wand2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { downloadPptOfficeCli, fetchPptOfficeCliCheck, fetchPptTemplates, pptAddSources, type PptOfficeCliStatus } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptCanvasFormat } from "@/lib/types";
import type {
  PptConfig,
  PptMode,
  PptImageMode,
  PptVisualMode,
  PptStyleMode,
  PptIconApproach,
  PptIconLibrary,
  PptFormulaPolicy,
  PptPageTransition,
  PptEntranceAnimation,
  PptAnimationTrigger,
  PptPhase,
} from "./PptMakerView";

interface PptConfigPanelProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  phase: PptPhase;
  onStart: () => void;
}

type SourceTab = "topic" | "files";

const IMAGE_MODE_OPTIONS: Array<{ value: PptImageMode; label: string; title: string }> = [
  { value: "none", label: "不用", title: "不主动生成 AI 图片" },
  { value: "key-pages", label: "关键页", title: "只在封面、章节页、关键概念页使用 AI 图片" },
  { value: "rich", label: "丰富", title: "允许更积极使用 AI 图片" },
];

const VISUAL_MODE_OPTIONS: Array<{ value: PptVisualMode; label: string; title: string }> = [
  { value: "auto", label: "自动", title: "按内容自动选择图表、流程图、架构图等表达方式" },
  { value: "data", label: "数据优先", title: "指标、趋势、对比内容优先做图表" },
  { value: "process", label: "流程架构", title: "业务链路、系统关系、方案结构优先做流程图或架构图" },
];

const STYLE_MODE_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "", label: "自动", title: "AI 根据内容推荐风格模式" },
  { value: "general", label: "通用", title: "视觉冲击优先，适合公众/客户" },
  { value: "consulting", label: "咨询", title: "数据清晰优先，适合团队/管理层" },
  { value: "top-consulting", label: "顶级咨询", title: "逻辑说服优先，适合高管/董事会" },
];

const ICON_APPROACH_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "", label: "自动", title: "AI 推荐图标方案" },
  { value: "emoji", label: "Emoji", title: "轻松活泼，社交媒体风格" },
  { value: "ai", label: "AI 生成", title: "自定义风格图标" },
  { value: "builtin", label: "内置图标库", title: "专业场景推荐" },
  { value: "custom", label: "自定义", title: "有品牌图标资源" },
];

const ICON_LIBRARY_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "tabler-filled", label: "Tabler 填充", title: "圆角曲线，亲和力强" },
  { value: "chunk-filled", label: "Chunk 填充", title: "直角几何，厚重建筑感" },
  { value: "tabler-outline", label: "Tabler 线条", title: "轻盈精致，适合屏幕" },
  { value: "phosphor-duotone", label: "Phosphor 双色", title: "双层质感，现代感" },
];

const FORMULA_POLICY_OPTIONS: Array<{ value: string; label: string; title: string }> = [
  { value: "", label: "自动", title: "AI 推荐公式渲染策略" },
  { value: "mixed", label: "混合", title: "复杂公式渲染为图片，简单保留文本" },
  { value: "render-all", label: "全部渲染", title: "所有公式渲染为图片" },
  { value: "text-only", label: "纯文本", title: "公式保留为可编辑文本" },
];

const PAGE_TRANSITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "fade", label: "淡入" },
  { value: "push", label: "推送" },
  { value: "wipe", label: "擦除" },
  { value: "split", label: "分割" },
  { value: "strips", label: "条带" },
  { value: "cover", label: "覆盖" },
  { value: "random", label: "随机" },
  { value: "none", label: "无" },
];

const ENTRANCE_ANIMATION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "auto", label: "自动（推荐）" },
  { value: "fade", label: "淡入" },
  { value: "fly", label: "飞入" },
  { value: "zoom", label: "缩放" },
  { value: "wipe", label: "擦除" },
  { value: "mixed", label: "混合轮换" },
  { value: "none", label: "无" },
];

const ANIMATION_TRIGGER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "after-previous", label: "自动级联" },
  { value: "with-previous", label: "同时" },
  { value: "on-click", label: "点击触发" },
];

export function PptConfigPanel({ config, setConfig, phase, onStart }: PptConfigPanelProps) {
  const { client, token } = useClient();
  const readOnly = phase !== "config";

  const [canvasFormats, setCanvasFormats] = useState<PptCanvasFormat[]>([]);
  const [sourceTab, setSourceTab] = useState<SourceTab>("topic");
  const [uploading, setUploading] = useState(false);
  const [designExpanded, setDesignExpanded] = useState(false);
  const [exportExpanded, setExportExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Template mode (officecli engine) ---
  const [engineStatus, setEngineStatus] = useState<PptOfficeCliStatus | null>(null);
  const [engineChecking, setEngineChecking] = useState(false);
  const [engineDownloading, setEngineDownloading] = useState(false);
  const [engineProgress, setEngineProgress] = useState(0);
  const [templateUploading, setTemplateUploading] = useState(false);
  const templateInputRef = useRef<HTMLInputElement>(null);

  const isTemplateMode = config.mode === "template";
  const engineOk = Boolean(engineStatus?.ok);

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

  // Check the engine the first time template mode is entered
  useEffect(() => {
    if (!isTemplateMode || readOnly || engineStatus || engineChecking) return;
    refreshEngineStatus();
  }, [isTemplateMode, readOnly, engineStatus, engineChecking, refreshEngineStatus]);

  const handleDownloadEngine = useCallback(async () => {
    if (engineDownloading) return;
    setEngineDownloading(true);
    setEngineProgress(0);
    // Simulate incremental progress while the download runs (same pattern
    // as the video runtime download).
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
      try {
        const res = await pptAddSources(token, [pptx]);
        const uploaded = res.files.find((f) => f.path.toLowerCase().endsWith(".pptx"));
        if (uploaded) {
          setConfig((prev) => ({ ...prev, templateFile: uploaded.path }));
        }
      } catch (e) {
        console.error("Failed to upload template", e);
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
        console.error("Failed to pick template via Tauri dialog", e);
      }
    } else {
      templateInputRef.current?.click();
    }
  }, [readOnly, templateUploading, addTemplateFile]);

  useEffect(() => {
    let cancelled = false;
    fetchPptTemplates(token)
      .then((res) => {
        if (!cancelled) {
          setCanvasFormats(res.canvasFormats);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

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

        setUploading(true);
        const res = await pptAddSources(token, paths);
        const newPaths = res.files.map((f) => f.path);
        setConfig((prev) => ({
          ...prev,
          sourceFiles: [...prev.sourceFiles, ...newPaths.filter((p) => !prev.sourceFiles.includes(p))],
        }));
      } catch (e) {
        console.error("Failed to pick files via Tauri dialog", e);
      } finally {
        setUploading(false);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [readOnly, uploading, token, setConfig]);

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
        try {
          setUploading(true);
          const res = await pptAddSources(token, paths);
          const newPaths = res.files.map((f) => f.path);
          setConfig((prev) => ({
            ...prev,
            sourceFiles: [...prev.sourceFiles, ...newPaths.filter((p) => !prev.sourceFiles.includes(p))],
          }));
        } catch {
        } finally {
          setUploading(false);
        }
      } else {
        setUploading(true);
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
          console.error("PPT upload timed out");
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
            console.error("PPT upload failed", result.error);
          }
        });
        client.sendPptUpload(results);
      }
    },
    [readOnly, uploading, token, setConfig, client],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">制作方式</h3>
          <div className="grid grid-cols-2 gap-1">
            {(
              [
                { value: "design", label: "AI 设计", title: "从 0 生成高视觉质量 PPT" },
                { value: "template", label: "我的模版", title: "上传 .pptx 模版，保留原有母版样式填充内容" },
              ] as Array<{ value: PptMode; label: string; title: string }>
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                title={item.title}
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

        {isTemplateMode && (
          <section>
            <h3 className="mb-2 text-[12px] font-medium text-foreground">模版引擎</h3>
            {engineChecking && !engineStatus ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 p-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在检测 OfficeCLI 引擎...
              </div>
            ) : engineOk ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/30 p-2 text-[11px]">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  引擎已就绪{engineStatus?.version ? `（${engineStatus.version}）` : ""}
                </span>
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-border/70 p-2">
                <div className="text-[11px] text-muted-foreground">
                  {engineStatus && !engineStatus.supported
                    ? "当前系统平台暂不支持模版模式"
                    : "模版模式需要 OfficeCLI 引擎（约 33 MB，仅首次下载）"}
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
                          {engineStatus?.error ? "重试下载" : "下载引擎"}
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
                  const reader = new FileReader();
                  reader.onload = () => {
                    const data_url = reader.result as string;
                    let handled = false;
                    const timeout = setTimeout(() => {
                      if (handled) return;
                      handled = true;
                      unsub();
                      setTemplateUploading(false);
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
                      }
                    });
                    client.sendPptUpload([{ name: file.name, data_url }]);
                  };
                  reader.onerror = () => setTemplateUploading(false);
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

        {!isTemplateMode && (
        <section>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-[12px] font-medium text-foreground"
            onClick={() => setDesignExpanded(!designExpanded)}
          >
            {designExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            设计偏好
            <span className="text-[10px] text-muted-foreground">（可选，不设则 AI 推荐）</span>
          </button>
          {designExpanded && (
            <div className="mt-2 space-y-3">
              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">风格模式</div>
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
                  {STYLE_MODE_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      title={item.title}
                      className={cn(
                        "rounded-md px-1.5 py-1 text-[10px] font-medium transition-all",
                        (config.styleMode ?? "") === item.value
                          ? "bg-background text-foreground shadow"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          styleMode: (item.value || null) as PptStyleMode | null,
                        }))
                      }
                      disabled={readOnly}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">视觉风格描述</div>
                <input
                  type="text"
                  className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[11px] outline-none focus:border-primary"
                  placeholder="如：极简、麦肯锡风、新中式、赛博朋克..."
                  value={config.styleDescriptor}
                  onChange={(e) => setConfig((prev) => ({ ...prev, styleDescriptor: e.target.value }))}
                  disabled={readOnly}
                />
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">页数</div>
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
                  <span className="text-[10px] text-muted-foreground">3-50，留空则 AI 推荐</span>
                </div>
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">目标受众</div>
                <input
                  type="text"
                  className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[11px] outline-none focus:border-primary"
                  placeholder="如：高管、技术团队、客户..."
                  value={config.audience}
                  onChange={(e) => setConfig((prev) => ({ ...prev, audience: e.target.value }))}
                  disabled={readOnly}
                />
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">主色调</div>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    className="h-7 w-7 cursor-pointer rounded border border-border/70"
                    value={config.primaryColor || "#1565C0"}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, primaryColor: e.target.value }))
                    }
                    disabled={readOnly}
                  />
                  <input
                    type="text"
                    className="w-24 rounded-lg border border-border/70 bg-transparent px-2 py-1 text-[11px] outline-none focus:border-primary"
                    placeholder="#000000"
                    value={config.primaryColor}
                    onChange={(e) => setConfig((prev) => ({ ...prev, primaryColor: e.target.value }))}
                    disabled={readOnly}
                  />
                  {config.primaryColor && (
                    <button
                      type="button"
                      className="text-[10px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfig((prev) => ({ ...prev, primaryColor: "" }))}
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">图标方案</div>
                <div className="grid grid-cols-5 gap-1 rounded-lg bg-muted p-1">
                  {ICON_APPROACH_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      title={item.title}
                      className={cn(
                        "rounded-md px-1 py-1 text-[10px] font-medium transition-all",
                        (config.iconApproach ?? "") === item.value
                          ? "bg-background text-foreground shadow"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          iconApproach: (item.value || null) as PptIconApproach | null,
                        }))
                      }
                      disabled={readOnly}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {config.iconApproach === "builtin" && (
                <div>
                  <div className="mb-1 text-[10px] text-muted-foreground">图标库</div>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                    {ICON_LIBRARY_OPTIONS.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        title={item.title}
                        className={cn(
                          "rounded-md px-2 py-1 text-[10px] font-medium transition-all",
                          (config.iconLibrary ?? "tabler-filled") === item.value
                            ? "bg-background text-foreground shadow"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() =>
                          setConfig((prev) => ({
                            ...prev,
                            iconLibrary: item.value as PptIconLibrary,
                          }))
                        }
                        disabled={readOnly}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">公式渲染</div>
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted p-1">
                  {FORMULA_POLICY_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      title={item.title}
                      className={cn(
                        "rounded-md px-1.5 py-1 text-[10px] font-medium transition-all",
                        (config.formulaPolicy ?? "") === item.value
                          ? "bg-background text-foreground shadow"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          formulaPolicy: (item.value || null) as PptFormulaPolicy | null,
                        }))
                      }
                      disabled={readOnly}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
        )}

        {!isTemplateMode && (
        <section>
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-[12px] font-medium text-foreground"
            onClick={() => setExportExpanded(!exportExpanded)}
          >
            {exportExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            动画与导出
            <span className="text-[10px] text-muted-foreground">（可选，默认已启用入场动画）</span>
          </button>
          {exportExpanded && (
            <div className="mt-2 space-y-3">
              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">页面过渡</div>
                <select
                  className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[11px] outline-none focus:border-primary"
                  value={config.pageTransition}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, pageTransition: e.target.value as PptPageTransition }))
                  }
                  disabled={readOnly}
                >
                  {PAGE_TRANSITION_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">入场动画</div>
                <select
                  className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[11px] outline-none focus:border-primary"
                  value={config.entranceAnimation}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, entranceAnimation: e.target.value as PptEntranceAnimation }))
                  }
                  disabled={readOnly}
                >
                  {ENTRANCE_ANIMATION_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">动画触发方式</div>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                  {ANIMATION_TRIGGER_OPTIONS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={cn(
                        "rounded-md px-2 py-1 text-[10px] font-medium transition-all",
                        config.animationTrigger === item.value
                          ? "bg-background text-foreground shadow"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() =>
                        setConfig((prev) => ({ ...prev, animationTrigger: item.value as PptAnimationTrigger }))
                      }
                      disabled={readOnly}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">自动翻页</div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={300}
                    className="w-20 rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[11px] outline-none focus:border-primary"
                    placeholder="关闭"
                    value={config.autoAdvance ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setConfig((prev) => ({
                        ...prev,
                        autoAdvance: v === "" ? null : Math.max(1, parseInt(v) || 5),
                      }));
                    }}
                    disabled={readOnly}
                  />
                  <span className="text-[10px] text-muted-foreground">秒，留空则关闭</span>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border"
                  checked={config.enableNarration}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, enableNarration: e.target.checked }))
                  }
                  disabled={readOnly}
                />
                <span className="text-[11px]">启用自动朗读</span>
                <Wand2 className="h-3 w-3 text-muted-foreground" />
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border"
                  checked={config.mergeParagraphs}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, mergeParagraphs: e.target.checked }))
                  }
                  disabled={readOnly}
                />
                <span className="text-[11px]">合并段落（可编辑优先）</span>
              </label>
            </div>
          )}
        </section>
        )}

        {!isTemplateMode && (
        <>
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">画布格式</h3>
          <select
            className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-2 text-[11px] outline-none focus:border-primary"
            value={config.canvasFormat}
            onChange={(e) => setConfig((prev) => ({ ...prev, canvasFormat: e.target.value }))}
            disabled={readOnly}
          >
            {canvasFormats.map((fmt) => (
              <option key={fmt.key} value={fmt.key}>
                {fmt.label} — {fmt.desc}
              </option>
            ))}
          </select>
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">生成策略</h3>
          <div className="space-y-2">
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">AI 图片</div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                {IMAGE_MODE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    title={item.title}
                    className={cn(
                      "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                      config.imageMode === item.value
                        ? "bg-background text-foreground shadow"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setConfig((prev) => ({ ...prev, imageMode: item.value }))}
                    disabled={readOnly}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] text-muted-foreground">表达方式</div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                {VISUAL_MODE_OPTIONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    title={item.title}
                    className={cn(
                      "rounded-md px-2 py-1 text-[11px] font-medium transition-all",
                      config.visualMode === item.value
                        ? "bg-background text-foreground shadow"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setConfig((prev) => ({ ...prev, visualMode: item.value }))}
                    disabled={readOnly}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
        </>
        )}

        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">输入来源</h3>
          <div className="mb-2 flex gap-1 rounded-lg bg-muted p-1">
            <button
              className={cn(
                "flex-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
                sourceTab === "topic"
                  ? "bg-background text-foreground shadow"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSourceTab("topic")}
              disabled={readOnly}
            >
              <FileText className="mr-1 inline h-3 w-3" />
              输入主题
            </button>
            <button
              className={cn(
                "flex-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
                sourceTab === "files"
                  ? "bg-background text-foreground shadow"
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
                    try {
                      setUploading(true);
                      const res = await pptAddSources(token, paths);
                      const newPaths = res.files.map((f) => f.path);
                      setConfig((prev) => ({
                        ...prev,
                        sourceFiles: [
                          ...prev.sourceFiles,
                          ...newPaths.filter((p) => !prev.sourceFiles.includes(p)),
                        ],
                      }));
                    } catch (err) {
                      console.error("Failed to add sources", err);
                    } finally {
                      setUploading(false);
                    }
                  } else {
                    setUploading(true);
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
                      console.error("PPT upload timed out");
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
                        console.error("PPT upload failed", result.error);
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
        </section>


      </div>

      {!readOnly && (
        <div className="shrink-0 border-t border-border/70 p-3">
          <Button
            className="w-full"
            disabled={
              (!config.topic && config.sourceFiles.length === 0) ||
              (isTemplateMode && (!engineOk || !config.templateFile))
            }
            onClick={onStart}
          >
            开始生成
          </Button>
          {isTemplateMode && (!engineOk || !config.templateFile) && (
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
              {!engineOk ? "请先下载模版引擎" : "请先上传 PPT 模版"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
