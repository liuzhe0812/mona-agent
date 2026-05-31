import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, Palette, Upload, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { fetchPptTemplates, getApiBase } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import type { PptCanvasFormat, PptTemplate } from "@/lib/types";

interface PptConfig {
  templateKey: string | null;
  templateKind: "layout" | "deck" | null;
  canvasFormat: string;
  stylePreference: string;
  sourceFiles: string[];
  topic: string;
}

interface PptConfigPanelProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  phase: "config" | "generating" | "done";
  onStart: () => void;
}

type TemplateTab = "layout" | "deck";
type SourceTab = "topic" | "files";

export function PptConfigPanel({ config, setConfig, phase, onStart }: PptConfigPanelProps) {
  const { token } = useClient();
  const readOnly = phase !== "config";

  const [layouts, setLayouts] = useState<PptTemplate[]>([]);
  const [decks, setDecks] = useState<PptTemplate[]>([]);
  const [canvasFormats, setCanvasFormats] = useState<PptCanvasFormat[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateTab, setTemplateTab] = useState<TemplateTab>("layout");
  const [sourceTab, setSourceTab] = useState<SourceTab>("topic");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [apiBase, setApiBase] = useState<string | null>(null);

  useEffect(() => {
    getApiBase().then(setApiBase);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTemplatesLoading(true);
    fetchPptTemplates(token)
      .then((res) => {
        if (!cancelled) {
          setLayouts(res.layouts);
          setDecks(res.decks);
          setCanvasFormats(res.canvasFormats);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const currentTemplates = templateTab === "layout" ? layouts : decks;

  function templateImgUrl(url: string): string {
    const base = apiBase ?? "";
    const sep = url.includes("?") ? "&" : "?";
    return `${base}${url}${sep}token=${encodeURIComponent(token)}`;
  }

  function handleSelectTemplate(tpl: PptTemplate) {
    if (readOnly) return;
    if (config.templateKey === tpl.key && config.templateKind === templateTab) {
      setConfig((prev) => ({ ...prev, templateKey: null, templateKind: null }));
    } else {
      setConfig((prev) => ({ ...prev, templateKey: tpl.key, templateKind: templateTab }));
    }
  }

  function handleSelectFormat(fmt: PptCanvasFormat) {
    if (readOnly) return;
    setConfig((prev) => ({ ...prev, canvasFormat: fmt.key }));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">模板</h3>
          <div className="mb-2 flex gap-1 rounded-lg bg-muted p-1">
            <button
              className={cn(
                "flex-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
                templateTab === "layout"
                  ? "bg-background text-foreground shadow"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTemplateTab("layout")}
              disabled={readOnly}
            >
              布局模板
            </button>
            <button
              className={cn(
                "flex-1 rounded-md px-3 py-1 text-[11px] font-medium transition-all",
                templateTab === "deck"
                  ? "bg-background text-foreground shadow"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setTemplateTab("deck")}
              disabled={readOnly}
            >
              品牌套件
            </button>
          </div>
          {templatesLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : currentTemplates.length === 0 ? (
            <div className="py-6 text-center text-[11px] text-muted-foreground">
              暂无模板
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {currentTemplates.map((tpl) => {
                const selected =
                  config.templateKey === tpl.key && config.templateKind === templateTab;
                return (
                  <button
                    key={tpl.key}
                    className={cn(
                      "flex flex-col overflow-hidden rounded-lg border text-left transition-colors",
                      selected
                        ? "border-primary ring-1 ring-primary"
                        : "border-border/70 hover:border-border",
                      readOnly && "cursor-default",
                    )}
                    onClick={() => handleSelectTemplate(tpl)}
                    disabled={readOnly}
                  >
                    <div className="aspect-video w-full overflow-hidden bg-muted">
                      <img
                        src={templateImgUrl(tpl.coverSvgUrl)}
                        alt={tpl.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="p-2">
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-[11px] font-medium text-foreground">
                          {tpl.name}
                        </span>
                        {templateTab === "deck" && tpl.primaryColor ? (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: tpl.primaryColor }}
                          />
                        ) : templateTab === "layout" && tpl.pageCount != null ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            {tpl.pageCount}页
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                        {tpl.summary}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">画布格式</h3>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {canvasFormats.map((fmt) => (
              <button
                key={fmt.key}
                className={cn(
                  "shrink-0 rounded-lg border px-3 py-2 text-left transition-colors",
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
              <Upload className="mr-1 inline h-3 w-3" />
              上传文件
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
                accept=".pdf,.doc,.docx,.txt,.md,.pptx"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length > 0) {
                    setConfig((prev) => ({
                      ...prev,
                      sourceFiles: [...prev.sourceFiles, ...files.map((f) => f.name)],
                    }));
                  }
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="flex min-h-[80px] w-full items-center justify-center rounded-lg border border-dashed border-border/70 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/30"
                onClick={() => fileInputRef.current?.click()}
                disabled={readOnly}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (readOnly) return;
                  const files = Array.from(e.dataTransfer.files ?? []);
                  if (files.length > 0) {
                    setConfig((prev) => ({
                      ...prev,
                      sourceFiles: [...prev.sourceFiles, ...files.map((f) => f.name)],
                    }));
                  }
                }}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                点击或拖拽文件到此处上传
              </button>
              {config.sourceFiles.length > 0 && (
                <div className="space-y-1">
                  {config.sourceFiles.map((name, i) => (
                    <div
                      key={`${name}-${i}`}
                      className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-[11px]"
                    >
                      <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
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

        <section>
          <h3 className="mb-2 text-[12px] font-medium text-foreground">
            <Palette className="mr-1 inline h-3 w-3" />
            风格偏好
          </h3>
          <Textarea
            className="min-h-[48px] resize-none text-[12px]"
            placeholder="例如：简约商务、科技感、中国风..."
            value={config.stylePreference}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, stylePreference: e.target.value }))
            }
            disabled={readOnly}
          />
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
