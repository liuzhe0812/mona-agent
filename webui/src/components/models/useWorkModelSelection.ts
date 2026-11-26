import { useCallback, useEffect, useRef, useState } from "react";

import { buildComposerModelOptions } from "@/components/models/model-options";
import type { ModelOption } from "@/components/models/model-sources";
import { fetchSettings } from "@/lib/api";
import { developmentApi, type DevExecutor, type ExecutorId } from "@/lib/development-api";
import { useNativeProviderState } from "@/lib/native-provider-state";
import { publishSettingsUpdate, subscribeSettingsUpdates } from "@/lib/settings-updates";
import { getManagedModelPrices, isTauri, type ManagedModelPrice } from "@/lib/tauri";
import type { SettingsPayload } from "@/lib/types";

function contextCapacity(settings: SettingsPayload, options: ModelOption[]) {
  const agent = settings.agent;
  if ((agent.executor ?? "mona") !== "mona") {
    return {
      contextWindowTokens: agent.native_context_window_tokens ?? options.find((option) => option.active)?.contextWindow ?? null,
      contextBudgetTokens: agent.context_budget_tokens ?? null,
    };
  }
  const window = agent.context_window_tokens ?? settings.model_presets?.find((preset) => preset.active)?.context_window_tokens ?? null;
  const defaultWindow = agent.context_window_source === "default" || agent.context_window_source === "reference";
  return {
    contextWindowTokens: defaultWindow ? null : window,
    contextBudgetTokens: agent.context_budget_tokens ?? (defaultWindow ? window : null),
  };
}

export function useWorkModelSelection({ token, modelName, enabled = true, onModelNameChange, onWorkspacePath }: {
  token: string;
  modelName: string | null;
  enabled?: boolean;
  onModelNameChange?: (model: string | null) => void;
  onWorkspacePath?: (path: string) => void;
}) {
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [imageInputEnabled, setImageInputEnabled] = useState(true);
  const [capacity, setCapacity] = useState<ReturnType<typeof contextCapacity>>({ contextWindowTokens: null, contextBudgetTokens: null });
  const settingsRef = useRef<SettingsPayload | null>(null);
  const nativeExecutorsRef = useRef<DevExecutor[]>([]);
  const managedModelPricesRef = useRef<ManagedModelPrice[]>([]);
  const nativeProviderRevision = useNativeProviderState((state) => state.revision);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let settingsUpdated = false;
    let managedPriceTimer: number | undefined;
    const applySettings = (settings: SettingsPayload) => {
      settingsRef.current = settings;
      const options = buildComposerModelOptions(settings, nativeExecutorsRef.current, managedModelPricesRef.current);
      setModelOptions(options);
      const activePreset = settings.model_presets.find((preset) => preset.active);
      const native = (settings.agent.executor ?? "mona") !== "mona";
      setImageInputEnabled(native || activePreset?.capabilities?.supports_vision !== false);
      setCapacity(contextCapacity(settings, options));
      if (settings.runtime?.workspace_path) onWorkspacePath?.(settings.runtime.workspace_path);
    };
    const unsubscribe = subscribeSettingsUpdates(token, (settings) => {
      settingsUpdated = true;
      applySettings(settings);
    });
    const refreshManagedPrices = async () => {
      try {
        const { prices } = await getManagedModelPrices();
        if (cancelled) return;
        managedModelPricesRef.current = prices;
        const priceByModel = new Map(prices.map((price) => [price.model, price]));
        setModelOptions((current) => current.map((option) => {
          const price = option.isBuiltin ? priceByModel.get(option.model) : undefined;
          return price ? {
            ...option,
            inputAmountPerMillion: price.input_amount_per_million,
            cachedInputAmountPerMillion: price.cached_input_amount_per_million,
            outputAmountPerMillion: price.output_amount_per_million,
            promotionLabel: price.promotion_label,
            promotionName: price.promotion_name,
            discountPercent: price.discount_percent,
            originalInputAmountPerMillion: price.original_input_amount_per_million,
            originalCachedInputAmountPerMillion: price.original_cached_input_amount_per_million,
            originalOutputAmountPerMillion: price.original_output_amount_per_million,
          } : option;
        }));
      } catch {
        // Pricing is optional and must not block the model selector.
      }
    };
    void (async () => {
      try {
        const settings = await fetchSettings(token);
        if (!cancelled && !settingsUpdated) applySettings(settings);
        if (isTauri()) {
          await refreshManagedPrices();
          if (!cancelled) {
            managedPriceTimer = window.setInterval(() => { void refreshManagedPrices(); }, 30_000);
          }
        }
      } catch {
        if (!cancelled && !settingsUpdated) setModelOptions([]);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      if (managedPriceTimer !== undefined) window.clearInterval(managedPriceTimer);
    };
  }, [enabled, token, onWorkspacePath, nativeProviderRevision]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void developmentApi.providerExecutors().then(({ executors }) => {
      if (cancelled) return;
      nativeExecutorsRef.current = executors;
      const settings = settingsRef.current;
      if (settings) setModelOptions(buildComposerModelOptions(settings, executors, managedModelPricesRef.current));
    }).catch(() => {
      // A local model catalog failure must not hide the configured API models.
    });
    return () => { cancelled = true; };
  }, [enabled, nativeProviderRevision]);

  const selectModel = useCallback(async (option: ModelOption, reasoningEffort?: string | null) => {
    if (option.disabledReason) return;
    const executor = (option.executor ?? "mona") as ExecutorId;
    const payload = await developmentApi.selectWorkModelSource({
      executor,
      model: option.model,
      ...(executor === "mona" ? { provider: option.provider } : {}),
      effort: reasoningEffort ?? null,
    });
    publishSettingsUpdate(token, payload);
    settingsRef.current = payload;
    const options = buildComposerModelOptions(payload, nativeExecutorsRef.current, managedModelPricesRef.current);
    setModelOptions(options);
    const native = (payload.agent.executor ?? "mona") !== "mona";
    onModelNameChange?.(native ? payload.agent.native_model || option.model : payload.agent.model || null);
    const activePreset = payload.model_presets?.find((preset) => preset.active);
    setImageInputEnabled(native || activePreset?.capabilities?.supports_vision !== false);
    setCapacity(contextCapacity(payload, options));
  }, [onModelNameChange, token]);

  const modelLabel = modelOptions.find((option) => option.active)?.label
    ?? (settingsRef.current?.agent.executor && settingsRef.current.agent.executor !== "mona"
      ? settingsRef.current.agent.native_model : null)
    ?? modelName;
  const agent = settingsRef.current?.agent;
  const executor = agent?.executor ?? "mona";
  const contextModel = executor === "mona" ? agent?.model : agent?.native_model;
  const contextProvider = executor === "mona" ? agent?.resolved_provider ?? agent?.provider : `native:${executor}`;
  return { modelOptions, modelLabel, imageInputEnabled, ...capacity, contextModel, contextProvider, selectModel };
}
