import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Loader2, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchPptTemplates, getApiBase, pptAddSources } from "@/lib/api";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptCanvasFormat, PptTemplate } from "@/lib/types";
import type { PptConfig } from "./PptMakerView";
import { PptTemplateDialog } from "./PptTemplateDialog";

interface PptConfigPanelProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  phase: "config" | "generating" | "done";
  onStart: () => void;
}

type SourceTab = "topic" | "files";

export function PptConfigPanel({ config, setConfig, phase, onStart }: PptConfigPanelProps) {
  const { client, token } = useClient();
  const readOnly = phase !== "config";

  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [canvasFormats, setCanvasFormats] = useState<PptCanvasFormat[]>([]);
  const [sourceTab, setSourceTab] = useState<SourceTab>("topic");
  const [uploading, setUploading] = useState(false);
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPptTemplates(token)
      .then((res) => {
        if (!cancelled) {
          setTemplates(res.templates);
          setCanvasFormats(res.canvasFormats);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  const selectedTemplate = templates.find(
    (t) => t.key === config.templateKey && t.kind === config.templateKind,
  );

  function templateImgUrl(url: string): string {
    const base = apiBase ?? "";
    const sep = url.includes("?") ? "&" : "?";
    return `${base}${url}${sep}token=${encodeURIComponent(token)}`;
  }

  function handleSelectTemplate(tpl: PptTemplate) {
    if (readOnly) return;
    if (config.templateKey === tpl.key && config.templateKind === tpl.kind) {
      setConfig((prev) => ({ ...prev, templateKey: null, templateKind: null }));
    } else {
      setConfig((prev) => ({ ...prev, templateKey: tpl.key, templateKind: tpl.kind }));
    }
  }

  function handleSelectFormat(fmt: PptCanvasFormat) {
    if (readOnly) return;
    setConfig((prev) => ({ ...prev, canvasFormat: fmt.key }));
  }

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
              extensions: ["pdf", "doc", "docx", "txt", "md", "pptx", "csv", "json"],
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
    <div>
      <div className="p-3 space-y-4">
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">模板</h3>
          {selectedTemplate ? (
            <div className="flex items-center gap-2 rounded-lg border border-primary/50 bg-muted/30 p-2">
              <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-muted">
                <img
                  src={templateImgUrl(selectedTemplate.coverSvgUrl)}
                  alt={selectedTemplate.name}
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[11px] font-medium text-foreground">
                    {selectedTemplate.name}
                  </span>
                  {selectedTemplate.kind === "deck" && selectedTemplate.primaryColor && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: selectedTemplate.primaryColor }}
                    />
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {selectedTemplate.group}
                </span>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setConfig((prev) => ({ ...prev, templateKey: null, templateKind: null }))
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ) : null}
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1.5 w-full text-[11px]"
              onClick={() => setTemplateDialogOpen(true)}
            >
              {selectedTemplate ? "更换模板" : "选择模板"}
            </Button>
          )}
          <PptTemplateDialog
            open={templateDialogOpen}
            onOpenChange={setTemplateDialogOpen}
            selectedKey={config.templateKey}
            selectedKind={config.templateKind}
            token={token}
            onSelect={handleSelectTemplate}
          />
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">画布格式</h3>
          <div className="flex flex-wrap gap-2">
            {canvasFormats.map((fmt) => (
              <button
                key={fmt.key}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors",
                  config.canvasFormat === fmt.key
                    ? "border-primary ring-1 ring-primary"
                    : "border-border/70 hover:border-border",
                  readOnly && "cursor-default",
                )}
                onClick={() => handleSelectFormat(fmt)}
                disabled={readOnly}
              >
                <div className="text-[11px] font-medium text-foreground">{fmt.label}</div>
                <div className="text-[10px] text-muted-foreground">{fmt.desc}</div>
              </button>
            ))}
          </div>
        </section>

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
          {sourceTab === "topic" ? (
            <Textarea
              className="min-h-[80px] resize-none text-[12px]"
              placeholder="描述你想要制作的 PPT 主题..."
              value={config.topic}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, topic: e.target.value }))
              }
              disabled={readOnly}
            />
          ) : (
            <div className="space-y-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept=".pdf,.doc,.docx,.txt,.md,.pptx,.csv,.json"
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
            disabled={!config.topic && config.sourceFiles.length === 0}
            onClick={onStart}
          >
            开始生成
          </Button>
        </div>
      )}
    </div>
  );
}
