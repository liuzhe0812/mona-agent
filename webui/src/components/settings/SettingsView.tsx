import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  BarChart3,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Cloud,
  Cpu,
  Database,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FolderOpen,
  Gem,
  Copy,
  Grid3X3,
  GripVertical,
  Hexagon,
  ImageIcon,
  Info,
  Keyboard,
  Layers,
  Loader2,
  Moon,
  Orbit,
  Palette,
  Pencil,
  Plug,
  Plus,
  QrCode,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Star,
  Triangle,
  Trash2,
  WalletCards,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MODULE_ICONS } from "@/components/shell/AppRail";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useLicense } from "@/hooks/useLicense";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  cancelWeixinLogin,
  fetchProviderModels,
  fetchSettings,
  getWeixinLoginStatus,
  logoutWeixin,
  startWeixinLogin,
  updateChannelSettings,
  updateImageGenerationSettings,
  updateProviderSettings,
  updateSettings,
  updateTtsSettings,
  updateVideoGenerationSettings,
  updateWebSearchSettings,
} from "@/lib/api";
import { EDGE_TTS_VOICES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  MODULE_DEFS,
  DEFAULT_SIDEBAR_MODULES,
  mergeSidebarModules,
} from "@/components/Sidebar";
import {
  isTauri,
  getDesktopSettings,
  updateDesktopSettings,
  checkForUpdates,
  performUpdate,
  getAgentSearchScope,
  setAgentSearchScope,
  loadDesktopNotesState,
  SEND_MESSAGE_SHORTCUT_EVENT,
  type UpdateCheckResult,
  type UpdateProgress,
  type DesktopAppSettings,
  type SidebarShortcuts,
  type SidebarModuleConfig,
  type AgentSearchScope,
  type SendMessageShortcut,
} from "@/lib/tauri";
import { listAccounts, getFolders } from "@/components/email/lib/emailApi";
import type { EmailAccount, EmailFolder } from "@/components/email/lib/types";
import { getFolderDisplayName } from "@/components/email/lib/folderUtils";
import { useClientOptional } from "@/providers/ClientProvider";
import type {
  ChannelInfo,
  ImageGenerationSettingsUpdate,
  SettingsPayload,
  TtsSettingsUpdate,
  VideoGenerationSettingsUpdate,
  WebSearchSettingsUpdate,
  WeixinLoginStatus,
} from "@/lib/types";
import { SkillManagementPanel } from "@/components/settings/SkillManagementPanel";
import { McpManagementPanel } from "@/components/settings/McpManagementPanel";
import { ChatProvidersSettings } from "@/components/settings/ChatProvidersSettings";
import { AccountSettings } from "@/components/settings/AccountSettings";
import { CreditsView } from "@/components/CreditsView";
import { UsageSettings } from "@/components/settings/UsageSettings";
import { ManagedRuntimeSettings } from "@/components/settings/ManagedRuntimeSettings";
import { AutomationSettings } from "@/components/settings/AutomationSettings";
import { SubsectionLabel } from "@/components/ui/page-header";
import { StatusNotice } from "@/components/ui/status-notice";
import { Switch } from "@/components/ui/switch";

type SettingsSectionKey =
  | "billing"
  | "usage"
  | "appearance"
  | "models_providers"
  | "image"
  | "general"
  | "resources"
  | "channels"
  | "shortcuts"
  | "skills"
  | "mcp"
  | "about";

interface AgentSettingsDraft {
  model: string;
  provider: string;
  modelPreset: string;
  timezone: string;
  toolHintMaxLength: number;
  workspace: string;
}

type PendingRestartSection = "runtime" | "web" | "providers" | "channels";
type PendingRestartSections = Record<PendingRestartSection, boolean>;

const LOCAL_UNCONFIGURED_PROVIDER_ORDER = new Map(
  ["vllm", "ollama", "lm_studio", "atomic_chat", "ovms"].map((name, index) => [
    name,
    index,
  ]),
);

const IMAGE_ASPECT_RATIO_OPTIONS = ["1:1", "3:4", "9:16", "4:3", "16:9", "3:2", "2:3", "21:9"];
const IMAGE_SIZE_OPTIONS = ["1K", "2K", "4K", "1024x1024", "1536x1024", "1024x1536"];
const VIDEO_ASPECT_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const VIDEO_DURATION_OPTIONS = [3, 5, 10, 18];
const EMPTY_PENDING_RESTART_SECTIONS: PendingRestartSections = {
  runtime: false,
  web: false,
  providers: false,
  channels: false,
};

interface SettingsViewProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onBackToChat: () => void;
  onModelNameChange: (modelName: string | null) => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  initialSection?: string;
  onTriggerAgent?: (prompt: string) => void;
  onOpenLogin?: () => void;
  onOpenSubscribe?: () => void;
  onChangePassword?: () => void;
}

function modelPresetValue(payload: SettingsPayload): string {
  return payload.agent.model_preset || "default";
}

function defaultPreset(payload: SettingsPayload): SettingsPayload["model_presets"][number] | null {
  return payload.model_presets.find((preset) => preset.is_default) ?? null;
}

function editableDefaultProvider(payload: SettingsPayload): string {
  const base = defaultPreset(payload);
  return base?.provider ?? payload.agent.provider ?? payload.agent.resolved_provider ?? "";
}

export function SettingsView({
  theme,
  onToggleTheme,
  onBackToChat,
  onModelNameChange,
  onRestart,
  isRestarting = false,
  initialSection,
  onOpenLogin,
  onOpenSubscribe,
  onChangePassword,
}: SettingsViewProps) {
  const { t } = useTranslation();
  const { token } = useClientOptional();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [webSearchSaving, setWebSearchSaving] = useState(false);
  const [imageGenerationSaving, setImageGenerationSaving] = useState(false);
  const [videoGenerationSaving, setVideoGenerationSaving] = useState(false);
  const [imageApiKeyDraft, setImageApiKeyDraft] = useState("");
  const [imageKeyVisible, setImageKeyVisible] = useState(false);
  const [videoApiKeyDraft, setVideoApiKeyDraft] = useState("");
  const [videoKeyVisible, setVideoKeyVisible] = useState(false);
  const [, setHighlightProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>(
    initialSection === "account" || initialSection === "web" || initialSection === "runtime" || initialSection === "desktop"
      ? "general"
      : (initialSection as SettingsSectionKey | undefined) ?? "general",
  );
  const [pendingRestartSections, setPendingRestartSections] = useState<PendingRestartSections>(
    EMPTY_PENDING_RESTART_SECTIONS,
  );
  const [webSearchForm, setWebSearchForm] = useState<WebSearchSettingsUpdate>({
    provider: "duckduckgo",
    apiKey: "",
    baseUrl: "",
    maxResults: 5,
    timeout: 30,
    useJinaReader: true,
  });
  const [imageGenerationForm, setImageGenerationForm] = useState<ImageGenerationSettingsUpdate>({
    enabled: false,
    provider: "openrouter",
    model: "openai/gpt-5.4-image-2",
    defaultAspectRatio: "1:1",
    defaultImageSize: "1K",
    maxImagesPerTurn: 4,
  });
  const [videoGenerationForm, setVideoGenerationForm] = useState<VideoGenerationSettingsUpdate>({
    enabled: false,
    provider: "agnes",
    model: "agnes-video-v2.0",
    defaultAspectRatio: "16:9",
    defaultDuration: 5,
  });
  const [ttsForm, setTtsForm] = useState<TtsSettingsUpdate>({
    provider: "edge",
    voice: "",
    apiBase: "",
    model: "",
  });
  const [ttsSaving, setTtsSaving] = useState(false);
  const [ttsApiKeyDraft, setTtsApiKeyDraft] = useState("");
  const [ttsKeyVisible, setTtsKeyVisible] = useState(false);
  const [webSearchKeyVisible, setWebSearchKeyVisible] = useState(false);
  const [webSearchKeyEditing, setWebSearchKeyEditing] = useState(false);
  const [form, setForm] = useState<AgentSettingsDraft>({
    model: "",
    provider: "",
    modelPreset: "default",
    timezone: "UTC",
    toolHintMaxLength: 40,
    workspace: "",
  });

  const applyPayload = useCallback((payload: SettingsPayload) => {
    const fallbackDefault = defaultPreset(payload);
    setSettings(payload);
    setForm({
      model: fallbackDefault?.model ?? payload.agent.model,
      provider: editableDefaultProvider(payload),
      modelPreset: modelPresetValue(payload),
      timezone: payload.agent.timezone,
      toolHintMaxLength: payload.agent.tool_hint_max_length,
      workspace: payload.runtime.workspace_path,
    });
    setWebSearchForm((prev) => ({
      provider: payload.web_search.provider,
      apiKey: prev.provider === payload.web_search.provider ? prev.apiKey ?? "" : "",
      baseUrl: payload.web_search.base_url ?? "",
      maxResults: payload.web_search.max_results,
      timeout: payload.web_search.timeout,
      useJinaReader: payload.web.fetch.use_jina_reader,
    }));
    setImageGenerationForm({
      enabled: payload.image_generation.enabled,
      provider: payload.image_generation.provider,
      model: payload.image_generation.model,
      defaultAspectRatio: payload.image_generation.default_aspect_ratio,
      defaultImageSize: payload.image_generation.default_image_size,
      maxImagesPerTurn: payload.image_generation.max_images_per_turn,
    });
    setVideoGenerationForm({
      enabled: payload.video_generation.enabled,
      provider: payload.video_generation.provider,
      model: payload.video_generation.model,
      defaultAspectRatio: payload.video_generation.default_aspect_ratio,
      defaultDuration: payload.video_generation.default_duration,
    });
    setTtsForm({
      provider: payload.tts.provider,
      voice: payload.tts.voice,
      apiBase: payload.tts.api_base ?? "",
      model: payload.tts.model ?? "",
    });
    setImageApiKeyDraft("");
    setVideoApiKeyDraft("");
    setTtsApiKeyDraft("");
    if (payload.restart_required_sections) {
      setPendingRestartSections({
        runtime: payload.restart_required_sections.includes("runtime"),
        web: payload.restart_required_sections.includes("web"),
        providers: payload.restart_required_sections.includes("providers"),
        channels: payload.restart_required_sections.includes("channels"),
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSettings(token)
      .then((payload) => {
        if (!cancelled) {
          applyPayload(payload);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyPayload, token]);

  const runtimeDirty = useMemo(() => {
    if (!settings) return false;
    return (
      form.timezone !== settings.agent.timezone ||
      form.toolHintMaxLength !== settings.agent.tool_hint_max_length ||
      form.workspace !== settings.runtime.workspace_path
    );
  }, [form, settings]);

  const imageGenerationDirty = useMemo(() => {
    if (!settings) return false;
    const formDirty =
      imageGenerationForm.enabled !== settings.image_generation.enabled ||
      imageGenerationForm.provider !== settings.image_generation.provider ||
      imageGenerationForm.model !== settings.image_generation.model ||
      imageGenerationForm.defaultAspectRatio !== settings.image_generation.default_aspect_ratio ||
      imageGenerationForm.defaultImageSize !== settings.image_generation.default_image_size ||
      imageGenerationForm.maxImagesPerTurn !== settings.image_generation.max_images_per_turn;
    return formDirty || imageApiKeyDraft.trim().length > 0;
  }, [imageGenerationForm, settings, imageApiKeyDraft]);

  const videoGenerationDirty = useMemo(() => {
    if (!settings) return false;
    const formDirty =
      videoGenerationForm.enabled !== settings.video_generation.enabled ||
      videoGenerationForm.provider !== settings.video_generation.provider ||
      videoGenerationForm.model !== settings.video_generation.model ||
      videoGenerationForm.defaultAspectRatio !== settings.video_generation.default_aspect_ratio ||
      videoGenerationForm.defaultDuration !== settings.video_generation.default_duration;
    return formDirty || videoApiKeyDraft.trim().length > 0;
  }, [videoGenerationForm, settings, videoApiKeyDraft]);

  const ttsDirty = useMemo(() => {
    if (!settings) return false;
    const formDirty =
      (ttsForm.provider ?? "edge") !== settings.tts.provider ||
      (ttsForm.voice ?? "") !== settings.tts.voice ||
      (ttsForm.apiBase ?? "") !== (settings.tts.api_base ?? "") ||
      (ttsForm.model ?? "") !== (settings.tts.model ?? "");
    return formDirty || ttsApiKeyDraft.trim().length > 0;
  }, [ttsForm, settings, ttsApiKeyDraft]);

  const saveRuntimeSettings = async () => {
    if (!settings || !runtimeDirty || saving) return;
    setSaving(true);
    try {
      const payload = await updateSettings(token, {
        timezone: form.timezone,
        toolHintMaxLength: form.toolHintMaxLength,
        workspace: form.workspace,
      });
      setSettings(payload);
      setForm((prev) => ({
        ...prev,
        timezone: payload.agent.timezone,
        toolHintMaxLength: payload.agent.tool_hint_max_length,
        workspace: payload.runtime.workspace_path,
      }));
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, runtime: true }));
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveImageGenerationSettings = async (
    override?: ImageGenerationSettingsUpdate,
    force = false,
    includeKeyDraft = true,
  ) => {
    if (!settings || (!force && !imageGenerationDirty) || imageGenerationSaving) return;
    const nextForm = override ?? imageGenerationForm;
    setImageGenerationSaving(true);
    try {
      const keyDraft = includeKeyDraft ? imageApiKeyDraft.trim() : "";
      if (keyDraft) {
        const providerPayload = await updateProviderSettings(token, {
          provider: nextForm.provider,
          apiKey: keyDraft,
        });
        applyPayload(providerPayload);
      }
      const payload = await updateImageGenerationSettings(token, nextForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, providers: true }));
      }
      setImageApiKeyDraft("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImageGenerationSaving(false);
    }
  };

  const saveVideoGenerationSettings = async (
    override?: VideoGenerationSettingsUpdate,
    force = false,
    includeKeyDraft = true,
  ) => {
    if (!settings || (!force && !videoGenerationDirty) || videoGenerationSaving) return;
    const nextForm = override ?? videoGenerationForm;
    setVideoGenerationSaving(true);
    try {
      const keyDraft = includeKeyDraft ? videoApiKeyDraft.trim() : "";
      if (keyDraft) {
        const providerPayload = await updateProviderSettings(token, {
          provider: nextForm.provider,
          apiKey: keyDraft,
        });
        applyPayload(providerPayload);
      }
      const payload = await updateVideoGenerationSettings(token, nextForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, providers: true }));
      }
      setVideoApiKeyDraft("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setVideoGenerationSaving(false);
    }
  };

  const saveTtsSettings = async () => {
    if (!settings || !ttsDirty || ttsSaving) return;
    setTtsSaving(true);
    try {
      const payload = await updateTtsSettings(token, {
        provider: ttsForm.provider,
        voice: ttsForm.voice?.trim() ?? "",
        apiBase: ttsForm.apiBase?.trim() ?? "",
        model: ttsForm.model?.trim() ?? "",
        apiKey: ttsApiKeyDraft.trim() || undefined,
      });
      applyPayload(payload);
      setTtsApiKeyDraft("");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTtsSaving(false);
    }
  };

  const saveWebSearch = async () => {
    if (!settings || webSearchSaving) return;
    const provider = settings.web_search.providers.find((item) => item.name === webSearchForm.provider);
    if (!provider) return;
    const apiKey = webSearchForm.apiKey?.trim() ?? "";
    const baseUrl = webSearchForm.baseUrl?.trim() ?? "";
    const hasExistingSecret =
      provider.credential === "api_key" &&
      webSearchForm.provider === settings.web_search.provider &&
      !!settings.web_search.api_key_hint;

    if (provider.credential === "api_key" && !apiKey && !hasExistingSecret) {
      setError(t("settings.byok.webSearch.apiKeyRequired"));
      return;
    }
    if (provider.credential === "base_url" && !baseUrl) {
      setError(t("settings.byok.webSearch.baseUrlRequired"));
      return;
    }

    setWebSearchSaving(true);
    try {
      const webFetchRestartRequired =
        (webSearchForm.useJinaReader ?? settings.web.fetch.use_jina_reader) !==
        settings.web.fetch.use_jina_reader;
      const update: WebSearchSettingsUpdate = {
        provider: webSearchForm.provider,
        maxResults: webSearchForm.maxResults,
        timeout: webSearchForm.timeout,
        useJinaReader: webSearchForm.useJinaReader,
      };
      if (provider.credential === "api_key" && apiKey) update.apiKey = apiKey;
      if (provider.credential === "base_url") update.baseUrl = baseUrl;
      const payload = await updateWebSearchSettings(token, update);
      setSettings(payload);
      if (payload.requires_restart || webFetchRestartRequired) {
        setPendingRestartSections((prev) => ({ ...prev, web: true }));
      }
      setWebSearchForm((prev) => ({
        provider: payload.web_search.provider,
        apiKey: "",
        baseUrl: payload.web_search.base_url ?? prev.baseUrl ?? "",
        maxResults: payload.web_search.max_results,
        timeout: payload.web_search.timeout,
        useJinaReader: payload.web.fetch.use_jina_reader,
      }));
      setWebSearchKeyVisible(false);
      setWebSearchKeyEditing(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWebSearchSaving(false);
    }
  };

  const resetWebSearchDraft = useCallback(() => {
    if (!settings) return;
    setWebSearchForm({
      provider: settings.web_search.provider,
      apiKey: "",
      baseUrl: settings.web_search.base_url ?? "",
      maxResults: settings.web_search.max_results,
      timeout: settings.web_search.timeout,
      useJinaReader: settings.web.fetch.use_jina_reader,
    });
    setWebSearchKeyVisible(false);
    setWebSearchKeyEditing(false);
  }, [settings]);

  const handleWebSearchProviderChange = useCallback((provider: string) => {
    if (!settings) return;
    setWebSearchForm((prev) => ({
      provider,
      apiKey: "",
      baseUrl: provider === settings.web_search.provider ? settings.web_search.base_url ?? "" : "",
      maxResults: prev.maxResults ?? settings.web_search.max_results,
      timeout: prev.timeout ?? settings.web_search.timeout,
      useJinaReader: prev.useJinaReader ?? settings.web.fetch.use_jina_reader,
    }));
    setWebSearchKeyVisible(false);
    setWebSearchKeyEditing(false);
  }, [settings]);

  const renderSection = () => {
    if (activeSection === "general") {
      return (
        <div className="space-y-10">
          <AccountSettings
            onOpenLogin={onOpenLogin}
            onManageSubscription={onOpenSubscribe}
            onOpenBilling={() => setActiveSection("billing")}
            onChangePassword={onChangePassword}
          />
          {loading && !settings ? (
            <div className="flex h-32 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.status.loading")}
            </div>
          ) : null}
          {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
          {settings ? (
            <>
              <WebSettings
                settings={settings}
                form={webSearchForm}
                keyVisible={webSearchKeyVisible}
                keyEditing={webSearchKeyEditing}
                saving={webSearchSaving}
                onChangeForm={setWebSearchForm}
                onChangeProvider={handleWebSearchProviderChange}
                onToggleKey={() => setWebSearchKeyVisible((visible) => !visible)}
                onToggleKeyEditing={() => {
                  setWebSearchKeyEditing((editing) => !editing);
                  setWebSearchKeyVisible(false);
                  setWebSearchForm((prev) => ({ ...prev, apiKey: "" }));
                }}
                onReset={resetWebSearchDraft}
                onSave={saveWebSearch}
                onRestart={onRestart}
                isRestarting={isRestarting}
                requiresRestartPending={pendingRestartSections.web}
              />
              <RuntimeSettings
                form={form}
                setForm={setForm}
                dirty={runtimeDirty}
                saving={saving}
                onSave={saveRuntimeSettings}
                onRestart={onRestart}
                isRestarting={isRestarting}
                requiresRestartPending={pendingRestartSections.runtime}
              />
              {isTauri() ? <DesktopSettings token={token} /> : null}
              {isTauri() ? <AgentScopeSettings /> : null}
            </>
          ) : null}
        </div>
      );
    }
    if (activeSection === "billing") {
      return <CreditsView />;
    }
    if (activeSection === "usage") {
      return <UsageSettings />;
    }
    if (activeSection === "resources") {
      return <ManagedRuntimeSettings token={token} />;
    }
    if (!settings) return null;
    switch (activeSection) {
      case "appearance":
        return (
          <AppearanceSettings
            theme={theme}
            onToggleTheme={onToggleTheme}
          />
        );
      case "models_providers":
        return (
          <AiModelsSettings
            settings={settings}
            token={token}
            onSettingsChanged={applyPayload}
            onChatModelNameChange={onModelNameChange}
            onOpenBilling={() => setActiveSection("billing")}
            onOpenUsage={() => setActiveSection("usage")}
            onSetHighlightProvider={setHighlightProvider}
            // image tab props
            imageForm={imageGenerationForm}
            imageDirty={imageGenerationDirty}
            imageSaving={imageGenerationSaving}
            onImageFormChange={setImageGenerationForm}
            onImageSave={saveImageGenerationSettings}
            onSelectImageModel={(provider, model) => {
              const next = { ...imageGenerationForm, enabled: true, provider, model };
              setImageGenerationForm(next);
              void saveImageGenerationSettings(next, true, false);
            }}
            imageProviderRestartPending={pendingRestartSections.providers}
            imageApiKeyDraft={imageApiKeyDraft}
            onImageApiKeyDraftChange={setImageApiKeyDraft}
            imageKeyVisible={imageKeyVisible}
            onToggleImageKeyVisible={() => setImageKeyVisible((v) => !v)}
            // video tab props
            videoForm={videoGenerationForm}
            videoDirty={videoGenerationDirty}
            videoSaving={videoGenerationSaving}
            onVideoFormChange={setVideoGenerationForm}
            onVideoSave={saveVideoGenerationSettings}
            onSelectVideoModel={(provider, model) => {
              const next = { ...videoGenerationForm, enabled: true, provider, model };
              setVideoGenerationForm(next);
              void saveVideoGenerationSettings(next, true, false);
            }}
            videoApiKeyDraft={videoApiKeyDraft}
            onVideoApiKeyDraftChange={setVideoApiKeyDraft}
            videoKeyVisible={videoKeyVisible}
            onToggleVideoKeyVisible={() => setVideoKeyVisible((v) => !v)}
            // tts tab props
            ttsForm={ttsForm}
            ttsDirty={ttsDirty}
            ttsSaving={ttsSaving}
            onTtsFormChange={setTtsForm}
            onTtsSave={saveTtsSettings}
            ttsApiKeyDraft={ttsApiKeyDraft}
            onTtsApiKeyDraftChange={setTtsApiKeyDraft}
            ttsKeyVisible={ttsKeyVisible}
            onToggleTtsKeyVisible={() => setTtsKeyVisible((v) => !v)}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        );
      case "channels":
        return (
          <ChannelsSettings
            settings={settings}
            token={token}
            onSettingsChanged={(payload) => {
              applyPayload(payload);
              if (payload.requires_restart) {
                setPendingRestartSections((prev) => ({ ...prev, channels: true }));
              }
            }}
            onRestart={onRestart}
            isRestarting={isRestarting}
            requiresRestartPending={pendingRestartSections.channels}
          />
        );
      case "shortcuts":
        return <ShortcutsSettings />;
      case "skills":
        return <SkillManagementPanel />;
      case "mcp":
        return <McpManagementPanel />;
      case "about":
        return <AboutSettings />;
      default:
        return null;
    }
  };

  const isIndependentSection = ["general", "billing", "usage", "resources"].includes(activeSection);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      <SettingsSidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onBackToChat={onBackToChat}
      />

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 lg:py-12">
          {isIndependentSection ? (
            renderSection()
          ) : loading ? (
            <div className="flex h-48 items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.status.loading")}
            </div>
          ) : error && !settings ? (
            <SettingsGroup>
              <SettingsRow title={t("settings.status.loadError")}>
                <span className="max-w-[520px] text-body text-muted-foreground">{error}</span>
              </SettingsRow>
            </SettingsGroup>
          ) : settings ? (
            <div className="space-y-5">
              {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
              {renderSection()}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const SETTINGS_NAV_ITEMS: Array<{ key: SettingsSectionKey; icon: LucideIcon; fallback: string; desktopOnly?: boolean }> = [
  { key: "general", icon: Settings2, fallback: "通用" },
  { key: "models_providers", icon: SlidersHorizontal, fallback: "模型设置" },
  { key: "billing", icon: WalletCards, fallback: "余额与充值" },
  { key: "usage", icon: BarChart3, fallback: "用量统计" },
  { key: "resources", icon: Download, fallback: "高级功能" },
  { key: "appearance", icon: Palette, fallback: "Appearance" },
  { key: "channels", icon: Radio, fallback: "频道" },
  { key: "shortcuts", icon: Keyboard, fallback: "快捷键", desktopOnly: true },
  { key: "skills", icon: Hexagon, fallback: "技能", desktopOnly: true },
  { key: "mcp", icon: Plug, fallback: "MCP", desktopOnly: true },
  { key: "about", icon: Info, fallback: "关于" },
];

function SettingsSidebar({
  activeSection,
  onSelectSection,
  onBackToChat,
}: {
  activeSection: SettingsSectionKey;
  onSelectSection: (section: SettingsSectionKey) => void;
  onBackToChat: () => void;
}) {
  const { t } = useTranslation();
  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-border/55 px-4 pb-3 pt-4 md:w-[17rem] md:border-b-0 md:border-r md:px-3 md:py-4">
      <Button
        type="button"
        variant="ghost"
        onClick={onBackToChat}
        className="mb-2 w-fit gap-1.5 rounded-full px-2.5 text-caption font-medium text-muted-foreground hover:text-foreground md:mb-3"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        {t("settings.backToChat")}
      </Button>
      <div className="mb-3 px-1 md:mb-4 md:px-2">
        <h2 className="text-title-sm text-foreground">
          {t("settings.sidebar.title")}
        </h2>
      </div>

      <nav
        aria-label={t("settings.sidebar.ariaLabel")}
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:mx-0 md:block md:space-y-1 md:overflow-visible md:px-0 md:pb-0"
      >
        {SETTINGS_NAV_ITEMS.filter((item) => !item.desktopOnly || isTauri()).map(({ key, icon: Icon, fallback }) => {
          const active = key === activeSection;
          return (
            <Button
              key={key}
              type="button"
              variant="ghost"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectSection(key)}
              className={cn(
                "h-9 w-auto shrink-0 justify-start gap-2 rounded-full px-3 text-left text-ui font-medium md:w-full md:rounded-md md:px-2.5",
                active
                  ? "relative text-foreground hover:bg-transparent active:bg-transparent before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[hsl(var(--brand-red))]"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <span className="truncate">{t(`settings.nav.${key}`, { defaultValue: fallback })}</span>
            </Button>
          );
        })}
      </nav>
    </aside>
  );
}

function AppearanceSettings({
  theme,
  onToggleTheme,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{t("settings.sections.interface")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.rows.theme")}
            description={t("settings.help.theme")}
          >
            <Button
              type="button"
              variant="ghost"
              onClick={onToggleTheme}
              className="h-8 gap-0 rounded-full bg-muted p-0.5 text-caption font-medium text-muted-foreground hover:bg-muted hover:text-muted-foreground"
            >
              <span
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  theme === "light" && "bg-background text-foreground",
                )}
              >
                {t("settings.values.light")}
              </span>
              <span
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  theme === "dark" && "bg-background text-foreground",
                )}
              >
                {t("settings.values.dark")}
              </span>
            </Button>
          </SettingsRow>

          <SettingsRow
            title={t("settings.rows.language")}
            description={t("settings.help.language")}
          >
            <LanguageSwitcher />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.sidebarModules", "侧边栏模块")}</SubsectionLabel>
        <SidebarModulesSettings />
      </section>
    </div>
  );
}

function SidebarModulesSettings() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [drafts, setDrafts] = useState<SidebarModuleConfig[]>(DEFAULT_SIDEBAR_MODULES);
  const [defaultView, setDefaultView] = useState<string>("chat");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await getDesktopSettings();
      setSettings(s);
      const merged = mergeSidebarModules(s.sidebar_modules);
      setDrafts(merged);
      setDefaultView(s.default_view || "chat");
    } catch (e) {
      console.error("Failed to load sidebar module settings:", e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // 比较草稿与已保存值，判断是否有改动
  const dirty = useMemo(() => {
    if (!settings) return false;
    const savedMerged = mergeSidebarModules(settings.sidebar_modules);
    if (mergeSidebarModules(drafts).length !== savedMerged.length) return true;
    const norm = (arr: SidebarModuleConfig[]) =>
      arr
        .slice()
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
        .map((m) => `${m.key}:${m.visible ? 1 : 0}:${m.order}`)
        .join("|");
    return norm(mergeSidebarModules(drafts)) !== norm(savedMerged) || defaultView !== (settings.default_view || "chat");
  }, [settings, drafts, defaultView]);

  const moveItem = (index: number, delta: -1 | 1) => {
    setDrafts((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      // 交换两元素 order
      const a = next[index];
      const b = next[target];
      next[index] = { ...b, order: a.order };
      next[target] = { ...a, order: b.order };
      return next.sort((x, y) => x.order - y.order);
    });
  };

  const toggleVisible = (key: string) => {
    setDrafts((prev) =>
      prev.map((m) => (m.key === key ? { ...m, visible: !m.visible } : m)),
    );
  };

  const handleSave = async () => {
    if (!settings || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateDesktopSettings({
        ...settings,
        default_view: defaultView,
        sidebar_modules: drafts,
      });
      setSettings(updated);
      setDrafts(mergeSidebarModules(updated.sidebar_modules));
      setDefaultView(updated.default_view || "chat");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2400);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setDrafts(DEFAULT_SIDEBAR_MODULES.map((m, i) => ({ ...m, order: i })));
    setDefaultView("chat");
  };

  if (!settings) {
    return (
      <div className="flex h-32 items-center justify-center text-body text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {tx("settings.status.loading", "Loading...")}
      </div>
    );
  }

  const defMap = new Map(MODULE_DEFS.map((d) => [d.key, d]));
  const moduleLabel = (def: (typeof MODULE_DEFS)[number]) =>
    def.key === "chat" ? t("rail.messages", "会话") : t(`rail.modules.${def.key}`, def.label);
  // 默认模块下拉选项：与侧栏实际可见性解耦，包含全部已定义模块
  const viewOptions = MODULE_DEFS.map((d) => ({ key: d.key, label: moduleLabel(d) }));
  const currentDefaultLabel = viewOptions.find((option) => option.key === defaultView)?.label ?? defaultView;

  return (
    <div className="space-y-3">
      <SettingsGroup>
        <SettingsRow
          title={tx("settings.rows.defaultModule", "启动时默认显示")}
          description={tx("settings.help.defaultModule", "应用启动时默认打开的模块。")}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 min-w-[140px] justify-between rounded-full px-3 text-caption font-medium"
              >
                <span className="truncate">{currentDefaultLabel}</span>
                <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              {viewOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.key}
                  className="gap-2 px-2.5 py-1.5 text-ui"
                  onSelect={() => setDefaultView(opt.key)}
                >
                  <span className="flex-1 truncate">{opt.label}</span>
                  {opt.key === defaultView && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup>
        {drafts.map((m, idx) => {
          const def = defMap.get(m.key);
          if (!def) return null;
          const locked = m.key === "chat";
          return (
            <div
              key={m.key}
              className="flex min-h-[52px] items-center gap-3 px-4 py-2.5 sm:px-5"
            >
              <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                {MODULE_ICONS[m.key] ?? def.icon}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-foreground">
                  {moduleLabel(def)}
                  {locked && (
                    <span className="ml-2 text-micro font-normal text-muted-foreground">
                      {tx("settings.values.locked", "固定")}
                    </span>
                  )}
                </div>
                {def.windowsOnly && (
                  <div className="mt-0.5 text-micro text-muted-foreground">Windows</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={tx("settings.actions.moveUp", "上移")}
                  disabled={idx === 0}
                  onClick={() => moveItem(idx, -1)}
                  className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={tx("settings.actions.moveDown", "下移")}
                  disabled={idx === drafts.length - 1}
                  onClick={() => moveItem(idx, 1)}
                  className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
                <Checkbox
                  checked={m.visible}
                  disabled={locked}
                  onCheckedChange={() => toggleVisible(m.key)}
                  aria-label={tx("settings.actions.toggleVisible", "显示/隐藏")}
                  className="ml-1"
                />
              </div>
            </div>
          );
        })}
      </SettingsGroup>

      <div className="flex items-center justify-between px-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleReset}
          disabled={saving || !dirty}
          className="h-8 rounded-full text-caption text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {tx("settings.actions.reset", "恢复默认")}
        </Button>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-caption text-success">
              <Check className="mr-1 inline h-3.5 w-3.5" />
              {tx("settings.status.saved", "已保存")}
            </span>
          )}
          {error && (
            <span className="text-caption text-destructive">{error}</span>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="h-8 rounded-full px-4 text-caption"
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {tx("settings.actions.save", "保存")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AiModelsSettings({
  settings,
  token,
  onSettingsChanged,
  onChatModelNameChange,
  onOpenBilling,
  onOpenUsage,
  // image tab
  imageForm,
  imageDirty,
  imageSaving,
  onImageFormChange,
  onImageSave,
  onSelectImageModel,
  imageProviderRestartPending,
  imageApiKeyDraft,
  onImageApiKeyDraftChange,
  imageKeyVisible,
  onToggleImageKeyVisible,
  // video tab
  videoForm,
  videoDirty,
  videoSaving,
  onVideoFormChange,
  onVideoSave,
  onSelectVideoModel,
  videoApiKeyDraft,
  onVideoApiKeyDraftChange,
  videoKeyVisible,
  onToggleVideoKeyVisible,
  // tts tab
  ttsForm,
  ttsDirty,
  ttsSaving,
  onTtsFormChange,
  onTtsSave,
  ttsApiKeyDraft,
  onTtsApiKeyDraftChange,
  ttsKeyVisible,
  onToggleTtsKeyVisible,
  // shared
  onSetHighlightProvider,
  onRestart,
  isRestarting,
}: {
  settings: SettingsPayload;
  token: string;
  onSettingsChanged: (payload: SettingsPayload) => void;
  onChatModelNameChange: (modelName: string | null) => void;
  onOpenBilling: () => void;
  onOpenUsage: () => void;
  // image tab
  imageForm: ImageGenerationSettingsUpdate;
  imageDirty: boolean;
  imageSaving: boolean;
  onImageFormChange: Dispatch<SetStateAction<ImageGenerationSettingsUpdate>>;
  onImageSave: () => void;
  onSelectImageModel: (provider: string, model: string) => void;
  imageProviderRestartPending: boolean;
  imageApiKeyDraft: string;
  onImageApiKeyDraftChange: Dispatch<SetStateAction<string>>;
  imageKeyVisible: boolean;
  onToggleImageKeyVisible: () => void;
  // video tab
  videoForm: VideoGenerationSettingsUpdate;
  videoDirty: boolean;
  videoSaving: boolean;
  onVideoFormChange: Dispatch<SetStateAction<VideoGenerationSettingsUpdate>>;
  onVideoSave: () => void;
  onSelectVideoModel: (provider: string, model: string) => void;
  videoApiKeyDraft: string;
  onVideoApiKeyDraftChange: Dispatch<SetStateAction<string>>;
  videoKeyVisible: boolean;
  onToggleVideoKeyVisible: () => void;
  // tts tab
  ttsForm: TtsSettingsUpdate;
  ttsDirty: boolean;
  ttsSaving: boolean;
  onTtsFormChange: Dispatch<SetStateAction<TtsSettingsUpdate>>;
  onTtsSave: () => void;
  ttsApiKeyDraft: string;
  onTtsApiKeyDraftChange: Dispatch<SetStateAction<string>>;
  ttsKeyVisible: boolean;
  onToggleTtsKeyVisible: () => void;
  // shared
  onSetHighlightProvider?: (provider: string | null) => void;
  onRestart?: () => void;
  isRestarting?: boolean;
}) {
  const [mediaSettings, setMediaSettings] = useState<"image" | "video" | "tts" | null>(null);

  const openImageSettings = (provider: string, model?: string) => {
    onImageFormChange((current) => ({ ...current, provider, ...(model ? { model } : {}) }));
    onImageApiKeyDraftChange("");
    setMediaSettings("image");
  };

  const openVideoSettings = (provider: string, model?: string) => {
    onVideoFormChange((current) => ({ ...current, provider, ...(model ? { model } : {}) }));
    onVideoApiKeyDraftChange("");
    setMediaSettings("video");
  };

  return (
    <>
      <ChatProvidersSettings
        settings={settings}
        token={token}
        onSettingsChanged={onSettingsChanged}
        onModelNameChange={onChatModelNameChange}
        onOpenBilling={onOpenBilling}
        onOpenUsage={onOpenUsage}
        onSelectImageModel={onSelectImageModel}
        onSelectVideoModel={onSelectVideoModel}
        onOpenImageSettings={openImageSettings}
        onOpenVideoSettings={openVideoSettings}
        onOpenTtsSettings={() => setMediaSettings("tts")}
      />

      <Dialog open={mediaSettings !== null} onOpenChange={(open) => !open && setMediaSettings(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{mediaSettings === "image" ? "图像模型配置" : mediaSettings === "video" ? "视频模型配置" : "语音合成配置"}</DialogTitle>
            <DialogDescription>
              配置专用生成模型及默认参数；保存后由对应生成工具读取，不会进入聊天模型选择器。
            </DialogDescription>
          </DialogHeader>
          {mediaSettings === "image" ? (
            <ImageGenerationSettings
              key={`image-${imageForm.provider}`}
              settings={settings}
              form={imageForm}
              dirty={imageDirty}
              saving={imageSaving}
              onChangeForm={onImageFormChange}
              onSave={onImageSave}
              onOpenProviders={(provider) => onSetHighlightProvider?.(provider ?? null)}
              onRestart={onRestart}
              isRestarting={isRestarting}
              requiresRestartPending={imageProviderRestartPending}
              apiKeyDraft={imageApiKeyDraft}
              onApiKeyDraftChange={onImageApiKeyDraftChange}
              keyVisible={imageKeyVisible}
              onToggleKeyVisible={onToggleImageKeyVisible}
            />
          ) : mediaSettings === "video" ? (
            <VideoGenerationSettings
              key={`video-${videoForm.provider}`}
              settings={settings}
              form={videoForm}
              dirty={videoDirty}
              saving={videoSaving}
              onChangeForm={onVideoFormChange}
              onSave={onVideoSave}
              onOpenProviders={(provider) => onSetHighlightProvider?.(provider ?? null)}
              onRestart={onRestart}
              isRestarting={isRestarting}
              requiresRestartPending={imageProviderRestartPending}
              apiKeyDraft={videoApiKeyDraft}
              onApiKeyDraftChange={onVideoApiKeyDraftChange}
              keyVisible={videoKeyVisible}
              onToggleKeyVisible={onToggleVideoKeyVisible}
            />
          ) : mediaSettings === "tts" ? (
            <TtsSettings
              settings={settings}
              form={ttsForm}
              dirty={ttsDirty}
              saving={ttsSaving}
              onChangeForm={onTtsFormChange}
              onSave={onTtsSave}
              apiKeyDraft={ttsApiKeyDraft}
              onApiKeyDraftChange={onTtsApiKeyDraftChange}
              keyVisible={ttsKeyVisible}
              onToggleKeyVisible={onToggleTtsKeyVisible}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ModelsProvidersSettings({
  settings,
  expandedProvider,
  providerForms,
  visibleProviderKeys,
  editingProviderKeys,
  providerSaving,
  query,
  onQueryChange,
  onToggleProvider,
  onToggleProviderKey,
  onToggleProviderKeyEditing,
  onChangeProviderForm,
  onSaveProvider,
  onDeleteProvider,
  onResetProviderDraft,
  onSetDefaultProvider,
  providersRestartPending,
  onRestart,
  isRestarting,
  highlightProvider,
  onHighlightConsumed,
  onTriggerAgent,
}: {
  settings: SettingsPayload;
  expandedProvider: string | null;
  providerForms: Record<string, { apiKey: string; apiBase: string; model: string }>;
  visibleProviderKeys: Record<string, boolean>;
  editingProviderKeys: Record<string, boolean>;
  providerSaving: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onToggleProvider: (provider: string) => void;
  onToggleProviderKey: (provider: string) => void;
  onToggleProviderKeyEditing: (provider: string) => void;
  onChangeProviderForm: (provider: string, value: Partial<{ apiKey: string; apiBase: string; model: string }>) => void;
  onSaveProvider: (provider: string) => void;
  onDeleteProvider: (provider: string) => void;
  onResetProviderDraft: (provider: string) => void;
  onSetDefaultProvider: (provider: string) => void;
  providersRestartPending: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  highlightProvider?: string | null;
  onHighlightConsumed?: () => void;
  onTriggerAgent?: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const highlightRef = useRef<HTMLDivElement>(null);
  const { token } = useClientOptional();

  // --- 模型列表拉取状态 ---
  // 每个 provider 独立维护 loading / 候选列表 / 错误信息。
  type ProbeState = { loading: boolean; models: string[]; error: string };
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  const setProbe = (providerName: string, patch: Partial<ProbeState>) => {
    setProbeStates((prev) => {
      const current = prev[providerName] ?? { loading: false, models: [], error: "" };
      return {
        ...prev,
        [providerName]: { ...current, ...patch },
      };
    });
  };

  const handleFetchModels = useCallback(
    async (providerName: string, apiKey: string, apiBase: string) => {
      if (!token) return;
      setProbe(providerName, { loading: true, models: [], error: "" });
      try {
        const result = await fetchProviderModels(token, {
          provider: providerName,
          apiKey: apiKey || undefined,
          apiBase: apiBase || undefined,
        });
        if (result.error) {
          setProbe(providerName, { loading: false, error: result.error });
        } else {
          setProbe(providerName, { loading: false, models: result.models });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setProbe(providerName, { loading: false, error: msg });
      }
    },
    [token],
  );

  // --- Agnes 一键配置对话框状态 ---
  const [agnesDialogOpen, setAgnesDialogOpen] = useState(false);
  const [agnesEmail, setAgnesEmail] = useState("");
  const [agnesPassword, setAgnesPassword] = useState("");
  const [agnesPasswordVisible, setAgnesPasswordVisible] = useState(false);

  const handleAgnesSubmit = useCallback(() => {
    const email = agnesEmail.trim();
    const password = agnesPassword;
    if (!email || !password || !onTriggerAgent) {
      setAgnesDialogOpen(false);
      return;
    }
    const prompt = [
      "请帮我完成 Agnes AI 的一键注册和配置。我已经填好注册信息，直接用即可，不要再向我索取邮箱密码：",
      `- 注册邮箱：${email}`,
      `- 注册密码：${password}`,
      "",
      "## 平台信息",
      "- 主站：https://agnes-ai.com/",
      "- 控制台：https://platform.agnes-ai.com/",
      "- API Base：https://apihub.agnes-ai.com/v1（OpenAI 兼容）",
      "- LLM 模型 ID：agnes-2.0-flash",
      "- 文生图模型 ID：agnes-image-2.1-flash",
      "- 文生视频模型 ID：agnes-video-v2.0",
      "",
      "## 执行流程",
      "1. 用 browser_open 打开 https://platform.agnes-ai.com/。若是登录页，找“注册”或 Sign Up 链接点击进入。用 browser_snapshot 定位邮箱框、密码框、发送验证码按钮、提交按钮。",
      "2. 用 browser_type 填入上面的邮箱和密码（不要点提交）。再点“发送验证码”按钮。",
      `3. 触发验证码后告诉我已发送到 ${email}，等我在对话中回复 6 位验证码再继续。`,
      "4. 用户回复验证码后，用 browser_type 填入验证码，点提交按钮。用 browser_snapshot 检查是否注册成功：跳转到控制台首页即成功；若出现“验证码错误”/“邮箱已注册”等错误，截图告诉我并停止；若出现图片/滑块验证码，截图让我在浏览器窗口手动完成，等我说“继续”再 snapshot。",
      "5. 注册成功后用 browser_navigate 打开 https://platform.agnes-ai.com/apiKey（或从控制台菜单找 API Keys / 密钥管理进入）。找“创建 API Key”/“Create Key”按钮点击，弹窗需要名称就填 Mona 或留默认。",
      "6. 用 browser_snapshot 抓取新生成的 API Key（通常是 sk- 开头字符串，显示在 disabled/readonly 的 textbox 里，snapshot 形如 `textbox [disabled] [ref=eXXX]: sk-...`）。也可用 browser_read 读取页面（会附带 Form field values 段，包含 disabled/readonly input 的 value；注意 password 类型字段会被跳过）。拿到 key 后立即在内存保留，不要在回复正文里复述完整 key。",
      "7. 用 browser_close 关闭浏览器。",
      "8. 调用 config_set_provider 一次性写入所有配置：provider=\"agnes\", api_key=\"<抓到的 key>\", set_as_default=true, default_model=\"agnes-2.0-flash\", image_model=\"agnes-image-2.1-flash\", video_model=\"agnes-video-v2.0\"。",
      "9. 报告完成：账号已注册（邮箱 xxx）、API key 已写入 ~/.mona/config.json、三个模型已启用，并提示我重启 Mona 让配置生效。如果密码是我替你填的，建议尽快去 Agnes 平台改密码。",
      "",
      "## 失败处理",
      "- 邮箱已注册：截图告知，询问是否改为登录已有账号；若是，让用户提供已有账号邮箱密码，跳到第 5 步。",
      "- 验证码连续 3 次错误：停止，请稍后重试。",
      "- 图片验证码用户拒绝手动：停止，告知用户当前 Agnes 需要人工验证。",
      "- API Key 创建按钮找不到：截图给我，让我手动创建 key 后告诉你，你跳到第 8 步。",
      "- config_set_provider 报错：原样告知错误，让我去设置页 BYOK 区域手动填入。",
      "",
      "## 安全要求",
      "- 不要在回复正文复述完整 API key（日志中可传递，会被自动脱敏）。",
      "- 不要在对话里复述我的密码。",
      "- 浏览器关闭后流程结束，不留残留凭据。",
    ].join("\n");
    setAgnesDialogOpen(false);
    setAgnesEmail("");
    setAgnesPassword("");
    setAgnesPasswordVisible(false);
    onTriggerAgent(prompt);
  }, [agnesEmail, agnesPassword, onTriggerAgent]);

  // --- Provider list logic ---
  const configuredProviders = settings.providers.filter((provider) => provider.configured);
  const sortedConfiguredProviders = configuredProviders;
  const unconfiguredProviders = useMemo(
    () => orderUnconfiguredProviders(settings.providers.filter((provider) => !provider.configured)),
    [settings.providers],
  );
  const filteredConfigured = filterProviders(sortedConfiguredProviders, query);
  const filteredUnconfigured = filterProviders(unconfiguredProviders, query);

  useEffect(() => {
    if (!highlightProvider) return;
    onToggleProvider(highlightProvider);
    onHighlightConsumed?.();
    requestAnimationFrame(() => {
      highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightProvider]);

  const renderProviderRow = (provider: SettingsPayload["providers"][number]) => {
    const expanded = expandedProvider === provider.name;
    const highlighted = highlightProvider === provider.name;
    const form = providerForms[provider.name] ?? {
      apiKey: "",
      apiBase: provider.api_base ?? provider.default_api_base ?? "",
      model: provider.model ?? "",
    };
    const saving = providerSaving === provider.name;
    const keyVisible = !!visibleProviderKeys[provider.name];
    const editingKey = !provider.configured || !!editingProviderKeys[provider.name];
    const apiKeyRequired = provider.api_key_required ?? true;
    const apiKey = form.apiKey.trim();
    const apiBase = form.apiBase.trim();
    const missingRequiredApiKey =
      apiKeyRequired && !provider.configured && !apiKey;
    const missingOptionalCredential =
      !apiKeyRequired && !provider.configured && !apiKey && !apiBase;
    return (
      <div
        key={provider.name}
        ref={highlighted ? highlightRef : undefined}
        className={cn(
          "divide-y divide-border/50",
          highlighted && "ring-2 ring-inset ring-primary/40 rounded-lg",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          onClick={() => onToggleProvider(provider.name)}
          className={cn(
            "h-auto min-h-[70px] w-full justify-between gap-4 rounded-none px-4 py-3 text-left sm:px-5",
            "hover:bg-accent",
          )}
        >
          <span className="flex min-w-0 items-center gap-3">
            <ProviderIcon provider={provider.name} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-body font-semibold text-foreground">
                  {provider.label}
                </span>
                {settings.agent.provider === provider.name ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-micro font-medium text-success">
                    <Star className="h-2.5 w-2.5" aria-hidden />
                    默认
                  </span>
                ) : null}
                {settings.image_generation.provider === provider.name ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-micro font-medium text-primary">
                    <ImageIcon className="h-2.5 w-2.5" aria-hidden />
                    {tx("settings.image.badge", "Image")}
                  </span>
                ) : null}
              </span>
              <span className="block truncate text-caption text-muted-foreground">
                {provider.api_base || provider.default_api_base || provider.name}
              </span>
            </span>
          </span>
          <StatusPill tone={provider.configured ? "success" : "neutral"}>
            {provider.configured
              ? t("settings.byok.configured")
              : t("settings.byok.notConfigured")}
          </StatusPill>
        </Button>

        {expanded ? (
          <div className="space-y-3 bg-muted/18 px-4 py-4 sm:px-5">
            <label className="block space-y-1.5">
              <span className="text-caption font-medium text-muted-foreground">
                {t("settings.byok.apiKey")}
              </span>
              <div className="relative">
                {editingKey ? (
                  <>
                    <Input
                      type={keyVisible ? "text" : "password"}
                      value={form.apiKey}
                      onChange={(event) =>
                        onChangeProviderForm(provider.name, { apiKey: event.target.value })
                      }
                      placeholder={
                        provider.configured
                          ? t("settings.byok.apiKeyConfiguredPlaceholder")
                          : t("settings.byok.apiKeyPlaceholder")
                      }
                      className="h-8 rounded-full pr-11 text-ui"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onToggleProviderKey(provider.name)}
                      aria-label={
                        keyVisible
                          ? t("settings.byok.hideApiKey")
                          : t("settings.byok.showApiKey")
                      }
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {keyVisible ? (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex h-8 items-center rounded-full border border-input bg-background px-3 pr-11 text-ui text-muted-foreground">
                      {provider.api_key_hint ?? t("settings.byok.configuredKeyHint")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => onToggleProviderKeyEditing(provider.name)}
                      aria-label={t("settings.actions.edit")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-caption font-medium text-muted-foreground">
                {t("settings.byok.apiBase")}
              </span>
              <Input
                value={form.apiBase}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { apiBase: event.target.value })
                }
                placeholder={provider.default_api_base ?? t("settings.byok.apiBasePlaceholder")}
                className="h-8 rounded-full text-ui"
              />
            </label>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-caption font-medium text-muted-foreground">
                  模型 ID
                </span>
                {provider.probe_supported && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleFetchModels(provider.name, form.apiKey, form.apiBase)}
                    disabled={probeStates[provider.name]?.loading}
                    className="h-6 px-2 text-micro text-muted-foreground hover:text-foreground"
                  >
                    {probeStates[provider.name]?.loading ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="mr-1 h-3 w-3" aria-hidden />
                    )}
                    {probeStates[provider.name]?.loading ? "拉取中" : "拉取模型"}
                  </Button>
                )}
              </div>
              <Input
                value={form.model}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { model: event.target.value })
                }
                placeholder="例如 qwen3-plus, deepseek-chat"
                className="h-8 rounded-full text-ui"
              />
              {probeStates[provider.name]?.error && (
                <p className="text-micro text-destructive">
                  {probeStates[provider.name]?.error}
                </p>
              )}
              {probeStates[provider.name]?.models.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-border/60 bg-background scrollbar-thin">
                  {probeStates[provider.name]?.models.map((modelId) => (
                    <Button
                      key={modelId}
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        onChangeProviderForm(provider.name, { model: modelId });
                        // 清空候选列表，避免误操作。
                        setProbe(provider.name, { models: [] });
                      }}
                      className="h-auto w-full justify-between rounded-none px-2.5 py-1.5 text-left text-caption font-normal hover:bg-accent"
                    >
                      <span className="truncate">{modelId}</span>
                      {form.model === modelId && (
                        <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />
                      )}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {provider.configured && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDeleteProvider(provider.name)}
                    disabled={saving}
                    className="rounded-full text-destructive hover:text-destructive"
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
                    删除
                  </Button>
                )}
                {provider.configured && provider.model && settings.agent.provider !== provider.name && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSetDefaultProvider(provider.name)}
                    disabled={saving}
                    className="rounded-full text-success hover:text-success/80"
                  >
                    <Star className="mr-1 h-3.5 w-3.5" aria-hidden />
                    设为默认
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onResetProviderDraft(provider.name)}
                  className="rounded-full"
                >
                  {t("settings.actions.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onSaveProvider(provider.name)}
                  disabled={saving || missingRequiredApiKey || missingOptionalCredential}
                  className="rounded-full"
                >
                  {saving ? t("settings.actions.saving") : t("settings.actions.save")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-7">
      {onTriggerAgent ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-full border border-primary/30 bg-primary/5 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="truncate text-ui font-medium text-foreground">
              {tx("settings.agnesSetup.title", "一键配置 Agnes AI")}
            </span>
            <a
              href="https://agnes-ai.com/doc/cid5"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden items-center gap-1 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline sm:inline-flex"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              {tx("settings.agnesSetup.manualTutorial", "手动配置教程")}
            </a>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-full px-3.5 text-caption"
            onClick={() => setAgnesDialogOpen(true)}
          >
            <Zap className="mr-1.5 h-3 w-3" aria-hidden />
            {tx("settings.agnesSetup.cta", "一键配置")}
          </Button>
        </div>
      ) : null}
      <AgnesSetupDialog
        open={agnesDialogOpen}
        email={agnesEmail}
        password={agnesPassword}
        passwordVisible={agnesPasswordVisible}
        onEmailChange={setAgnesEmail}
        onPasswordChange={setAgnesPassword}
        onTogglePasswordVisible={() => setAgnesPasswordVisible((v) => !v)}
        onClose={() => setAgnesDialogOpen(false)}
        onSubmit={handleAgnesSubmit}
      />
      {/* 供应商配置区 */}
      <section>
        <SubsectionLabel className="mb-2 px-1">供应商</SubsectionLabel>
        {providersRestartPending && onRestart ? (
          <div className="flex min-h-[48px] items-center justify-between gap-3 border-y border-border/55 py-3 mb-4">
            <p className="text-ui text-muted-foreground">
              {tx("settings.status.providerRestart", "Provider changes saved. Restart when ready.")}
            </p>
            <div className="shrink-0">
              <Button
                size="sm"
                variant="ghost"
                onClick={onRestart}
                disabled={isRestarting}
                className="rounded-full"
              >
                {isRestarting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {isRestarting ? t("app.system.restarting") : t("app.system.restart")}
              </Button>
            </div>
          </div>
        ) : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={tx("settings.providers.searchPlaceholder", "搜索供应商")}
            className="h-8 rounded-full pl-9 text-ui"
          />
        </div>
        <div className="mt-4">
          <ProviderSection
            title={t("settings.byok.configuredSection")}
            count={filteredConfigured.length}
            empty={t("settings.byok.noConfiguredProviders")}
          >
            {filteredConfigured.map(renderProviderRow)}
          </ProviderSection>
          <ProviderSection
            title={t("settings.byok.notConfiguredSection")}
            count={filteredUnconfigured.length}
            empty={tx("settings.providers.noMatches", "No providers match this search.")}
          >
            {filteredUnconfigured.map(renderProviderRow)}
          </ProviderSection>
        </div>
      </section>
    </div>
  );
}

function AgnesSetupDialog({
  open,
  email,
  password,
  passwordVisible,
  onEmailChange,
  onPasswordChange,
  onTogglePasswordVisible,
  onClose,
  onSubmit,
}: {
  open: boolean;
  email: string;
  password: string;
  passwordVisible: boolean;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onTogglePasswordVisible: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const passwordValid = password.length >= 6;
  const canSubmit = emailValid && passwordValid;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md rounded-2xl border-border/70 bg-popover p-6 shadow-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) return;
            onSubmit();
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 text-body-lg">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden />
              {tx("settings.agnesSetup.dialogTitle", "一键配置 Agnes AI")}
            </DialogTitle>
            <DialogDescription>
              {tx(
                "settings.agnesSetup.dialogDescription",
                "填写 Agnes 注册邮箱和密码，AI 将自动打开浏览器完成注册、获取 API Key 并配置 LLM、文生图、文生视频三类模型。验证码会在注册过程中向你索取。",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <label htmlFor="agnes-setup-email" className="text-caption font-medium text-muted-foreground">
              {tx("settings.agnesSetup.emailLabel", "注册邮箱")}
            </label>
            <Input
              id="agnes-setup-email"
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              placeholder={tx("settings.agnesSetup.emailPlaceholder", "you@example.com")}
              autoFocus
              autoComplete="email"
              className="h-8 rounded-lg text-ui"
            />
          </div>

          <div className="grid gap-2">
            <label htmlFor="agnes-setup-password" className="text-caption font-medium text-muted-foreground">
              {tx("settings.agnesSetup.passwordLabel", "注册密码")}
            </label>
            <div className="relative">
              <Input
                id="agnes-setup-password"
                type={passwordVisible ? "text" : "password"}
                value={password}
                onChange={(event) => onPasswordChange(event.target.value)}
                placeholder={tx("settings.agnesSetup.passwordPlaceholder", "至少 6 位")}
                autoComplete="new-password"
                className="h-8 rounded-lg pr-9 text-ui"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onTogglePasswordVisible}
                aria-label={passwordVisible ? tx("common.hide", "隐藏") : tx("common.show", "显示")}
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-md text-muted-foreground hover:bg-transparent hover:text-foreground"
              >
                {passwordVisible ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                )}
              </Button>
            </div>
          </div>

          <p className="text-micro leading-relaxed text-muted-foreground">
            {tx(
              "settings.agnesSetup.securityNote",
              "密码仅在本地浏览器中填入并随本次会话发送给 AI 完成注册，不会被存储。注册完成后建议尽快去 Agnes 平台修改密码。",
            )}
          </p>

          <DialogFooter className="gap-2 sm:space-x-0">
            <Button type="button" variant="outline" onClick={onClose}>
              {tx("common.cancel", "取消")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              <Zap className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              {tx("settings.agnesSetup.startSetup", "开始配置")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImageGenerationSettings({
  settings,
  form,
  dirty,
  saving,
  onChangeForm,
  onSave,
  onOpenProviders,
  onRestart,
  isRestarting,
  requiresRestartPending,
  apiKeyDraft,
  onApiKeyDraftChange,
  keyVisible,
  onToggleKeyVisible,
}: {
  settings: SettingsPayload;
  form: ImageGenerationSettingsUpdate;
  dirty: boolean;
  saving: boolean;
  onChangeForm: Dispatch<SetStateAction<ImageGenerationSettingsUpdate>>;
  onSave: () => void;
  onOpenProviders: (provider?: string) => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
  apiKeyDraft: string;
  onApiKeyDraftChange: Dispatch<SetStateAction<string>>;
  keyVisible: boolean;
  onToggleKeyVisible: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [keyEditing, setKeyEditing] = useState(false);
  const selectedProvider =
    settings.image_generation.providers.find((provider) => provider.name === form.provider) ??
    settings.image_generation.providers[0];
  const providerConfigured = !!selectedProvider?.configured;
  const hasApiKeyDraft = apiKeyDraft.length > 0;
  const showKeyInput = keyEditing || hasApiKeyDraft;
  const missingCredential = form.enabled && !providerConfigured && !hasApiKeyDraft;
  const imageModelOptions = selectedProvider?.image_models ?? [];
  const aspectOptions = optionRowsWithCurrent(
    IMAGE_ASPECT_RATIO_OPTIONS.map((value) => ({ name: value, label: value })),
    form.defaultAspectRatio,
  );
  const sizeOptions = optionRowsWithCurrent(
    IMAGE_SIZE_OPTIONS.map((value) => ({ name: value, label: value })),
    form.defaultImageSize,
  );

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.imageGeneration", "Image generation")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.imageGeneration", "Image generation")}
            description={tx("settings.help.imageGeneration", "Expose generate_image in chats when a configured image provider is available.")}
          >
            <ToggleButton
              checked={form.enabled}
              onChange={(enabled) => onChangeForm((prev) => ({ ...prev, enabled }))}
              label={form.enabled ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.imageProvider", "Image provider")}
            description={tx("settings.help.imageProvider", "Choose the registry provider used by generate_image.")}
          >
            <ProviderPicker
              providers={settings.image_generation.providers}
              value={form.provider}
              emptyLabel={tx("settings.image.selectProvider", "Select provider")}
              onChange={(provider) => {
                const newInfo = settings.image_generation.providers.find((p) => p.name === provider);
                const newCandidates = newInfo?.image_models ?? [];
                const newDefault = newInfo?.default_image_model ?? null;
                onChangeForm((prev) => {
                  const wasCandidate =
                    !prev.model ||
                    imageModelOptions.includes(prev.model) ||
                    (selectedProvider?.image_models ?? []).includes(prev.model);
                  const shouldReplace = wasCandidate && newCandidates.length > 0;
                  return {
                    ...prev,
                    provider,
                    model: shouldReplace && newDefault ? newDefault : prev.model,
                  };
                });
                onApiKeyDraftChange("");
                setKeyEditing(false);
              }}
            />
          </SettingsRow>
          {providerConfigured && !showKeyInput ? (
            <SettingsRow
              title={tx("settings.rows.imageProviderStatus", "Provider credentials")}
              description={tx("settings.help.imageProviderStatus", "Image generation reuses provider credentials from Providers.")}
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusPill tone="success">
                  {tx("settings.values.configured", "Configured")}
                </StatusPill>
                {selectedProvider?.api_key_hint ? (
                  <span className="text-ui text-muted-foreground">{selectedProvider.api_key_hint}</span>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onApiKeyDraftChange("");
                    setKeyEditing(true);
                  }}
                  className="rounded-full text-ui text-muted-foreground"
                >
                  {tx("settings.image.changeKey", "修改")}
                </Button>
              </div>
            </SettingsRow>
          ) : (
            <SettingsRow
              title={tx("settings.rows.imageApiKey", "API Key")}
              description={tx("settings.help.imageApiKey", "Enter the API key for the selected provider. Saved directly to provider credentials.")}
            >
              <div className="flex items-center gap-2">
                <Input
                  type={keyVisible ? "text" : "password"}
                  value={apiKeyDraft}
                  onChange={(event) => onApiKeyDraftChange(event.target.value)}
                  placeholder={selectedProvider?.api_key_hint ?? tx("settings.image.apiKeyPlaceholder", "输入 API Key")}
                  className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onToggleKeyVisible}
                  className="rounded-full"
                >
                  {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </SettingsRow>
          )}
          <SettingsRow title={tx("settings.rows.imageProviderBase", "Provider base")}>
            <span className="max-w-[320px] truncate text-right text-ui text-muted-foreground">
              {selectedProvider?.api_base || selectedProvider?.default_api_base || selectedProvider?.name || tx("settings.values.notAvailable", "Not available")}
            </span>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.imageDefaults", "Defaults")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.imageModel", "Image model")}
            description={tx(
              "settings.help.imageModel",
              "Image generation uses a dedicated image model (different from the chat model). It reuses the credentials of the selected provider.",
            )}
          >
            <ImageModelInput
              value={form.model}
              onChange={(model) => onChangeForm((prev) => ({ ...prev, model }))}
              options={imageModelOptions}
              placeholder={tx("settings.image.modelPlaceholder", "e.g. gpt-image-1, wan2.2-t2i-plus")}
              selectLabel={tx("settings.image.selectModel", "Select image model")}
              noMatchLabel={tx("settings.image.noModelMatch", "No match, keep typing or use this value")}
              addModelLabel={tx("settings.image.addModel", "Add model")}
              onAddModel={() => onOpenProviders(form.provider)}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.defaultAspectRatio", "Default aspect")}
            description={tx("settings.help.defaultAspectRatio", "Used when the prompt does not choose an aspect ratio.")}
          >
            <ProviderPicker
              providers={aspectOptions}
              value={form.defaultAspectRatio}
              emptyLabel={tx("settings.image.selectAspect", "Select aspect")}
              onChange={(defaultAspectRatio) =>
                onChangeForm((prev) => ({ ...prev, defaultAspectRatio }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.defaultImageSize", "Default size")}
            description={tx("settings.help.defaultImageSize", "Size hint sent to providers that support it.")}
          >
            <ProviderPicker
              providers={sizeOptions}
              value={form.defaultImageSize}
              emptyLabel={tx("settings.image.selectSize", "Select size")}
              onChange={(defaultImageSize) =>
                onChangeForm((prev) => ({ ...prev, defaultImageSize }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.maxImagesPerTurn", "Max images per turn")}
            description={tx("settings.help.maxImagesPerTurn", "Upper bound for one generate_image request.")}
          >
            <NumberInput
              value={form.maxImagesPerTurn}
              min={1}
              max={8}
              onChange={(maxImagesPerTurn) =>
                onChangeForm((prev) => ({ ...prev, maxImagesPerTurn }))
              }
            />
          </SettingsRow>
          <ReadOnlyRow title={tx("settings.rows.imageSaveDir", "Save directory")} value={settings.image_generation.save_dir} />
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            disabled={missingCredential}
            message={
              missingCredential
                ? tx("settings.image.missingCredential", "Configure this provider before enabling image generation.")
                : undefined
            }
            dirtyMessage={tx("settings.status.restartAfterSaving", "Save changes, then restart when ready.")}
            pendingMessage={tx("settings.status.savedRestartApply", "Saved. Restart when ready.")}
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function VideoGenerationSettings({
  settings,
  form,
  dirty,
  saving,
  onChangeForm,
  onSave,
  onOpenProviders,
  onRestart,
  isRestarting,
  requiresRestartPending,
  apiKeyDraft,
  onApiKeyDraftChange,
  keyVisible,
  onToggleKeyVisible,
}: {
  settings: SettingsPayload;
  form: VideoGenerationSettingsUpdate;
  dirty: boolean;
  saving: boolean;
  onChangeForm: Dispatch<SetStateAction<VideoGenerationSettingsUpdate>>;
  onSave: () => void;
  onOpenProviders: (provider?: string) => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
  apiKeyDraft: string;
  onApiKeyDraftChange: Dispatch<SetStateAction<string>>;
  keyVisible: boolean;
  onToggleKeyVisible: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [keyEditing, setKeyEditing] = useState(false);
  const selectedProvider =
    settings.video_generation.providers.find((provider) => provider.name === form.provider) ??
    settings.video_generation.providers[0];
  const providerConfigured = !!selectedProvider?.configured;
  const hasApiKeyDraft = apiKeyDraft.length > 0;
  const showKeyInput = keyEditing || hasApiKeyDraft;
  const missingCredential = form.enabled && !providerConfigured && !hasApiKeyDraft;
  const videoModelOptions = selectedProvider?.video_models ?? [];
  const aspectOptions = optionRowsWithCurrent(
    VIDEO_ASPECT_RATIO_OPTIONS.map((value) => ({ name: value, label: value })),
    form.defaultAspectRatio,
  );
  const durationOptions = optionRowsWithCurrent(
    VIDEO_DURATION_OPTIONS.map((value) => ({ name: String(value), label: `${value}s` })),
    String(form.defaultDuration),
  );

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.videoGeneration", "视频生成")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.videoGeneration", "视频生成")}
            description={tx("settings.help.videoGeneration", "当配置了可用的视频供应商时，在聊天中启用 generate_video 工具。")}
          >
            <ToggleButton
              checked={form.enabled}
              onChange={(enabled) => onChangeForm((prev) => ({ ...prev, enabled }))}
              label={form.enabled ? tx("settings.values.on", "开启") : tx("settings.values.off", "关闭")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.videoProvider", "视频供应商")}
            description={tx("settings.help.videoProvider", "选择 generate_video 使用的供应商。")}
          >
            <ProviderPicker
              providers={settings.video_generation.providers}
              value={form.provider}
              emptyLabel={tx("settings.video.selectProvider", "选择供应商")}
              onChange={(provider) => {
                const newInfo = settings.video_generation.providers.find((p) => p.name === provider);
                const newCandidates = newInfo?.video_models ?? [];
                const newDefault = newInfo?.default_video_model ?? null;
                onChangeForm((prev) => {
                  const wasCandidate =
                    !prev.model ||
                    videoModelOptions.includes(prev.model) ||
                    (selectedProvider?.video_models ?? []).includes(prev.model);
                  const shouldReplace = wasCandidate && newCandidates.length > 0;
                  return {
                    ...prev,
                    provider,
                    model: shouldReplace && newDefault ? newDefault : prev.model,
                  };
                });
                onApiKeyDraftChange("");
                setKeyEditing(false);
              }}
            />
          </SettingsRow>
          {providerConfigured && !showKeyInput ? (
            <SettingsRow
              title={tx("settings.rows.videoProviderStatus", "供应商凭据")}
              description={tx("settings.help.videoProviderStatus", "视频生成复用供应商的凭据配置。")}
            >
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusPill tone="success">
                  {tx("settings.values.configured", "已配置")}
                </StatusPill>
                {selectedProvider?.api_key_hint ? (
                  <span className="text-ui text-muted-foreground">{selectedProvider.api_key_hint}</span>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onApiKeyDraftChange("");
                    setKeyEditing(true);
                  }}
                  className="rounded-full text-ui text-muted-foreground"
                >
                  {tx("settings.video.changeKey", "修改")}
                </Button>
              </div>
            </SettingsRow>
          ) : (
            <SettingsRow
              title={tx("settings.rows.videoApiKey", "API 密钥")}
              description={tx("settings.help.videoApiKey", "输入所选供应商的 API 密钥，将直接保存到供应商凭据。")}
            >
              <div className="flex items-center gap-2">
                <Input
                  type={keyVisible ? "text" : "password"}
                  value={apiKeyDraft}
                  onChange={(event) => onApiKeyDraftChange(event.target.value)}
                  placeholder={selectedProvider?.api_key_hint ?? tx("settings.video.apiKeyPlaceholder", "输入 API Key")}
                  className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onToggleKeyVisible}
                  className="rounded-full"
                >
                  {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </SettingsRow>
          )}
          <SettingsRow title={tx("settings.rows.videoProviderBase", "供应商地址")}>
            <span className="max-w-[320px] truncate text-right text-ui text-muted-foreground">
              {selectedProvider?.api_base || selectedProvider?.default_api_base || selectedProvider?.name || tx("settings.values.notAvailable", "不可用")}
            </span>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.videoDefaults", "默认设置")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.videoModel", "视频模型")}
            description={tx(
              "settings.help.videoModel",
              "视频生成使用专用视频模型（与聊天模型不同），复用所选供应商的凭据。",
            )}
          >
            <ImageModelInput
              value={form.model}
              onChange={(model) => onChangeForm((prev) => ({ ...prev, model }))}
              options={videoModelOptions}
              placeholder={tx("settings.video.modelPlaceholder", "例如 agnes-video-v2.0")}
              selectLabel={tx("settings.video.selectModel", "选择视频模型")}
              noMatchLabel={tx("settings.video.noModelMatch", "无匹配项，可继续输入或使用当前值")}
              addModelLabel={tx("settings.video.addModel", "添加模型")}
              onAddModel={() => onOpenProviders(form.provider)}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.defaultVideoAspect", "默认宽高比")}
            description={tx("settings.help.defaultVideoAspect", "当提示词未指定宽高比时使用。")}
          >
            <ProviderPicker
              providers={aspectOptions}
              value={form.defaultAspectRatio}
              emptyLabel={tx("settings.video.selectAspect", "选择宽高比")}
              onChange={(defaultAspectRatio) =>
                onChangeForm((prev) => ({ ...prev, defaultAspectRatio }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.defaultVideoDuration", "默认时长")}
            description={tx("settings.help.defaultVideoDuration", "目标视频时长（秒）。实际时长为 num_frames / frame_rate。")}
          >
            <ProviderPicker
              providers={durationOptions}
              value={String(form.defaultDuration)}
              emptyLabel={tx("settings.video.selectDuration", "选择时长")}
              onChange={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (!Number.isNaN(parsed)) {
                  onChangeForm((prev) => ({ ...prev, defaultDuration: parsed }));
                }
              }}
            />
          </SettingsRow>
          <ReadOnlyRow title={tx("settings.rows.videoSaveDir", "保存目录")} value={settings.video_generation.save_dir} />
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            disabled={missingCredential}
            message={
              missingCredential
                ? tx("settings.video.missingCredential", "启用视频生成前请先配置该供应商。")
                : undefined
            }
            dirtyMessage={tx("settings.status.restartAfterSaving", "保存修改后，准备好时重启。")}
            pendingMessage={tx("settings.status.savedRestartApply", "已保存，准备好时重启。")}
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

const TTS_PROVIDER_OPTIONS = [
  { name: "edge", label: "Edge TTS（免费）" },
  { name: "custom", label: "自定义（OpenAI 兼容接口）" },
];

function TtsSettings({
  settings,
  form,
  dirty,
  saving,
  onChangeForm,
  onSave,
  apiKeyDraft,
  onApiKeyDraftChange,
  keyVisible,
  onToggleKeyVisible,
}: {
  settings: SettingsPayload;
  form: TtsSettingsUpdate;
  dirty: boolean;
  saving: boolean;
  onChangeForm: Dispatch<SetStateAction<TtsSettingsUpdate>>;
  onSave: () => void;
  apiKeyDraft: string;
  onApiKeyDraftChange: Dispatch<SetStateAction<string>>;
  keyVisible: boolean;
  onToggleKeyVisible: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [keyEditing, setKeyEditing] = useState(false);
  const isCustom = form.provider === "custom";
  const keyConfigured = settings.tts.api_key_configured;
  const showKeyInput = !keyConfigured || keyEditing || apiKeyDraft.length > 0;
  const missingCredential = isCustom && !keyConfigured && apiKeyDraft.trim().length === 0;
  const edgeVoiceOptions = useMemo(
    () => EDGE_TTS_VOICES.map((voice) => voice.value),
    [],
  );

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.tts", "语音合成")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.ttsProvider", "合成引擎")}
            description={tx(
              "settings.help.ttsProvider",
              "视频旁白和语音朗读共用的全局语音合成配置。",
            )}
          >
            <ProviderPicker
              providers={TTS_PROVIDER_OPTIONS}
              value={form.provider ?? "edge"}
              emptyLabel={tx("settings.tts.selectProvider", "选择合成引擎")}
              onChange={(provider) => {
                onChangeForm((prev) => ({ ...prev, provider }));
                onApiKeyDraftChange("");
                setKeyEditing(false);
              }}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.ttsVoice", "音色")}
            description={
              isCustom
                ? tx("settings.help.ttsVoiceCustom", "自定义接口的 Voice ID，例如 alloy。")
                : tx("settings.help.ttsVoiceEdge", "Edge TTS 音色 ID，可输入列表外的其他音色。")
            }
          >
            {isCustom ? (
              <Input
                value={form.voice ?? ""}
                onChange={(event) =>
                  onChangeForm((prev) => ({ ...prev, voice: event.target.value }))
                }
                placeholder="alloy"
                aria-label={tx("settings.tts.voiceId", "Voice ID")}
                className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
              />
            ) : (
              <ImageModelInput
                value={form.voice ?? ""}
                onChange={(voice) => onChangeForm((prev) => ({ ...prev, voice }))}
                options={edgeVoiceOptions}
                placeholder="zh-CN-XiaoyiNeural"
                selectLabel={tx("settings.tts.selectVoice", "选择音色")}
                noMatchLabel={tx("settings.tts.noVoiceMatch", "无匹配项，可继续输入音色 ID")}
                addModelLabel=""
              />
            )}
          </SettingsRow>
          {isCustom ? (
            <>
              <SettingsRow
                title={tx("settings.rows.ttsApiBase", "API 地址")}
                description={tx(
                  "settings.help.ttsApiBase",
                  "OpenAI 兼容的语音合成接口地址，例如 https://api.openai.com/v1。",
                )}
              >
                <Input
                  value={form.apiBase ?? ""}
                  onChange={(event) =>
                    onChangeForm((prev) => ({ ...prev, apiBase: event.target.value }))
                  }
                  placeholder="https://api.openai.com/v1"
                  aria-label={tx("settings.tts.apiBase", "API 地址")}
                  className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
                />
              </SettingsRow>
              <SettingsRow
                title={tx("settings.rows.ttsModel", "模型")}
                description={tx("settings.help.ttsModel", "语音合成模型名，例如 tts-1。")}
              >
                <Input
                  value={form.model ?? ""}
                  onChange={(event) =>
                    onChangeForm((prev) => ({ ...prev, model: event.target.value }))
                  }
                  placeholder="tts-1"
                  aria-label={tx("settings.tts.model", "模型")}
                  className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
                />
              </SettingsRow>
              {keyConfigured && !showKeyInput ? (
                <SettingsRow
                  title={tx("settings.rows.ttsApiKey", "API 密钥")}
                  description={tx("settings.help.ttsApiKeyConfigured", "密钥已保存，仅用于语音合成请求。")}
                >
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <StatusPill tone="success">
                      {tx("settings.values.configured", "已配置")}
                    </StatusPill>
                    {settings.tts.api_key_hint ? (
                      <span className="text-ui text-muted-foreground">
                        {settings.tts.api_key_hint}
                      </span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        onApiKeyDraftChange("");
                        setKeyEditing(true);
                      }}
                      className="rounded-full text-ui text-muted-foreground"
                    >
                      {tx("settings.tts.changeKey", "修改")}
                    </Button>
                  </div>
                </SettingsRow>
              ) : (
                <SettingsRow
                  title={tx("settings.rows.ttsApiKey", "API 密钥")}
                  description={tx(
                    "settings.help.ttsApiKey",
                    "自定义语音合成接口的 API 密钥，保存后不会回显完整内容。",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Input
                      type={keyVisible ? "text" : "password"}
                      value={apiKeyDraft}
                      onChange={(event) => onApiKeyDraftChange(event.target.value)}
                      placeholder={
                        settings.tts.api_key_hint ??
                        tx("settings.tts.apiKeyPlaceholder", "输入 API Key")
                      }
                      aria-label={tx("settings.rows.ttsApiKey", "API 密钥")}
                      className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={onToggleKeyVisible}
                      aria-label={keyVisible ? "隐藏密钥" : "显示密钥"}
                      className="rounded-full"
                    >
                      {keyVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </SettingsRow>
              )}
            </>
          ) : null}
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={false}
            disabled={missingCredential}
            message={
              missingCredential
                ? tx("settings.tts.missingCredential", "使用自定义引擎前请先配置 API 密钥。")
                : undefined
            }
            onSave={onSave}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function WebSettings({
  settings,
  form,
  keyVisible,
  keyEditing,
  saving,
  onChangeForm,
  onChangeProvider,
  onToggleKey,
  onToggleKeyEditing,
  onReset,
  onSave,
  onRestart,
  isRestarting,
  requiresRestartPending,
}: {
  settings: SettingsPayload;
  form: WebSearchSettingsUpdate;
  keyVisible: boolean;
  keyEditing: boolean;
  saving: boolean;
  onChangeForm: Dispatch<SetStateAction<WebSearchSettingsUpdate>>;
  onChangeProvider: (provider: string) => void;
  onToggleKey: () => void;
  onToggleKeyEditing: () => void;
  onReset: () => void;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const selectedProvider =
    settings.web_search.providers.find((provider) => provider.name === form.provider) ??
    settings.web_search.providers[0];
  const hasExistingSecret =
    selectedProvider?.credential === "api_key" &&
    form.provider === settings.web_search.provider &&
    !!settings.web_search.api_key_hint;
  const showKeyInput = selectedProvider?.credential === "api_key" && (!hasExistingSecret || keyEditing);
  const apiKey = form.apiKey?.trim() ?? "";
  const baseUrl = form.baseUrl?.trim() ?? "";
  const effectiveJinaReader = form.useJinaReader ?? settings.web.fetch.use_jina_reader;
  const dirty =
    form.provider !== settings.web_search.provider ||
    apiKey.length > 0 ||
    baseUrl !== (settings.web_search.base_url ?? "") ||
    form.maxResults !== settings.web_search.max_results ||
    form.timeout !== settings.web_search.timeout ||
    effectiveJinaReader !== settings.web.fetch.use_jina_reader;
  const jinaReaderDirty = effectiveJinaReader !== settings.web.fetch.use_jina_reader;
  const missingCredential =
    selectedProvider?.credential === "api_key"
      ? !apiKey && !hasExistingSecret
      : selectedProvider?.credential === "base_url"
        ? !baseUrl
        : false;

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.webSearch", "Web search")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.byok.webSearch.provider")}
            description={t("settings.byok.webSearch.providerHelp")}
          >
            <ProviderPicker
              providers={settings.web_search.providers}
              value={form.provider}
              emptyLabel={t("settings.byok.webSearch.selectProvider")}
              onChange={onChangeProvider}
            />
          </SettingsRow>

          {selectedProvider?.credential === "api_key" ? (
            <SettingsRow
              title={t("settings.byok.apiKey")}
              description={t("settings.byok.webSearch.apiKeyHelp")}
            >
              <div className="relative w-[280px] max-w-full">
                {showKeyInput ? (
                  <>
                    <Input
                      type={keyVisible ? "text" : "password"}
                      value={form.apiKey ?? ""}
                      onChange={(event) =>
                        onChangeForm((prev) => ({ ...prev, apiKey: event.target.value }))
                      }
                      placeholder={
                        hasExistingSecret
                          ? t("settings.byok.apiKeyConfiguredPlaceholder")
                          : t("settings.byok.apiKeyPlaceholder")
                      }
                      className="h-8 rounded-full pr-11 text-ui"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={onToggleKey}
                      aria-label={
                        keyVisible ? t("settings.byok.hideApiKey") : t("settings.byok.showApiKey")
                      }
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {keyVisible ? (
                        <EyeOff className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex h-8 items-center rounded-full border border-input bg-background px-3 pr-11 text-ui text-muted-foreground">
                      {settings.web_search.api_key_hint ?? t("settings.byok.configuredKeyHint")}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={onToggleKeyEditing}
                      aria-label={t("settings.actions.edit")}
                      className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </SettingsRow>
          ) : null}

          {selectedProvider?.credential === "base_url" ? (
            <SettingsRow
              title={t("settings.byok.webSearch.baseUrl")}
              description={t("settings.byok.webSearch.baseUrlHelp")}
            >
              <Input
                value={form.baseUrl ?? ""}
                onChange={(event) =>
                  onChangeForm((prev) => ({ ...prev, baseUrl: event.target.value }))
                }
                placeholder={t("settings.byok.webSearch.baseUrlPlaceholder")}
                className="h-8 w-[280px] rounded-full text-ui"
              />
            </SettingsRow>
          ) : null}
          <SettingsRow
            title={tx("settings.rows.maxResults", "Max results")}
            description={tx("settings.help.maxResults", "Results returned by each web_search call.")}
          >
            <NumberInput
              value={form.maxResults ?? settings.web_search.max_results}
              min={1}
              max={10}
              onChange={(maxResults) => onChangeForm((prev) => ({ ...prev, maxResults }))}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.timeout", "Timeout")}
            description={tx("settings.help.timeout", "Seconds before a search provider request times out.")}
          >
            <NumberInput
              value={form.timeout ?? settings.web_search.timeout}
              min={1}
              max={120}
              onChange={(timeout) => onChangeForm((prev) => ({ ...prev, timeout }))}
              suffix="s"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.jinaReader", "Jina reader")}
            description={tx("settings.help.jinaReader", "Use Jina Reader for web_fetch when available.")}
          >
            <ToggleButton
              checked={effectiveJinaReader}
              onChange={(useJinaReader) => onChangeForm((prev) => ({ ...prev, useJinaReader }))}
              label={effectiveJinaReader ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            disabled={missingCredential}
            message={
              missingCredential
                ? t("settings.byok.webSearch.missingCredential")
                : requiresRestartPending && !dirty
                  ? tx("settings.status.savedRestartApply", "Saved. Restart when ready.")
                  : jinaReaderDirty
                    ? tx("settings.status.restartAfterSaving", "Save changes, then restart when ready.")
                    : dirty
                      ? t("settings.byok.webSearch.saveHint")
                      : undefined
            }
            onSave={onSave}
            onRestart={onRestart}
            onReset={onReset}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

/** Reusable card for credential-based channels (WeCom, QQ, Feishu).
 *
 * Encapsulates the common pattern: toggle + credential inputs (ID + secret)
 * + allow_from editor.  Secret values are never echoed back from the server;
 * we only know whether one is set.
 */
function CredentialChannelCard({
  channel,
  token,
  onSettingsChanged,
  description,
  i18nPrefix,
  idFieldKey,
  idQueryKey,
  idLabel,
  idPlaceholder,
  secretFieldKey,
  secretQueryKey,
  secretLabel,
  toggleLabel,
}: {
  channel: ChannelInfo;
  token: string;
  onSettingsChanged: (payload: SettingsPayload) => void;
  description: string;
  i18nPrefix: string;
  idFieldKey: "bot_id" | "app_id";
  idQueryKey: "botId" | "appId";
  idLabel: string;
  idPlaceholder: string;
  secretFieldKey: "secret" | "app_secret";
  secretQueryKey: "secret" | "appSecret";
  secretLabel: string;
  toggleLabel: string;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const [toggling, setToggling] = useState(false);
  const [idValue, setIdValue] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretDirty, setSecretDirty] = useState(false);
  const [allowFrom, setAllowFrom] = useState("");
  const [allowAll, setAllowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIdValue((channel as unknown as Record<string, string>)[idFieldKey] ?? "");
    setSecretValue("");
    setSecretDirty(false);
    const list = channel.allow_from ?? [];
    const all = list.includes("*");
    setAllowAll(all);
    setAllowFrom(all ? "" : list.join("\n"));
    setError(null);
  }, [channel, idFieldKey]);

  const handleToggle = useCallback(async (enabled: boolean) => {
    if (!token) return;
    setToggling(true);
    setError(null);
    try {
      const payload = await updateChannelSettings(token, channel.name, enabled);
      onSettingsChanged(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  }, [token, channel.name, onSettingsChanged]);

  const handleSave = useCallback(async () => {
    if (!token) return;
    setSaving(true);
    setError(null);
    try {
      const list = allowAll
        ? ["*"]
        : allowFrom
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
      const extra: { botId?: string; appId?: string; secret?: string; appSecret?: string } = {};
      if (idQueryKey === "botId") extra.botId = idValue;
      else extra.appId = idValue;
      if (secretDirty) {
        if (secretQueryKey === "secret") extra.secret = secretValue;
        else extra.appSecret = secretValue;
      }
      const payload = await updateChannelSettings(
        token,
        channel.name,
        channel.enabled,
        list,
        undefined,
        extra,
      );
      onSettingsChanged(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [token, channel, allowAll, allowFrom, idValue, secretValue, secretDirty, idQueryKey, secretQueryKey, onSettingsChanged]);

  const secretIsSet = (channel as unknown as Record<string, string>)[secretFieldKey] === "true";

  return (
    <>
      <SettingsRow title={channel.display_name} description={description}>
        <div className="flex items-center gap-2">
          {channel.enabled ? (
            <StatusPill tone="success">
              {tx(`${i18nPrefix}.status.enabled`, "已启用")}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">
              {tx(`${i18nPrefix}.status.disabled`, "已禁用")}
            </StatusPill>
          )}
          <ToggleSwitch
            checked={channel.enabled}
            disabled={toggling}
            onChange={handleToggle}
            aria-label={toggleLabel}
          />
        </div>
      </SettingsRow>

      {channel.enabled ? (
        <SettingsRow
          title={tx(`${i18nPrefix}.credentials`, "凭据配置")}
          description={tx(
            `${i18nPrefix}.credentialsHelp`,
            "填入凭据后保存。Secret 保存后不会再次显示。",
          )}
        >
          <div className="flex w-full min-w-[200px] flex-col items-stretch gap-3 sm:w-[300px]">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-ui text-muted-foreground">
                {idLabel}
              </span>
              <Input
                value={idValue}
                onChange={(e) => setIdValue(e.target.value)}
                placeholder={idPlaceholder}
                className="h-8 rounded-full text-ui"
                disabled={saving}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-ui text-muted-foreground">
                {secretLabel}
              </span>
              <Input
                type="password"
                value={secretValue}
                onChange={(e) => {
                  setSecretValue(e.target.value);
                  setSecretDirty(true);
                }}
                placeholder={
                  secretIsSet
                    ? tx(`${i18nPrefix}.secretSet`, "已设置，输入新值覆盖")
                    : tx(`${i18nPrefix}.secretPlaceholder`, "输入 Secret")
                }
                className="h-8 rounded-full text-ui"
                disabled={saving}
              />
            </div>
            {error ? (
              <span className="text-caption text-destructive">{error}</span>
            ) : null}
          </div>
        </SettingsRow>
      ) : null}

      {channel.enabled ? (
        <SettingsRow
          title={tx(`${i18nPrefix}.allowFrom`, "允许的用户")}
          description={tx(
            `${i18nPrefix}.allowFromHelp`,
            "设置可给 Mona 发消息的用户 ID。开启「允许所有人」则接收任意用户消息。",
          )}
        >
          <div className="flex w-full min-w-[200px] flex-col items-stretch gap-3 sm:w-[260px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ui text-muted-foreground">
                {tx(`${i18nPrefix}.allowAll`, "允许所有人")}
              </span>
              <ToggleSwitch
                checked={allowAll}
                disabled={saving}
                onChange={(checked) => {
                  setAllowAll(checked);
                  if (checked) setAllowFrom("");
                }}
                aria-label={tx(`${i18nPrefix}.allowAll`, "允许所有人")}
              />
            </div>
            {!allowAll ? (
              <Textarea
                value={allowFrom}
                onChange={(e) => setAllowFrom(e.target.value)}
                placeholder={tx(
                  `${i18nPrefix}.allowFromPlaceholder`,
                  "每行一个用户 ID，或用逗号分隔",
                )}
                className="min-h-[80px] resize-none rounded-lg text-ui"
                disabled={saving}
              />
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving}
                className="rounded-full"
              >
                {saving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : null}
                {tx(`${i18nPrefix}.save`, "保存")}
              </Button>
            </div>
          </div>
        </SettingsRow>
      ) : null}
    </>
  );
}

function ChannelsSettings({
  settings,
  token,
  onSettingsChanged,
  onRestart,
  isRestarting,
  requiresRestartPending,
}: {
  settings: SettingsPayload;
  token: string;
  onSettingsChanged: (payload: SettingsPayload) => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const channels = settings.channels?.available ?? [];
  const weixin = channels.find((c) => c.name === "weixin");
  const wecom = channels.find((c) => c.name === "wecom");
  const qq = channels.find((c) => c.name === "qq");
  const feishu = channels.find((c) => c.name === "feishu");

  const [toggling, setToggling] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginStatus, setLoginStatus] = useState<WeixinLoginStatus | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowFromInput, setAllowFromInput] = useState("");
  const [allowAll, setAllowAll] = useState(false);
  const [allowFromSaving, setAllowFromSaving] = useState(false);
  const [allowFromError, setAllowFromError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const list = weixin?.allow_from ?? [];
    const all = list.includes("*");
    setAllowAll(all);
    setAllowFromInput(all ? "" : list.join("\n"));
    setAllowFromError(null);
  }, [weixin?.allow_from]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const pollStatus = useCallback(async () => {
    if (!token) return;
    try {
      const status = await getWeixinLoginStatus(token);
      setLoginStatus(status);
      if (status.state === "confirmed" || status.state === "failed" || status.state === "expired" || status.state === "cancelled") {
        stopPolling();
        if (status.state === "confirmed") {
          // Refresh settings so logged_in reflects the new state.
          try {
            const fresh = await fetchSettings(token);
            onSettingsChanged(fresh);
          } catch {
            // best-effort
          }
          setLoginOpen(false);
        }
        return;
      }
      pollRef.current = setTimeout(pollStatus, 1500);
    } catch {
      pollRef.current = setTimeout(pollStatus, 2000);
    }
  }, [token, onSettingsChanged, stopPolling]);

  const handleStartLogin = useCallback(async () => {
    if (!token) return;
    setLoginBusy(true);
    setError(null);
    try {
      const status = await startWeixinLogin(token);
      setLoginStatus(status);
      setLoginOpen(true);
      pollRef.current = setTimeout(pollStatus, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoginBusy(false);
    }
  }, [token, pollStatus]);

  const handleCloseLogin = useCallback(async () => {
    stopPolling();
    setLoginOpen(false);
    if (loginStatus && (loginStatus.state === "awaiting_scan" || loginStatus.state === "fetching_qr")) {
      try {
        await cancelWeixinLogin(token);
      } catch {
        // ignore
      }
    }
    setLoginStatus(null);
  }, [token, loginStatus, stopPolling]);

  const handleLogout = useCallback(async () => {
    if (!token) return;
    setLoggingOut(true);
    setError(null);
    try {
      await logoutWeixin(token);
      const fresh = await fetchSettings(token);
      onSettingsChanged(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoggingOut(false);
    }
  }, [token, onSettingsChanged]);

  const handleToggle = useCallback(async (enabled: boolean) => {
    if (!token || !weixin) return;
    setToggling(true);
    setError(null);
    try {
      const payload = await updateChannelSettings(token, "weixin", enabled);
      onSettingsChanged(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  }, [token, weixin, onSettingsChanged]);

  const handleSaveAllowFrom = useCallback(async () => {
    if (!token || !weixin) return;
    setAllowFromSaving(true);
    setAllowFromError(null);
    try {
      const list = allowAll
        ? ["*"]
        : allowFromInput
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
      const payload = await updateChannelSettings(token, "weixin", weixin.enabled, list);
      onSettingsChanged(payload);
    } catch (e) {
      setAllowFromError(e instanceof Error ? e.message : String(e));
    } finally {
      setAllowFromSaving(false);
    }
  }, [token, weixin, allowAll, allowFromInput, onSettingsChanged]);

  const loginStateLabel = (() => {
    if (!loginStatus) return "";
    switch (loginStatus.state) {
      case "fetching_qr":
        return tx("settings.channels.weixin.login.fetchingQr", "正在获取二维码…");
      case "awaiting_scan":
        return tx("settings.channels.weixin.login.awaitingScan", "请使用微信扫码");
      case "confirmed":
        return tx("settings.channels.weixin.login.confirmed", "登录成功");
      case "expired":
        return tx("settings.channels.weixin.login.expired", "二维码已过期");
      case "failed":
        return tx("settings.channels.weixin.login.failed", "登录失败");
      case "cancelled":
        return tx("settings.channels.weixin.login.cancelled", "已取消");
      default:
        return "";
    }
  })();

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.channels", "频道接入")}</SubsectionLabel>
        <SettingsGroup>
          {weixin ? (
            <>
              <SettingsRow
                title={weixin.display_name}
                description={tx(
                  "settings.channels.weixin.description",
                  "启用后可通过微信与 Mona 对话。需扫码登录微信账号。",
                )}
              >
                <div className="flex items-center gap-2">
                  {weixin.enabled ? (
                    weixin.logged_in ? (
                      <StatusPill tone="success">
                        {tx("settings.channels.weixin.status.loggedIn", "已登录")}
                      </StatusPill>
                    ) : (
                      <StatusPill tone="warning">
                        {tx("settings.channels.weixin.status.notLoggedIn", "未登录")}
                      </StatusPill>
                    )
                  ) : (
                    <StatusPill tone="neutral">
                      {tx("settings.channels.weixin.status.disabled", "已禁用")}
                    </StatusPill>
                  )}
                  <ToggleSwitch
                    checked={weixin.enabled}
                    disabled={toggling}
                    onChange={handleToggle}
                    aria-label={tx("settings.channels.weixin.toggle", "启用微信")}
                  />
                </div>
              </SettingsRow>

              {weixin.enabled ? (
                <SettingsRow
                  title={tx("settings.channels.weixin.account", "微信账号")}
                  description={tx(
                    "settings.channels.weixin.accountHelp",
                    "扫码登录微信账号以接收和回复消息。",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {weixin.logged_in ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleLogout}
                        disabled={loggingOut}
                        className="rounded-full"
                      >
                        {loggingOut ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : null}
                        {tx("settings.channels.weixin.logout", "退出登录")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={handleStartLogin}
                        disabled={loginBusy}
                        className="rounded-full"
                      >
                        {loginBusy ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <QrCode className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        )}
                        {tx("settings.channels.weixin.scanLogin", "扫码登录")}
                      </Button>
                    )}
                  </div>
                </SettingsRow>
              ) : null}

              {weixin.enabled ? (
                <SettingsRow
                  title={tx("settings.channels.weixin.allowFrom", "允许的用户")}
                  description={tx(
                    "settings.channels.weixin.allowFromHelp",
                    "设置可给 Mona 发消息的微信用户 ID。开启“允许所有人”则接收任意用户消息。",
                  )}
                >
                  <div className="flex w-full min-w-[200px] flex-col items-stretch gap-3 sm:w-[260px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ui text-muted-foreground">
                        {tx("settings.channels.weixin.allowAll", "允许所有人")}
                      </span>
                      <ToggleSwitch
                        checked={allowAll}
                        disabled={allowFromSaving}
                        onChange={(checked) => {
                          setAllowAll(checked);
                          if (checked) setAllowFromInput("");
                        }}
                        aria-label={tx("settings.channels.weixin.allowAll", "允许所有人")}
                      />
                    </div>
                    {!allowAll ? (
                      <Textarea
                        value={allowFromInput}
                        onChange={(e) => setAllowFromInput(e.target.value)}
                        placeholder={tx(
                          "settings.channels.weixin.allowFromPlaceholder",
                          "每行一个微信用户 ID，或用逗号分隔",
                        )}
                        className="min-h-[80px] resize-none rounded-lg text-ui"
                        disabled={allowFromSaving}
                      />
                    ) : null}
                    <div className="flex items-center justify-end gap-2">
                      {allowFromError ? (
                        <span className="text-caption text-destructive">{allowFromError}</span>
                      ) : null}
                      <Button
                        size="sm"
                        onClick={handleSaveAllowFrom}
                        disabled={allowFromSaving}
                        className="rounded-full"
                      >
                        {allowFromSaving ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : null}
                        {tx("settings.channels.weixin.saveAllowFrom", "保存")}
                      </Button>
                    </div>
                  </div>
                </SettingsRow>
              ) : null}
            </>
          ) : null}

          {wecom ? (
            <CredentialChannelCard
              channel={wecom}
              token={token}
              onSettingsChanged={onSettingsChanged}
              description={tx(
                "settings.channels.wecom.description",
                "企业微信 AI 机器人。需在企业微信 AI Bot 平台获取 Bot ID 和 Secret。",
              )}
              i18nPrefix="settings.channels.wecom"
              idFieldKey="bot_id"
              idQueryKey="botId"
              idLabel={tx("settings.channels.wecom.botId", "Bot ID")}
              idPlaceholder="bot_xxx"
              secretFieldKey="secret"
              secretQueryKey="secret"
              secretLabel={tx("settings.channels.wecom.secret", "Secret")}
              toggleLabel={tx("settings.channels.wecom.toggle", "启用企业微信")}
            />
          ) : null}

          {qq ? (
            <CredentialChannelCard
              channel={qq}
              token={token}
              onSettingsChanged={onSettingsChanged}
              description={tx(
                "settings.channels.qq.description",
                "QQ 机器人。在 QQ 开放平台创建机器人后获取 App ID 和 Secret。",
              )}
              i18nPrefix="settings.channels.qq"
              idFieldKey="app_id"
              idQueryKey="appId"
              idLabel={tx("settings.channels.qq.appId", "App ID")}
              idPlaceholder="10xxxxxx"
              secretFieldKey="secret"
              secretQueryKey="secret"
              secretLabel={tx("settings.channels.qq.secret", "Secret")}
              toggleLabel={tx("settings.channels.qq.toggle", "启用 QQ")}
            />
          ) : null}

          {feishu ? (
            <CredentialChannelCard
              channel={feishu}
              token={token}
              onSettingsChanged={onSettingsChanged}
              description={tx(
                "settings.channels.feishu.description",
                "飞书/Lark 机器人。在飞书开放平台创建应用后获取 App ID 和 App Secret。",
              )}
              i18nPrefix="settings.channels.feishu"
              idFieldKey="app_id"
              idQueryKey="appId"
              idLabel={tx("settings.channels.feishu.appId", "App ID")}
              idPlaceholder="cli_xxx"
              secretFieldKey="app_secret"
              secretQueryKey="appSecret"
              secretLabel={tx("settings.channels.feishu.appSecret", "App Secret")}
              toggleLabel={tx("settings.channels.feishu.toggle", "启用飞书")}
            />
          ) : null}

          {!weixin && !wecom && !qq && !feishu ? (
            <SettingsRow
              title={tx("settings.channels.empty", "暂无可配置的频道")}
              description={tx(
                "settings.channels.emptyHelp",
                "频道插件未安装或未注册。",
              )}
            >
              <StatusPill tone="neutral">{tx("settings.channels.none", "无")}</StatusPill>
            </SettingsRow>
          ) : null}
        </SettingsGroup>

        {error ? (
          <div className="mt-3 px-1 text-caption text-destructive">{error}</div>
        ) : null}

        {requiresRestartPending ? (
          <div className="mt-4 flex items-center justify-end gap-2">
            <span className="text-caption text-muted-foreground">
              {tx("settings.status.savedRestartApply", "已保存，重启后生效")}
            </span>
            {onRestart ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={onRestart}
                disabled={isRestarting}
                className="rounded-full"
              >
                {isRestarting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                )}
                {isRestarting
                  ? t("app.system.restarting")
                  : t("app.system.restart")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      <Dialog open={loginOpen} onOpenChange={(open) => { if (!open) handleCloseLogin(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {tx("settings.channels.weixin.login.title", "微信扫码登录")}
            </DialogTitle>
            <DialogDescription>
              {tx(
                "settings.channels.weixin.login.description",
                "使用微信扫描下方二维码完成登录。",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-2">
            <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg border border-border/50 bg-white p-3">
              {loginStatus?.qr_svg ? (
                <div
                  className="h-full w-full [&>svg]:h-full [&>svg]:w-full"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{ __html: loginStatus.qr_svg }}
                />
              ) : (
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
              )}
            </div>
            <div className="flex items-center gap-2 text-ui text-muted-foreground">
              {loginStatus?.state === "confirmed" ? (
                <Check className="h-4 w-4 text-emerald-500" aria-hidden />
              ) : loginStatus?.state === "failed" || loginStatus?.state === "expired" ? (
                <Triangle className="h-4 w-4 text-amber-500" aria-hidden />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              )}
              <span>{loginStateLabel}</span>
            </div>
            {loginStatus?.error ? (
              <div className="max-w-full text-center text-caption text-destructive">
                {loginStatus.error}
              </div>
            ) : null}
            {loginStatus?.state === "expired" || loginStatus?.state === "failed" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleStartLogin}
                className="rounded-full"
              >
                {tx("settings.channels.weixin.login.retry", "重新获取二维码")}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <Button
      type="button"
      role="switch"
      variant="ghost"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-11 shrink-0 cursor-pointer justify-start rounded-full border-2 border-transparent p-0 transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed",
        checked ? "bg-info hover:bg-info" : "bg-muted hover:bg-muted",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow-lg ring-0 transition",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </Button>
  );
}

function RuntimeSettings({
  form,
  setForm,
  dirty,
  saving,
  onSave,
  onRestart,
  isRestarting,
  requiresRestartPending,
}: {
  form: AgentSettingsDraft;
  setForm: Dispatch<SetStateAction<AgentSettingsDraft>>;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onRestart?: () => void;
  isRestarting?: boolean;
  requiresRestartPending: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.sections.runtimeParameters", "Runtime parameters")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow title={tx("settings.rows.timezone", "Timezone")} description={tx("settings.help.timezone", "IANA timezone used by runtime context and schedules.")}>
            <Input
              value={form.timezone}
              onChange={(event) => setForm((prev) => ({ ...prev, timezone: event.target.value }))}
              className="h-8 w-[220px] rounded-full text-ui"
            />
          </SettingsRow>
          <SettingsRow title={tx("settings.rows.toolHintMaxLength", "Tool hint length")} description={tx("settings.help.toolHintMaxLength", "Maximum characters shown in tool progress hints.")}>
            <NumberInput
              value={form.toolHintMaxLength}
              min={20}
              max={500}
              onChange={(toolHintMaxLength) => setForm((prev) => ({ ...prev, toolHintMaxLength }))}
            />
          </SettingsRow>
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-1.5">
                {tx("settings.rows.workspacePath", "Workspace path")}
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-72 whitespace-normal leading-relaxed">
                      {tx("settings.help.workspacePath", "修改工作区路径后需要重启才能生效。会话记录将自动迁移到新目录。")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </span>
            }
          >
            <div className="flex items-center gap-2">
              <Input
                value={form.workspace}
                onChange={(event) => setForm((prev) => ({ ...prev, workspace: event.target.value }))}
                className="h-8 w-[min(280px,60vw)] rounded-full text-ui"
              />
              {isTauri() ? (
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  className="h-8 w-8 shrink-0 rounded-full"
                  aria-label={tx("settings.actions.chooseWorkspace", "Choose workspace")}
                  onClick={async () => {
                    try {
                      const { open } = await import("@tauri-apps/plugin-dialog");
                      const selected = await open({ directory: true, multiple: false });
                      if (selected) {
                        setForm((prev) => ({ ...prev, workspace: selected }));
                      }
                    } catch (e) {
                      console.error("Failed to open directory picker:", e);
                    }
                  }}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </SettingsRow>
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={requiresRestartPending}
            dirtyMessage={tx("settings.status.restartAfterSaving", "Save changes, then restart when ready.")}
            pendingMessage={tx("settings.status.savedRestartApply", "Saved. Restart when ready.")}
            onSave={onSave}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function AboutSettings() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const { refreshLicense } = useLicense();
  const [licenseStatus, setLicenseStatus] = useState<"checking" | "active" | "trial" | "expired" | "missing">("checking");
  const [licenseExpiry, setLicenseExpiry] = useState<string | null>(null);
  const [machineId, setMachineId] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);

  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    checkLicense();
    loadMachineId();
    loadAppVersion();
  }, []);

  // Listen for update progress and auto-check events
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenProgress: (() => void) | null = null;
    let unlistenAvailable: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlistenProgress = await listen<UpdateProgress>("update-progress", (event) => {
          setUpdateProgress(event.payload);
        });
        unlistenAvailable = await listen<UpdateCheckResult>("update-available", (event) => {
          setUpdateCheck(event.payload);
        });
      } catch {}
    })();

    return () => {
      unlistenProgress?.();
      unlistenAvailable?.();
    };
  }, []);

  const handleCheckUpdate = async () => {
    if (updateChecking) return;
    setUpdateChecking(true);
    setUpdateCheck(null);
    try {
      const result = await checkForUpdates();
      setUpdateCheck(result);
    } catch {
      setUpdateCheck({
        has_update: false,
        current_version: appVersion,
        latest_version: "",
        notes: null,
        size: null,
      });
    } finally {
      setUpdateChecking(false);
    }
  };

  const handlePerformUpdate = async () => {
    if (updateDownloading) return;
    setUpdateDownloading(true);
    try {
      await performUpdate();
      // performUpdate calls process::exit(0), so this line may not be reached
    } catch {
      setUpdateDownloading(false);
    }
  };

  const loadAppVersion = async () => {
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      setAppVersion(await getVersion());
    } catch {
      setAppVersion("unknown");
    }
  };

  const loadMachineId = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const id = await invoke<string>("get_machine_id");
      setMachineId(id);
    } catch {
      setMachineId("");
    }
  };

  const copyMachineId = async () => {
    if (!machineId) return;
    try {
      await navigator.clipboard.writeText(machineId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("plugin:clipboard-manager|write_text", { text: machineId });
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {}
    }
  };

  const checkLicense = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ status: string; expires_at: string | null; trial?: boolean }>("check_license");
      if (result.status === "valid") {
        if (result.trial) {
          setLicenseStatus("trial");
        } else {
          setLicenseStatus("active");
        }
        setLicenseExpiry(result.expires_at);
      } else if (result.status === "expired") {
        setLicenseStatus("expired");
        setLicenseExpiry(result.expires_at);
      } else {
        setLicenseStatus("missing");
      }
    } catch {
      setLicenseStatus("missing");
    }
  };

  const handleImportLicense = async () => {
    setImporting(true);
    setImportMessage(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "License", extensions: ["jwt", "lic", "txt"] }],
      });
      if (!selected) {
        setImporting(false);
        return;
      }
      const filePath = typeof selected === "string" ? selected : Array.isArray(selected) ? selected[0] : null;
      if (!filePath) {
        setImporting(false);
        return;
      }
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ success: boolean; message: string }>("import_license", { path: filePath });
      if (result.success) {
        setImportMessage({ type: "success", text: result.message || tx("settings.about.licenseImported", "License imported successfully") });
        await checkLicense();
        await refreshLicense();
      } else {
        setImportMessage({ type: "error", text: result.message || tx("settings.about.licenseImportFailed", "Failed to import license") });
      }
    } catch (e) {
      setImportMessage({ type: "error", text: String(e) });
    } finally {
      setImporting(false);
    }
  };

  const statusTone = licenseStatus === "active" ? "success" as const : licenseStatus === "trial" ? "info" as const : licenseStatus === "expired" ? "warning" as const : "neutral" as const;
  const statusLabel =
    licenseStatus === "checking"
      ? tx("settings.about.checking", "检测中...")
      : licenseStatus === "active"
        ? tx("settings.about.activated", "已激活")
        : licenseStatus === "trial"
          ? tx("settings.about.trial", "试用中")
          : licenseStatus === "expired"
            ? tx("settings.about.expired", "已过期")
            : tx("settings.about.notActivated", "未激活");

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.about.product", "产品信息")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow title={tx("settings.about.productName", "产品名称")}>
            <span className="text-ui text-muted-foreground">Mona</span>
          </SettingsRow>
          <SettingsRow title={tx("settings.about.version", "版本号")}>
            <span className="text-ui text-muted-foreground">{appVersion || "..."}</span>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.about.machineId", "机器码")}
            description={tx("settings.about.machineIdDesc", "复制此机器码，到授权页面换取 License 文件")}
          >
            <div className="flex items-center gap-2">
              <code className="max-w-[200px] truncate rounded bg-muted px-2 py-0.5 text-caption font-mono text-muted-foreground">
                {machineId || "..."}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={copyMachineId}
                disabled={!machineId}
                className="h-7 rounded-full px-2"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      </section>

      {isTauri() ? (
        <section>
          <SubsectionLabel className="mb-2 px-1">{tx("settings.about.update", "软件更新")}</SubsectionLabel>
          <SettingsGroup>
            <SettingsRow title={tx("settings.about.currentVersion", "当前版本")}>
              <span className="text-ui text-muted-foreground">{appVersion || "..."}</span>
            </SettingsRow>
            <SettingsRow
              title={tx("settings.about.checkUpdate", "检查更新")}
              description={
                updateCheck?.has_update
                  ? tx("settings.about.newVersionAvailable", "发现新版本 {{version}}").replace(
                      "{{version}}",
                      updateCheck.latest_version,
                    )
                  : updateCheck && !updateCheck.has_update
                    ? tx("settings.about.alreadyUpToDate", "已是最新版本")
                    : undefined
              }
            >
              <div className="flex shrink-0 items-center gap-2">
                {updateCheck?.has_update && !updateDownloading ? (
                  <Button
                    size="sm"
                    onClick={handlePerformUpdate}
                    className="shrink-0 rounded-full"
                  >
                    <Download className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {tx("settings.about.downloadAndInstall", "下载并安装")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCheckUpdate}
                    disabled={updateChecking || updateDownloading}
                    className="shrink-0 rounded-full"
                  >
                    {updateChecking ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                    {updateChecking
                      ? tx("settings.about.checking", "检查中...")
                      : tx("settings.about.checkNow", "立即检查")}
                  </Button>
                )}
              </div>
            </SettingsRow>
            {updateDownloading && updateProgress ? (
              <div className="px-4 py-3 sm:px-5">
                <div className="mb-1.5 flex items-center justify-between text-caption">
                  <span className="text-muted-foreground">{updateProgress.message}</span>
                  <span className="font-medium text-foreground">{updateProgress.percent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-info transition-all duration-300"
                    style={{ width: `${updateProgress.percent}%` }}
                  />
                </div>
              </div>
            ) : null}
            {updateCheck?.notes ? (
              <div className="px-4 py-3 text-ui text-muted-foreground sm:px-5">
                {updateCheck.notes}
              </div>
            ) : null}
          </SettingsGroup>
        </section>
      ) : null}

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.about.license", "授权")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.about.activationStatus", "激活状态")}
            description={
              licenseStatus === "active"
                ? tx("settings.about.activatedDesc", "Mona Pro 的工作区 AI、AI 文档与 AI 诊股已解锁")
                : licenseStatus === "expired"
                  ? tx("settings.about.expiredDesc", "授权已过期，Pro 功能已锁定")
                  : tx("settings.about.notActivatedDesc", "激活后可使用工作区 AI、完整 AI 文档与 AI 诊股")
            }
          >
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </SettingsRow>
          {licenseExpiry ? (
            <ReadOnlyRow title={tx("settings.about.licenseExpiry", "授权到期时间")} value={new Date(licenseExpiry).toLocaleDateString()} />
          ) : null}
          <SettingsRow
            title={tx("settings.about.importLicense", "导入授权文件")}
            description={tx("settings.about.importLicenseDesc", "导入 .jwt 授权文件以激活 Pro 功能")}
          >
            <Button
              size="sm"
              variant="outline"
              onClick={handleImportLicense}
              disabled={importing}
              className="rounded-full"
            >
              {importing
                ? tx("settings.about.importing", "导入中...")
                : tx("settings.about.selectFile", "选择文件")}
            </Button>
          </SettingsRow>
          {importMessage ? (
            <div className={cn(
              "px-4 py-2.5 text-ui sm:px-5",
              importMessage.type === "success" && "text-emerald-700 dark:text-emerald-300",
              importMessage.type === "error" && "text-destructive",
            )}>
              {importMessage.text}
            </div>
          ) : null}
        </SettingsGroup>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.about.proFeatures", "Pro 功能")}</SubsectionLabel>
        <SettingsGroup>
          <ReadOnlyRow title="DB AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="笔记 AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="终端 AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="邮件 AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title={tx("settings.about.knowledgeBaseAI", "知识库 AI")} value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="AI 文档" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="AI 诊股" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
        </SettingsGroup>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent 搜索范围设置
// ---------------------------------------------------------------------------

interface NotebookListItem {
  id: string;
  name: string;
}

interface NotesStateLike {
  notebooks: NotebookListItem[];
}

function AgentScopeSettings() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const [scope, setScope] = useState<AgentSearchScope | null>(null);
  const [notebooks, setNotebooks] = useState<NotebookListItem[]>([]);
  const [vaultReady, setVaultReady] = useState<boolean>(false);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [foldersByAccount, setFoldersByAccount] = useState<Record<string, EmailFolder[]>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [configuringScope, setConfiguringScope] = useState<"notes" | "email" | null>(null);

  // 初次加载：读取配置 + 笔记本 + 邮件账号/文件夹
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loadedScope = await getAgentSearchScope();
        // 归一化 mode：空串视为 "all"
        const notesMode = loadedScope.notes.mode || "all";
        const emailMode = loadedScope.email.mode || "all";
        // 若 scope 文件不存在（全空默认），默认 notes/email 均为 all
        const isEmpty =
          !loadedScope.notes.mode &&
          loadedScope.notes.allowedNotebookIds.length === 0 &&
          !loadedScope.email.mode &&
          loadedScope.email.allowedFolders.length === 0;
        const nextScope: AgentSearchScope = isEmpty
          ? {
              notes: { mode: "all", allowedNotebookIds: [] },
              email: { mode: "all", allowedFolders: [] },
            }
          : {
              notes: { mode: notesMode, allowedNotebookIds: loadedScope.notes.allowedNotebookIds ?? [] },
              email: { mode: emailMode, allowedFolders: loadedScope.email.allowedFolders ?? [] },
            };
        if (cancelled) return;
        setScope(nextScope);
        if (isEmpty) {
          // 立即持久化，避免下次再触发默认初始化
          void setAgentSearchScope(nextScope).catch(() => {});
        }
      } catch {
        if (!cancelled) {
          setScope({
            notes: { mode: "all", allowedNotebookIds: [] },
            email: { mode: "all", allowedFolders: [] },
          });
        }
      }

      try {
        const state = (await loadDesktopNotesState()) as NotesStateLike | null;
        if (cancelled) return;
        if (state && Array.isArray(state.notebooks)) {
          setNotebooks(state.notebooks);
          setVaultReady(true);
        } else {
          setVaultReady(false);
        }
      } catch {
        if (!cancelled) setVaultReady(false);
      }

      try {
        const accs = await listAccounts();
        if (cancelled) return;
        setAccounts(accs);
        const foldersMap: Record<string, EmailFolder[]> = {};
        await Promise.all(
          accs.map(async (a) => {
            try {
              const folders = await getFolders(a.id);
              foldersMap[a.id] = folders ?? [];
            } catch {
              foldersMap[a.id] = [];
            }
          }),
        );
        if (!cancelled) setFoldersByAccount(foldersMap);
      } catch {
        // 邮件模块可能未初始化
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = async (nextScope: AgentSearchScope) => {
    setScope(nextScope);
    setSaving(true);
    try {
      await setAgentSearchScope(nextScope);
    } finally {
      setSaving(false);
    }
  };

  const setNotesMode = async (mode: string) => {
    if (!scope) return;
    await persist({ ...scope, notes: { mode, allowedNotebookIds: scope.notes.allowedNotebookIds } });
  };

  const toggleNotebook = async (notebookId: string) => {
    if (!scope) return;
    const allowed = new Set(scope.notes.allowedNotebookIds);
    if (allowed.has(notebookId)) {
      allowed.delete(notebookId);
    } else {
      allowed.add(notebookId);
    }
    await persist({
      ...scope,
      notes: { mode: "specific", allowedNotebookIds: Array.from(allowed) },
    });
  };

  const toggleEmailFolder = async (folder: string) => {
    if (!scope) return;
    const allowed = new Set(scope.email.allowedFolders);
    if (allowed.has(folder)) {
      allowed.delete(folder);
    } else {
      allowed.add(folder);
    }
    await persist({
      ...scope,
      email: { mode: "specific", allowedFolders: Array.from(allowed) },
    });
  };

  const setEmailMode = async (mode: string) => {
    if (!scope) return;
    await persist({ ...scope, email: { mode, allowedFolders: scope.email.allowedFolders } });
  };

  if (!loaded || !scope) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border/60 bg-card text-body text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {tx("settings.status.loading", "Loading…")}
      </div>
    );
  }

  const notesMode = scope.notes.mode || "all";
  const allowedSet = new Set(scope.notes.allowedNotebookIds);
  const emailMode = scope.email.mode || "all";
  const emailAllowed = new Set(scope.email.allowedFolders);

  const notesModeOptions: { value: string; label: string; desc: string }[] = [
    { value: "all", label: "全部允许", desc: "所有笔记（含根目录与全部文件夹）均可被 Agent 检索。" },
    { value: "none", label: "全部不允许", desc: "Agent 无法检索任何笔记。" },
    { value: "specific", label: "指定文件夹允许", desc: "仅勾选的文件夹（含根目录）参与检索，新增文件夹默认不参与。" },
  ];

  const emailModeOptions: { value: string; label: string; desc: string }[] = [
    { value: "all", label: "全部允许", desc: "所有邮件文件夹均可被 Agent 检索。" },
    { value: "none", label: "全部不允许", desc: "Agent 无法检索任何邮件。" },
    { value: "specific", label: "指定文件夹允许", desc: "仅勾选的文件夹参与检索，新增文件夹默认不参与。" },
  ];

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">Agent 搜索范围</SubsectionLabel>
        <SettingsGroup>
          {vaultReady ? (
            <>
              <SettingsRow
                title="笔记搜索范围"
                description={notesModeOptions.find((option) => option.value === notesMode)?.desc}
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={notesMode}
                    options={notesModeOptions}
                    onValueChange={(value) => void setNotesMode(value)}
                    disabled={saving}
                    aria-label="笔记搜索范围"
                    className="h-8 w-[180px] rounded-full text-ui"
                  />
                  {notesMode === "specific" ? <Button type="button" variant="outline" size="sm" className="h-8 rounded-full" onClick={() => setConfiguringScope("notes")}>配置</Button> : null}
                </div>
              </SettingsRow>
            </>
          ) : (
            <SettingsRow
              title="未配置笔记仓库"
              description="请先在笔记模块中设置仓库路径后再管理搜索范围。"
            />
          )}

          {accounts.length === 0 ? (
            <SettingsRow
              title="未配置邮件账号"
              description="请先在邮件模块中添加账号后再管理搜索范围。"
            />
          ) : (
            <>
              <SettingsRow
                title="邮件搜索范围"
                description={emailModeOptions.find((option) => option.value === emailMode)?.desc}
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={emailMode}
                    options={emailModeOptions}
                    onValueChange={(value) => void setEmailMode(value)}
                    disabled={saving}
                    aria-label="邮件搜索范围"
                    className="h-8 w-[180px] rounded-full text-ui"
                  />
                  {emailMode === "specific" ? <Button type="button" variant="outline" size="sm" className="h-8 rounded-full" onClick={() => setConfiguringScope("email")}>配置</Button> : null}
                </div>
              </SettingsRow>
            </>
          )}
        </SettingsGroup>
      </section>

      <Dialog open={configuringScope !== null} onOpenChange={(open) => !open && setConfiguringScope(null)}>
        <DialogContent className="max-h-[75vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{configuringScope === "notes" ? "配置允许检索的笔记文件夹" : "配置允许检索的邮件文件夹"}</DialogTitle>
            <DialogDescription>仅勾选的文件夹会参与 Agent 搜索。</DialogDescription>
          </DialogHeader>
          {configuringScope === "notes" ? (
            <div className="divide-y divide-border/60 rounded-xl border border-border/60">
              <label className="flex cursor-pointer select-none items-center gap-2.5 px-4 py-3 text-ui text-foreground/85 hover:bg-muted/35">
                <Checkbox checked={allowedSet.has("")} onCheckedChange={() => void toggleNotebook("")} />
                <span>根目录（未分类笔记）</span>
              </label>
              {notebooks.map((notebook) => (
                <label key={notebook.id} className="flex cursor-pointer select-none items-center gap-2.5 px-4 py-3 text-ui text-foreground/85 hover:bg-muted/35">
                  <Checkbox checked={allowedSet.has(notebook.id)} onCheckedChange={() => void toggleNotebook(notebook.id)} />
                  <span className="truncate">{notebook.name}</span>
                </label>
              ))}
            </div>
          ) : configuringScope === "email" ? (
            <div className="space-y-3">
              {accounts.map((account) => {
                const folders = foldersByAccount[account.id] ?? [];
                return (
                  <div key={account.id} className="rounded-xl border border-border/60">
                    <div className="border-b border-border/60 px-4 py-2.5 text-ui font-medium text-foreground">{account.displayName || account.fromAddress || account.imapUsername}</div>
                    <div className="divide-y divide-border/50">
                      {folders.length === 0 ? <div className="px-4 py-3 text-caption text-muted-foreground">暂无文件夹缓存</div> : folders.map((folder) => (
                        <label key={folder.name} className="flex cursor-pointer select-none items-center gap-2.5 px-4 py-2.5 text-ui text-foreground/85 hover:bg-muted/35">
                          <Checkbox checked={emailAllowed.has(folder.name)} onCheckedChange={() => void toggleEmailFolder(folder.name)} />
                          <span className="truncate">{getFolderDisplayName(folder.name)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {saving ? (
        <div className="text-caption text-muted-foreground">正在保存…</div>
      ) : null}
    </div>
  );
}

function ProviderPicker({
  providers,
  value,
  emptyLabel,
  onChange,
}: {
  providers: Array<{ name: string; label: string }>;
  value: string;
  emptyLabel: string;
  onChange: (provider: string) => void;
}) {
  const selectedProvider = providers.find((provider) => provider.name === value) ?? null;
  const disabled = providers.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-8 w-[210px] justify-between rounded-full border-input bg-background px-3 text-ui font-normal shadow-none",
            "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "text-muted-foreground",
          )}
        >
          <span className="truncate">{selectedProvider?.label ?? emptyLabel}</span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[18rem] w-[240px] overflow-y-auto rounded-md border-border/65 bg-popover p-1.5 text-popover-foreground shadow-lg dark:border-white/10"
      >
        {providers.map((provider) => {
          const selected = provider.name === value;
          return (
            <DropdownMenuItem
              key={provider.name}
              onSelect={() => onChange(provider.name)}
              className={cn(
                "flex cursor-default items-center justify-between gap-2 rounded-lg px-3 py-2 text-ui",
                "focus:bg-muted focus:text-foreground",
                selected && "bg-info-soft text-info focus:bg-info-soft focus:text-info",
              )}
            >
              <span className="truncate">{provider.label}</span>
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ImageModelInput({
  value,
  onChange,
  options,
  placeholder,
  selectLabel,
  noMatchLabel,
  addModelLabel,
  onAddModel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  selectLabel: string;
  noMatchLabel: string;
  addModelLabel: string;
  onAddModel?: () => void;
}) {
  const filtered = useMemo(() => {
    if (!options.length) return [];
    const v = value.trim().toLowerCase();
    if (!v) return options;
    return options.filter((o) => o.toLowerCase().includes(v));
  }, [options, value]);

  if (!options.length) {
    return (
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 w-[min(300px,70vw)] rounded-full text-ui"
      />
    );
  }

  return (
    <div className="relative flex items-center">
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 w-[min(300px,70vw)] rounded-full pr-9 text-ui"
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={selectLabel}
            className="absolute right-1.5 top-1/2 h-6 w-6 -translate-y-1/2 rounded-full text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[18rem] w-[min(300px,70vw)] overflow-y-auto rounded-md border-border/65 bg-popover p-1.5 text-popover-foreground shadow-lg dark:border-white/10"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-ui text-muted-foreground">{noMatchLabel}</div>
          ) : (
            filtered.map((model) => {
              const selected = model === value;
              return (
                <DropdownMenuItem
                  key={model}
                  onSelect={() => onChange(model)}
                  className={cn(
                    "flex cursor-default items-center justify-between gap-2 rounded-lg px-3 py-2 text-ui",
                    "focus:bg-muted focus:text-foreground",
                    selected && "bg-info-soft text-info focus:bg-info-soft focus:text-info",
                  )}
                >
                  <span className="truncate font-mono">{model}</span>
                  {selected ? <Check className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                </DropdownMenuItem>
              );
            })
          )}
          {onAddModel ? (
            <>
              <DropdownMenuSeparator className="my-1 h-px bg-border/60" />
              <DropdownMenuItem
                onSelect={onAddModel}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-lg px-3 py-2 text-ui",
                  "focus:bg-muted focus:text-foreground text-primary",
                )}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{addModelLabel}</span>
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ProviderSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <ByokSectionHeader title={title} count={count} />
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
        {count > 0 ? (
          <div className="divide-y divide-border/50">{children}</div>
        ) : (
          <ByokEmptyState>{empty}</ByokEmptyState>
        )}
      </div>
    </section>
  );
}

function ByokSectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-ui font-semibold tracking-[-0.01em] text-foreground/85">
        {title}
      </h2>
      <span className="rounded-full bg-muted px-2 py-0.5 text-micro font-medium text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function ByokEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border/65 bg-card/45 px-4 py-5 text-ui text-muted-foreground">
      {children}
    </div>
  );
}

function orderUnconfiguredProviders(
  providers: SettingsPayload["providers"],
): SettingsPayload["providers"] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => {
      const rank = providerVisibilityRank(left.provider) - providerVisibilityRank(right.provider);
      return rank || left.index - right.index;
    })
    .map(({ provider }) => provider);
}

function providerVisibilityRank(provider: SettingsPayload["providers"][number]): number {
  const localRank = LOCAL_UNCONFIGURED_PROVIDER_ORDER.get(provider.name);
  if (localRank !== undefined) return localRank;
  if ((provider.api_key_required ?? true) === false) return 100;
  return 200;
}

function filterProviders(
  providers: SettingsPayload["providers"],
  query: string,
): SettingsPayload["providers"] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return providers;
  return providers.filter((provider) =>
    `${provider.name} ${provider.label} ${provider.api_base ?? ""} ${provider.default_api_base ?? ""}`
      .toLowerCase()
      .includes(normalized),
  );
}

function optionRowsWithCurrent(
  options: Array<{ name: string; label: string }>,
  value: string,
): Array<{ name: string; label: string }> {
  if (!value || options.some((option) => option.name === value)) return options;
  return [{ name: value, label: value }, ...options];
}

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  custom: Hexagon,
  openrouter: Sparkles,
  skywork: Sparkles,
  aihubmix: Triangle,
  anthropic: Brain,
  openai: Bot,
  deepseek: Waves,
  zhipu: Grid3X3,
  dashscope: Cloud,
  dashscope_coding_plan: Cloud,
  moonshot: Moon,
  minimax: Zap,
  minimax_anthropic: Brain,
  groq: Cpu,
  huggingface: Layers,
  gemini: Gem,
  mistral: Orbit,
  siliconflow: Layers,
  agnes: Sparkles,
  volcengine: Cloud,
  volcengine_coding_plan: Cloud,
  byteplus: Cloud,
  byteplus_coding_plan: Cloud,
  qianfan: Database,
  ant_ling: Sparkles,
  azure_openai: Cloud,
  bedrock: Database,
  vllm: Cpu,
  ollama: Cpu,
  lm_studio: Cpu,
  atomic_chat: Cpu,
  ovms: Cpu,
  nvidia: Zap,
};

function ProviderIcon({ provider }: { provider: string }) {
  const Icon = PROVIDER_ICONS[provider] ?? Hexagon;
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground/82 dark:bg-muted/70">
      <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
    </span>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

function SettingsRow({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[62px] flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0">
        <div className="text-body font-medium text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 max-w-[28rem] text-caption text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? <div className="shrink-0 sm:ml-6">{children}</div> : null}
    </div>
  );
}

function ReadOnlyRow({ title, value }: { title: string; value: string }) {
  return (
    <SettingsRow title={title}>
      <span className="block max-w-[320px] truncate text-right text-ui text-muted-foreground">
        {value}
      </span>
    </SettingsRow>
  );
}

function RestartSettingsFooter({
  dirty,
  saving,
  pendingRestart,
  disabled = false,
  message,
  dirtyMessage,
  pendingMessage,
  onSave,
  onRestart,
  onReset,
  isRestarting,
}: {
  dirty: boolean;
  saving: boolean;
  pendingRestart: boolean;
  disabled?: boolean;
  message?: string;
  dirtyMessage?: string;
  pendingMessage?: string;
  onSave: () => void;
  onRestart?: () => void;
  onReset?: () => void;
  isRestarting?: boolean;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const statusMessage =
    message ??
    (pendingRestart && !dirty
      ? pendingMessage ?? tx("settings.status.savedRestartApply", "Saved. Restart when ready.")
      : dirty
        ? dirtyMessage ?? t("settings.status.unsaved")
        : undefined);
  const statusTone = disabled ? "danger" : dirty || pendingRestart ? "accent" : undefined;

  return (
    <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 text-ui leading-5 text-muted-foreground">
        <SettingsStatusMessage tone={statusTone}>{statusMessage}</SettingsStatusMessage>
      </div>
      <div className="flex w-full shrink-0 flex-wrap justify-end gap-2 sm:w-auto">
        {pendingRestart && !dirty && onRestart ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRestart}
            disabled={isRestarting}
            className="rounded-full"
          >
            {isRestarting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            )}
            {isRestarting ? t("app.system.restarting") : t("app.system.restart")}
          </Button>
        ) : null}
        {onReset ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onReset}
            disabled={!dirty || saving}
            className="rounded-full"
          >
            {t("settings.actions.cancel")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={onSave}
          disabled={!dirty || disabled || saving}
          className="rounded-full"
        >
          {saving ? t("settings.actions.saving") : t("settings.actions.save")}
        </Button>
      </div>
    </div>
  );
}

function SettingsStatusMessage({
  children,
  tone,
}: {
  children?: ReactNode;
  tone?: "accent" | "danger";
}) {
  if (!children) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2",
        tone === "accent" && "font-medium text-blue-600 dark:text-blue-300",
        tone === "danger" && "font-medium text-destructive",
      )}
    >
      {tone ? (
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            tone === "accent" &&
              "bg-blue-500 ring ring-blue-500/15 dark:bg-blue-400 dark:ring-blue-400/20",
            tone === "danger" && "bg-destructive/70",
          )}
          aria-hidden
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "info";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[260px] items-center rounded-full px-2.5 py-1 text-caption font-medium",
        tone === "success" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "warning" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        tone === "info" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function ToggleButton({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      title={label}
    />
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
        className="h-8 w-24 rounded-full text-ui"
      />
      {suffix ? <span className="text-caption text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");

  let key = event.key;
  if (/^[a-z]$/i.test(key)) {
    key = key.toUpperCase();
  } else if (key === " ") {
    key = "Space";
  } else {
    const aliases: Record<string, string> = {
      Escape: "Esc",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
    };
    key = aliases[key] ?? key;
  }

  if (!key || key.length > 12) return null;
  parts.push(key);
  return parts.join("+");
}

function DesktopSettings({ token }: { token: string | null }) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await getDesktopSettings();
      setSettings({ ...s, send_message_shortcut: s.send_message_shortcut ?? "enter" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const updateSetting = async (patch: Partial<DesktopAppSettings>) => {
    if (!settings) return;
    setError(null);
    try {
      const updated = await updateDesktopSettings({ ...settings, ...patch });
      setSettings(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!settings) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {tx("settings.status.loading", "Loading...")}
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.desktop.behavior", "窗口行为")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.desktop.runInBackground", "后台运行")}
            description={tx("settings.desktop.runInBackgroundHelp", "启用后，关闭窗口会将 Mona 隐藏到系统托盘而非退出。网关继续运行，仍可通过浏览器访问。")}
          >
            <ToggleButton
              checked={settings.run_in_background}
              onChange={(run_in_background) => updateSetting({ run_in_background })}
              label={settings.run_in_background ? tx("settings.values.on", "开") : tx("settings.values.off", "关")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.desktop.autoStartGateway", "自动启动网关")}
            description={tx("settings.desktop.autoStartGatewayHelp", "Mona 启动时自动启动网关。")}
          >
            <ToggleButton
              checked={settings.auto_start_gateway}
              onChange={(auto_start_gateway) => updateSetting({ auto_start_gateway })}
              label={settings.auto_start_gateway ? tx("settings.values.on", "开") : tx("settings.values.off", "关")}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>

      <AutomationSettings token={token} />

      {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
    </div>
  );
}

const SIDEBAR_SHORTCUT_ITEMS: Array<{ key: keyof SidebarShortcuts; label: string }> = [
  { key: "mona", label: "Mona" },
  { key: "note", label: "笔记" },
  { key: "ssh", label: "终端" },
  { key: "email", label: "邮件" },
  { key: "schedule", label: "日程" },
  { key: "db", label: "数据库" },
];

const DEFAULT_SIDEBAR_SHORTCUTS: SidebarShortcuts = {
  mona: "Alt+1",
  note: "Alt+2",
  ssh: "Alt+3",
  email: "Alt+4",
  schedule: "Alt+5",
  db: "Alt+6",
};

export function ShortcutsSettings() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [sendShortcutSaving, setSendShortcutSaving] = useState(false);
  const [sendShortcutError, setSendShortcutError] = useState<string | null>(null);
  const [quickAskDraft, setQuickAskDraft] = useState("Ctrl+Alt+M");
  const [quickAskSaving, setQuickAskSaving] = useState(false);
  const [quickAskSaved, setQuickAskSaved] = useState(false);
  const [quickAskError, setQuickAskError] = useState<string | null>(null);
  const [quickAskMode, setQuickAskMode] = useState("compact");
  const [sidebarDrafts, setSidebarDrafts] = useState<SidebarShortcuts>(DEFAULT_SIDEBAR_SHORTCUTS);
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const [sidebarSaved, setSidebarSaved] = useState(false);
  const [sidebarError, setSidebarError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await getDesktopSettings();
      setSettings({ ...s, send_message_shortcut: s.send_message_shortcut ?? "enter" });
      setQuickAskDraft(s.quick_ask_shortcut || "Ctrl+Alt+M");
      setQuickAskMode(s.quick_ask_mode || "compact");
      setSidebarDrafts(s.sidebar_shortcuts || DEFAULT_SIDEBAR_SHORTCUTS);
    } catch (e) {
      console.error("Failed to load desktop settings:", e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const quickAskDirty = settings
    ? quickAskDraft.trim() !== settings.quick_ask_shortcut
    : false;

  const quickAskModeDirty = settings
    ? quickAskMode !== settings.quick_ask_mode
    : false;

  const sidebarDirty = settings
    ? Object.keys(DEFAULT_SIDEBAR_SHORTCUTS).some(
        (key) => sidebarDrafts[key as keyof SidebarShortcuts] !== settings!.sidebar_shortcuts[key as keyof SidebarShortcuts],
      )
    : false;

  const saveSendMessageShortcut = async (send_message_shortcut: SendMessageShortcut) => {
    if (!settings || sendShortcutSaving || settings.send_message_shortcut === send_message_shortcut) {
      return;
    }
    setSendShortcutSaving(true);
    setSendShortcutError(null);
    try {
      const updated = await updateDesktopSettings({ ...settings, send_message_shortcut });
      setSettings(updated);
      window.dispatchEvent(
        new CustomEvent<SendMessageShortcut>(SEND_MESSAGE_SHORTCUT_EVENT, {
          detail: updated.send_message_shortcut,
        }),
      );
    } catch (e) {
      setSendShortcutError(e instanceof Error ? e.message : String(e));
    } finally {
      setSendShortcutSaving(false);
    }
  };

  const saveQuickAsk = async () => {
    if (!settings || quickAskSaving || (!quickAskDirty && !quickAskModeDirty)) return;
    setQuickAskSaving(true);
    setQuickAskError(null);
    setQuickAskSaved(false);
    try {
      const updated = await updateDesktopSettings({
        ...settings,
        quick_ask_shortcut: quickAskDraft.trim(),
        quick_ask_mode: quickAskMode,
      });
      setSettings(updated);
      setQuickAskDraft(updated.quick_ask_shortcut);
      setQuickAskMode(updated.quick_ask_mode);
      setQuickAskSaved(true);
      window.setTimeout(() => setQuickAskSaved(false), 2400);
    } catch (e) {
      setQuickAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuickAskSaving(false);
    }
  };

  const saveSidebarShortcuts = async () => {
    if (!settings || sidebarSaving || !sidebarDirty) return;
    setSidebarSaving(true);
    setSidebarError(null);
    setSidebarSaved(false);
    try {
      const updated = await updateDesktopSettings({
        ...settings,
        sidebar_shortcuts: sidebarDrafts,
      });
      setSettings(updated);
      setSidebarDrafts(updated.sidebar_shortcuts);
      setSidebarSaved(true);
      window.setTimeout(() => setSidebarSaved(false), 2400);
    } catch (e) {
      setSidebarError(e instanceof Error ? e.message : String(e));
    } finally {
      setSidebarSaving(false);
    }
  };

  const handleQuickAskKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      setQuickAskDraft("");
      setQuickAskSaved(false);
      setQuickAskError(null);
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) return;
    event.preventDefault();
    setQuickAskDraft(shortcut);
    setQuickAskSaved(false);
    setQuickAskError(null);
  };

  const handleSidebarShortcutKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
    key: keyof SidebarShortcuts,
  ) => {
    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      setSidebarDrafts((prev) => ({ ...prev, [key]: "" }));
      setSidebarSaved(false);
      setSidebarError(null);
      return;
    }
    const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
    if (!shortcut) return;
    event.preventDefault();
    setSidebarDrafts((prev) => ({ ...prev, [key]: shortcut }));
    setSidebarSaved(false);
    setSidebarError(null);
  };

  if (!settings) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {tx("settings.status.loading", "Loading...")}
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.shortcuts.messageInput", "消息输入")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.shortcuts.sendMessage", "发送消息")}
            description={tx("settings.shortcuts.sendMessageHelp", "选择在消息输入框中用于发送的按键。")}
          >
            <div className="flex items-center gap-1 rounded-full border border-border p-0.5">
              {([
                ["enter", tx("settings.shortcuts.enterToSend", "Enter")],
                ["ctrl_enter", tx("settings.shortcuts.ctrlEnterToSend", "Ctrl + Enter")],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sendShortcutSaving}
                  onClick={() => void saveSendMessageShortcut(value)}
                  className={cn(
                    "h-auto rounded-full px-3 py-1 text-ui font-normal",
                    settings.send_message_shortcut === value
                      ? "bg-info/[0.10] text-info hover:bg-info/[0.14]"
                      : "text-muted-foreground hover:bg-transparent hover:text-foreground",
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
          </SettingsRow>
        </SettingsGroup>
        {sendShortcutError ? (
          <p className="mt-2 px-1 text-caption text-destructive">{sendShortcutError}</p>
        ) : null}
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.shortcuts.quickAsk", "快问快捷键")}</SubsectionLabel>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.desktop.quickAskShortcut", "快问快捷键")}
            description={tx("settings.desktop.quickAskShortcutHelp", "按下此快捷键会唤出置顶的 Mona 快问窗口。")}
          >
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-2">
                <Input
                  value={quickAskDraft}
                  onChange={(event) => {
                    setQuickAskDraft(event.target.value);
                    setQuickAskSaved(false);
                    setQuickAskError(null);
                  }}
                  onKeyDown={handleQuickAskKeyDown}
                  placeholder="Ctrl+Alt+M"
                  className="h-8 w-44 rounded-full text-right text-ui"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveQuickAsk}
                  disabled={(!quickAskDirty && !quickAskModeDirty) || quickAskSaving}
                  className="rounded-full"
                >
                  {quickAskSaving
                    ? tx("settings.actions.saving", "保存中...")
                    : tx("settings.actions.save", "保存")}
                </Button>
              </div>
              <div className="max-w-[320px] text-right text-caption leading-5 text-muted-foreground">
                {quickAskError ? (
                  <span className="text-destructive">{quickAskError}</span>
                ) : quickAskSaved ? (
                  <span className="text-blue-600 dark:text-blue-300">
                    {tx("settings.status.saved", "已保存")}
                  </span>
                ) : (
                  tx("settings.desktop.quickAskShortcutFormat", "建议使用 Ctrl / Alt / Shift 加字母组合。")
                )}
              </div>
            </div>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.desktop.quickAskMode", "打开方式")}
            description={tx("settings.desktop.quickAskModeHelp", "选择按下快捷键后的打开方式。")}
          >
            <div className="flex items-center gap-1 rounded-full border border-border p-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setQuickAskMode("compact"); setQuickAskSaved(false); }}
                className={cn(
                  "h-auto rounded-full px-3 py-1 text-ui font-normal",
                  quickAskMode === "compact"
                    ? "bg-info/[0.10] text-info hover:bg-info/[0.14]"
                    : "text-muted-foreground hover:bg-transparent hover:text-foreground",
                )}
              >
                {tx("settings.desktop.quickAskModeCompact", "简洁模式")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setQuickAskMode("full"); setQuickAskSaved(false); }}
                className={cn(
                  "h-auto rounded-full px-3 py-1 text-ui font-normal",
                  quickAskMode === "full"
                    ? "bg-info/[0.10] text-info hover:bg-info/[0.14]"
                    : "text-muted-foreground hover:bg-transparent hover:text-foreground",
                )}
              >
                {tx("settings.desktop.quickAskModeFull", "完整模式")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SubsectionLabel className="mb-2 px-1">{tx("settings.shortcuts.sidebarNav", "侧边栏导航快捷键")}</SubsectionLabel>
        <SettingsGroup>
          {SIDEBAR_SHORTCUT_ITEMS.map(({ key, label }) => (
            <SettingsRow
              key={key}
              title={`切换至${label}`}
            >
              <Input
                value={sidebarDrafts[key]}
                onChange={(event) => {
                  setSidebarDrafts((prev) => ({ ...prev, [key]: event.target.value }));
                  setSidebarSaved(false);
                  setSidebarError(null);
                }}
                onKeyDown={(event) => handleSidebarShortcutKeyDown(event, key)}
                placeholder={DEFAULT_SIDEBAR_SHORTCUTS[key]}
                className="h-8 w-44 rounded-full text-right text-ui"
              />
            </SettingsRow>
          ))}
          <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0 text-ui leading-5 text-muted-foreground">
              {sidebarError ? (
                <span className="text-destructive">{sidebarError}</span>
              ) : sidebarSaved ? (
                <span className="text-blue-600 dark:text-blue-300">
                  {tx("settings.status.saved", "已保存")}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={saveSidebarShortcuts}
                disabled={!sidebarDirty || sidebarSaving}
                className="rounded-full"
              >
                {sidebarSaving
                  ? tx("settings.actions.saving", "保存中...")
                  : tx("settings.actions.save", "保存")}
              </Button>
            </div>
          </div>
        </SettingsGroup>
      </section>
    </div>
  );
}
