import { useEffect, useState } from "react";
import { LayoutTemplate } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiBase } from "@/lib/api";
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

/** 向导第 3 步：模板选择（从内容生成）或旧模板模式提示 */
export function PptConfigStepTemplate({
  config,
  setConfig,
  readOnly,
  selectedTemplate,
  setSelectedTemplate,
  onTemplateIssueChange,
}: PptConfigStepTemplateProps) {
  const { token } = useClient();
  const isTemplateMode = config.mode === "template";

  // --- 从内容生成：内置版式 / 品牌 / 自定义模板选择 ---
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [apiBase, setApiBase] = useState("");

  useEffect(() => {
    getApiBase().then(setApiBase).catch(() => {});
  }, []);

  // 向向导报告本步骤阻塞原因（旧版模板模式不可继续）
  useEffect(() => {
    onTemplateIssueChange(isTemplateMode ? "旧版 PPT 模板编辑模式已停止，无法继续。" : null);
  }, [isTemplateMode, onTemplateIssueChange]);

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

  // Legacy template state: keep it visible, but do not let it continue.
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-[11px] text-muted-foreground"
    >
      <p className="text-foreground">旧版 PPT 模板编辑模式已停止。</p>
      <p>当前不会下载或运行旧版编辑组件，也不会自动切换到普通生成。</p>
      {!readOnly ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setConfig((prev) => ({ ...prev, mode: "design" }))}
        >
          切换到“从内容生成”
        </Button>
      ) : null}
    </div>
  );
}
