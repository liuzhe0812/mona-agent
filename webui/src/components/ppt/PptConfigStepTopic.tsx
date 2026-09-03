import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PptConfig, PptMode } from "./PptMakerView";

interface PptConfigStepTopicProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  readOnly: boolean;
}

/** 向导第 1 步：制作方式 + 主题输入 */
export function PptConfigStepTopic({ config, setConfig, readOnly }: PptConfigStepTopicProps) {
  const isTemplateMode = config.mode === "template";

  return (
    <div className="space-y-4">
      {/* 制作方式 */}
      <section>
        <h3 className="mb-2 text-[12px] font-medium text-foreground">制作方式</h3>
        <div className="grid grid-cols-1 gap-1">
          {(
            [
              { value: "design", label: "从内容生成", title: "输入主题或上传素材，AI 从 0 生成高质量 PPT，可选内置版式" },
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

      {isTemplateMode ? (
        <div role="status" className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <p className="text-foreground">旧版 PPT 模板编辑模式已停止。</p>
          <p className="mt-0.5">请明确切换到“从内容生成”；系统不会自动替换模板内容。</p>
          {!readOnly ? (
            <button
              type="button"
              className="mt-2 rounded-md border border-border/70 px-2 py-1 text-foreground hover:bg-muted"
              onClick={() => setConfig((prev) => ({ ...prev, mode: "design" }))}
            >
              切换到“从内容生成”
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 主题 */}
      <section>
        <h3 className="mb-2 text-[12px] font-medium text-foreground">
          主题
          <span className="ml-1 text-[10px] font-normal text-muted-foreground">
            （也可在下一步仅添加源文件）
          </span>
        </h3>
        <Textarea
          className="min-h-[80px] resize-none text-[12px]"
          placeholder={
            isTemplateMode
              ? "描述你想在模版上制作的内容..."
              : "描述你想要制作的 PPT 主题..."
          }
          value={config.topic}
          onChange={(e) =>
            setConfig((prev) => ({ ...prev, topic: e.target.value }))
          }
          disabled={readOnly}
        />
      </section>
    </div>
  );
}
