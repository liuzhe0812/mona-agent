import { useCallback, useState } from "react";
import { AlertCircle, Check, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PptTemplate } from "@/lib/types";
import type { PptConfig, PptPhase } from "./PptMakerView";
import { PptConfigStepTopic } from "./PptConfigStepTopic";
import { PptConfigStepSources } from "./PptConfigStepSources";
import { PptConfigStepTemplate } from "./PptConfigStepTemplate";
import { PptConfigStepConfirm } from "./PptConfigStepConfirm";

interface PptConfigWizardProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  phase: PptPhase;
  onStart: () => void;
}

/** 配置页统一错误区域：携带原动作的重试入口 */
export interface ActionError {
  message: string;
  retry: (() => void) | null;
}

const WIZARD_STEPS = [
  { key: "topic", label: "主题", title: "想做什么样的 PPT？" },
  { key: "sources", label: "源文件", title: "添加源文件（可选）" },
  { key: "template", label: "模板", title: "选择模板" },
  { key: "confirm", label: "确认", title: "确认配置" },
] as const;

const STEP_DESCRIPTIONS: Record<(typeof WIZARD_STEPS)[number]["key"], string> = {
  topic: "选择制作方式并描述主题；也可以在下一步只添加源文件。",
  sources: "上传参考材料，AI 将直接读取文件内容；没有可跳过。",
  template: "选择内置版式或品牌模板；不选则由 AI 推荐。",
  confirm: "确认以下配置无误后，点击下方「开始生成」。",
};

/** PPT-401：向导式配置（主题 → 源文件 → 模板 → 确认） */
export function PptConfigWizard({ config, setConfig, phase, onStart }: PptConfigWizardProps) {
  const readOnly = phase !== "config";

  const [step, setStep] = useState(0);
  // 统一错误区域：上传、选择文件和模板加载失败都写入这里
  const [actionError, setActionError] = useState<ActionError | null>(null);
  // 模板步骤的阻塞原因（仅沿用现有 PPT 模式）；null 表示可继续
  const [templateIssue, setTemplateIssue] = useState<string | null>(null);
  // 提升已选模板元信息：步骤卸载后摘要页仍能展示模板名称
  const [selectedTemplate, setSelectedTemplate] = useState<PptTemplate | null>(null);

  const isTemplateMode = config.mode === "template";
  const isLastStep = step === WIZARD_STEPS.length - 1;

  const handleActionError = useCallback((error: ActionError | null) => {
    setActionError(error);
  }, []);

  const handleTemplateIssueChange = useCallback((issue: string | null) => {
    setTemplateIssue(issue);
  }, []);

  // 主按钮禁用原因（PPT-102：不可用必须给出原因）
  const missingContent = !config.topic.trim() && config.sourceFiles.length === 0;
  const nextDisabledReason =
    WIZARD_STEPS[step].key === "template" && isTemplateMode ? templateIssue : null;
  const startDisabledReason = missingContent
    ? "请先填写主题或添加源文件"
    : isTemplateMode
      ? templateIssue
      : null;
  const footerHint = isLastStep ? startDisabledReason : nextDisabledReason;

  const stepMeta = WIZARD_STEPS[step];
  const stepTitle =
    stepMeta.key === "template" && isTemplateMode ? "准备 PPT 模版" : stepMeta.title;
  const stepDescription =
    stepMeta.key === "template" && isTemplateMode
      ? "沿用现有 PPT 需要 PPT 编辑组件与 .pptx 模版。"
      : STEP_DESCRIPTIONS[stepMeta.key];

  return (
    <div className="flex h-full flex-col">
      {/* 步骤指示器 */}
      <div className="flex shrink-0 items-center justify-center gap-1 px-3 pb-3">
        {WIZARD_STEPS.map((s, i) => {
          const status = i < step ? "completed" : i === step ? "current" : "pending";
          return (
            <div key={s.key} className="flex items-center">
              {i > 0 && (
                <div
                  className={cn(
                    "mx-2 h-px w-5",
                    i <= step ? "bg-primary/40" : "bg-border",
                  )}
                />
              )}
              <div className="flex items-center gap-1.5">
                <div
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
                    status === "completed" && "bg-emerald-500/15 text-emerald-600",
                    status === "current" && "bg-action text-white",
                    status === "pending" && "border border-border bg-background text-muted-foreground",
                  )}
                >
                  {status === "completed" ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
                </div>
                <span
                  className={cn(
                    "text-[11px] font-medium",
                    status === "completed" && "text-muted-foreground",
                    status === "current" && "text-foreground",
                    status === "pending" && "text-muted-foreground/50",
                  )}
                >
                  {s.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-0">
        <div className="mb-3">
          <h3 className="text-[13px] font-medium text-foreground">{stepTitle}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{stepDescription}</p>
        </div>

        {stepMeta.key === "topic" && (
          <PptConfigStepTopic config={config} setConfig={setConfig} readOnly={readOnly} />
        )}
        {stepMeta.key === "sources" && (
          <PptConfigStepSources
            config={config}
            setConfig={setConfig}
            readOnly={readOnly}
            onActionError={handleActionError}
          />
        )}
        {stepMeta.key === "template" && (
          <PptConfigStepTemplate
            config={config}
            setConfig={setConfig}
            readOnly={readOnly}
            selectedTemplate={selectedTemplate}
            setSelectedTemplate={setSelectedTemplate}
            onActionError={handleActionError}
            onTemplateIssueChange={handleTemplateIssueChange}
          />
        )}
        {stepMeta.key === "confirm" && (
          <PptConfigStepConfirm
            config={config}
            selectedTemplate={selectedTemplate}
            templateIssue={templateIssue}
          />
        )}
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
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="outline"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                <ChevronLeft className="mr-1 h-3.5 w-3.5" />
                上一步
              </Button>
            )}
            {isLastStep ? (
              <Button
                className="flex-1"
                disabled={startDisabledReason !== null}
                onClick={onStart}
              >
                开始生成
              </Button>
            ) : (
              <Button
                className="flex-1"
                disabled={nextDisabledReason !== null}
                onClick={() => setStep((s) => Math.min(WIZARD_STEPS.length - 1, s + 1))}
              >
                下一步
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {footerHint && (
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
              {footerHint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
