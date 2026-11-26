import { MONA_PROVIDER_ICON } from "@/lib/brand-assets";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PRIMARY_SOURCES, modelKey, orderedSources, sourceId, useModelPreferences } from "@/components/models/model-sources";
import { developmentApi, executorLabels, isCodeBuddyConnected, type DevExecutor, type ExecutorSettings, type NativeExecutorId } from "@/lib/development-api";
import { useNativeProviderState } from "@/lib/native-provider-state";
import { ProviderNativeConnection } from "./ProviderNativeConnection";
import { ProviderMark } from "@/components/models/ProviderMark";
import { NativeAccountQuota, formatNativePlan } from "./NativeAccountQuota";
import { useNativeAccountUsage } from "./useNativeAccountUsage";
import { modelPresentation } from "./model-presentation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NativeProviderSetup } from "./NativeProviderSetup";
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
  ChevronDown,
  Filter,
  Image as ImageIcon,
  GripVertical,
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
import { TooltipButton } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useLicense } from "@/hooks/useLicense";
import { formatBalanceAmount } from "@/lib/money";
import { isTauri, openExternalUrl } from "@/lib/tauri";
import {
  cancelGitHubCopilotLogin,
  fetchGitHubCopilotLogin,
  fetchProviderModels,
  fetchSettings,
  startGitHubCopilotLogin,
  updateProviderSettings,
  updateSettings,
  type GitHubCopilotLoginStatus,
} from "@/lib/api";
import type { CustomProviderWireApi, ProviderModelMetadata, ProviderModelOverride, SettingsPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

type ChatProvider = NonNullable<SettingsPayload["chat_providers"]>[number];
type ChatModel = ChatProvider["models"][number];
const CODEBUDDY_PRICING_URL = "https://www.codebuddy.cn/pricing/";

type ModelReasoningMetadata = Pick<
  ChatModel,
  | "reasoning_efforts"
  | "default_reasoning_effort"
  | "supports_adaptive_thinking"
>;

function isPositiveContextWindow(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isConcreteApiBase(value: string): boolean {
  const base = value.trim();
  if (!base || /\s|[{}]|%7[bd]/i.test(base)) return false;
  try {
    const url = new URL(base);
    return ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function trustedGitHubDeviceUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.port
      && !url.username && !url.password && /^\/login\/device\/?$/.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function githubLoginFailure(message?: string): string {
  const known = ["登录已过期，请重新登录。", "GitHub 授权被拒绝，请重新登录。", "GitHub 返回的登录信息无效，请重试。", "GitHub 登录失败，请检查网络后重试。"];
  return message && known.includes(message) ? message : "GitHub 登录失败，请重试。";
}

function customRouteKey(value: string): string {
  const raw = value.trim();
  if (!raw || /\s|\\/.test(raw)) return raw;
  const parts = raw.match(/^(https?):\/\/(\[[^\]]+\]|[^:/?#@]+)(?::(\d+))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i);
  if (!parts || parts[5] || parts[6]) return raw;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return raw;
    const scheme = parts[1].toLowerCase();
    const port = parts[3] ? Number(parts[3]) : null;
    if (port !== null && (!Number.isInteger(port) || port > 65535)) return raw;
    const portSuffix = port !== null && port !== (scheme === "https" ? 443 : 80) ? `:${port}` : "";
    return `${scheme}://${parts[2].toLowerCase()}${portSuffix}${parts[4].replace(/\/+$/, "")}`;
  } catch {
    return raw;
  }
}

function customWireApi(value?: string | null): CustomProviderWireApi {
  return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages" ? value : "auto";
}

function customConnectionKey(base: string, wireApi: CustomProviderWireApi): string {
  return JSON.stringify([customRouteKey(base), wireApi]);
}

function reasoningMetadataFor(
  model: ModelReasoningMetadata,
): ModelReasoningMetadata | undefined {
  const metadata: ModelReasoningMetadata = {};
  if (model.reasoning_efforts !== undefined) {
    metadata.reasoning_efforts = model.reasoning_efforts;
  }
  if (Object.prototype.hasOwnProperty.call(model, "default_reasoning_effort")) {
    metadata.default_reasoning_effort = model.default_reasoning_effort;
  }
  if (model.supports_adaptive_thinking !== undefined) {
    metadata.supports_adaptive_thinking = model.supports_adaptive_thinking;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

function mergeModelNames(current: Record<string, string>, models: Array<{ id: string; name?: string }>) {
  const names = { ...current };
  for (const model of models) {
    const name = model.name?.trim();
    if (name && (!names[model.id] || names[model.id] === model.id)) names[model.id] = name;
  }
  return names;
}

function mergeModelReasoning(
  current: Record<string, ModelReasoningMetadata>,
  models: Array<ModelReasoningMetadata & { id: string }>,
) {
  const result = { ...current };
  for (const model of models) {
    const incoming = reasoningMetadataFor(model);
    if (!incoming) continue;
    const merged = { ...result[model.id], ...incoming };
    if (incoming.reasoning_efforts && !Object.prototype.hasOwnProperty.call(incoming, "default_reasoning_effort")
      && merged.default_reasoning_effort != null && !incoming.reasoning_efforts.includes(merged.default_reasoning_effort)) {
      merged.default_reasoning_effort = null;
    }
    result[model.id] = merged;
  }
  return result;
}

function rawMetadataFor(model: ChatModel): ProviderModelMetadata {
  if (model.discovered_metadata !== undefined) return model.discovered_metadata;
  return {
    name: model.name, type: model.type, context_window: model.context_window,
    input_modalities: model.input_modalities, ...reasoningMetadataFor(model),
  };
}

function observedDiscovery(model: ProviderModelMetadata & { id: string; discovered_metadata?: ProviderModelMetadata }) {
  return model.discovered_metadata !== undefined ? { id: model.id, ...model.discovered_metadata } : model;
}

function mergeDiscoveredMetadata(
  current: Record<string, ProviderModelMetadata>,
  models: Array<ProviderModelMetadata & { id: string }>,
) {
  const result = { ...current };
  for (const model of models) {
    const previous = result[model.id] ?? {};
    const reasoning = reasoningMetadataFor(mergeModelReasoning({ [model.id]: previous }, [model])[model.id]) ?? {};
    const name = model.name?.trim();
    result[model.id] = {
      ...previous,
      ...(name && (!previous.name || previous.name === model.id) ? { name } : {}),
      ...(model.type && !previous.type ? { type: model.type } : {}),
      ...(isPositiveContextWindow(model.context_window) ? { context_window: model.context_window } : {}),
      ...(isPositiveContextWindow(model.context_window_max) ? { context_window_max: model.context_window_max } : {}),
      ...(model.opaque_model_id === true ? { opaque_model_id: true } : {}),
      ...(model.input_modalities ? { input_modalities: model.input_modalities } : {}),
      ...reasoning,
    };
  }
  return result;
}

function discoveredUpdate(id: string, metadata: ProviderModelMetadata = {}) {
  return {
    id,
    name: metadata.name || id,
    ...(metadata.type ? { type: metadata.type } : {}),
    ...(isPositiveContextWindow(metadata.context_window) ? { contextWindow: metadata.context_window } : {}),
    ...(isPositiveContextWindow(metadata.context_window_max) ? { contextWindowMax: metadata.context_window_max } : {}),
    ...(metadata.opaque_model_id === true ? { opaque_model_id: true } : {}),
    ...(metadata.input_modalities ? { inputModalities: metadata.input_modalities } : {}),
    ...(metadata.reasoning_efforts !== undefined ? { reasoningEfforts: metadata.reasoning_efforts } : {}),
    ...(Object.prototype.hasOwnProperty.call(metadata, "default_reasoning_effort")
      ? { defaultReasoningEffort: metadata.default_reasoning_effort } : {}),
    ...(metadata.supports_adaptive_thinking !== undefined ? { supportsAdaptiveThinking: metadata.supports_adaptive_thinking } : {}),
  };
}

type ModelOverrideDraft = {
  contextWindow: string;
  efforts: string;
  defaultEffort: string;
  noEfforts: boolean;
};
type ModelOverrideErrors = Partial<Record<"contextWindow" | "efforts" | "defaultEffort", string>>;

function modelOverrideDraft(value?: ProviderModelOverride): ModelOverrideDraft {
  return {
    contextWindow: value?.context_window?.toString() ?? "",
    efforts: value?.reasoning_efforts?.join(", ") ?? "",
    defaultEffort: value?.default_reasoning_effort ?? "",
    noEfforts: Array.isArray(value?.reasoning_efforts) && value.reasoning_efforts.length === 0,
  };
}

function parseModelOverride(draft: ModelOverrideDraft, knownEfforts?: string[]) {
  const errors: ModelOverrideErrors = {};
  const windowText = draft.contextWindow.trim();
  const window = Number(windowText);
  if (windowText && (!/^\d+$/.test(windowText) || !Number.isSafeInteger(window) || window <= 0)) {
    errors.contextWindow = "请输入正整数";
  }
  const effortText = draft.efforts.trim();
  const efforts = [...new Set(effortText.split(/[,，]/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const validEffort = (value: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(value) && value !== "none";
  if (!draft.noEfforts && effortText && (!efforts.length || efforts.length > 16 || efforts.some((value) => !validEffort(value)))) {
    errors.efforts = "请输入不超过 16 个有效英文档位，用逗号分隔";
  }
  const defaultEffort = draft.defaultEffort.trim().toLowerCase();
  const supported = effortText ? efforts : knownEfforts;
  if (!draft.noEfforts && defaultEffort && (!validEffort(defaultEffort) || supported && !supported.includes(defaultEffort))) {
    errors.defaultEffort = "默认档位必须属于支持列表";
  }
  const value: ProviderModelOverride = {
    ...(windowText && !errors.contextWindow ? { context_window: window } : {}),
    ...(draft.noEfforts ? { reasoning_efforts: [] } : effortText && !errors.efforts ? { reasoning_efforts: efforts } : {}),
    ...(!draft.noEfforts && defaultEffort && !errors.defaultEffort ? { default_reasoning_effort: defaultEffort } : {}),
  };
  return { value: Object.keys(value).length ? value : null, errors };
}

function ModelOverrideEditor({ name, draft, errors, onChange }: {
  name: string;
  draft: ModelOverrideDraft;
  errors: ModelOverrideErrors;
  onChange: (draft: ModelOverrideDraft) => void;
}) {
  return <div className="space-y-3 px-2 pb-3 pt-1 text-caption">
    <p className="text-muted-foreground">留空时使用模型提供的信息。</p>
    <label className="grid gap-1">上下文窗口（Token）
      <Input aria-label={`${name} 上下文窗口`} aria-invalid={!!errors.contextWindow} inputMode="numeric"
        value={draft.contextWindow} onChange={(event) => onChange({ ...draft, contextWindow: event.target.value })} placeholder="自动识别" />
      {errors.contextWindow && <span className="text-destructive">{errors.contextWindow}</span>}
    </label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={draft.noEfforts}
      onChange={(event) => onChange({ ...draft, noEfforts: event.target.checked })} />不支持思考强度</label>
    {!draft.noEfforts && <>
      <label className="grid gap-1">支持的思考档位
        <Input aria-label={`${name} 支持的思考档位`} aria-invalid={!!errors.efforts} value={draft.efforts}
          onChange={(event) => onChange({ ...draft, efforts: event.target.value })} placeholder="例如 low,medium,high" />
        {errors.efforts && <span className="text-destructive">{errors.efforts}</span>}
      </label>
      <label className="grid gap-1">默认思考档位
        <Input aria-label={`${name} 默认思考档位`} aria-invalid={!!errors.defaultEffort} value={draft.defaultEffort}
          onChange={(event) => onChange({ ...draft, defaultEffort: event.target.value })} placeholder="自动识别" />
        {errors.defaultEffort && <span className="text-destructive">{errors.defaultEffort}</span>}
      </label>
    </>}
    <Button type="button" variant="ghost" size="sm" onClick={() => onChange(modelOverrideDraft())}>恢复自动识别</Button>
  </div>;
}

function isLanguageModel(modelType?: string | null, allowUnknown = true): boolean {
  return !modelType
    ? allowUnknown
    : ["chat", "language", "text", "llm"].includes(modelType.toLowerCase());
}

type ModelCapability = "chat" | "image" | "video" | "audio" | "tts" | "stt" | "embedding" | "rerank" | "3d" | "other";
const MODEL_TYPE_OPTIONS: Array<{ value: ModelCapability; label: string }> = [
  { value: "chat", label: "对话" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "tts", label: "语音合成" },
  { value: "stt", label: "语音识别" },
  { value: "embedding", label: "向量" },
  { value: "rerank", label: "重排序" },
  { value: "3d", label: "3D" },
  { value: "other", label: "其他" },
];

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
  if (["tts", "speech", "text_to_speech"].includes(normalized ?? "")) return { label: "语音合成", capability: "tts", known: true };
  if (["stt", "transcription", "speech_to_text"].includes(normalized ?? "")) return { label: "语音识别", capability: "stt", known: true };
  if (["embedding", "embeddings"].includes(normalized ?? "")) return { label: "向量", capability: "embedding", known: true };
  if (["rerank", "reranker"].includes(normalized ?? "")) return { label: "重排序", capability: "rerank", known: true };
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
  openai: openaiIcon,
  anthropic: anthropicIcon,
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
  const icon = provider.is_builtin ? MONA_PROVIDER_ICON : PROVIDER_ICON_BY_ID[provider.name];
  if (!icon) return <span aria-hidden className="text-xs font-semibold">{providerInitials(provider.label)}</span>;
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
  const { providerOrder, moveProvider, hiddenNative, setNativeVisible } = useModelPreferences();
  const [nativeExecutors, setNativeExecutors] = useState<DevExecutor[]>([]);
  const [executorSettings, setExecutorSettings] = useState<ExecutorSettings>();
  const codebuddy = nativeExecutors.find((item) => item.id === "codebuddy");
  const [nativeRefresh, setNativeRefresh] = useState(0);
  const providerRevision = useNativeProviderState((state) => state.revision);
  const [nativeError, setNativeError] = useState("");
  const [engineError, setEngineError] = useState("");
  const [nativeFailure, setNativeFailure] = useState<NativeExecutorId | null>(null);
  const refreshNative = useCallback(() => setNativeRefresh((value) => value + 1), []);
  const [pricingError, setPricingError] = useState(false);
  const [engineBusy, setEngineBusy] = useState<NativeExecutorId | null>(null);
  const probedSources = useRef(new Set<string>());
  const codebuddyResumeProbe = useRef({ pending: false, lastStartedAt: 0 });
  const primary = (name: string) => (PRIMARY_SOURCES as readonly string[]).includes(name);
  const nativeFor = (name: string) => nativeExecutors.find((item) => sourceId(`native:${item.id}`) === name);
  const nativeConnected = (name: string) => name === "native:codebuddy" ? isCodeBuddyConnected(codebuddy) : name === "openai"
    ? nativeFor(name)?.probe?.authMode === "chatgpt"
    : nativeFor(name)?.probe?.authentication === "ready";
  const sourceSearchAlias = (id: string) => id === "openai" ? "ChatGPT 订阅 · Codex"
    : id === "anthropic" ? "Claude Code 账号" : "";
  const isAccountSource = (id: string) => id === "openai" || id === "anthropic" || id === "native:codebuddy";
  const nativeEnabled = (executor: DevExecutor) => executorSettings?.enabledEngines !== undefined
    ? executorSettings.enabledEngines.includes(executor.id as NativeExecutorId)
    : executor.enabled ?? executor.available;
  const nativeProgramAvailable = (executor: DevExecutor) => executor.programAvailable ?? executor.available;
  const openCodeBuddyPricing = async () => {
    try {
      await openExternalUrl(CODEBUDDY_PRICING_URL);
    } catch {
      setPricingError(true);
    }
  };
  useEffect(() => {
    let active = true;
    void developmentApi.providerExecutors().then((data) => { if (active) { setNativeExecutors(data.executors); setNativeError(""); } })
      .catch(() => { if (active) setNativeError("部分连接暂不可用，其他模型仍可使用。"); });
    void developmentApi.executorSettings().then((data) => { if (active) { setExecutorSettings(data); setEngineError(""); } })
      .catch(() => { if (active) setEngineError("暂时无法读取引擎设置。"); });
    return () => { active = false; };
  }, [nativeRefresh, providerRevision]);
  const builtinProvider = providers.find((provider) => provider.is_builtin) ?? null;
  const [managedBalance, setManagedBalance] = useState<string | null>(null);
  const manageableProviders = useMemo(
    () => providers.filter((provider) => !provider.is_builtin),
    [providers],
  );
  const configured = useMemo(() => {
    const visible = providers.filter((provider) => provider.is_builtin || provider.configured || (PRIMARY_SOURCES as readonly string[]).includes(provider.name));
    const order = orderedSources(visible.map((provider) => provider.name), providerOrder);
    return visible.slice().sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }, [providers, providerOrder]);
  const [selectedId, setSelectedId] = useState<string | null>(builtinProvider?.name ?? configured[0]?.name ?? null);
  const selectedCodebuddy = selectedId === "native:codebuddy" ? codebuddy : undefined;
  const workbuddyAuthenticated = !!selectedCodebuddy && nativeProgramAvailable(selectedCodebuddy)
    && selectedCodebuddy.probe?.authentication === "ready";
  const codebuddyCanRefreshOnResume = selectedId === "native:codebuddy"
    && !!codebuddy
    && nativeProgramAvailable(codebuddy);
  useEffect(() => {
    if (!codebuddyCanRefreshOnResume) return;
    const refreshOnResume = () => {
      if (document.visibilityState !== "visible") return;
      const guard = codebuddyResumeProbe.current;
      const now = Date.now();
      if (guard.pending || now - guard.lastStartedAt < 5_000) return;
      guard.pending = true;
      guard.lastStartedAt = now;
      void developmentApi.probe(undefined, "codebuddy")
        .catch(() => setNativeError("暂时无法刷新 WorkBuddy 账号状态，请稍后重试。"))
        .finally(() => { guard.pending = false; });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshOnResume();
    };
    window.addEventListener("focus", refreshOnResume);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshOnResume);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [codebuddyCanRefreshOnResume]);
  useEffect(() => {
    const executor = nativeFor(selectedId ?? "");
    if (!executor || !nativeProgramAvailable(executor) || probedSources.current.has(executor.id)) return;
    probedSources.current.add(executor.id);
    void developmentApi.probe(undefined, executor.id)
      .then(() => setNativeRefresh((value) => value + 1))
      .catch(() => setNativeError("暂时无法检查连接，请稍后重试。"));
  }, [selectedId, nativeExecutors]);
  const [providerQuery, setProviderQuery] = useState("");
  const [wizardQuery, setWizardQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [collapsedBrands, setCollapsedBrands] = useState<string[]>(["hidden"]);
  const [managementView, setManagementView] = useState<"brand" | "model">("brand");
  useEffect(() => { setModelFilter("all"); setCollapsedBrands(["hidden"]); }, [selectedId]);
  const [adjustModels, setAdjustModels] = useState(false);
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
    if (selectedId === "native:codebuddy" && codebuddy) return;
    if (!configured.some((provider) => provider.name === selectedId)) {
      setSelectedId(builtinProvider?.name ?? configured[0]?.name ?? null);
    }
  }, [builtinProvider?.name, configured, selectedId, codebuddy]);
  const [customApiBase, setCustomApiBase] = useState("");
  const [customProtocol, setCustomProtocol] = useState<CustomProviderWireApi>("auto");
  const [customBaseError, setCustomBaseError] = useState("");
  const customCurrentRoute = useRef("");
  const customDataRoute = useRef("");
  const customProbeRevision = useRef(0);
  const [customApiKey, setCustomApiKey] = useState("");
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customModelNames, setCustomModelNames] = useState<Record<string, string>>({});
  const [customDiscoveredMetadata, setCustomDiscoveredMetadata] = useState<Record<string, ProviderModelMetadata>>({});
  const [customModelTypes, setCustomModelTypes] = useState<Record<string, string>>({});
  const [customOverrideDrafts, setCustomOverrideDrafts] = useState<Record<string, ModelOverrideDraft>>({});
  const [customOverrideTouched, setCustomOverrideTouched] = useState<string[]>([]);
  const [customOverrideErrors, setCustomOverrideErrors] = useState<Record<string, ModelOverrideErrors>>({});
  const [customExpandedModel, setCustomExpandedModel] = useState<string | null>(null);
  const [customSelectedModels, setCustomSelectedModels] = useState<string[]>([]);
  const [customManualModel, setCustomManualModel] = useState("");
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);
  const [wizardProviderId, setWizardProviderId] = useState<string | null>(null);
  const [wizardApiKey, setWizardApiKey] = useState("");
  const [wizardApiBase, setWizardApiBase] = useState("");
  const wizardCurrentRoute = useRef("");
  const wizardDataRoute = useRef("");
  const wizardProbeRevision = useRef(0);
  const [wizardBaseError, setWizardBaseError] = useState("");
  const [wizardModels, setWizardModels] = useState<string[]>([]);
  const [wizardManualModels, setWizardManualModels] = useState<string[]>([]);
  const [wizardModelNames, setWizardModelNames] = useState<Record<string, string>>({});
  const [wizardDiscoveredMetadata, setWizardDiscoveredMetadata] = useState<Record<string, ProviderModelMetadata>>({});
  const [wizardModelTypes, setWizardModelTypes] = useState<Record<string, string>>({});
  const [wizardSelectedModels, setWizardSelectedModels] = useState<string[]>([]);
  const [wizardManualModel, setWizardManualModel] = useState("");
  const [wizardLoading, setWizardLoading] = useState(false);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [githubLogin, setGithubLogin] = useState<GitHubCopilotLoginStatus>({ status: "idle" });
  const [githubChecking, setGithubChecking] = useState(false);
  const [githubActionPending, setGithubActionPending] = useState(false);
  const [githubPollVersion, setGithubPollVersion] = useState(0);
  const [githubError, setGithubError] = useState("");
  const githubEpoch = useRef(0);
  const githubBusy = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = selectedCodebuddy ? undefined : configured.find((provider) => provider.name === selectedId) ?? configured[0];
  const isMonaManaged = selected?.name === "mona_managed";
  const accountUsage = useNativeAccountUsage(selected?.name === "openai", Boolean(nativeConnected("openai")), nativeRefresh);
  const usageIdentity = useRef<string | null>(null);
  useEffect(() => {
    const usage = accountUsage.usage;
    if (!usage) return;
    if (!usage.connected) {
      usageIdentity.current = null;
      if (nativeFor("openai")?.probe?.authMode === "chatgpt") setNativeRefresh((value) => value + 1);
      return;
    }
    const identity = JSON.stringify([usage.accountKey, usage.email, usage.planType]);
    const previous = usageIdentity.current;
    usageIdentity.current = identity;
    if (previous !== null && previous !== identity) {
      void developmentApi.probe(undefined, "codex").then(() => setNativeRefresh((value) => value + 1))
        .catch(() => setNativeError("账号已更新，模型目录暂未刷新，请重试。"));
    }
  }, [accountUsage.usage]);
  const filteredConfigured = configured.filter((provider) =>
    `${provider.label} ${provider.name} ${sourceSearchAlias(provider.name)}`.toLowerCase().includes(providerQuery.trim().toLowerCase()),
  );
  const allSourceIds = orderedSources([...configured.map((provider) => provider.name), ...(codebuddy ? ["native:codebuddy"] : [])], providerOrder);
  const visibleSourceIds = allSourceIds.filter((id) => id === "native:codebuddy"
    ? `WorkBuddy CodeBuddy 腾讯 ${codebuddy?.name ?? ""}`.toLowerCase().includes(providerQuery.trim().toLowerCase())
    : filteredConfigured.some((provider) => provider.name === id));
  const apiSourceIds = visibleSourceIds.filter((id) => !isAccountSource(id));
  const accountSourceIds = visibleSourceIds.filter(isAccountSource);
  const isSuggestedSource = (id: string) => id === "anthropic" ? !nativeConnected(id) && !configured.find((provider) => provider.name === id)?.configured
    : id === "native:codebuddy" && codebuddy?.probe?.authentication !== "ready";
  const sortableSourceIds = allSourceIds.filter((id) => !isSuggestedSource(id));
  const [orderAnnouncement, setOrderAnnouncement] = useState("");
  const moveSource = (source: string, before: string | null) => {
    moveProvider(source, before, sortableSourceIds);
    const order = sortableSourceIds.filter((id) => id !== source);
    const index = before === null ? order.length : order.indexOf(before);
    setOrderAnnouncement(`已移到第 ${index + 1} 项，共 ${sortableSourceIds.length} 项`);
  };
  const wizardProvider = manageableProviders.find((provider) => provider.name === wizardProviderId);
  const githubStepActive = wizardOpen && wizardStep === 2 && wizardProvider?.auth_method === "github-copilot";
  useEffect(() => {
    if (!githubStepActive) return;
    const epoch = ++githubEpoch.current;
    let cancelled = false;
    let timer: number | undefined;
    setGithubChecking(true);
    const poll = async () => {
      try {
        const status = await fetchGitHubCopilotLogin(token);
        if (cancelled || epoch !== githubEpoch.current) return;
        setGithubLogin(status);
        setGithubChecking(false);
        if (status.status === "authorized") setWizardError((current) => current === "请先登录 GitHub。" ? null : current);
        if (status.status === "failed") setGithubError(githubLoginFailure(status.message));
        if (status.status === "starting" || status.status === "waiting") timer = window.setTimeout(poll, 1000);
      } catch {
        if (cancelled || epoch !== githubEpoch.current) return;
        setGithubChecking(false);
        setGithubLogin({ status: "failed" });
        setGithubError("无法读取 GitHub 登录状态，请重试。");
      }
    };
    void poll();
    return () => {
      cancelled = true;
      githubEpoch.current += 1;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [githubStepActive, githubPollVersion, token]);
  const wizardCandidates = useMemo(() => {
    if (!wizardProvider) return [];
    const originalRoute = customRouteKey(wizardApiBase) === customRouteKey(wizardProvider.api_base || wizardProvider.default_api_base);
    const models = originalRoute || wizardEditing ? wizardProvider.models : [];
    const discovered = modelRowsFromIds({ ...wizardProvider, models }, wizardModels);
    const known = new Set([...models, ...discovered].map((model) => model.id));
    const catalog = (!wizardEditing || originalRoute ? wizardProvider.catalog_candidates ?? [] : [])
      .filter((candidate) => {
        if (!candidate.id || known.has(candidate.id)) return false;
        known.add(candidate.id);
        return true;
      })
      .map((candidate) => ({ ...candidate, enabled: false, recommended: false }));
    return [...models.map((model) => ({
      ...model,
      name: wizardModelNames[model.id] ?? (originalRoute ? model.name : model.id),
      type: wizardModelTypes[model.id] ?? model.type,
    })), ...discovered.map((model) => ({
      ...model,
      name: wizardModelNames[model.id] ?? model.name,
      type: wizardModelTypes[model.id],
    })), ...catalog];
  }, [wizardApiBase, wizardEditing, wizardModelNames, wizardModelTypes, wizardModels, wizardProvider]);
  const customCandidates = useMemo<ChatModel[]>(
    () => customModels.map((id) => ({
      id,
      name: customModelNames[id] ?? id,
      type: customModelTypes[id],
      enabled: customSelectedModels.includes(id),
      recommended: false,
    })),
    [customModelNames, customModelTypes, customModels, customSelectedModels],
  );

  const startCustomRoute = (value: string, wireApi: CustomProviderWireApi = "auto") => {
    customProbeRevision.current += 1;
    customCurrentRoute.current = customConnectionKey(value, wireApi);
    customDataRoute.current = customCurrentRoute.current;
    setCustomApiBase(value);
    setCustomProtocol(wireApi);
    setCustomBaseError("");
  };

  const changeCustomRoute = (value: string) => {
    const route = customConnectionKey(value, customProtocol);
    if (route !== customCurrentRoute.current) {
      customProbeRevision.current += 1;
      setWizardLoading(false);
    }
    customCurrentRoute.current = route;
    setCustomApiBase(value);
    setCustomBaseError("");
  };

  const changeCustomProtocol = (value: string) => {
    const wireApi = customWireApi(value);
    const route = customConnectionKey(customApiBase, wireApi);
    if (route !== customCurrentRoute.current) {
      customProbeRevision.current += 1;
      setWizardLoading(false);
    }
    customCurrentRoute.current = route;
    setCustomProtocol(wireApi);
  };

  const startWizardRoute = (value: string) => {
    const base = isConcreteApiBase(value) ? value : "";
    wizardProbeRevision.current += 1;
    wizardCurrentRoute.current = customRouteKey(base);
    wizardDataRoute.current = wizardCurrentRoute.current;
    setWizardApiBase(base);
    setWizardBaseError("");
    setWizardLoading(false);
  };

  const changeWizardRoute = (value: string) => {
    const route = customRouteKey(value);
    if (route !== wizardCurrentRoute.current) {
      wizardProbeRevision.current += 1;
      setWizardLoading(false);
    }
    wizardCurrentRoute.current = route;
    setWizardApiBase(value);
    setWizardBaseError("");
  };

  const changeGitHubLogin = async (action: "start" | "cancel") => {
    if (githubBusy.current) return;
    githubBusy.current = true;
    setGithubActionPending(true);
    const epoch = ++githubEpoch.current;
    if (action === "start") setGithubLogin({ status: "starting" });
    try {
      const status = await (action === "start" ? startGitHubCopilotLogin(token) : cancelGitHubCopilotLogin(token));
      if (epoch !== githubEpoch.current) return;
      setGithubLogin(status);
      setGithubPollVersion((value) => value + 1);
    } catch {
      if (epoch !== githubEpoch.current) return;
      setGithubLogin({ status: "failed" });
      setGithubError(action === "start" ? "GitHub 登录未能开始，请重试。" : "取消 GitHub 登录失败，请重试。");
    } finally {
      githubBusy.current = false;
      setGithubActionPending(false);
    }
  };

  const openGitHubDevicePage = async () => {
    const url = trustedGitHubDeviceUrl(githubLogin.verification_url);
    if (!url) return;
    try {
      await openExternalUrl(url);
    } catch {
      setGithubError("无法打开 GitHub 授权页面，请重试。");
    }
  };

  const openWizard = () => {
    setWizardOpen(true);
    setWizardEditing(false);
    setWizardCustom(false);
    setCustomProviderId(null);
    setWizardStep(1);
    setWizardProviderId(null);
    setWizardQuery("");
    setWizardApiKey("");
    startWizardRoute("");
    setWizardModels([]);
    setWizardManualModels([]);
    setWizardModelNames({});
    setWizardDiscoveredMetadata({});
    setWizardModelTypes({});
    setWizardSelectedModels([]);
    setWizardManualModel("");
    setWizardError(null);
    setGithubLogin({ status: "idle" });
    setCustomName("");
    startCustomRoute("");
    setCustomApiKey("");
    setCustomModels([]);
    setCustomModelNames({});
    setCustomDiscoveredMetadata({});
    setCustomModelTypes({});
    setCustomOverrideDrafts({});
    setCustomOverrideTouched([]);
    setCustomOverrideErrors({});
    setCustomExpandedModel(null);
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
    startCustomRoute("");
    setCustomApiKey("");
    setCustomModels([]);
    setCustomModelNames({});
    setCustomDiscoveredMetadata({});
    setCustomModelTypes({});
    setCustomOverrideDrafts({});
    setCustomOverrideTouched([]);
    setCustomOverrideErrors({});
    setCustomExpandedModel(null);
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
      startCustomRoute(selected.api_base || "", customWireApi(selected.wire_api));
      setCustomApiKey("");
      const ids = selected.models.map((model) => model.id);
      setCustomModels(ids);
      setCustomModelNames(mergeModelNames({}, selected.models));
      setCustomDiscoveredMetadata(Object.fromEntries(selected.models.map((model) => [model.id, rawMetadataFor(model)])));
      setCustomModelTypes(Object.fromEntries(selected.models.flatMap((model) => model.type ? [[model.id, model.type]] : [])));
      setCustomOverrideDrafts(Object.fromEntries(Object.entries(selected.model_overrides ?? {}).map(([id, value]) => [id, modelOverrideDraft(value)])));
      setCustomOverrideTouched([]);
      setCustomOverrideErrors({});
      setCustomExpandedModel(null);
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
    startWizardRoute(selected.api_base || selected.default_api_base);
    setWizardModels([]);
    setWizardManualModels([]);
    setWizardModelNames(mergeModelNames({}, selected.models));
    setWizardDiscoveredMetadata(Object.fromEntries(selected.models.map((model) => [model.id, rawMetadataFor(model)])));
    setWizardModelTypes(Object.fromEntries(selected.models.flatMap((model) =>
      model.type ? [[model.id, model.type] as const] : [],
    )));
    setWizardSelectedModels(selected.configured
      ? selected.models.filter((model) => model.enabled).map((model) => model.id)
      : selected.models[0] ? [selected.models[0].id] : []);
    setWizardManualModel("");
    setWizardError(null);
    setGithubLogin({ status: "idle" });
  };

  const chooseWizardProvider = (provider: ChatProvider) => {
    setWizardOpen(true);
    setWizardEditing(false);
    setWizardCustom(false);
    setWizardProviderId(provider.name);
    startWizardRoute(provider.api_base || provider.default_api_base);
    setWizardApiKey("");
    setWizardModels([]);
    setWizardManualModels([]);
    setWizardModelNames(mergeModelNames({}, provider.models));
    setWizardDiscoveredMetadata(Object.fromEntries(provider.models.map((model) => [model.id, rawMetadataFor(model)])));
    setWizardModelTypes({});
    setWizardSelectedModels(provider.models[0] ? [provider.models[0].id] : []);
    setWizardManualModel("");
    setWizardError(null);
    setGithubLogin({ status: "idle" });
    setWizardStep(2);
  };

  const prepareCustomRoute = (route: string) => {
    if (route === customDataRoute.current) return;
    const original = wizardEditing && selected?.name === customProviderId
      && customConnectionKey(selected.api_base, customWireApi(selected.wire_api)) === route ? selected : undefined;
    const oldMetadata = customDiscoveredMetadata;
    setCustomModelNames(original ? mergeModelNames({}, original.models) : {});
    setCustomDiscoveredMetadata(Object.fromEntries(customModels.map((id) => {
      const restored = original?.models.find((model) => model.id === id);
      const type = customModelTypes[id] ?? oldMetadata[id]?.type;
      const raw = restored ? rawMetadataFor(restored) : {};
      return [id, type && (!restored || type !== restored.type) ? { ...raw, type } : raw];
    })));
    setCustomOverrideDrafts(Object.fromEntries(Object.entries(original?.model_overrides ?? {}).map(([id, value]) => [id, modelOverrideDraft(value)])));
    setCustomOverrideTouched([]);
    setCustomOverrideErrors({});
    setCustomExpandedModel(null);
    customDataRoute.current = route;
  };

  const canOpenCustomModels = () => {
    if (!customName.trim()) {
      setWizardError("请输入显示名称");
      return false;
    }
    if (!isConcreteApiBase(customApiBase)) {
      setCustomBaseError("请输入有效的 http/https API Base");
      return false;
    }
    return true;
  };

  const openCustomModelsManually = () => {
    if (!canOpenCustomModels()) return;
    customProbeRevision.current += 1;
    prepareCustomRoute(customConnectionKey(customApiBase, customProtocol));
    setWizardLoading(false);
    setWizardError(null);
    setWizardStep(3);
  };

  const loadCustomModels = async () => {
    if (!canOpenCustomModels()) return;
    const base = customApiBase.trim();
    const route = customConnectionKey(base, customProtocol);
    const revision = ++customProbeRevision.current;
    prepareCustomRoute(route);
    setWizardLoading(true);
    setWizardError(null);
    try {
      const result = await fetchProviderModels(token, {
        provider: customProviderId ?? "custom",
        apiKey: customApiKey.trim() || undefined,
        apiBase: base,
        wireApi: customProtocol,
      });
      if (revision !== customProbeRevision.current || route !== customCurrentRoute.current) return;
      const fetched = result.models ?? [];
      const candidates = [...new Set([...customModels, ...fetched.map((id) => id.trim()).filter(Boolean)])];
      setCustomModels(candidates);
      setCustomModelNames((current) => mergeModelNames(current, result.model_details ?? []));
      setCustomDiscoveredMetadata((current) => mergeDiscoveredMetadata(current, (result.model_details ?? []).map(observedDiscovery)));
      setCustomModelTypes((current) => ({
        ...Object.fromEntries(
          (result.model_details ?? [])
            .flatMap((model) => model.type ? [[model.id, model.type] as const] : []),
        ),
        ...current,
      }));
      setCustomSelectedModels((current) => current.filter((id) => candidates.includes(id)));
      if (result.error) setWizardError("暂时无法获取模型，请检查连接设置后重试。");
    } catch (err) {
      if (revision === customProbeRevision.current && route === customCurrentRoute.current) {
        setWizardError("暂时无法获取模型，请检查连接设置后重试。");
      }
    } finally {
      if (revision === customProbeRevision.current && route === customCurrentRoute.current) {
        setWizardLoading(false);
        setWizardStep(3);
      }
    }
  };

  const addCustomManualModel = () => {
    const ids = customManualModel.split(/[,\n]/).map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return;
    setCustomModels((current) => [...new Set([...current, ...ids])]);
    setCustomSelectedModels((current) => [...new Set([...current, ...ids])]);
    setCustomDiscoveredMetadata((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, { ...current[id], type: "chat" }])),
    }));
    setCustomModelTypes((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, "chat"])),
    }));
    setCustomManualModel("");
  };

  const knownCustomEfforts = (id: string) => {
    const raw = customDiscoveredMetadata[id]?.reasoning_efforts;
    if (raw !== undefined) return raw;
    if (!wizardEditing || selected?.name !== customProviderId
      || customDataRoute.current !== customConnectionKey(selected.api_base, customWireApi(selected.wire_api))
      || selected.model_overrides?.[id]?.reasoning_efforts !== undefined) return undefined;
    return selected.models.find((model) => model.id === id)?.reasoning_efforts;
  };

  const changeCustomOverride = (id: string, draft: ModelOverrideDraft) => {
    setCustomOverrideDrafts((current) => ({ ...current, [id]: draft }));
    setCustomOverrideTouched((current) => current.includes(id) ? current : [...current, id]);
    setCustomOverrideErrors((current) => ({ ...current, [id]: {} }));
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
    if (!isConcreteApiBase(base)) {
      setCustomBaseError("请输入有效的 http/https API Base");
      setWizardStep(2);
      return;
    }
    if (!customModels.length) {
      setWizardError("请至少添加一个模型");
      return;
    }
    const modelOverrides: Record<string, ProviderModelOverride | null> = {};
    const fieldErrors: Record<string, ModelOverrideErrors> = {};
    for (const id of customOverrideTouched.filter((item) => customModels.includes(item))) {
      const parsed = parseModelOverride(customOverrideDrafts[id] ?? modelOverrideDraft(), knownCustomEfforts(id));
      if (Object.keys(parsed.errors).length) fieldErrors[id] = parsed.errors;
      else modelOverrides[id] = parsed.value;
    }
    const firstInvalid = Object.keys(fieldErrors)[0];
    if (firstInvalid) {
      setCustomOverrideErrors(fieldErrors);
      setCustomExpandedModel(firstInvalid);
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
        wireApi: customProtocol,
        ...(selectedModels[0] ? { model: selectedModels[0] } : {}),
        enabledModels: selectedModels,
        discoveredModels: customModels.map((id) => discoveredUpdate(id, customDiscoveredMetadata[id])),
        ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}),
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
      const message = err instanceof Error ? err.message : "";
      let field: { id: string; name: keyof ModelOverrideErrors; text: string } | undefined;
      for (const id of customOverrideTouched) {
        if (message === `模型 ${id} 的上下文窗口必须是正整数`) field = { id, name: "contextWindow", text: "请输入正整数" };
        if (message === `模型 ${id} 的思考档位格式无效`) field = { id, name: "efforts", text: "请输入有效的思考档位" };
        if (message === `模型 ${id} 的默认思考档位必须属于支持列表`) field = { id, name: "defaultEffort", text: "默认档位必须属于支持列表" };
        if (field) break;
      }
      if (field) {
        setCustomOverrideErrors({ [field.id]: { [field.name]: field.text } });
        setCustomExpandedModel(field.id);
      } else {
        setWizardError("保存失败，请检查设置后重试。");
      }
    } finally {
      setWizardLoading(false);
    }
  };

  const prepareWizardRoute = (route: string) => {
    if (!wizardProvider || route === wizardDataRoute.current) return;
    const original = wizardEditing && customRouteKey(wizardProvider.api_base) === route ? wizardProvider : undefined;
    const models = wizardEditing ? wizardProvider.models : [];
    const ids = [...new Set([...models.map((model) => model.id), ...wizardManualModels])];
    setWizardModelNames(original ? mergeModelNames({}, original.models) : {});
    setWizardDiscoveredMetadata(Object.fromEntries(ids.map((id) => {
      const previous = models.find((model) => model.id === id);
      const restored = original?.models.find((model) => model.id === id);
      const type = wizardModelTypes[id] ?? previous?.type ?? wizardDiscoveredMetadata[id]?.type;
      const raw = restored ? rawMetadataFor(restored) : {};
      return [id, type && (!restored || type !== restored.type) ? { ...raw, type } : raw];
    })));
    setWizardModels(wizardManualModels);
    wizardDataRoute.current = route;
  };

  const canOpenWizardModels = () => {
    if (!wizardProvider) return false;
    if (wizardProvider.auth_method === "github-copilot" && (githubChecking || githubLogin.status !== "authorized")) {
      setWizardError("请先登录 GitHub。");
      return false;
    }
    if (!isConcreteApiBase(wizardApiBase)) {
      setWizardBaseError("请输入有效的 http/https API Base");
      return false;
    }
    if (wizardProvider.api_key_required && !wizardApiKey.trim() && !(wizardEditing && wizardProvider.api_key_hint)) {
      setWizardError("请输入 API Key");
      return false;
    }
    return true;
  };

  const openWizardModelsManually = () => {
    if (!canOpenWizardModels()) return;
    wizardProbeRevision.current += 1;
    prepareWizardRoute(customRouteKey(wizardApiBase));
    setWizardLoading(false);
    setWizardError(null);
    setWizardStep(3);
  };

  const loadWizardModels = async () => {
    if (!canOpenWizardModels()) return;
    if (!wizardProvider) return;
    const route = customRouteKey(wizardApiBase);
    const revision = ++wizardProbeRevision.current;
    const errorMessage = wizardProvider.auth_method === "aws" ? "无法拉取模型，请检查 AWS 凭据、区域和模型权限。"
      : wizardProvider.auth_method === "google-adc" ? "无法拉取模型，请检查 Google 凭据、项目地址和模型权限。"
      : wizardProvider.auth_method === "github-copilot" ? "无法拉取模型，请检查 GitHub 授权和订阅权限。"
      : "无法拉取模型，请检查 API Base 和 API Key 后重试。";
    prepareWizardRoute(route);
    setWizardLoading(true);
    setWizardError(null);
    try {
      const result = await fetchProviderModels(token, {
        provider: wizardProvider.name,
        apiKey: wizardApiKey.trim() || undefined,
        apiBase: wizardApiBase.trim() || undefined,
      });
      if (revision !== wizardProbeRevision.current || route !== wizardCurrentRoute.current) return;
      const fetched = [...new Set([...wizardManualModels, ...(result.models ?? []).map((id) => id.trim()).filter(Boolean)])];
      setWizardModels(fetched);
      setWizardModelNames((current) => mergeModelNames(current, result.model_details ?? []));
      setWizardDiscoveredMetadata((current) => mergeDiscoveredMetadata(current, (result.model_details ?? []).map(observedDiscovery)));
      setWizardModelTypes((current) => ({
        ...Object.fromEntries(
          (result.model_details ?? [])
            .flatMap((model) => model.type ? [[model.id, model.type] as const] : []),
        ),
        ...current,
      }));
      const originalRoute = customRouteKey(wizardProvider.api_base || wizardProvider.default_api_base) === route;
      const candidates = [...(wizardEditing || originalRoute ? wizardProvider.models.map((model) => model.id) : []), ...fetched];
      setWizardSelectedModels((current) => {
        const valid = current.filter((id) => candidates.includes(id));
        return valid.length > 0 ? valid : candidates.slice(0, 1);
      });
      if (result.error) setWizardError(errorMessage);
    } catch (err) {
      if (revision === wizardProbeRevision.current && route === wizardCurrentRoute.current) {
        setWizardError(errorMessage);
      }
    } finally {
      if (revision === wizardProbeRevision.current && route === wizardCurrentRoute.current) {
        setWizardLoading(false);
        setWizardStep(3);
      }
    }
  };

  const addManualModel = () => {
    const ids = wizardManualModel.split(/[,\n]/).map((id) => id.trim()).filter(Boolean);
    if (!ids.length) return;
    setWizardModels((current) => [...new Set([...current, ...ids])]);
    setWizardManualModels((current) => [...new Set([...current, ...ids])]);
    setWizardDiscoveredMetadata((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, { ...current[id], type: "chat" }])),
    }));
    setWizardModelTypes((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, "chat"])),
    }));
    setWizardSelectedModels((current) => [...new Set([...current, ...ids])]);
    setWizardManualModel("");
  };

  const finishWizard = async () => {
    if (!wizardProvider) return;
    if (!canOpenWizardModels()) {
      setWizardStep(2);
      return;
    }
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
      const candidatesToSave = wizardCandidates.filter((candidate) => wizardProvider.models.some((model) => model.id === candidate.id)
        || wizardModels.includes(candidate.id) || wizardSelectedModels.includes(candidate.id));
      const payload = await updateProviderSettings(token, {
        provider: wizardProvider.name,
        apiBase: wizardApiBase.trim(),
        model: selectedModels[0],
        enabledModels: selectedModels,
        discoveredModels: candidatesToSave.map((candidate) => discoveredUpdate(candidate.id,
          wizardDiscoveredMetadata[candidate.id] ?? (wizardSelectedModels.includes(candidate.id) ? { type: candidate.type || "chat" } : undefined))),
        ...(apiKey ? { apiKey } : {}),
      });
      onSettingsChanged(payload);
      setSelectedId(wizardProvider.name);
      setWizardOpen(false);
    } catch (err) {
      setWizardError("保存失败，请检查设置后重试。");
    } finally {
      setWizardLoading(false);
    }
  };

  const toggleModel = async (model: ChatModel) => {
    if (!selected || isMonaManaged || saving) return;
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
      setError("保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const changeModelType = async (model: ChatModel, type: string) => {
    if (!selected || selected.is_builtin || saving) return;
    setSaving(true);
    try {
      const raw = rawMetadataFor(model);
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        discoveredModels: [{
          id: model.id,
          name: raw.name || model.id,
          type,
          ...(isPositiveContextWindow(raw.context_window)
            ? { contextWindow: raw.context_window }
            : {}),
          ...(isPositiveContextWindow(raw.context_window_max)
            ? { contextWindowMax: raw.context_window_max }
            : {}),
        }],
      });
      onSettingsChanged(payload);
      setError(null);
    } catch (err) {
      setError("保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const toggleAllModels = async (action: "show" | "hide" | "reset") => {
    if (!selected || isMonaManaged || saving) return;
    const native = nativeFor(selected.name);
    const nativeKeys = native && nativeProgramAvailable(native) && nativeConnected(selected.name)
      ? native.models.filter((model) => model.id).map((model) =>
        modelKey({ provider: `native:${native.id}`, model: model.id, executor: native.id }),
      ) : [];
    const chatModels = selected.configured ? selected.models.filter((model) => isLanguageModel(model.type, !selected.is_custom)) : [];
    if (!chatModels.length) {
      if (nativeKeys.length) setNativeVisible(nativeKeys, action !== "hide");
      return;
    }
    const next = action === "reset" ? null : action === "hide" ? [] : chatModels.map((model) => model.id);
    const anotherProviderHasEnabledModel = providers.some((provider) =>
      provider.name !== selected.name
      && provider.configured
      && provider.models.some((model) => model.enabled),
    );
    if (next?.length === 0 && !anotherProviderHasEnabledModel) {
      setError("请至少保留一个可用模型");
      return;
    }
    setSaving(true);
    try {
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        enabledModels: next,
      });
      if (nativeKeys.length) setNativeVisible(nativeKeys, action !== "hide");
      onSettingsChanged(payload);
      setError(null);
    } catch (err) {
      setError("保存失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const refreshModels = async () => {
    if (!selected || refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      if (selected.is_builtin) {
        onSettingsChanged(await fetchSettings(token));
        return;
      }
      const native = nativeFor(selected.name);
      if (native && nativeProgramAvailable(native)) {
        try {
          await developmentApi.probe(undefined, native.id);
          setNativeRefresh((value) => value + 1);
        } catch (cause) {
          setError("暂时无法刷新模型，请稍后重试。");
        }
      }
      if (!selected.configured || selected.model_discovery_supported === false) return;
      if (!isConcreteApiBase(selected.api_base)) {
        setError("请先填写有效的 API Base。");
        return;
      }
      const result = await fetchProviderModels(token, {
        provider: selected.name,
        apiBase: selected.api_base,
        ...(selected.is_custom ? { wireApi: customWireApi(selected.wire_api) } : {}),
      });
      if (result.error) throw new Error(result.error);
      const existingTypes = new Map(selected.models.map((model) => [model.id, rawMetadataFor(model).type]));
      const discovered: Array<{
        id: string;
        name?: string;
        type?: string | null;
        input_modalities?: string[] | null;
        context_window?: number | null;
        context_window_max?: number | null;
        opaque_model_id?: boolean;
        reasoning_efforts?: string[];
        default_reasoning_effort?: string | null;
        supports_adaptive_thinking?: boolean;
      }> = (result.model_details ?? (result.models ?? []).map((id) => ({ id, name: id, type: null })))
        .map((model) => {
          const raw = observedDiscovery(model);
          return { ...raw, type: existingTypes.get(model.id) ?? raw.type };
        });
      if (!discovered.length) return;
      const existingEnabled = selected.models.filter((model) => model.enabled).map((model) => model.id);
      const knownIds = new Set(selected.models.map((model) => model.id));
      const newChatModels = discovered
        .filter((model) => !knownIds.has(model.id) && (!model.type || isLanguageModel(model.type)))
        .map((model) => model.id);
      const payload = await updateProviderSettings(token, {
        provider: selected.name,
        discoveredModels: discovered.map((model) => discoveredUpdate(model.id, model)),
        enabledModels: [...new Set([...existingEnabled, ...newChatModels])],
      });
      onSettingsChanged(payload);
    } catch (err) {
      setError("暂时无法刷新模型，请稍后重试。");
    } finally {
      setRefreshing(false);
    }
  };

  const refreshNativeModels = async (executor: DevExecutor) => {
    if (refreshing) return;
    setRefreshing(true);
    setNativeError("");
    try {
      await developmentApi.probe(undefined, executor.id);
      setNativeRefresh((value) => value + 1);
    } catch {
      setNativeError("暂时无法刷新模型，请稍后重试。");
    } finally {
      setRefreshing(false);
    }
  };

  const updateNativeEnabled = async (executor: DevExecutor, enabled: boolean) => {
    if (!executorSettings || engineBusy) return;
    const current = executorSettings.enabledEngines
      ?? nativeExecutors.filter((item) => item.id !== "mona" && (item.enabled ?? item.available)).map((item) => item.id as NativeExecutorId);
    const next = new Set(current);
    if (enabled) next.add(executor.id as NativeExecutorId);
    else next.delete(executor.id as NativeExecutorId);
    setEngineBusy(executor.id as NativeExecutorId);
    setEngineError("");
    try {
      const saved = await developmentApi.updateExecutorSettings(executorSettings, {}, [...next]);
      setExecutorSettings(saved);
      developmentApi.refreshNativeProviders();
      setNativeRefresh((value) => value + 1);
    } catch {
      setNativeFailure(executor.id as NativeExecutorId);
      refreshNative();
    } finally {
      setEngineBusy(null);
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
      setError("保存失败，请稍后重试。");
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
      setError("删除失败，请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const normalizedModelQuery = modelQuery.trim().toLowerCase();
  const selectedImageProvider = settings.image_generation?.providers.find((provider) => provider.name === selected?.name);
  const selectedVideoProvider = settings.video_generation?.providers.find((provider) => provider.name === selected?.name);
  const chatModelIds = new Set(selected?.models.map((model) => model.id) ?? []);
  const isOfficial = selected ? ["openai", "anthropic"].includes(selected.name) : false;
  const unifiedModels = selected ? [
    ...(isOfficial && !selected.configured ? [] : selected.models),
    ...modelRowsFromIds(selected, [
      ...(isOfficial ? [] : selectedImageProvider?.image_models ?? []),
      ...(isOfficial ? [] : selectedVideoProvider?.video_models ?? []),
    ]).map((model) => ({ ...model, enabled: false,
      type: selectedImageProvider?.image_models?.includes(model.id) && !selectedVideoProvider?.video_models?.includes(model.id) ? "image"
        : selectedVideoProvider?.video_models?.includes(model.id) && !selectedImageProvider?.image_models?.includes(model.id) ? "video" : "other",
    })),
  ] : [];
  const visibleModels = unifiedModels.filter((model) => {
    const presentation = modelPresentation(model, { id: selected!.name, label: selected!.label });
    const capability = isLanguageModel(model.type, !selected!.is_custom) && chatModelIds.has(model.id) ? "chat" : modelTypeInfo(model.type).capability;
    return (modelFilter === "all" || capability === modelFilter)
      && `${presentation.name} ${presentation.brandLabel} ${model.name} ${model.id}`.toLowerCase().includes(normalizedModelQuery);
  });
  const modelGroups = new Map<string, { label: string; kind: string; models: typeof visibleModels }>();
  const namedModels = visibleModels.slice().sort((a, b) => modelPresentation(a, { id: selected!.name, label: selected!.label }).name
    .localeCompare(modelPresentation(b, { id: selected!.name, label: selected!.label }).name, undefined, { numeric: true }));
  const hiddenModels: typeof visibleModels = [];
  for (const model of managementView === "model" ? namedModels : visibleModels) {
    if (!isMonaManaged && chatModelIds.has(model.id) && isLanguageModel(model.type, !selected!.is_custom) && !model.enabled) {
      hiddenModels.push(model);
      continue;
    }
    const presentation = modelPresentation(model, { id: selected!.name, label: selected!.label });
    const capability = chatModelIds.has(model.id) && isLanguageModel(model.type, !selected!.is_custom) ? "chat" : modelTypeInfo(model.type).capability;
    const groupId = capability === "chat" && managementView === "brand" ? presentation.brandId : capability;
    const group = modelGroups.get(groupId);
    if (group) group.models.push(model);
    else modelGroups.set(groupId, { label: capability === "chat" && managementView === "brand" ? presentation.brandLabel : MODEL_TYPE_OPTIONS.find((option) => option.value === capability)!.label, kind: capability, models: [model] });
  }
  if (hiddenModels.length) modelGroups.set("hidden", { label: "未显示", kind: "hidden", models: hiddenModels });
  const kindOrder = [...MODEL_TYPE_OPTIONS.map((option) => option.value), "hidden"];
  const orderedModelGroups = [...modelGroups].sort(([, a], [, b]) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind));
  const nativeSource = nativeFor(selected?.name ?? "");
  const nativeSelectable = !!nativeSource && nativeProgramAvailable(nativeSource) && !!nativeConnected(selected?.name ?? "");
  const selectedModelCount = (selected?.configured ? selected.models.filter((model) => (isMonaManaged || model.enabled) && isLanguageModel(model.type, !selected.is_custom)).length : 0)
    + (nativeSelectable ? nativeSource?.models.filter((model) => model.id && !hiddenNative.includes(modelKey({ provider: `native:${nativeSource.id}`, model: model.id, executor: nativeSource.id }))).length ?? 0 : 0);
  const presentCapabilities = new Set(unifiedModels.map((model) => chatModelIds.has(model.id) && isLanguageModel(model.type, !selected?.is_custom)
    ? "chat" : modelTypeInfo(model.type).capability));
  if (nativeSource?.models.some((model) => model.id)) presentCapabilities.add("chat");
  const selectableModelCount = (nativeSelectable ? nativeSource?.models.filter((model) => model.id).length ?? 0 : 0)
    + unifiedModels.filter((model) => chatModelIds.has(model.id) && isLanguageModel(model.type, !selected?.is_custom)).length;
  const modelFilters = [["all", "全部"], ...MODEL_TYPE_OPTIONS.filter((option) => presentCapabilities.has(option.value))
    .map((option) => [option.value, option.value === "image" ? "图像" : option.label])];
  useEffect(() => {
    if (!modelFilters.some(([value]) => value === modelFilter)) setModelFilter("all");
  }, [modelFilters.map(([value]) => value).join(","), modelFilter]);
  const selectionAvailable = Boolean(selected?.configured || nativeSelectable);
  const selectedImageModel = selected && settings.image_generation?.provider === selected.name ? settings.image_generation.model : null;
  const selectedVideoModel = selected && settings.video_generation?.provider === selected.name ? settings.video_generation.model : null;
  const hasVisibleModels = visibleModels.length > 0;
  const visibleNative = !!nativeSource && nativeProgramAvailable(nativeSource) && nativeConnected(selected?.name ?? "")
    && (modelFilter === "all" || modelFilter === "chat") && nativeSource.models.some((model) => model.id && `${model.label} ${model.id}`.toLowerCase().includes(normalizedModelQuery));
  const availableToAdd = manageableProviders
    .filter((provider) => !provider.configured && !["openai", "anthropic"].includes(provider.name))
    .slice()
    .sort((a, b) => Number(primary(b.name)) - Number(primary(a.name)) || Number(b.region === "cn") - Number(a.region === "cn"))
    .filter((provider) => `${provider.label} ${provider.name}`.toLowerCase().includes(wizardQuery.trim().toLowerCase()));

  const renderNativeSetup = (executor?: DevExecutor) => {
    if (!executor || executor.id === "mona") return null;
    return <div className="p-5">
      <NativeProviderSetup key={executor.id} executor={executor} enabled={nativeEnabled(executor)}
        enableBusy={engineBusy === executor.id} enableAvailable={!!executorSettings}
        onEnabledChange={(enabled) => void updateNativeEnabled(executor, enabled)} onChanged={refreshNative} />
      {engineError && !nativeFailure && <div role="status" className="mt-3 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        暂时无法读取 {executorLabels[executor.id]} 使用设置，准备和认证仍可继续。
        <Button variant="ghost" size="sm" onClick={refreshNative}>重新读取设置</Button>
      </div>}
    </div>;
  };
  const renderSource = (id: string) => {
    const provider = configured.find((item) => item.name === id);
    const buddy = id === "native:codebuddy";
    if (!provider && !buddy) return null;
    const label = buddy ? "WorkBuddy" : provider!.label;
    const suggested = isSuggestedSource(id);
    const executor = nativeFor(id);
    const position = sortableSourceIds.indexOf(id);
    const active = buddy ? !!selectedCodebuddy : selected?.name === id;
    return <div key={id} data-provider-id={id} className="group relative mb-1" draggable={!suggested && sortableSourceIds.length > 1}
      onDragStart={(event) => event.dataTransfer.setData("application/mona-provider", id)}
      onDragOver={(event) => { if (!suggested && event.dataTransfer.types.includes("application/mona-provider")) event.preventDefault(); }}
      onDrop={(event) => {
        const source = event.dataTransfer.getData("application/mona-provider");
        if (suggested || !sortableSourceIds.includes(source) || source === id || isAccountSource(source) !== isAccountSource(id)) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        const remaining = sortableSourceIds.filter((value) => value !== source);
        const before = event.clientY > bounds.top + bounds.height / 2 ? remaining[remaining.indexOf(id) + 1] ?? null : id;
        moveSource(source, before);
      }}>
      {!suggested && sortableSourceIds.length > 1 && <button type="button" aria-label="调整顺序" aria-describedby={`source-name-${id}`}
        aria-keyshortcuts="ArrowUp ArrowDown" title="使用上下方向键调整顺序"
        className="absolute inset-y-0 left-0 my-auto flex h-8 w-4 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          if (event.key === "ArrowUp" && position > 0) moveSource(id, sortableSourceIds[position - 1]);
          if (event.key === "ArrowDown" && position < sortableSourceIds.length - 1) moveSource(id, sortableSourceIds[position + 2] ?? null);
        }}><GripVertical className="h-3 w-3" /></button>}
      <button type="button" aria-label={buddy ? "WorkBuddy 连接设置" : undefined} aria-current={active ? "true" : undefined}
        onClick={() => {
          setSelectedId(id); setModelQuery(""); setAdjustModels(false);
        }}
        className={cn("flex w-full items-center gap-2 rounded-xl py-2 pr-3 text-left transition-colors", suggested ? "pl-3" : "pl-4", active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm">{buddy ? <ProviderMark provider={id} label={label} /> : <ProviderIcon provider={provider!} size={22} />}</span>
        <span id={`source-name-${id}`} className="min-w-0 flex-1 truncate text-ui font-medium">{label}</span>
        {suggested && <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-micro text-muted-foreground">{executor && nativeProgramAvailable(executor) ? "待认证" : "待准备"}</span>}
      </button>
    </div>;
  };

  return (
    <div data-testid="model-provider-settings" className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-title-md font-semibold">模型来源</h2>
          <p className="text-caption text-muted-foreground">管理 API 供应商、本机订阅与账号中的模型。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {error ? <span className="text-caption text-destructive">{error}</span> : null}
          {onOpenJevSettings ? <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onOpenJevSettings}>决策模型</Button> : null}
          {onOpenTtsSettings ? <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onOpenTtsSettings}>语音合成</Button> : null}
        </div>
      </div>
      <div data-testid="model-provider-panel" className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm max-[760px]:min-h-[420px] max-[760px]:grid-cols-1">
        <aside className="flex min-h-0 flex-col border-r border-border/70 bg-muted/20 max-[760px]:max-h-56 max-[760px]:border-b max-[760px]:border-r-0">
          <div className="border-b border-border/60 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="搜索供应商" className="h-8 rounded-full pl-9 text-caption" />
            </div>
          </div>
          <div data-testid="provider-list-scroll" className="scrollbar-thin scrollbar-track-transparent min-h-0 flex-1 overflow-y-auto p-2">
            {apiSourceIds.length > 0 && <p className="px-3 pb-2 pt-1 text-micro text-muted-foreground">API 来源</p>}
            {apiSourceIds.map(renderSource)}
            {accountSourceIds.length > 0 && <p className="px-3 pb-2 pt-4 text-micro text-muted-foreground">订阅与账号</p>}
            {accountSourceIds.map(renderSource)}
            <span className="sr-only" aria-live="polite" aria-atomic="true">{orderAnnouncement}</span>
            {!visibleSourceIds.length && <p className="p-3 text-caption text-muted-foreground">没有匹配的供应商</p>}
          </div>
          <div className="border-t border-border/60 p-3">
            <Button type="button" variant="outline" className="w-full rounded-xl border-dashed" onClick={openWizard}>
              <Plus className="mr-1.5 h-4 w-4" /> 添加供应商
            </Button>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          {selectedCodebuddy ? <div className="scrollbar-thin scrollbar-track-transparent min-h-0 flex-1 overflow-y-auto">
            <header className="flex items-center gap-3 border-b border-border/70 p-5">
              <ProviderMark provider="native:codebuddy" label="WorkBuddy" className="h-9 w-9" />
              <div className="min-w-0 flex-1">
                <h3 className="text-title-sm font-semibold">WorkBuddy</h3>
                <p className="text-caption text-muted-foreground">
                  在 Mona 中使用 WorkBuddy 的订阅模型。
                  {selectedCodebuddy.probe?.authentication === "ready" ? "购买套餐时，请使用当前已连接的 WorkBuddy 账号。" : ""}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" className="shrink-0"
                onClick={() => void openCodeBuddyPricing()}>
                查看套餐
              </Button>
            </header>
            {renderNativeSetup(selectedCodebuddy)}
            {workbuddyAuthenticated ? <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2.5">
              <span className="text-caption font-medium">可用模型 {selectedCodebuddy.models.length}</span>
              <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => void refreshNativeModels(selectedCodebuddy)} disabled={refreshing || !nativeProgramAvailable(selectedCodebuddy)} title="刷新模型" aria-label="刷新模型">
                  {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><TooltipButton type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" title="筛选模型" aria-label="筛选模型"><Filter className="h-4 w-4" /></TooltipButton></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>排列</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={managementView} onValueChange={(value) => { if (value === "brand" || value === "model") setManagementView(value); }}>
                      <DropdownMenuRadioItem value="brand">按品牌分组</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="model">按名称排序</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>显示选择</DropdownMenuLabel>
                    {([ ["show", "全部显示"], ["hide", "全部隐藏"], ["reset", "重置显示偏好"] ] as const).map(([action, label]) => {
                      const keys = selectedCodebuddy.models.map((model) => modelKey({ provider: "native:codebuddy", model: model.id, executor: "codebuddy" }));
                      const visibleCount = keys.filter((key) => !hiddenNative.includes(key)).length;
                      return <DropdownMenuItem key={action} disabled={!nativeConnected("native:codebuddy") || !keys.length || (action === "show" && visibleCount === keys.length) || (action === "hide" && visibleCount === 0)} onSelect={() => setNativeVisible(keys, action !== "hide")}>{label}</DropdownMenuItem>;
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
                <div className="relative min-w-32 max-w-56 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" className="h-8 rounded-full pl-9 text-caption" />
                </div>
              </div>
            </div>
            <div data-testid="model-list-scroll" className="min-w-0 px-5 pb-5 pt-2">
              <ProviderNativeConnection executor={selectedCodebuddy} showControls={false} modelControl="checkbox" search={modelQuery} managementView={managementView} onChanged={refreshNative} />
              {nativeError && <p role="status" className="mt-3 text-caption text-muted-foreground">{nativeError}</p>}
            </div>
            </> : <div data-testid="model-list-scroll" className="border-t border-border/60 px-5 py-4">
              <h4 className="text-caption font-semibold">可用模型</h4>
              <p className="py-6 text-center text-caption text-muted-foreground">
                {nativeProgramAvailable(selectedCodebuddy) ? "认证完成后，自动显示可用模型" : "准备就绪后，这里会显示可用模型"}
              </p>
            </div>}
          </div> : selected ? (
            <div className={cn("flex min-h-0 flex-1 flex-col", nativeSource ? "scrollbar-thin scrollbar-track-transparent overflow-y-auto" : "overflow-hidden")}>
              <header className="flex items-center gap-3 border-b border-border/70 p-5">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white shadow-sm"><ProviderIcon provider={selected} size={30} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-title-sm font-semibold">{selected.label}</h3>
                    {selected.is_builtin ? <span className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">内置</span> : null}
                    {selected.name === "openai" ? <Badge variant="outline" className="min-w-0 max-w-[65%] truncate" title={formatNativePlan(accountUsage.usage?.planType)}>{formatNativePlan(accountUsage.usage?.planType)}</Badge> : null}
                  </div>
                  <p className="truncate text-caption text-muted-foreground">{selected.is_builtin ? (selected.configured ? "全部模型 · 按实际 Token 从 Mona AI 余额扣费" : "暂无可用模型") : selected.name === "openai" ? (accountUsage.usage?.email ? `ChatGPT 订阅 · Codex · ${accountUsage.usage.email}` : "ChatGPT 订阅 · Codex") : selected.name === "anthropic" ? "Claude Code 账号 · Anthropic 模型" : isConcreteApiBase(selected.api_base) ? selected.api_base : "请填写 API Base"}</p>
                </div>
                {!["openai", "anthropic"].includes(selected.name) && <span className={cn("flex shrink-0 items-center gap-1.5 text-caption", selected.configured || nativeConnected(selected.name) ? "text-success" : "text-muted-foreground")}><span className={cn("h-1.5 w-1.5 rounded-full", selected.configured || nativeConnected(selected.name) ? "bg-success" : "bg-muted-foreground/30")} />{nativeConnected(selected.name) ? "已连接" : selected.is_builtin ? selected.configured ? "可用" : "暂无模型" : selected.configured ? "已配置" : "未配置"}</span>}
                {!["openai", "anthropic"].includes(selected.name) && !selected.is_builtin ? <>
                  <Button type="button" variant="ghost" size="icon" onClick={openEditWizard} disabled={saving} title="编辑供应商" aria-label="编辑供应商"><Pencil className="h-4 w-4" /></Button>
                  <Button type="button" variant="ghost" size="icon" onClick={deleteSelected} disabled={saving} title="删除供应商" aria-label="删除供应商"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                </> : null}
              </header>
              {renderNativeSetup(nativeSource)}
              {isOfficial && <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-3">
                <div className="min-w-0 flex-1"><p className="text-ui font-medium">API 接入</p><p className="text-caption text-muted-foreground">使用 API Key 的模型由 Mona 调用。</p></div>
                <span className="text-caption text-muted-foreground">{selected.configured ? "已配置" : "未配置"}</span>
                <Button type="button" variant="outline" size="sm" onClick={openEditWizard} disabled={saving}>{selected.configured ? "编辑 API 配置" : "配置 API"}</Button>
              </div>}
              <div data-testid="model-list-scroll" className={nativeSource ? "min-w-0" : "scrollbar-thin scrollbar-track-transparent min-h-0 flex-1 overflow-y-auto"}>
              {selected.name === "openai" && accountUsage.usage?.connected && <NativeAccountQuota usage={accountUsage.usage} />}
              {selected.is_builtin && selected.configured ? (
                <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-caption text-muted-foreground">可用余额</p>
                    <p className="mt-0.5 text-xl font-semibold tabular-nums">{managedBalance === null ? "—" : `¥${formatBalanceAmount(managedBalance)}`}</p>
                  </div>
                  {onOpenUsage ? <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={onOpenUsage}>查看用量</Button> : null}
                  {onOpenBilling ? <Button type="button" size="sm" className="rounded-full" onClick={onOpenBilling}>余额充值</Button> : null}
                </div>
              ) : null}
              <div className={cn("z-10 flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-2.5", !nativeSource && "sticky top-0 bg-card")}>
                <span className="shrink-0 text-caption text-muted-foreground">{nativeSource ? `可用模型 ${(nativeProgramAvailable(nativeSource) && nativeConnected(selected.name) ? nativeSource.models.filter((model) => model.id).length : 0) + unifiedModels.length}` : isMonaManaged ? `可用模型 ${unifiedModels.length}` : `已选 ${selectedModelCount} 个模型`}</span>
                <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
                  {(selected.model_discovery_supported !== false || nativeSource) && <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={refreshModels} disabled={refreshing || saving || (!selected.configured && (!nativeSource || !nativeProgramAvailable(nativeSource)))} title="刷新模型" aria-label="刷新模型">
                    {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  </Button>}
                  <DropdownMenu>
                      <DropdownMenuTrigger asChild><TooltipButton type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-full" title="筛选模型" aria-label="筛选模型"><Filter className="h-4 w-4" /></TooltipButton></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>排列</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={managementView} onValueChange={(value) => { if (value === "brand" || value === "model") setManagementView(value); }}>
                          <DropdownMenuRadioItem value="brand">按品牌分组</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="model">按名称排序</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        {!isMonaManaged && <>
                          <DropdownMenuLabel>显示选择</DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => void toggleAllModels("show")} disabled={saving || !selectionAvailable || selectedModelCount === selectableModelCount}>全部显示</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void toggleAllModels("hide")} disabled={saving || !selectionAvailable || selectedModelCount === 0}>全部隐藏</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void toggleAllModels("reset")} disabled={saving || !selectionAvailable || !selectableModelCount}>重置显示偏好</DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>}
                        {(!nativeSource || unifiedModels.length > 0) && <DropdownMenuItem onSelect={() => setAdjustModels((value) => !value)}>分别调整{adjustModels && <Check className="ml-auto h-4 w-4" />}</DropdownMenuItem>}
                      </DropdownMenuContent>
                  </DropdownMenu>
                  {modelFilters.length > 2 && <Tabs value={modelFilter} onValueChange={setModelFilter}>
                    <TabsList className="h-8 rounded-full p-0.5" aria-label="模型分类">
                      {modelFilters.map(([value, label]) => <TabsTrigger key={value} value={value} className="rounded-full px-3 py-1">{label}</TabsTrigger>)}
                    </TabsList>
                  </Tabs>}
                  <div className="relative min-w-32 max-w-56 flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型" className="h-8 rounded-full pl-9 text-caption" />
                  </div>
                </div>
              </div>
              <div className="px-5 py-2">
                {(modelFilter === "all" || modelFilter === "chat") && nativeSource && nativeProgramAvailable(nativeSource) && nativeConnected(selected.name) && <ProviderNativeConnection key={selected.name} executor={nativeSource} showControls={false} modelControl="checkbox" search={modelQuery} managementView={managementView} onChanged={refreshNative} />}
                {nativeError && ["openai", "anthropic"].includes(selected.name) && <p role="status" className="px-3 py-2 text-caption text-muted-foreground">{nativeError}</p>}
                {hasVisibleModels ? (
                  <section>
                    {(isOfficial || nativeFor(selected.name)?.models.some((model) => model.id)) && <p className="px-3 pb-2 pt-4 text-caption text-muted-foreground">API 模型</p>}
                    {orderedModelGroups.map(([brandId, group]) => <div key={brandId} className="mb-4">
                      {group.label && <button type="button" className="flex h-8 w-full items-center gap-1.5 text-left text-caption text-muted-foreground hover:text-foreground" aria-expanded={!collapsedBrands.includes(brandId) || !!normalizedModelQuery} onClick={() => setCollapsedBrands((current) => current.includes(brandId) ? current.filter((id) => id !== brandId) : [...current, brandId])}>
                        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", collapsedBrands.includes(brandId) && !normalizedModelQuery && "-rotate-90")} />{group.label}<span className="tabular-nums">{group.models.length}</span>
                      </button>}
                      {(!collapsedBrands.includes(brandId) || !!normalizedModelQuery) && group.models.map((model) => {
                      const presentation = modelPresentation(model, { id: selected.name, label: selected.label });
                      const isChatModel = chatModelIds.has(model.id) && isLanguageModel(model.type, !selected.is_custom);
                      const typeInfo = modelTypeInfo(model.type || (isChatModel ? "chat" : undefined));
                      const showImageActions =
                        typeInfo.capability === "image"
                        && Boolean(onSelectImageModel || onOpenImageSettings);
                      const showVideoActions =
                        typeInfo.capability === "video"
                        && Boolean(onSelectVideoModel || onOpenVideoSettings);
                      const isDefaultChat = settings.agent.provider === selected.name && settings.agent.model === model.id;
                      const isDefaultImage = selectedImageModel === model.id;
                      const isDefaultVideo = selectedVideoModel === model.id;
                      const modelMeta = [
                        model.id !== model.name ? model.id : null,
                        model.context_window ? `${formatContextWindow(model.context_window)} ${model.context_window_source === "reference" ? "参考预算" : "上下文"}` : null,
                      ].filter(Boolean).join(" · ");
                      return (
                        <div key={model.id} className={cn("group flex min-h-10 items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/40", isChatModel && !selected.configured && "opacity-50")}>
                          {presentation.icon ? <img src={presentation.icon} alt="" className="h-5 w-5 shrink-0 opacity-60 dark:invert" /> : <span className="flex h-5 w-5 shrink-0 items-center justify-center opacity-60" aria-hidden><ProviderIcon provider={selected} size={20} /></span>}
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span className="truncate text-ui" title={model.id}>{presentation.name}</span>
                              {model.price_tier && <span className="text-micro text-muted-foreground">{model.price_tier}</span>}
                              {adjustModels && <Badge variant="outline">{typeInfo.label}</Badge>}
                              {adjustModels && model.recommended ? <Badge variant="secondary">推荐</Badge> : null}
                              {adjustModels && isDefaultChat ? <Badge variant="secondary">默认对话</Badge> : null}
                              {isDefaultImage ? <Badge variant="secondary" className="gap-1"><ImageIcon className="h-3.5 w-3.5" />默认图片</Badge> : null}
                              {isDefaultVideo ? <Badge variant="secondary" className="gap-1"><VideoIcon className="h-3.5 w-3.5" />默认视频</Badge> : null}
                            </div>
                            {adjustModels && modelMeta ? <p className="truncate font-mono text-micro text-muted-foreground">{modelMeta}</p> : null}
                          </div>
                          {adjustModels && isChatModel && (isMonaManaged || model.enabled) && !isDefaultChat && !isDefaultImage && !isDefaultVideo ? <Button type="button" variant="outline" size="sm" onClick={() => setDefault(model)} disabled={saving}>设为默认</Button> : null}
                          {!isChatModel || selected.configured ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon" className={cn("h-8 w-8 shrink-0 rounded-md", isChatModel && !adjustModels && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100")} disabled={saving} title="模型设置" aria-label={`设置 ${model.name}`}>
                                  <Settings2 className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-64">
                                <DropdownMenuLabel className="truncate" title={model.name}>{model.name}</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="font-normal text-muted-foreground">模型类型</DropdownMenuLabel>
                                {selected.is_builtin ? <p className="px-2 pb-2 text-caption text-muted-foreground">{typeInfo.label} · 由供应商提供</p> : (
                                  <DropdownMenuRadioGroup value={typeInfo.capability} onValueChange={(type) => void changeModelType(model, type)} aria-label={`${model.name} 模型类型`} className="grid grid-cols-2 gap-1">
                                    {MODEL_TYPE_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value} disabled={saving}>{option.label}</DropdownMenuRadioItem>)}
                                  </DropdownMenuRadioGroup>
                                )}
                                {(showImageActions || showVideoActions) && <DropdownMenuSeparator />}
                                {typeInfo.capability === "other" && <p className="px-2 py-2 text-caption text-muted-foreground">选择模型类型后显示对应设置。</p>}
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
                          {isChatModel && !isMonaManaged ? (
                            <Switch
                              checked={selected.configured && model.enabled}
                              onCheckedChange={() => void toggleModel(model)}
                              aria-label={`${model.name} ${model.enabled ? "不在对话中显示" : "在对话中显示"}`}
                              title={model.enabled ? "不在对话模型选择中显示" : "在对话模型选择中显示"}
                              disabled={saving || !selected.configured}
                            />
                          ) : null}
                        </div>
                      );
                    })}</div>)}
                  </section>
                ) : !visibleNative ? (
                  <p className="p-6 text-center text-caption text-muted-foreground">
                    {selected.is_builtin && !selected.configured ? "暂无可用模型" : nativeSource && !nativeConnected(selected.name) ? nativeProgramAvailable(nativeSource) ? "认证完成后，自动显示可用模型" : "准备就绪后，这里会显示可用模型" : "没有匹配的模型"}
                  </p>
                ) : null}
              </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
              <KeyRound className="h-8 w-8" />
              <p className="text-ui">添加供应商后管理模型</p>
            </div>
          )}
        </section>
      </div>

      {wizardOpen ? (
        <Dialog open={wizardOpen} onOpenChange={(open) => { if (!wizardLoading) setWizardOpen(open); }}>
          <DialogContent className="max-h-[85vh] max-w-2xl gap-5 overflow-y-auto rounded-2xl p-6">
            <DialogHeader><DialogTitle>{wizardCustom ? (wizardEditing ? "编辑自定义供应商" : "添加自定义供应商") : `${wizardEditing ? "编辑" : "添加"}${wizardProvider ? ` · ${wizardProvider.label}` : "供应商"}`}</DialogTitle><DialogDescription>{wizardStep === 1 ? "1 选择供应商" : wizardStep === 2 ? "✓ 选择供应商　2 连接" : "✓ 连接　3 选择模型"}</DialogDescription></DialogHeader>
            {wizardCustom ? wizardStep === 2 ? (
              <div className="space-y-4">
                <div><p className="text-ui font-medium">自定义端点</p><p className="text-caption text-muted-foreground">接入自定义模型服务</p></div>
                <label className="grid gap-1 text-caption">显示名称<Input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="例如：我的本地模型" /></label>
                <label className="grid gap-1 text-caption">API Base<Input value={customApiBase} onChange={(event) => changeCustomRoute(event.target.value)} placeholder="https://example.com/v1" aria-invalid={!!customBaseError} />{customBaseError && <span className="text-destructive">{customBaseError}</span>}</label>
                <label className="grid gap-1 text-caption">协议<Select aria-label="协议" value={customProtocol} onValueChange={changeCustomProtocol} options={[
                  { value: "auto", label: "自动" },
                  { value: "openai-completions", label: "OpenAI Chat Completions" },
                  { value: "openai-responses", label: "OpenAI Responses" },
                  { value: "anthropic-messages", label: "Anthropic Messages" },
                ]} /></label>
                <label className="grid gap-1 text-caption">API Key<Input type="password" value={customApiKey} onChange={(event) => setCustomApiKey(event.target.value)} placeholder={wizardEditing ? "已配置，留空保持不变" : "可选"} autoComplete="new-password" /></label>
                {wizardError ? <p className="text-caption text-destructive">{wizardError}</p> : null}
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => { customProbeRevision.current += 1; setWizardLoading(false); setWizardOpen(false); }}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><div className="flex gap-2"><Button type="button" variant="outline" onClick={openCustomModelsManually} disabled={wizardLoading}>手动添加模型</Button><Button type="button" onClick={loadCustomModels} disabled={wizardLoading}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}拉取模型列表</Button></div></div>
              </div>
            ) : (
              <div className="space-y-4">
                 <div><p className="text-ui font-medium">选择对话模型</p><p className="text-caption text-muted-foreground">类型识别有误时，可在模型右侧修改；图片和视频模型可在供应商详情中分别选择。</p></div>
                {wizardError ? <p className="rounded-lg bg-destructive/10 p-2 text-caption text-destructive">{wizardError}</p> : null}
                <div className={cn("space-y-1 overflow-y-auto rounded-xl border p-2", customExpandedModel ? "max-h-80" : "max-h-48")}>
                  {customCandidates.map((model) => {
                    const expanded = customExpandedModel === model.id;
                    const draft = customOverrideDrafts[model.id] ?? modelOverrideDraft();
                    const errors = { ...parseModelOverride(draft, knownCustomEfforts(model.id)).errors, ...customOverrideErrors[model.id] };
                    return <div key={model.id} className="rounded-lg hover:bg-accent">
                      <div className="flex items-center gap-2 px-2 py-2 text-ui">
                        <label className="flex min-w-0 flex-1 items-center gap-2">
                          <input type="checkbox" checked={customSelectedModels.includes(model.id)} onChange={() => setCustomSelectedModels((current) => current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id])} />
                          <span className="min-w-0 flex-1 truncate">{model.name}</span>
                          {adjustModels && model.recommended ? <span className="text-[11px] text-emerald-600">推荐</span> : null}
                        </label>
                        {isLanguageModel(model.type, false) && <Button type="button" variant="ghost" size="sm" aria-label={`${model.name} 能力设置`}
                          aria-expanded={expanded} onClick={() => setCustomExpandedModel(expanded ? null : model.id)}>能力设置</Button>}
                        <Select aria-label={`${model.name} 模型类型`} value={modelTypeInfo(model.type).capability} options={MODEL_TYPE_OPTIONS}
                          onValueChange={(type) => {
                            setCustomModelTypes((current) => ({ ...current, [model.id]: type }));
                            setCustomDiscoveredMetadata((current) => ({ ...current, [model.id]: { ...current[model.id], type } }));
                            if (!isLanguageModel(type)) setCustomExpandedModel(null);
                          }} className="h-8 w-24 text-caption" />
                      </div>
                      {expanded && isLanguageModel(model.type, false) && <ModelOverrideEditor name={model.name} draft={draft} errors={errors}
                        onChange={(value) => changeCustomOverride(model.id, value)} />}
                    </div>;
                  })}
                </div>
                <div className="flex gap-2"><Input value={customManualModel} onChange={(event) => setCustomManualModel(event.target.value)} placeholder="手动添加模型 ID（逗号分隔）" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomManualModel(); } }} /><Button type="button" variant="outline" onClick={addCustomManualModel}>添加</Button></div>
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setWizardStep(2)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={finishCustomWizard} disabled={wizardLoading || customModels.length === 0}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}完成</Button></div>
              </div>
            ) : wizardStep === 1 ? (
              <div className="space-y-3">
                <Input value={wizardQuery} onChange={(event) => setWizardQuery(event.target.value)} placeholder="搜索供应商" className="h-8 rounded-full" />
                <div className="max-h-[55vh] space-y-1 overflow-y-auto">
                  {availableToAdd.map((provider) => <button key={provider.name} type="button" onClick={() => chooseWizardProvider(provider)} className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-accent"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white shadow-sm"><ProviderIcon provider={provider} size={24} /></span><span className="min-w-0 flex-1 truncate text-ui">{provider.label}</span>{provider.region === "cn" ? <span className="text-[11px] text-muted-foreground">中国大陆</span> : null}</button>)}
                </div>
                <button type="button" onClick={openCustomWizard} className="flex w-full items-center gap-2.5 rounded-xl border border-dashed p-3 text-left hover:bg-accent"><Plus className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-ui font-medium">自定义端点</span><span className="block text-caption text-muted-foreground">接入自定义模型服务</span></span></button>
                <p className="text-[11px] text-muted-foreground">鉴权方式由供应商定义决定；基础 URL 由你自行填写。</p>
              </div>
            ) : wizardStep === 2 && wizardProvider ? (
              <div className="space-y-4">
                <div><p className="text-ui font-medium">{wizardProvider.label}</p><p className="text-caption text-muted-foreground">配置凭据和 API Base</p></div>
                {wizardProvider.auth_method === "aws" && <p className="text-caption text-muted-foreground">可使用本机 AWS 凭据，也可填写 Bedrock API Key。</p>}
                {wizardProvider.auth_method === "google-adc" && <p className="text-caption text-muted-foreground">使用 Google 应用默认凭据，请填写项目和区域对应的地址。</p>}
                {wizardProvider.auth_method === "github-copilot" && <div className="space-y-2 text-caption">
                  <p className="text-muted-foreground">使用 GitHub Copilot 账号的设备授权。</p>
                  {githubChecking && <p role="status" className="text-muted-foreground">正在检查登录状态…</p>}
                  {githubLogin.status === "authorized" ? <p>已登录 GitHub</p> : <>
                    <Button type="button" variant="outline" size="sm" onClick={() => void changeGitHubLogin("start")}
                      disabled={githubChecking || githubActionPending || githubLogin.status === "starting" || githubLogin.status === "waiting"}>登录 GitHub</Button>
                    {githubLogin.status === "starting" && <p role="status" className="text-muted-foreground">正在获取登录验证码…</p>}
                    {githubLogin.status === "waiting" && <div className="space-y-2">
                      {githubLogin.user_code && <p>验证码：<span className="select-text font-mono">{githubLogin.user_code}</span></p>}
                      {trustedGitHubDeviceUrl(githubLogin.verification_url)
                        ? <Button type="button" variant="outline" size="sm" onClick={() => void openGitHubDevicePage()}>打开 GitHub 授权页面</Button>
                        : <p className="text-muted-foreground">无法识别授权页面，请取消后重试。</p>}
                    </div>}
                    {(githubLogin.status === "starting" || githubLogin.status === "waiting") && <Button type="button" variant="ghost" size="sm" disabled={githubActionPending} onClick={() => void changeGitHubLogin("cancel")}>取消登录</Button>}
                  </>}
                </div>}
                {wizardProvider.auth_method !== "google-adc" && wizardProvider.auth_method !== "github-copilot" && <label className="grid gap-1 text-caption">{wizardProvider.auth_method === "aws" ? "Bedrock API Key" : "API Key"}<Input type="password" value={wizardApiKey} onChange={(event) => setWizardApiKey(event.target.value)} placeholder={wizardEditing && wizardProvider.api_key_hint ? `已配置 ${wizardProvider.api_key_hint}，留空保持不变` : wizardProvider.api_key_required ? "请输入 API Key" : "可选"} autoComplete="new-password" /></label>}
                <label className="grid gap-1 text-caption">API Base<Input value={wizardApiBase} onChange={(event) => changeWizardRoute(event.target.value)} readOnly={!wizardProvider.api_base_editable} placeholder={wizardProvider.api_base_editable ? "请输入 API Base" : undefined} aria-invalid={!!wizardBaseError} />{wizardBaseError && <span className="text-destructive">{wizardBaseError}</span>}</label>
                {wizardProvider.wire_api === "azure-openai-responses" && <p className="text-caption text-muted-foreground">模型名称请填写 Azure 部署名称。</p>}
                {wizardError ? <p className="text-caption text-destructive">{wizardError}</p> : null}
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => { wizardProbeRevision.current += 1; setWizardLoading(false); if (wizardEditing) setWizardOpen(false); else setWizardStep(1); }}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><div className="flex gap-2"><Button type="button" variant="outline" onClick={openWizardModelsManually} disabled={wizardLoading}>{wizardProvider.catalog_candidates?.length ? "选择模型" : "手动添加模型"}</Button>{wizardProvider.model_discovery_supported !== false && <Button type="button" onClick={loadWizardModels} disabled={wizardLoading || (wizardProvider.api_key_required && !wizardApiKey.trim() && !(wizardEditing && wizardProvider.api_key_hint))}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}拉取模型</Button>}</div></div>
              </div>
            ) : wizardProvider ? (
              <div className="space-y-4">
                 <p className="text-ui font-medium">{wizardProvider.catalog_candidates?.length ? "选择模型；目录候选是否可用取决于账号权限。" : "选择可用模型；类型识别有误时可在右侧修改"}</p>
                {wizardProvider.wire_api === "azure-openai-responses" && <p className="text-caption text-muted-foreground">请使用 Azure 部署名称；目录候选需与部署名称一致。</p>}
                {wizardError ? <p className="rounded-lg bg-destructive/10 p-2 text-caption text-destructive">{wizardError}</p> : null}
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2">{wizardCandidates.map((model) => <div key={model.id} className="flex items-center gap-2 rounded-lg px-2 py-2 text-ui hover:bg-accent"><label className="flex min-w-0 flex-1 items-center gap-2"><input type="checkbox" checked={wizardSelectedModels.includes(model.id)} onChange={() => setWizardSelectedModels((current) => current.includes(model.id) ? current.filter((id) => id !== model.id) : [...current, model.id])} /><span className="min-w-0 flex-1 truncate">{model.name}</span>{adjustModels && model.recommended ? <span className="text-[11px] text-emerald-600">推荐</span> : null}</label><Select aria-label={`${model.name} 模型类型`} value={modelTypeInfo(model.type).capability} options={MODEL_TYPE_OPTIONS} onValueChange={(type) => {
                  setWizardModelTypes((current) => ({ ...current, [model.id]: type }));
                  setWizardDiscoveredMetadata((current) => ({ ...current, [model.id]: { ...current[model.id], type } }));
                }} className="h-8 w-24 text-caption" /></div>)}</div>
                <div className="flex gap-2"><Input value={wizardManualModel} onChange={(event) => setWizardManualModel(event.target.value)} placeholder="手动添加模型 ID（逗号分隔）" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualModel(); } }} /><Button type="button" variant="outline" onClick={addManualModel}>添加</Button></div>
                <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setWizardStep(2)}><ChevronLeft className="mr-1 h-4 w-4" />返回</Button><Button type="button" onClick={finishWizard} disabled={wizardLoading || wizardSelectedModels.length === 0}>{wizardLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}完成</Button></div>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
      <AlertDialog open={!!githubError} onOpenChange={(open) => { if (!open) setGithubError(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>GitHub 登录操作失败</AlertDialogTitle><AlertDialogDescription>{githubError}</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>知道了</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!nativeFailure} onOpenChange={(open) => { if (!open) setNativeFailure(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{nativeFailure ? executorLabels[nativeFailure] : "引擎"} 使用状态未能确认</AlertDialogTitle>
            <AlertDialogDescription>更新请求未获得确认，正在重新读取状态。请稍后核对开关的当前状态，再决定是否重试。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>知道了</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={pricingError} onOpenChange={(open) => { if (!open) setPricingError(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>套餐页面打不开</AlertDialogTitle>
            <AlertDialogDescription>无法打开 WorkBuddy 套餐页面，请稍后重试。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>关闭</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setPricingError(false); void openCodeBuddyPricing(); }}>重试</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
