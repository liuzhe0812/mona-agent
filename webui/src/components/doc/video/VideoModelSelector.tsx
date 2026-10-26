import { useCallback, useEffect, useMemo, useState } from "react";

import { ModelSelector } from "@/components/models/ModelSelector";
import { buildComposerNativeOptions, buildComposerProviderOptions } from "@/components/models/model-options";
import { sourceLabel } from "@/components/models/model-sources";
import { cn } from "@/lib/utils";
import { fetchSettings } from "@/lib/api";
import { developmentApi, executorLabels, type DevExecutor } from "@/lib/development-api";
import { useNativeProviderState } from "@/lib/native-provider-state";
import type { AgentModelBinding, SettingsPayload } from "@/lib/types";
import type { ModelOption } from "@/components/models/model-sources";
import { useClientContextOrNull } from "@/providers/ClientProvider";

const inheritOption: ModelOption = {
  provider: "inherit",
  providerLabel: "默认",
  model: "inherit",
  label: "跟随 Mona",
  selectionId: "inherit",
  active: false,
};

function bindingMatches(binding: AgentModelBinding, option: ModelOption): boolean {
  if (binding.executor === "mona") {
    return !option.executor
      && option.provider === (binding.provider ?? "mona_managed")
      && option.model === binding.model;
  }
  return option.executor === binding.executor && option.model === binding.model;
}

function preservedOption(binding: AgentModelBinding, settings: SettingsPayload | null, executors: DevExecutor[]): ModelOption {
  const executor = binding.executor;
  const native = executor === "mona" ? undefined : executors.find((item) => item.id === executor);
  const provider = executor === "mona" ? binding.provider ?? "mona_managed" : `native:${executor}`;
  const providerLabel = executor === "mona"
    ? settings?.chat_providers?.find((item) => item.name === provider)?.label ?? (binding.provider ? binding.provider : "Mona AI")
    : sourceLabel(provider, native?.name ?? executorLabels[executor]);
  const disabledReason = executor !== "mona" && !native
    ? "此引擎当前不可用，已保留原选择。请重新连接或选择其他模型。"
    : executor === "mona" && !settings
      ? "暂时无法确认此模型是否可用，已保留原选择。请重试读取模型列表。"
      : "此模型当前不可用或未启用，已保留原选择。请重新启用来源或选择其他模型。";
  return {
    provider,
    providerLabel,
    model: binding.model,
    label: binding.model || "未知模型",
    executor: executor === "mona" ? undefined : executor,
    selectionId: `retained:${executor}:${binding.provider ?? ""}:${binding.model}`,
    reasoningEffort: binding.effort,
    active: true,
    disabledReason,
  };
}

export function VideoModelSelector({ token, value, onChange, disabled, className }: {
  token: string;
  value: AgentModelBinding | null;
  onChange: (binding: AgentModelBinding | null) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
}) {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [executors, setExecutors] = useState<DevExecutor[]>([]);
  const [apiError, setApiError] = useState(false);
  const [nativeError, setNativeError] = useState(false);
  const [apiRetry, setApiRetry] = useState(0);
  const [nativeRetry, setNativeRetry] = useState(0);
  const [runtimeModelRevision, setRuntimeModelRevision] = useState(0);
  const nativeProviderRevision = useNativeProviderState((state) => state.revision);
  const context = useClientContextOrNull();
  const client = context?.client;
  const [runtimeModelName, setRuntimeModelName] = useState(context?.modelName ?? null);

  useEffect(() => { setRuntimeModelName(context?.modelName ?? null); }, [context?.modelName]);

  useEffect(() => {
    if (!client) return;
    return client.onRuntimeModelUpdate((model) => { setRuntimeModelName(model); setRuntimeModelRevision((revision) => revision + 1); });
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setApiError(false);
    if (!token) {
      setApiError(true);
      return () => { cancelled = true; };
    }
    void fetchSettings(token)
      .then((result) => {
        if (!cancelled) {
          setSettings(result);
          setApiError(false);
        }
      })
      .catch(() => { if (!cancelled) setApiError(true); });
    return () => { cancelled = true; };
  }, [token, apiRetry, nativeProviderRevision, runtimeModelRevision]);

  useEffect(() => {
    let cancelled = false;
    setNativeError(false);
    void developmentApi.providerExecutors()
      .then(({ executors: result }) => {
        if (!cancelled) {
          setExecutors(result);
          setNativeError(false);
        }
      })
      .catch(() => { if (!cancelled) setNativeError(true); });
    return () => { cancelled = true; };
  }, [nativeProviderRevision, nativeRetry]);

  const options = useMemo(() => {
    const inheritedModel = runtimeModelName || (settings
      ? (settings.agent.executor ?? "mona") !== "mona"
        ? settings.agent.native_model
        : settings.agent.model
      : null);
    const currentInheritOption = {
      ...inheritOption,
      label: inheritedModel ? `跟随 Mona · ${inheritedModel}` : inheritOption.label,
    };
    const available = [
      ...(settings ? buildComposerProviderOptions(settings) : []),
      ...buildComposerNativeOptions(settings, executors),
    ].map((option) => ({ ...option, active: false }));
    if (!value) return [{ ...currentInheritOption, active: true }, ...available];

    const matchIndex = available.findIndex((option) => bindingMatches(value, option));
    if (matchIndex >= 0) {
      available[matchIndex] = {
        ...available[matchIndex],
        active: true,
        reasoningEffort: value.effort ?? available[matchIndex].defaultReasoningEffort ?? available[matchIndex].reasoningEffort,
      };
      return [currentInheritOption, ...available];
    }
    return [currentInheritOption, preservedOption(value, settings, executors), ...available];
  }, [executors, settings, value, runtimeModelName]);

  const active = options.find((option) => option.active);
  const label = active?.selectionId === "inherit" ? active.label
    : active ? `${active.providerLabel} · ${active.label}` : "选择模型";

  const selectModel = useCallback(async (option: ModelOption, effort?: string | null) => {
    if (option.selectionId === "inherit") {
      await onChange(null);
      return;
    }
    if (option.disabledReason) return;
    const executor = option.executor;
    if (executor === "codex" || executor === "claude" || executor === "codebuddy") {
      await onChange({ executor, model: option.model, provider: null, effort: effort ?? null });
      return;
    }
    await onChange({ executor: "mona", model: option.model, provider: option.provider, effort: effort ?? null });
  }, [onChange]);

  const loadError = apiError || nativeError;
  return <div className={cn("flex min-w-0 items-center gap-2", className)}>
    <ModelSelector options={options} label={label} disabled={disabled} onSelect={selectModel} />
    {loadError && <div role="status" className="flex min-w-0 items-center gap-1 text-micro text-muted-foreground">
      <span className="truncate">{apiError && nativeError
        ? "模型列表未能加载"
        : apiError ? "Mona 模型列表未能加载"
          : "第三方引擎列表未能加载"}</span>
      <button type="button" className="shrink-0 text-foreground underline underline-offset-2 disabled:opacity-50"
        disabled={disabled} onClick={() => {
          if (apiError) setApiRetry((value) => value + 1);
          if (nativeError) setNativeRetry((value) => value + 1);
        }}>重试</button>
    </div>}
  </div>;
}
