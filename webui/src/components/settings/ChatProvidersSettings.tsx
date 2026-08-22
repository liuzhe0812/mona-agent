import { useMemo, useState } from "react";
import {
  Check,
  ChevronLeft,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchProviderModels,
  updateProviderSettings,
  updateSettings,
} from "@/lib/api";
import type { SettingsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

type ChatProvider = NonNullable<SettingsPayload["chat_providers"]>[number];
type ChatModel = ChatProvider["models"][number];

interface ChatProvidersSettingsProps {
  settings: SettingsPayload;
  token: string;
  onSettingsChanged: (payload: SettingsPayload) => void;
  onModelNameChange: (modelName: string | null) => void;
}

function providerInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [label[0] ?? "?"])
    .join("")
    .toUpperCase();
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
}: ChatProvidersSettingsProps) {
  const providers = settings.chat_providers ?? [];
  const configured = useMemo(
    () =>
      providers
        .filter((provider) => provider.configured)
        .slice()
        .sort((a, b) => Number(b.region === "cn") - Number(a.region === "cn")),
    [providers],
  );
  const [selectedId, setSelectedId] = useState<string | null>(configured[0]?.name ?? null);
  const [providerQuery, setProviderQuery] = useState("");
  const [wizardQuery, setWizardQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardEditing, setWizardEditing] = useState(false);
  const [wizardCustom, setWizardCustom] = useState(false);
  const [customProviderId, setCustomProviderId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customApiBase, setCustomApiBase] = useState("");
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customSelectedModels, setCustomSelectedModels] = useState<string[]>([]);
  const [customManualModel, setCustomManualModel] = useState("");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [wizardProviderId, setWizardProviderId] = useState<string | null>(null);
  const [wizardApiKey, setWizardApiKey] = useState("");
  const [wizardApiBase, setWizardApiBase] = useState("");
  const [wizardModels, setWizardModels] = useState<string[]>([]);
  const [wizardSelectedModels, setWizardSelectedModels] = useState<string[]>([]);
  const [wizardManualModel, setWizardManualModel] = useState("");
  const [wizardLoading, setWizardLoading] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = providers.find((provider) => provider.name === selectedId) ?? configured[0];
  const filteredConfigured = configured.filter((provider) =>
    `${provider.label} ${provider.name}`.toLowerCase().includes(providerQuery.trim().toLowerCase()),
  );
  const wizardProvider = providers.find((provider) => provider.name === wizardProviderId);
  const wizardCandidates = useMemo(() => {
    if (!wizardProvider) return [];
    const discovered = modelRowsFromIds(wizardProvider, wizardModels);
    return [...wizardProvider.models, ...discovered];
  }, [wizardModels, wizardProvider]);
  const customCandidates = useMemo<ChatModel[]>(
    () => customModels.map((id, index) => ({
      id,
      name: id,
      context_window: null,
      enabled: customSelectedModels.includes(id),
      recommended: index === 0,
    })),
    [customModels, customSelectedModels],
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
    setWizardSelectedModels([]);
    setWizardManualModel("");
    setWizardError(null);
    setCustomName("");
    setCustomApiBase("");
    setCustomApiKey("");
    setCustomModels([]);
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
    setCustomSelectedModels([]);
    setCustomManualModel("");
  };

  const openEditWizard = () => {
    if (!selected) return;
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
      setCustomSelectedModels((current) => {
        const valid = current.filter((id) => candidates.includes(id));
        return valid.length ? valid : candidates.slice(0, 1);
      });
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
    setCustomSelectedModels((current) => [...new Set([...current, ...ids])]);
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
    if (!selectedModels.length) {
      setWizardError("请至少选择一个模型");
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
        model: selectedModels[0],
        enabledModels: selectedModels,
        discoveredModels: customModels.map((id) => ({ id, name: id })),
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
        discoveredModels: wizardModels.map((id) => ({ id, name: id })),
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
    if (!next.length) {
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
    if (!selected || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const result = await fetchProviderModels(token, {
        provider: selected.name,
        apiBase: selected.api_base,
      });
      if (result.error) throw new Error(result.error);
      const discovered = modelRowsFromIds(selected, result.models ?? []);
      if (!discovered.length) return;
      const existingEnabled = selected.models.filter((model) => model.enabled).map((model) => model.id);
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        discoveredModels: discovered.map((model) => ({ id: model.id, name: model.name })),
        enabledModels: [...existingEnabled, ...discovered.map((model) => model.id)],
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
    if (!selected || saving || !window.confirm(`删除供应商「${selected.label}」？`)) return;
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

  const visibleModels = selected?.models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(modelQuery.trim().toLowerCase()),
  ) ?? [];
  const availableToAdd = providers
    .filter((provider) => !provider.configured)
    .slice()
    .sort((a, b) => Number(b.region === "cn") - Number(a.region === "cn"))
    .filter((provider) => `${provider.label} ${provider.name}`.toLowerCase().includes(wizardQuery.trim().toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-title-md font-semibold">模型供应商</h2>
          <p className="text-caption text-muted-foreground">管理已添加的模型供应商和可用模型</p>
        </div>
        {error ? <span className="text-caption text-destructive">{error}</span> : null}
      </div>
      <div className="grid h-[min(70vh,680px)] min-h-[520px] max-h-[calc(100vh-200px)] grid-cols-[240px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm max-[760px]:grid-cols-1">
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
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-xs font-semibold">{providerInitials(provider.label)}</span>
                <span className="min-w-0 flex-1 truncate text-ui font-medium">{provider.label}</span>
                {provider.is_custom ? <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">自定义</span> : null}
                <span className="shrink-0 text-[11px] text-muted-foreground">已连接</span>
                {provider.name === settings.agent.provider ? <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="默认" /> : null}
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
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-sm font-semibold">{providerInitials(selected.label)}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-title-sm font-semibold">{selected.label}</h3>
                  <p className="truncate text-caption text-muted-foreground">{selected.api_base}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-caption text-emerald-600"><span className="h-2 w-2 rounded-full bg-emerald-500" />已连接</span>
                <Button type="button" variant="ghost" size="icon" onClick={openEditWizard} disabled={saving} title="编辑供应商" aria-label="编辑供应商">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={refreshModels} disabled={refreshing || saving} title="刷新模型" aria-label="刷新模型">
                  {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={deleteSelected} disabled={saving} title="删除供应商" aria-label="删除供应商">
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </header>
              <div className="flex items-center gap-3 border-b border-border/60 p-4">
                <span className="shrink-0 text-ui font-medium">可用模型</span>
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" className="h-8 rounded-full pl-9 text-caption" />
                </div>
                <span className="shrink-0 text-caption text-muted-foreground">{selected.models.filter((model) => model.enabled).length} 个已启用</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {visibleModels.length ? visibleModels.map((model) => (
                  <div key={model.id} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-accent/40">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={cn("truncate text-ui font-medium", !model.enabled && "text-muted-foreground")}>{model.name}</span>
                        {model.recommended ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">推荐</span> : null}
                        {settings.agent.provider === selected.name && settings.agent.model === model.id ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700 dark:bg-blue-950 dark:text-blue-300">默认</span> : null}
                      </div>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{model.id}{model.context_window ? ` · ${formatContextWindow(model.context_window)} 上下文` : ""}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={model.enabled}
                      aria-label={`${model.name} ${model.enabled ? "关闭" : "开启"}`}
                      onClick={() => toggleModel(model)}
                      disabled={saving}
                      className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors", model.enabled ? "bg-emerald-500" : "bg-muted", saving && "cursor-not-allowed opacity-60")}
                    >
                      <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-white shadow transition-transform", model.enabled ? "left-5" : "left-1")} />
                    </button>
                    {model.enabled && (settings.agent.provider !== selected.name || settings.agent.model !== model.id) ? <Button type="button" variant="outline" size="sm" onClick={() => setDefault(model)} disabled={saving}>设为默认</Button> : null}
                  </div>
                )) : <p className="p-6 text-center text-caption text-muted-foreground">没有匹配的模型</p>}
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
              <KeyRound className="h-8 w-8" />
              <p className="text-ui">添加供应商后管理聊天模型</p>
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
                <p className="text-ui font-medium">选择可用模型</p>
                {wizardError ? <p className="rounded-lg bg-destructive/10 p-2 text-caption text-destructive">{wizardError}</p> : null}
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2">{customCandidates.map((model) => <label key={model.id} className="flex items-center gap-2 rounded-lg px-2 py-2 text-ui hover:bg-accent"><input type="checkbox" checked={customSelectedModels.includes(model.id)} onChange={() => setCustomSelectedModels((current) => current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id])} /><span className="min-w-0 flex-1 truncate">{model.name}</span>{model.recommended ? <span className="text-[11px] text-emerald-600">推荐</span> : null}</label>)}</div>
                <div className="flex gap-2"><Input value={customManualModel} onChange={(event) => setCustomManualModel(event.target.value)} placeholder="手动添加模型 ID（逗号分隔）" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomManualModel(); } }} /><Button type="button" variant="outline" onClick={addCustomManualModel}>添加</Button></div>
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setWizardStep(2)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={finishCustomWizard} disabled={wizardLoading || customSelectedModels.length === 0}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}完成</Button></div>
              </div>
            ) : wizardStep === 1 ? (
              <div className="space-y-3">
                <Input value={wizardQuery} onChange={(event) => setWizardQuery(event.target.value)} placeholder="搜索供应商" className="h-8 rounded-full" />
                <div className="max-h-[55vh] space-y-1 overflow-y-auto">
                  {availableToAdd.map((provider) => <button key={provider.name} type="button" onClick={() => chooseWizardProvider(provider)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-accent"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-xs font-semibold">{providerInitials(provider.label)}</span><span className="min-w-0 flex-1 truncate text-ui">{provider.label}</span>{provider.region === "cn" ? <span className="text-[11px] text-muted-foreground">中国大陆</span> : null}</button>)}
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
