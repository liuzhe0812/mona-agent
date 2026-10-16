import type { ModelOption } from "@/components/models/model-sources";
import { isCodeBuddyConnected, type DevExecutor } from "@/lib/development-api";
import type { SettingsPayload } from "@/lib/types";
import type { ManagedModelPrice } from "@/lib/tauri";
import { sourceLabel } from "@/components/models/model-sources";

function isLanguageModel(
  model: NonNullable<SettingsPayload["chat_providers"]>[number]["models"][number],
): boolean {
  if (!model.type) return true;
  return ["chat", "language", "text", "llm"].includes(model.type.toLowerCase());
}

function isDefaultMediaModel(
  settings: SettingsPayload,
  provider: NonNullable<SettingsPayload["chat_providers"]>[number],
  model: NonNullable<SettingsPayload["chat_providers"]>[number]["models"][number],
): boolean {
  return (
    (settings.image_generation?.provider === provider.name && settings.image_generation.model === model.id)
    || (settings.video_generation?.provider === provider.name && settings.video_generation.model === model.id)
  );
}

export function buildComposerProviderOptions(
  settings: SettingsPayload,
  managedPrices: ManagedModelPrice[] = [],
): ModelOption[] {
  const managedPriceByModel = new Map(managedPrices.map((price) => [price.model, price]));
  return (settings.chat_providers ?? [])
    .filter((provider) => provider.configured)
    .slice()
    .sort((a, b) =>
      Number(b.name === settings.agent.provider) - Number(a.name === settings.agent.provider)
      || Number(Boolean(a.is_builtin)) - Number(Boolean(b.is_builtin)),
    )
    .flatMap((provider) => provider.models
      .filter((model) => (
        model.enabled
        && isLanguageModel(model)
        && !isDefaultMediaModel(settings, provider, model)
      ))
      .map((model) => {
        const managedPrice = provider.is_builtin ? managedPriceByModel.get(model.id) : undefined;
        return {
          provider: provider.name,
          providerLabel: provider.label,
          model: model.id,
          label: model.name,
          active: provider.name === settings.agent.provider && model.id === settings.agent.model,
          isBuiltin: provider.is_builtin,
          description: model.description,
          contextWindow: model.context_window,
          recommended: model.recommended,
          tags: model.tags,
          priceTier: model.price_tier,
          reasoningEfforts: model.reasoning_efforts,
          defaultReasoningEffort: model.default_reasoning_effort,
          reasoningEffort:
            provider.name === settings.agent.provider && model.id === settings.agent.model
              ? settings.agent.reasoning_effort ?? model.default_reasoning_effort
              : model.default_reasoning_effort,
          inputAmountPerMillion: managedPrice?.input_amount_per_million ?? model.input_amount_per_million,
          cachedInputAmountPerMillion: managedPrice?.cached_input_amount_per_million ?? model.cached_input_amount_per_million,
          outputAmountPerMillion: managedPrice?.output_amount_per_million ?? model.output_amount_per_million,
          promotionLabel: managedPrice?.promotion_label ?? model.promotion_label,
          promotionName: managedPrice?.promotion_name ?? model.promotion_name,
          discountPercent: managedPrice?.discount_percent ?? model.discount_percent,
          originalInputAmountPerMillion:
            managedPrice?.original_input_amount_per_million ?? model.original_input_amount_per_million,
          originalCachedInputAmountPerMillion:
            managedPrice?.original_cached_input_amount_per_million ?? model.original_cached_input_amount_per_million,
          originalOutputAmountPerMillion:
            managedPrice?.original_output_amount_per_million ?? model.original_output_amount_per_million,
        };
      }));
}

export function buildComposerNativeOptions(
  settings: SettingsPayload | null,
  executors: DevExecutor[],
): ModelOption[] {
  return executors
    .filter((executor) => executor.id !== "mona")
    .flatMap((executor) => executor.models.flatMap((model) => {
      if (!model.id) return [];
      const provider = `native:${executor.id}`;
      const active = settings?.agent.executor === executor.id && settings.agent.native_model === model.id;
      const disabledReason = executor.enabled === false
        ? "此引擎已停用，请在模型设置中启用。"
        : !executor.available || executor.programAvailable === false
          ? executor.reason || "此模型来源当前不可用，请在模型设置中检查连接。"
          : executor.probe?.authentication !== "ready"
            ? executor.probe?.reason || "请先在模型设置中连接此账号。"
            : executor.id === "codebuddy" && !isCodeBuddyConnected(executor)
              ? executor.probe?.reason || "模型目录暂不可用，请在模型设置中检查连接。"
              : null;
      return [{
        provider,
        providerLabel: sourceLabel(provider, executor.name),
        model: model.id,
        label: model.label || model.id,
        executor: executor.id,
        active,
        disabledReason,
        description: model.description,
        contextWindow: model.contextWindow,
        reasoningEfforts: model.reasoningEfforts,
        reasoningEffort: active ? settings?.agent.native_reasoning_effort ?? model.reasoningEffort : model.reasoningEffort,
        defaultReasoningEffort: model.reasoningEffort,
      }];
    }));
}

export function buildComposerModelOptions(
  settings: SettingsPayload,
  executors: DevExecutor[] = [],
  managedPrices: ManagedModelPrice[] = [],
): ModelOption[] {
  const monaActive = (settings.agent.executor ?? "mona") === "mona";
  return [
    ...buildComposerProviderOptions(settings, managedPrices).map((option) => ({
      ...option,
      active: monaActive && option.active,
    })),
    ...buildComposerNativeOptions(settings, executors),
  ];
}
