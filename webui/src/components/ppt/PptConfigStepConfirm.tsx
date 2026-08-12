import { AlertCircle, CheckCircle2, FileText, Presentation } from "lucide-react";

import type { PptTemplate } from "@/lib/types";
import type { PptConfig } from "./PptMakerView";

interface PptConfigStepConfirmProps {
  config: PptConfig;
  selectedTemplate: PptTemplate | null;
  /** 模板步骤的阻塞原因（沿用现有 PPT 模式）；null 表示已就绪 */
  templateIssue: string | null;
}

const TEMPLATE_KIND_LABELS: Record<string, string> = {
  layout: "内置版式",
  brand: "品牌模板",
  native: "自定义模板",
};

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      <span className="w-16 shrink-0 pt-px text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-[12px] text-foreground">{children}</div>
    </div>
  );
}

/** 向导第 4 步：配置摘要确认 */
export function PptConfigStepConfirm({
  config,
  selectedTemplate,
  templateIssue,
}: PptConfigStepConfirmProps) {
  const isTemplateMode = config.mode === "template";
  const missingContent = !config.topic.trim() && config.sourceFiles.length === 0;

  return (
    <div className="space-y-3">
      <div className="divide-y divide-border/60 rounded-lg border border-border/70">
        <SummaryRow label="制作方式">
          {isTemplateMode ? "沿用现有 PPT" : "从内容生成"}
        </SummaryRow>

        <SummaryRow label="主题">
          {config.topic.trim() ? (
            <span className="whitespace-pre-wrap break-words">{config.topic.trim()}</span>
          ) : (
            <span className="text-muted-foreground">未填写</span>
          )}
        </SummaryRow>

        <SummaryRow label="源文件">
          {config.sourceFiles.length > 0 ? (
            <div className="space-y-1">
              {config.sourceFiles.map((path, i) => (
                <div key={`${path}-${i}`} className="flex items-center gap-1.5">
                  <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{path}</span>
                </div>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">无</span>
          )}
        </SummaryRow>

        {isTemplateMode ? (
          <>
            <SummaryRow label="PPT 模版">
              {config.templateFile ? (
                <div className="flex items-center gap-1.5">
                  <Presentation className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{config.templateFile}</span>
                </div>
              ) : (
                <span className="text-muted-foreground">未上传</span>
              )}
            </SummaryRow>
            <SummaryRow label="编辑组件">
              {templateIssue === null ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" />
                  已就绪
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">未就绪</span>
              )}
            </SummaryRow>
          </>
        ) : (
          <>
            <SummaryRow label="版式">
              {config.templateKey ? (
                <span>
                  {selectedTemplate?.name ?? config.templateKey}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {config.templateKind ? TEMPLATE_KIND_LABELS[config.templateKind] : ""}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">AI 推荐</span>
              )}
            </SummaryRow>
            <SummaryRow label="页数">
              {config.pageCount != null ? (
                `${config.pageCount} 页`
              ) : (
                <span className="text-muted-foreground">AI 推荐</span>
              )}
            </SummaryRow>
          </>
        )}
      </div>

      {(missingContent || (isTemplateMode && templateIssue !== null)) && (
        <div className="flex items-center gap-1.5 rounded-md bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1">
            {missingContent ? "还未填写主题或添加源文件，请返回前面的步骤补充" : templateIssue}
          </span>
        </div>
      )}
    </div>
  );
}
