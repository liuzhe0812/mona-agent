import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import alibabaCloudIcon from "@lobehub/icons-static-svg/icons/alibabacloud-color.svg";
import deepSeekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi.svg";
import longCatIcon from "@lobehub/icons-static-svg/icons/longcat-color.svg";
import miniMaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import openCodeIcon from "@lobehub/icons-static-svg/icons/opencode.svg";
import openRouterIcon from "@lobehub/icons-static-svg/icons/openrouter-color.svg";
import tencentCloudIcon from "@lobehub/icons-static-svg/icons/tencentcloud-color.svg";
import vercelIcon from "@lobehub/icons-static-svg/icons/vercel.svg";
import volcengineIcon from "@lobehub/icons-static-svg/icons/volcengine-color.svg";
import xiaomiMimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zaiIcon from "@lobehub/icons-static-svg/icons/zai.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import {
  Check,
  ChevronLeft,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Video as VideoIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useLicense } from "@/hooks/useLicense";
import { formatBalanceAmount } from "@/lib/money";
import { isTauri } from "@/lib/tauri";
import {
  fetchProviderModels,
  updateProviderSettings,
  updateSettings,
} from "@/lib/api";
import type { SettingsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

type ChatProvider = NonNullable<SettingsPayload["chat_providers"]>[number];
type ChatModel = ChatProvider["models"][number];

function isLanguageModel(modelType?: string | null, allowUnknown = true): boolean {
  return !modelType
    ? allowUnknown
    : ["chat", "language", "text", "llm"].includes(modelType.toLowerCase());
}

type ModelCapability = "chat" | "image" | "video" | "audio" | "3d" | "other";

interface ModelTypeInfo {
  label: string;
  capability: ModelCapability;
  known: boolean;
}

function modelTypeInfo(modelType?: string | null): ModelTypeInfo {
  const normalized = modelType?.trim().toLowerCase();
  if (["chat", "language", "text", "llm"].includes(normalized ?? "")) {
    return { label: "对话", capability: "chat", known: true };
  }
  if (normalized === "image") return { label: "图片", capability: "image", known: true };
  if (normalized === "video") return { label: "视频", capability: "video", known: true };
  if (normalized === "audio") return { label: "音频", capability: "audio", known: true };
  if (["3d", "world3d", "world_3d"].includes(normalized ?? "")) {
    return { label: "3D", capability: "3d", known: true };
  }
  if (normalized === "other") return { label: "其他", capability: "other", known: true };
  return { label: "其他", capability: "other", known: false };
}

interface ChatProvidersSettingsProps {
  settings: SettingsPayload;
  token: string;
  onSettingsChanged: (payload: SettingsPayload) => void;
  onModelNameChange: (modelName: string | null) => void;
  onOpenBilling?: () => void;
  onOpenUsage?: () => void;
  onSelectImageModel?: (provider: string, model: string) => void;
  onSelectVideoModel?: (provider: string, model: string) => void;
  onOpenImageSettings?: (provider: string, model?: string) => void;
  onOpenVideoSettings?: (provider: string, model?: string) => void;
  onOpenTtsSettings?: () => void;
  onOpenJevSettings?: () => void;
}

function providerInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [label[0] ?? "?"])
    .join("")
    .toUpperCase();
}

const PROVIDER_ICON_BY_ID: Record<string, string> = {
  openrouter: openRouterIcon,
  deepseek: deepSeekIcon,
  "zhipu-glm-cn": zhipuIcon,
  "zhipu-glm-global": zaiIcon,
  "zhipu-coding-plan-cn": zhipuIcon,
  "zai-coding-plan-global": zaiIcon,
  "moonshot-kimi-cn": kimiIcon,
  "moonshot-kimi-global": kimiIcon,
  "moonshot-kimi-code": kimiIcon,
  "minimax-cn": miniMaxIcon,
  "minimax-global": miniMaxIcon,
  "aliyun-bailian-coding": alibabaCloudIcon,
  "aliyun-bailian-token-plan-cn": alibabaCloudIcon,
  "aliyun-bailian-token-plan-team-cn": alibabaCloudIcon,
  "google-gemini-api": geminiIcon,
  longcat: longCatIcon,
  "xiaomi-mimo-api-cn": xiaomiMimoIcon,
  "xiaomi-mimo-token-plan-cn": xiaomiMimoIcon,
  "volcengine-agent-plan": volcengineIcon,
  "volcengine-coding-plan": volcengineIcon,
  "tencentcloud-coding-plan": tencentCloudIcon,
  "opencode-go": openCodeIcon,
  "vercel-ai-gateway": vercelIcon,
};

function ProviderIcon({ provider, size }: { provider: ChatProvider; size: number }) {
  const icon = provider.is_builtin ? "/brand/mona_icon.png" : PROVIDER_ICON_BY_ID[provider.name];
  if (!icon) return <span className="text-xs font-semibold">{providerInitials(provider.label)}</span>;
  return <img src={icon} alt="" width={size} height={size} className="object-contain" />;
}

function formatContextWindow(value: number | null | undefined): string {
  if (!value) return "";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}M` : `${Math.round(value / 1000)}K`;
}

function modelRowsFromIds(provider: ChatProvider, ids: string[]): ChatModel[] {
  const existing = new Set(provider.models.map((model) => model.id));
  return ids.reduce<ChatModel[]>((rows, rawId) => {
    const id = rawId.trim();
    if (!id || existing.has(id)) return rows;
    existing.add(id);
    rows.push({
      id,
      name: id,
      context_window: null,
      enabled: true,
      recommended: false,
    });
    return rows;
  }, []);
}

export function ChatProvidersSettings({
  settings,
  token,
  onSettingsChanged,
  onModelNameChange,
  onOpenBilling,
  onOpenUsage,
  onSelectImageModel,
  onSelectVideoModel,
  onOpenImageSettings,
  onOpenVideoSettings,
  onOpenTtsSettings,
  onOpenJevSettings,
}: ChatProvidersSettingsProps) {
  const { licenseInfo } = useLicense();
  const providers = settings.chat_providers ?? [];
  const builtinProvider = providers.find((provider) => provider.is_builtin) ?? null;
  const [managedBalance, setManagedBalance] = useState<string | null>(null);
  const manageableProviders = useMemo(
    () => providers.filter((provider) => !provider.is_builtin),
    [providers],
  );
  const configured = useMemo(
    () =>
      providers
        .filter((provider) => provider.is_builtin || provider.configured)
        .slice()
        .sort((a, b) => Number(Boolean(b.is_builtin)) - Number(Boolean(a.is_builtin)) || Number(b.region === "cn") - Number(a.region === "cn")),
    [providers],
  );
  const modelCountByProvider = useMemo(() => {
    const modelIds = new Map<string, Set<string>>();
    const addModels = (provider: string, models: string[]) => {
      const ids = modelIds.get(provider) ?? new Set<string>();
      models.forEach((model) => ids.add(model));
      modelIds.set(provider, ids);
    };
    for (const provider of providers) {
      addModels(provider.name, provider.models.map((model) => model.id));
    }
    for (const provider of settings.image_generation?.providers ?? []) {
      addModels(provider.name, provider.image_models ?? []);
    }
    for (const provider of settings.video_generation?.providers ?? []) {
      addModels(provider.name, provider.video_models ?? []);
    }
    return new Map([...modelIds].map(([provider, ids]) => [provider, ids.size]));
  }, [providers, settings.image_generation?.providers, settings.video_generation?.providers]);
  const [selectedId, setSelectedId] = useState<string | null>(builtinProvider?.name ?? configured[0]?.name ?? null);
  const [providerQuery, setProviderQuery] = useState("");
  const [wizardQuery, setWizardQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardEditing, setWizardEditing] = useState(false);
  const [wizardCustom, setWizardCustom] = useState(false);
  const [customProviderId, setCustomProviderId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");

  useEffect(() => {
    setManagedBalance(null);
    if (!builtinProvider || !isTauri()) return;
    let cancelled = false;
    void invoke<{ available_amount: string }>("get_credit_balance")
      .then((value) => {
        if (!cancelled) setManagedBalance(value.available_amount);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [builtinProvider, licenseInfo?.account, licenseInfo?.email]);
  useEffect(() => {
    if (!configured.some((provider) => provider.name === selectedId)) {
      setSelectedId(builtinProvider?.name ?? configured[0]?.name ?? null);
    }
  }, [builtinProvider?.name, configured, selectedId]);
  const [customApiBase, setCustomApiBase] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customModelTypes, setCustomModelTypes] = useState<Record<string, string>>({});
  const [customModelModalities, setCustomModelModalities] = useState<Record<string, string[]>>({});
  const [customSelectedModels, setCustomSelectedModels] = useState<string[]>([]);
  const [customManualModel, setCustomManualModel] = useState("");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [wizardProviderId, setWizardProviderId] = useState<string | null>(null);
  const [wizardApiKey, setWizardApiKey] = useState("");
  const [wizardApiBase, setWizardApiBase] = useState("");
  const [wizardModels, setWizardModels] = useState<string[]>([]);
  const [wizardModelTypes, setWizardModelTypes] = useState<Record<string, string>>({});
  const [wizardModelModalities, setWizardModelModalities] = useState<Record<string, string[]>>({});
  const [wizardSelectedModels, setWizardSelectedModels] = useState<string[]>([]);
  const [wizardManualModel, setWizardManualModel] = useState("");
  const [wizardLoading, setWizardLoading] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = configured.find((provider) => provider.name === selectedId) ?? configured[0];
  const filteredConfigured = configured.filter((provider) =>
    `${provider.label} ${provider.name}`.toLowerCase().includes(providerQuery.trim().toLowerCase()),
  );
  const wizardProvider = manageableProviders.find((provider) => provider.name === wizardProviderId);
  const wizardCandidates = useMemo(() => {
    if (!wizardProvider) return [];
    const discovered = modelRowsFromIds(wizardProvider, wizardModels);
    return [...wizardProvider.models, ...discovered.map((model) => ({
      ...model,
      type: wizardModelTypes[model.id],
      input_modalities: wizardModelModalities[model.id],
    }))];
  }, [wizardModelModalities, wizardModelTypes, wizardModels, wizardProvider]);
  const customCandidates = useMemo<ChatModel[]>(
    () => customModels.map((id) => ({
      id,
      name: id,
      type: customModelTypes[id],
      input_modalities: customModelModalities[id],
      context_window: null,
      enabled: customSelectedModels.includes(id),
      recommended: false,
    })),
    [customModelModalities, customModelTypes, customModels, customSelectedModels],
  );

  const openWizard = () => {
    setWizardOpen(true);
    setWizardEditing(false);
    setWizardCustom(false);
    setCustomProviderId(null);
    setWizardStep(1);
    setWizardProviderId(null);
    setWizardQuery("");
    setWizardApiKey("");
    setWizardApiBase("");
    setWizardModels([]);
    setWizardModelTypes({});
    setWizardModelModalities({});
    setWizardSelectedModels([]);
    setWizardManualModel("");
    setWizardError(null);
    setCustomName("");
    setCustomApiBase("");
    setCustomApiKey("");
    setCustomModels([]);
    setCustomModelTypes({});
    setCustomModelModalities({});
    setCustomSelectedModels([]);
    setCustomManualModel("");
  };

  const openCustomWizard = () => {
    setWizardOpen(true);
    setWizardEditing(false);
    setWizardCustom(true);
    setCustomProviderId(null);
    setWizardStep(2);
    setWizardError(null);
    setCustomName("");
    setCustomApiBase("");
    setCustomApiKey("");
    setCustomModels([]);
    setCustomModelTypes({});
    setCustomSelectedModels([]);
    setCustomManualModel("");
  };

  const openEditWizard = () => {
    if (!selected || selected.is_builtin) return;
    if (selected.is_custom) {
      setWizardOpen(true);
      setWizardEditing(true);
      setWizardCustom(true);
      setCustomProviderId(selected.name);
      setWizardStep(2);
      setCustomName(selected.label);
      setCustomApiBase(selected.api_base || "");
      setCustomApiKey("");
      const ids = selected.models.map((model) => model.id);
      setCustomModels(ids);
      setCustomModelTypes(Object.fromEntries(selected.models.flatMap((model) => model.type ? [[model.id, model.type]] : [])));
      setCustomModelModalities(Object.fromEntries(selected.models.flatMap((model) => model.input_modalities ? [[model.id, model.input_modalities]] : [])));
      setCustomSelectedModels(selected.models.filter((model) => model.enabled).map((model) => model.id));
      setCustomManualModel("");
      setWizardError(null);
      return;
    }
    setWizardOpen(true);
    setWizardEditing(true);
    setWizardCustom(false);
    setWizardStep(2);
    setWizardProviderId(selected.name);
    setWizardQuery("");
    setWizardApiKey("");
    setWizardApiBase(selected.api_base || selected.default_api_base);
    setWizardModels([]);
    setWizardModelTypes({});
    setWizardModelModalities({});
    setWizardSelectedModels(
      selected.models.filter((model) => model.enabled).map((model) => model.id),
    );
    setWizardManualModel("");
    setWizardError(null);
  };

  const chooseWizardProvider = (provider: ChatProvider) => {
    setWizardCustom(false);
    setWizardProviderId(provider.name);
    setWizardApiBase(provider.api_base || provider.default_api_base);
    setWizardApiKey("");
    setWizardModels([]);
    setWizardModelTypes({});
    setWizardModelModalities({});
    setWizardSelectedModels(provider.models[0] ? [provider.models[0].id] : []);
    setWizardManualModel("");
    setWizardError(null);
    setWizardStep(2);
  };

  const loadCustomModels = async () => {
    const name = customName.trim();
    const base = customApiBase.trim();
    if (!name) {
      setWizardError("请输入显示名称");
      return;
    }
    if (!/^https?:\/\/[^\s]+$/i.test(base)) {
      setWizardError("API Base 必须是合法的 http/https 地址");
      return;
    }
    setWizardLoading(true);
    setWizardError(null);
    try {
      const result = await fetchProviderModels(token, {
        provider: customProviderId ?? "custom",
        apiKey: customApiKey.trim() || undefined,
        apiBase: base,
      });
      const fetched = result.models ?? [];
      const candidates = [...new Set([...customModels, ...fetched.map((id) => id.trim()).filter(Boolean)])];
      setCustomModels(candidates);
      setCustomModelTypes((current) => ({
        ...current,
        ...Object.fromEntries(
          (result.model_details ?? [])
            .flatMap((model) => model.type ? [[model.id, model.type] as const] : []),
        ),
      }));
      setCustomModelModalities((current) => ({
        ...current,
        ...Object.fromEntries(
          (result.model_details ?? []).flatMap((model) =>
            model.input_modalities ? [[model.id, model.input_modalities] as const] : []),
        ),
      }));
      setCustomSelectedModels((current) => current.filter((id) => candidates.includes(id)));
      if (result.error) setWizardError(result.error);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : String(err));
    } finally {
      setWizardLoading(false);
      setWizardStep(3);
    }
  };

  const addCustomManualModel = () => {
    const ids = customManualModel.split(/[,\n]/).map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return;
    setCustomModels((current) => [...new Set([...current, ...ids])]);
    setCustomModelTypes((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, "chat"])),
    }));
    setCustomManualModel("");
  };

  const finishCustomWizard = async () => {
    const name = customName.trim();
    const base = customApiBase.trim();
    const selectedModels = customSelectedModels.filter(Boolean);
    if (!name) {
      setWizardError("请输入显示名称");
      setWizardStep(2);
      return;
    }
    if (!/^https?:\/\/[^\s]+$/i.test(base)) {
      setWizardError("API Base 必须是合法的 http/https 地址");
      setWizardStep(2);
      return;
    }
    if (!customModels.length) {
      setWizardError("请至少添加一个模型");
      return;
    }
    setWizardLoading(true);
    setWizardError(null);
    try {
      const apiKey = customApiKey.trim();
      const payload = await updateProviderSettings(token, {
        provider: customProviderId ?? "custom",
        customName: name,
        apiBase: base,
        ...(selectedModels[0] ? { model: selectedModels[0] } : {}),
        enabledModels: selectedModels,
        discoveredModels: customModels.map((id) => ({
          id,
          name: id,
          type: customModelTypes[id],
          inputModalities: customModelModalities[id],
        })),
        ...(apiKey ? { apiKey } : {}),
      });
      onSettingsChanged(payload);
      const customRows = payload.chat_providers?.filter(
        (provider) => provider.is_custom && provider.label === name,
      ) ?? [];
      const nextId = customProviderId
        ?? customRows[customRows.length - 1]?.name
        ?? null;
      setSelectedId(nextId);
      setWizardOpen(false);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : String(err));
    } finally {
      setWizardLoading(false);
    }
  };

  const loadWizardModels = async () => {
    if (!wizardProvider) return;
    setWizardLoading(true);
    setWizardError(null);
    try {
      const result = await fetchProviderModels(token, {
        provider: wizardProvider.name,
        apiKey: wizardApiKey.trim() || undefined,
        apiBase: wizardApiBase.trim() || undefined,
      });
      const fetched = result.models ?? [];
      setWizardModels(fetched);
      setWizardModelTypes((current) => ({
        ...current,
        ...Object.fromEntries(
          (result.model_details ?? [])
            .flatMap((model) => model.type ? [[model.id, model.type] as const] : []),
        ),
      }));
      setWizardModelModalities((current) => ({
        ...current,
        ...Object.fromEntries(
          (result.model_details ?? []).flatMap((model) =>
            model.input_modalities ? [[model.id, model.input_modalities] as const] : []),
        ),
      }));
      const candidates = [...wizardProvider.models.map((model) => model.id), ...fetched];
      setWizardSelectedModels((current) => {
        const valid = current.filter((id) => candidates.includes(id));
        return valid.length > 0 ? valid : candidates.slice(0, 1);
      });
      if (result.error) setWizardError(result.error);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : String(err));
    } finally {
      setWizardLoading(false);
      setWizardStep(3);
    }
  };

  const addManualModel = () => {
    const ids = wizardManualModel.split(/[,\n]/).map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return;
    setWizardModels((current) => [...new Set([...current, ...ids])]);
    setWizardModelTypes((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, "chat"])),
    }));
    setWizardSelectedModels((current) => [...new Set([...current, ...ids])]);
    setWizardManualModel("");
  };

  const finishWizard = async () => {
    if (!wizardProvider) return;
    const selectedModels = wizardSelectedModels.filter(Boolean);
    if (!selectedModels.length) {
      setWizardError("请至少选择一个模型");
      return;
    }
    if (
      wizardProvider.api_key_required
      && !wizardApiKey.trim()
      && !(wizardEditing && wizardProvider.api_key_hint)
    ) {
      setWizardError("请输入 API Key");
      setWizardStep(2);
      return;
    }
    setWizardLoading(true);
    setWizardError(null);
    try {
      const apiKey = wizardApiKey.trim();
      const payload = await updateProviderSettings(token, {
        provider: wizardProvider.name,
        apiBase: wizardApiBase.trim(),
        model: selectedModels[0],
        enabledModels: selectedModels,
        discoveredModels: wizardModels.map((id) => ({
          id,
          name: id,
          type: wizardModelTypes[id],
          inputModalities: wizardModelModalities[id],
        })),
        ...(apiKey ? { apiKey } : {}),
      });
      onSettingsChanged(payload);
      setSelectedId(wizardProvider.name);
      setWizardOpen(false);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : String(err));
    } finally {
      setWizardLoading(false);
    }
  };

  const toggleModel = async (model: ChatModel) => {
    if (!selected || saving) return;
    const enabledModels = selected.models.filter((item) => item.enabled).map((item) => item.id);
    const next = model.enabled
      ? enabledModels.filter((id) => id !== model.id)
      : [...enabledModels, model.id];
    const anotherProviderHasEnabledModel = providers.some((provider) =>
      provider.name !== selected.name
      && provider.configured
      && provider.models.some((item) => item.enabled),
    );
    if (!next.length && !anotherProviderHasEnabledModel) {
      setError("请至少保留一个可用模型");
      return;
    }
    setSaving(true);
    try {
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        enabledModels: next,
      });
      onSettingsChanged(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleAllModels = async () => {
    if (!selected || saving) return;
    const chatModels = selected.models.filter((model) => isLanguageModel(model.type, !selected.is_custom));
    if (!chatModels.length) return;
    const allEnabled = chatModels.every((model) => model.enabled);
    const next = allEnabled ? [] : chatModels.map((model) => model.id);
    const anotherProviderHasEnabledModel = providers.some((provider) =>
      provider.name !== selected.name
      && provider.configured
      && provider.models.some((model) => model.enabled),
    );
    if (next.length === 0 && !anotherProviderHasEnabledModel) {
      setError("请至少保留一个可用模型");
      return;
    }
    setSaving(true);
    try {
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        enabledModels: next,
      });
      onSettingsChanged(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const refreshModels = async () => {
    if (!selected || selected.is_builtin || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await fetchProviderModels(token, {
        provider: selected.name,
        apiBase: selected.api_base,
      });
      if (result.error) throw new Error(result.error);
      const discovered: Array<{
        id: string;
        name?: string;
        type?: string | null;
        input_modalities?: string[] | null;
      }> =
        result.model_details ?? (result.models ?? []).map((id) => ({ id, name: id }));
      if (!discovered.length) return;
      const existingEnabled = selected.models.filter((model) => model.enabled).map((model) => model.id);
      const newChatModels = discovered
        .filter((model) => !model.type || isLanguageModel(model.type))
        .map((model) => model.id);
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        discoveredModels: discovered.map((model) => ({
          id: model.id,
          name: model.name,
          type: model.type,
          inputModalities: model.input_modalities,
        })),
        enabledModels: [...new Set([...existingEnabled, ...newChatModels])],
      });
      onSettingsChanged(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const setDefault = async (model: ChatModel) => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const payload = await updateSettings(token, {
        provider: selected.name,
        model: model.id,
        providerModel: model.id,
      });
      onSettingsChanged(payload);
      onModelNameChange(payload.agent.model || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteSelected = async () => {
    if (!selected || selected.is_builtin || saving || !window.confirm(`删除供应商「${selected.label}」？`)) return;
    setSaving(true);
    try {
      const payload = await updateProviderSettings(token, { provider: selected.name, delete: true });
      onSettingsChanged(payload);
      setSelectedId(payload.chat_providers?.find((provider) => provider.configured)?.name ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const selectedImageProvider = settings.image_generation?.providers.find((provider) => provider.name === selected?.name);
  const selectedVideoProvider = settings.video_generation?.providers.find((provider) => provider.name === selected?.name);
  const chatModelIds = new Set(selected?.models.map((model) => model.id) ?? []);
  const unifiedModels = selected ? [
    ...selected.models,
    ...modelRowsFromIds(selected, [
      ...(selectedImageProvider?.image_models ?? []),
      ...(selectedVideoProvider?.video_models ?? []),
    ]).map((model) => ({ ...model, enabled: false })),
  ] : [];
  const visibleModels = unifiedModels.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(normalizedModelQuery),
  );
  const selectedImageModel = settings.image_generation?.provider === selected?.name ? settings.image_generation.model : null;
  const selectedVideoModel = settings.video_generation?.provider === selected?.name ? settings.video_generation.model : null;
  const hasVisibleModels = visibleModels.length > 0;
  const availableToAdd = manageableProviders
    .filter((provider) => !provider.configured)
    .slice()
    .sort((a, b) => Number(b.region === "cn") - Number(a.region === "cn"))
    .filter((provider) => `${provider.label} ${provider.name}`.toLowerCase().includes(wizardQuery.trim().toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-title-md font-semibold">模型供应商</h2>
          <p className="text-caption text-muted-foreground">管理模型来源、对话显示和图片/视频默认模型</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {error ? <span className="text-caption text-destructive">{error}</span> : null}
          {onOpenJevSettings ? <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onOpenJevSettings}>决策模型</Button> : null}
          {onOpenTtsSettings ? <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onOpenTtsSettings}>语音合成</Button> : null}
        </div>
      </div>
      <div className="grid h-[min(70vh,680px)] min-h-[420px] max-h-[calc(100dvh-260px)] grid-cols-[240px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm max-[760px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r border-border/70 bg-muted/20 max-[760px]:max-h-56 max-[760px]:border-b max-[760px]:border-r-0">
          <div className="border-b border-border/60 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="搜索供应商" className="h-8 rounded-full pl-9 text-caption" />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {filteredConfigured.length ? filteredConfigured.map((provider) => (
              <button
                key={provider.name}
                type="button"
                onClick={() => { setSelectedId(provider.name); setModelQuery(""); }}
                className={cn("mb-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors", selected?.name === provider.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm"><ProviderIcon provider={provider} size={22} /></span>
                <span className="min-w-0 flex-1 truncate text-ui font-medium">{provider.label}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{modelCountByProvider.get(provider.name) ?? provider.models.length} 个模型</span>
                {provider.is_builtin ? <span className={cn("h-2 w-2 shrink-0 rounded-full", provider.configured ? "bg-emerald-500" : "bg-muted-foreground/30")} aria-label={provider.configured ? "已配置" : "未配置"} /> : provider.is_custom ? <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">自定义</span> : null}
                {provider.configured && provider.name === settings.agent.provider ? <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="默认" /> : null}
              </button>
            )) : <p className="p-3 text-caption text-muted-foreground">还没有添加供应商</p>}
          </div>
          <div className="border-t border-border/60 p-3">
            <Button type="button" variant="outline" className="w-full rounded-xl border-dashed" onClick={openWizard}>
              <Plus className="mr-1.5 h-4 w-4" /> 添加供应商
            </Button>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {selected ? (
            <>
              <header className="flex items-center gap-3 border-b border-border/70 p-5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm"><ProviderIcon provider={selected} size={30} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-title-sm font-semibold">{selected.label}</h3>
                    {selected.is_builtin ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">内置</span> : null}
                  </div>
                  <p className="truncate text-caption text-muted-foreground">{selected.is_builtin ? (selected.configured ? "全部模型 · 按实际 Token 从 Mona AI 余额扣费" : "服务端尚未开放可用的托管模型") : selected.api_base}</p>
                </div>
                <span className={cn("flex shrink-0 items-center gap-1.5 text-caption", selected.configured ? "text-emerald-600" : "text-muted-foreground")}><span className={cn("h-2 w-2 rounded-full", selected.configured ? "bg-emerald-500" : "bg-muted-foreground/30")} />{selected.configured ? "已配置" : "未配置"}</span>
                {!selected.is_builtin ? <>
                  <Button type="button" variant="ghost" size="icon" onClick={openEditWizard} disabled={saving} title="编辑供应商" aria-label="编辑供应商"><Pencil className="h-4 w-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" onClick={deleteSelected} disabled={saving} title="删除供应商" aria-label="删除供应商"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </> : null}
              </header>
              {selected.is_builtin && selected.configured ? (
                <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-caption text-muted-foreground">可用余额</p>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums">{managedBalance === null ? "—" : `¥${formatBalanceAmount(managedBalance)}`}</p>
                  </div>
                  {onOpenUsage ? <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onOpenUsage}>查看用量</Button> : null}
                  {onOpenBilling ? <Button type="button" size="sm" className="rounded-full" onClick={onOpenBilling}>余额充值</Button> : null}
                </div>
              ) : selected.is_builtin ? (
                <div className="border-b border-border/60 px-5 py-4 text-caption text-muted-foreground">
                  VPS 尚未启用托管模型，或没有配置生效价格；配置完成后模型会自动出现。
                </div>
              ) : null}
              <div className="flex items-center gap-3 border-b border-border/60 p-4">
                <div className="shrink-0">
                  <p className="text-ui font-medium">模型列表</p>
                  <p className="text-caption text-muted-foreground">开关控制对话，设置按钮指定图片和视频默认模型</p>
                </div>
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" className="h-8 rounded-full pl-9 text-caption" />
                </div>
                {!selected.is_builtin ? (
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={refreshModels} disabled={refreshing || saving} title="刷新模型" aria-label="刷新模型">
                    {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>
                ) : null}
                <Button type="button" variant="ghost" size="sm" className="shrink-0 rounded-full" onClick={() => void toggleAllModels()} disabled={saving || !selected.models.some((model) => isLanguageModel(model.type, !selected.is_custom))} title="批量控制是否在对话模型选择中显示">
                  {selected.models.filter((model) => isLanguageModel(model.type, !selected.is_custom)).every((model) => model.enabled) ? "全部隐藏" : "全部显示"}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {hasVisibleModels ? (
                  <section>
                    {visibleModels.map((model) => {
                      const isChatModel = chatModelIds.has(model.id) && isLanguageModel(model.type, !selected.is_custom);
                      const typeInfo = modelTypeInfo(model.type);
                      const showImageActions =
                        (!typeInfo.known || typeInfo.capability === "image")
                        && Boolean(onSelectImageModel || onOpenImageSettings);
                      const showVideoActions =
                        (!typeInfo.known || typeInfo.capability === "video")
                        && Boolean(onSelectVideoModel || onOpenVideoSettings);
                      const isDefaultChat = settings.agent.provider === selected.name && settings.agent.model === model.id;
                      const isDefaultImage = selectedImageModel === model.id;
                      const isDefaultVideo = selectedVideoModel === model.id;
                      const modelMeta = [
                        model.id !== model.name ? model.id : null,
                        model.context_window ? `${formatContextWindow(model.context_window)} 上下文` : null,
                      ].filter(Boolean).join(" · ");
                      return (
                        <div key={model.id} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-accent/40">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="truncate text-ui font-medium">{model.name}</span>
                              <Badge variant="outline">{typeInfo.label}</Badge>
                              {model.recommended ? <Badge variant="secondary">推荐</Badge> : null}
                              {isDefaultChat ? <Badge variant="secondary">默认对话</Badge> : null}
                              {isDefaultImage ? <Badge variant="secondary" className="gap-1"><ImageIcon className="h-3.5 w-3.5" />默认图片</Badge> : null}
                              {isDefaultVideo ? <Badge variant="secondary" className="gap-1"><VideoIcon className="h-3.5 w-3.5" />默认视频</Badge> : null}
                            </div>
                            {modelMeta ? <p className="truncate font-mono text-micro text-muted-foreground">{modelMeta}</p> : null}
                          </div>
                          {isChatModel && model.enabled && !isDefaultChat && !isDefaultImage && !isDefaultVideo ? <Button type="button" variant="outline" size="sm" onClick={() => setDefault(model)} disabled={saving}>设为默认</Button> : null}
                          {isChatModel ? (
                            <button
                              type="button"
                              role="switch"
                              aria-checked={model.enabled}
                              aria-label={`${model.name} ${model.enabled ? "不在对话中显示" : "在对话中显示"}`}
                              title={model.enabled ? "不在对话模型选择中显示" : "在对话模型选择中显示"}
                              onClick={() => toggleModel(model)}
                              disabled={saving}
                              className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors", model.enabled ? "bg-emerald-500" : "bg-muted", saving && "cursor-not-allowed opacity-60")}
                            >
                              <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform", model.enabled ? "left-5" : "left-1")} />
                            </button>
                          ) : <span className="w-10 shrink-0" aria-hidden />}
                          {showImageActions || showVideoActions ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-md" disabled={saving} title="模型设置" aria-label={`设置 ${model.name}`}>
                                  <Settings2 className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel>生成模型</DropdownMenuLabel>
                                {showImageActions ? (
                                  <>
                                    {onSelectImageModel ? (
                                      <DropdownMenuItem
                                        disabled={isDefaultImage}
                                        onSelect={() => onSelectImageModel(selected.name, model.id)}
                                      >
                                        <ImageIcon className="h-4 w-4" />
                                        <span className="flex-1">设为默认图片模型</span>
                                        {isDefaultImage ? <Check className="h-4 w-4" aria-label="当前默认图片模型" /> : null}
                                      </DropdownMenuItem>
                                    ) : null}
                                    {onOpenImageSettings ? (
                                      <DropdownMenuItem onSelect={() => onOpenImageSettings(selected.name, model.id)}>
                                        <ImageIcon className="h-4 w-4" />图片生成设置
                                      </DropdownMenuItem>
                                    ) : null}
                                  </>
                                ) : null}
                                {showImageActions && showVideoActions ? <DropdownMenuSeparator /> : null}
                                {showVideoActions ? (
                                  <>
                                    {onSelectVideoModel ? (
                                      <DropdownMenuItem
                                        disabled={isDefaultVideo}
                                        onSelect={() => onSelectVideoModel(selected.name, model.id)}
                                      >
                                        <VideoIcon className="h-4 w-4" />
                                        <span className="flex-1">设为默认视频模型</span>
                                        {isDefaultVideo ? <Check className="h-4 w-4" aria-label="当前默认视频模型" /> : null}
                                      </DropdownMenuItem>
                                    ) : null}
                                    {onOpenVideoSettings ? (
                                      <DropdownMenuItem onSelect={() => onOpenVideoSettings(selected.name, model.id)}>
                                        <VideoIcon className="h-4 w-4" />视频生成设置
                                      </DropdownMenuItem>
                                    ) : null}
                                  </>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      );
                    })}
                  </section>
                ) : (
                  <p className="p-6 text-center text-caption text-muted-foreground">
                    {selected.is_builtin && !selected.configured ? "服务端暂无可用模型" : "没有匹配的模型"}
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
              <KeyRound className="h-8 w-8" />
              <p className="text-ui">添加供应商后管理模型</p>
            </div>
          )}
        </section>
      </div>

      {wizardOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={wizardCustom ? (wizardEditing ? "编辑自定义供应商" : "添加自定义供应商") : (wizardEditing ? "编辑供应商" : "添加供应商")}>
          <div className="grid w-full max-w-lg gap-4 rounded-2xl border bg-background p-6 shadow-lg">
            <div className="flex items-center justify-between"><div><h3 className="text-title-sm font-semibold">{wizardCustom ? (wizardEditing ? "编辑自定义供应商" : "添加自定义供应商") : (wizardEditing ? "编辑供应商" : "添加供应商")}</h3><p className="text-caption text-muted-foreground">步骤 {wizardStep} / 3</p></div><Button type="button" variant="ghost" onClick={() => setWizardOpen(false)}>取消</Button></div>
            {wizardCustom ? wizardStep === 2 ? (
              <div className="space-y-4">
                <div><p className="text-ui font-medium">自定义端点</p><p className="text-caption text-muted-foreground">接入任意 OpenAI 兼容的模型来源</p></div>
                <label className="grid gap-1 text-caption">显示名称<Input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="例如：我的本地模型" /></label>
                <label className="grid gap-1 text-caption">API Base<Input value={customApiBase} onChange={(event) => setCustomApiBase(event.target.value)} placeholder="https://example.com/v1" /></label>
                <label className="grid gap-1 text-caption">API Key<Input type="password" value={customApiKey} onChange={(event) => setCustomApiKey(event.target.value)} placeholder={wizardEditing ? "已配置，留空保持不变" : "可选"} autoComplete="new-password" /></label>
                {wizardError ? <p className="text-caption text-destructive">{wizardError}</p> : null}
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setWizardOpen(false)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={loadCustomModels} disabled={wizardLoading}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}拉取模型列表</Button></div>
              </div>
            ) : (
              <div className="space-y-4">
                <div><p className="text-ui font-medium">选择对话模型</p><p className="text-caption text-muted-foreground">这里只控制对话模型；图片和视频模型可在供应商详情中分别选择。</p></div>
                {wizardError ? <p className="rounded-lg bg-destructive/10 p-2 text-caption text-destructive">{wizardError}</p> : null}
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2">{customCandidates.map((model) => <label key={model.id} className="flex items-center gap-2 rounded-lg px-2 py-2 text-ui hover:bg-accent"><input type="checkbox" checked={customSelectedModels.includes(model.id)} onChange={() => setCustomSelectedModels((current) => current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id])} /><span className="min-w-0 flex-1 truncate">{model.name}</span>{model.recommended ? <span className="text-[11px] text-emerald-600">推荐</span> : null}</label>)}</div>
                <div className="flex gap-2"><Input value={customManualModel} onChange={(event) => setCustomManualModel(event.target.value)} placeholder="手动添加模型 ID（逗号分隔）" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomManualModel(); } }} /><Button type="button" variant="outline" onClick={addCustomManualModel}>添加</Button></div>
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setWizardStep(2)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={finishCustomWizard} disabled={wizardLoading || customModels.length === 0}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}完成</Button></div>
              </div>
            ) : wizardStep === 1 ? (
              <div className="space-y-3">
                <Input value={wizardQuery} onChange={(event) => setWizardQuery(event.target.value)} placeholder="搜索供应商" className="h-8 rounded-full" />
                <div className="max-h-[55vh] space-y-1 overflow-y-auto">
                  {availableToAdd.map((provider) => <button key={provider.name} type="button" onClick={() => chooseWizardProvider(provider)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-accent"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white shadow-sm"><ProviderIcon provider={provider} size={24} /></span><span className="min-w-0 flex-1 truncate text-ui">{provider.label}</span>{provider.region === "cn" ? <span className="text-[11px] text-muted-foreground">中国大陆</span> : null}</button>)}
                </div>
                <button type="button" onClick={openCustomWizard} className="flex w-full items-center gap-2.5 rounded-xl border border-dashed p-3 text-left hover:bg-accent"><Plus className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-ui font-medium">自定义端点</span><span className="block text-caption text-muted-foreground">接入任意 OpenAI 兼容的模型来源</span></span></button>
                <p className="text-[11px] text-muted-foreground">鉴权方式由供应商定义决定；基础 URL 由你自行填写。</p>
              </div>
            ) : wizardStep === 2 && wizardProvider ? (
              <div className="space-y-4">
                <div><p className="text-ui font-medium">{wizardProvider.label}</p><p className="text-caption text-muted-foreground">配置凭据和 API Base</p></div>
                <label className="grid gap-1 text-caption">API Key<Input type="password" value={wizardApiKey} onChange={(event) => setWizardApiKey(event.target.value)} placeholder={wizardEditing && wizardProvider.api_key_hint ? `已配置 ${wizardProvider.api_key_hint}，留空保持不变` : wizardProvider.api_key_required ? "请输入 API Key" : "可选"} autoComplete="new-password" /></label>
                <label className="grid gap-1 text-caption">API Base<Input value={wizardApiBase} onChange={(event) => setWizardApiBase(event.target.value)} readOnly={!wizardProvider.api_base_editable} /></label>
                {wizardError ? <p className="text-caption text-destructive">{wizardError}</p> : null}
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => wizardEditing ? setWizardOpen(false) : setWizardStep(1)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={loadWizardModels} disabled={wizardLoading || (wizardProvider.api_key_required && !wizardApiKey.trim() && !(wizardEditing && wizardProvider.api_key_hint))}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}拉取模型</Button></div>
              </div>
            ) : wizardProvider ? (
              <div className="space-y-4">
                <p className="text-ui font-medium">选择可用模型</p>
                {wizardError ? <p className="rounded-lg bg-destructive/10 p-2 text-caption text-destructive">{wizardError}</p> : null}
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2">{wizardCandidates.map((model) => <label key={model.id} className="flex items-center gap-2 rounded-lg px-2 py-2 text-ui hover:bg-accent"><input type="checkbox" checked={wizardSelectedModels.includes(model.id)} onChange={() => setWizardSelectedModels((current) => current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id])} /><span className="min-w-0 flex-1 truncate">{model.name}</span>{model.recommended ? <span className="text-[11px] text-emerald-600">推荐</span> : null}</label>)}</div>
                <div className="flex gap-2"><Input value={wizardManualModel} onChange={(event) => setWizardManualModel(event.target.value)} placeholder="手动添加模型 ID（逗号分隔）" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualModel(); } }} /><Button type="button" variant="outline" onClick={addManualModel}>添加</Button></div>
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setWizardStep(2)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={finishWizard} disabled={wizardLoading || wizardSelectedModels.length === 0}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}完成</Button></div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
