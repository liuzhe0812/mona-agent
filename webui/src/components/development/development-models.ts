import type { DevExecutor, DevSession, ExecutorId } from "@/lib/development-api";
import { sourceLabel, type ModelOption } from "@/components/models/model-sources";

export function developmentModels(executors: DevExecutor[], current?: DevSession | null): ModelOption[] {
  return executors.flatMap((executor) => executor.models.flatMap((model) => {
    const preset = executor.id === "mona" && model.preset !== false;
    const provider = executor.id === "mona" ? model.provider || "legacy-presets" : `native:${executor.id}`;
    const configured = executor.id === "mona" && !preset;
    const engine = configured ? "mona" : executor.id;
    const target = executors.find((item) => item.id === engine);
    const sameSource = (current?.modelProvider ?? null) === (configured ? provider : null);
    const active = current?.executor === engine && (current.model ?? "") === model.id && sameSource;
    const option: ModelOption = { ...model, provider, providerLabel: sourceLabel(provider, model.providerLabel || (preset ? "已有模型预设" : executor.name)),
      model: model.model || model.id, selectionId: preset ? `preset:${model.id}` : undefined,
      label: model.label, executor: engine,
      defaultReasoningEffort: model.reasoningEffort,
      reasoningEffort: active ? current.modelReasoningEffort : model.reasoningEffort,
      active,
      disabledReason: !target?.available ? configured ? "所选引擎不可用，请检查运行环境或在模型设置中选择 Mona。" : executor.reason
        : current?.readonly && engine !== current.executor ? "只读讨论不切换执行者" : null,
    };
    // A preference change applies to the next selection, not an existing task.
    return configured && current && sameSource && current.model === model.id && current.executor !== engine
      ? [option, { ...option, executor: current.executor, active: true, reasoningEffort: current.modelReasoningEffort,
        disabledReason: executors.find((item) => item.id === current.executor)?.available ? null : "当前任务的引擎不可用，请检查运行环境。" }]
      : [option];
  }));
}

export function developmentModelRoute(option: ModelOption, effort?: string | null) {
  const executor = option.executor as ExecutorId;
  const preset = option.selectionId?.startsWith("preset:");
  return { executor, model: preset ? option.selectionId!.slice(7) || null : option.model || null,
    provider: !preset && !option.provider.startsWith("native:") ? option.provider : null,
    effort: !preset ? effort ?? null : null };
}
