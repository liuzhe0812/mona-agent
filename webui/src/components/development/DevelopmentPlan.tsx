import { CircleCheck, Circle, LoaderCircle } from "lucide-react";
import type { DevPlan } from "@/lib/development-api";
import { cn } from "@/lib/utils";

export function DevelopmentPlan({ value, currentRunId }: { value?: DevPlan | null; currentRunId?: string }) {
  const steps = value?.plan ?? [];
  const done = steps.filter((s) => s.status === "completed").length;
  return <section aria-label="任务待办" className="space-y-3">
    <div className="flex items-center justify-between"><h3 className="text-ui font-medium">待办</h3><span className="text-caption tabular-nums text-muted-foreground">{value?.issue ? "待核对" : steps.length ? `${done}/${steps.length}` : "未创建"}</span></div>
    {value && currentRunId && value.runId !== currentRunId && <p className="text-micro text-muted-foreground">上一轮计划，等待当前执行者更新</p>}
    {steps.length ? <ol className="space-y-2.5">{steps.map((step, index) => <li key={`${index}:${step.step}`} className="flex items-start gap-2.5 text-ui">
      {step.status === "completed" ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : step.status === "in_progress" ? <LoaderCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-foreground motion-reduce:animate-none" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
      <span className={cn("break-words leading-relaxed", step.status === "pending" && "text-muted-foreground", step.status === "completed" && "text-muted-foreground line-through decoration-muted-foreground/50")}>{step.step}</span>
      <span className="sr-only">{step.status === "completed" ? "已完成" : step.status === "in_progress" ? "进行中" : "待处理"}</span>
    </li>)}</ol> : <p className="text-caption leading-relaxed text-muted-foreground">{value?.issue ?? "执行者创建计划后会显示在这里。简单任务无需计划。"}</p>}
  </section>;
}
