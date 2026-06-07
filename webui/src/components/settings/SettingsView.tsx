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
  Activity,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Cpu,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  Gem,
  Globe2,
  Copy,
  Grid3X3,
  HardDrive,
  Hexagon,
  ImageIcon,
  Info,
  KeyRound,
  Keyboard,
  Layers,
  Loader2,
  Monitor,
  Moon,
  Orbit,
  Palette,
  Pencil,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Triangle,
  Trash2,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Button } from "@/components/ui/button";
import { useLicense } from "@/hooks/useLicense";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  fetchSettings,
  updateImageGenerationSettings,
  updateProviderSettings,
  updateSettings,
  updateWebSearchSettings,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  isTauri,
  getDesktopSettings,
  updateDesktopSettings,
  getGatewayStatus,
  type DesktopAppSettings,
  type SidebarShortcuts,
} from "@/lib/tauri";
import { useClient } from "@/providers/ClientProvider";
import type {
  ImageGenerationSettingsUpdate,
  SettingsPayload,
  WebSearchSettingsUpdate,
} from "@/lib/types";

type SettingsSectionKey =
  | "overview"
  | "appearance"
  | "models_providers"
  | "image"
  | "web"
  | "runtime"
  | "desktop"
  | "shortcuts"
  | "advanced"
  | "about";

type LocalDensity = "comfortable" | "compact";
type LocalActivityMode = "auto" | "expanded";

interface LocalPreferences {
  density: LocalDensity;
  activityMode: LocalActivityMode;
  codeWrap: boolean;
}

interface AgentSettingsDraft {
  model: string;
  provider: string;
  modelPreset: string;
  timezone: string;
  botName: string;
  botIcon: string;
  toolHintMaxLength: number;
  workspace: string;
}

type PendingRestartSection = "runtime" | "web" | "image";
type PendingRestartSections = Record<PendingRestartSection, boolean>;

const LOCAL_PREFS_STORAGE_KEY = "mona-webui.settings-preferences";

const DEFAULT_LOCAL_PREFS: LocalPreferences = {
  density: "comfortable",
  activityMode: "auto",
  codeWrap: true,
};

const LOCAL_UNCONFIGURED_PROVIDER_ORDER = new Map(
  ["vllm", "ollama", "lm_studio", "atomic_chat", "ovms"].map((name, index) => [
    name,
    index,
  ]),
);

const IMAGE_ASPECT_RATIO_OPTIONS = ["1:1", "3:4", "9:16", "4:3", "16:9", "3:2", "2:3", "21:9"];
const IMAGE_SIZE_OPTIONS = ["1K", "2K", "4K", "1024x1024", "1536x1024", "1024x1536"];
const EMPTY_PENDING_RESTART_SECTIONS: PendingRestartSections = {
  runtime: false,
  web: false,
  image: false,
};

interface SettingsViewProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onBackToChat: () => void;
  onModelNameChange: (modelName: string | null) => void;
  onRestart?: () => void;
  isRestarting?: boolean;
}

function readLocalPreferences(): LocalPreferences {
  try {
    const raw = window.localStorage.getItem(LOCAL_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_LOCAL_PREFS;
    const parsed = JSON.parse(raw) as Partial<LocalPreferences>;
    return {
      density: parsed.density === "compact" ? "compact" : "comfortable",
      activityMode: parsed.activityMode === "expanded" ? "expanded" : "auto",
      codeWrap: parsed.codeWrap !== false,
    };
  } catch {
    return DEFAULT_LOCAL_PREFS;
  }
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
}: SettingsViewProps) {
  const { t } = useTranslation();
  const { token } = useClient();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providerSaving, setProviderSaving] = useState<string | null>(null);
  const [webSearchSaving, setWebSearchSaving] = useState(false);
  const [imageGenerationSaving, setImageGenerationSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionKey>("overview");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [providerForms, setProviderForms] = useState<Record<string, { apiKey: string; apiBase: string; model: string }>>({});
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({});
  const [editingProviderKeys, setEditingProviderKeys] = useState<Record<string, boolean>>({});
  const [highlightProvider, setHighlightProvider] = useState<string | null>(null);
  const [pendingRestartSections, setPendingRestartSections] = useState<PendingRestartSections>(
    EMPTY_PENDING_RESTART_SECTIONS,
  );
  const [localPrefs, setLocalPrefs] = useState<LocalPreferences>(() => readLocalPreferences());
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
  const [webSearchKeyVisible, setWebSearchKeyVisible] = useState(false);
  const [webSearchKeyEditing, setWebSearchKeyEditing] = useState(false);
  const [form, setForm] = useState<AgentSettingsDraft>({
    model: "",
    provider: "",
    modelPreset: "default",
    timezone: "UTC",
    botName: "mona",
    botIcon: "",
    toolHintMaxLength: 40,
    workspace: "",
  });

  const text = useCallback(
    (key: string, fallback: string, options?: Record<string, unknown>) =>
      t(key, { defaultValue: fallback, ...(options ?? {}) }),
    [t],
  );

  const applyPayload = useCallback((payload: SettingsPayload) => {
    const fallbackDefault = defaultPreset(payload);
    setSettings(payload);
    setForm({
      model: fallbackDefault?.model ?? payload.agent.model,
      provider: editableDefaultProvider(payload),
      modelPreset: modelPresetValue(payload),
      timezone: payload.agent.timezone,
      botName: payload.agent.bot_name,
      botIcon: payload.agent.bot_icon,
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
    if (payload.restart_required_sections) {
      setPendingRestartSections({
        runtime: payload.restart_required_sections.includes("runtime"),
        web: payload.restart_required_sections.includes("web"),
        image: payload.restart_required_sections.includes("image"),
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

  useEffect(() => {
    try {
      window.localStorage.setItem(LOCAL_PREFS_STORAGE_KEY, JSON.stringify(localPrefs));
    } catch {
      // Browser-only preferences should never block settings.
    }
  }, [localPrefs]);

  useEffect(() => {
    if (!settings) return;
    setProviderForms((prev) => {
      const next = { ...prev };
      for (const provider of settings.providers) {
        next[provider.name] = {
          apiKey: next[provider.name]?.apiKey ?? "",
          apiBase: next[provider.name]?.apiBase ?? provider.api_base ?? provider.default_api_base ?? "",
          model: next[provider.name]?.model ?? provider.model ?? "",
        };
      }
      return next;
    });
  }, [settings]);

  const runtimeDirty = useMemo(() => {
    if (!settings) return false;
    return (
      form.timezone !== settings.agent.timezone ||
      form.botName !== settings.agent.bot_name ||
      form.botIcon !== settings.agent.bot_icon ||
      form.toolHintMaxLength !== settings.agent.tool_hint_max_length ||
      form.workspace !== settings.runtime.workspace_path
    );
  }, [form, settings]);

  const imageGenerationDirty = useMemo(() => {
    if (!settings) return false;
    return (
      imageGenerationForm.enabled !== settings.image_generation.enabled ||
      imageGenerationForm.provider !== settings.image_generation.provider ||
      imageGenerationForm.model !== settings.image_generation.model ||
      imageGenerationForm.defaultAspectRatio !== settings.image_generation.default_aspect_ratio ||
      imageGenerationForm.defaultImageSize !== settings.image_generation.default_image_size ||
      imageGenerationForm.maxImagesPerTurn !== settings.image_generation.max_images_per_turn
    );
  }, [imageGenerationForm, settings]);

  const hasPendingRestart = useMemo(
    () =>
      !!settings?.requires_restart ||
      pendingRestartSections.runtime ||
      pendingRestartSections.web ||
      pendingRestartSections.image,
    [pendingRestartSections, settings?.requires_restart],
  );

  const saveRuntimeSettings = async () => {
    if (!settings || !runtimeDirty || saving) return;
    setSaving(true);
    try {
      const payload = await updateSettings(token, {
        timezone: form.timezone,
        botName: form.botName,
        botIcon: form.botIcon,
        toolHintMaxLength: form.toolHintMaxLength,
        workspace: form.workspace,
      });
      applyPayload(payload);
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

  const saveImageGenerationSettings = async () => {
    if (!settings || !imageGenerationDirty || imageGenerationSaving) return;
    setImageGenerationSaving(true);
    try {
      const payload = await updateImageGenerationSettings(token, imageGenerationForm);
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, image: true }));
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImageGenerationSaving(false);
    }
  };

  const saveProvider = async (providerName: string) => {
    if (providerSaving) return;
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    const providerForm = providerForms[providerName] ?? { apiKey: "", apiBase: "", model: "" };
    const apiKey = providerForm.apiKey.trim();
    const apiBase = providerForm.apiBase.trim();
    const model = providerForm.model.trim();
    const apiKeyRequired = provider.api_key_required ?? true;
    if (!provider.configured && apiKeyRequired && !apiKey) {
      setError(t("settings.byok.apiKeyRequired"));
      return;
    }
    setProviderSaving(providerName);
    try {
      const payload = await updateProviderSettings(token, {
        provider: providerName,
        apiKey,
        apiBase,
        model: model || undefined,
      });
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, image: true }));
      }
      setProviderForms((prev) => ({
        ...prev,
        [providerName]: {
          apiKey: "",
          apiBase,
          model,
        },
      }));
      setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(null);
    }
  };

  const deleteProvider = async (providerName: string) => {
    if (providerSaving) return;
    setProviderSaving(providerName);
    try {
      const payload = await updateProviderSettings(token, {
        provider: providerName,
        apiKey: "",
        apiBase: "",
      });
      applyPayload(payload);
      if (payload.requires_restart) {
        setPendingRestartSections((prev) => ({ ...prev, image: true }));
      }
      setProviderForms((prev) => ({
        ...prev,
        [providerName]: { apiKey: "", apiBase: "", model: "" },
      }));
      setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
      setExpandedProvider(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProviderSaving(null);
    }
  };

  const setDefaultProvider = async (providerName: string) => {
    if (providerSaving) return;
    const provider = settings?.providers.find((p) => p.name === providerName);
    const model = provider?.model ?? "";
    if (!model) return;
    try {
      const payload = await updateSettings(token, {
        provider: providerName,
        model,
        providerModel: model,
      });
      applyPayload(payload);
      onModelNameChange?.(payload.agent.model || null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
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
      applyPayload(payload);
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

  const resetProviderDraft = useCallback((providerName: string) => {
    const provider = settings?.providers.find((item) => item.name === providerName);
    if (!provider) return;
    setProviderForms((prev) => ({
      ...prev,
      [providerName]: {
        apiKey: "",
        apiBase: provider.api_base ?? provider.default_api_base ?? "",
        model: provider.model ?? "",
      },
    }));
    setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: false }));
    setEditingProviderKeys((prev) => ({ ...prev, [providerName]: false }));
  }, [settings]);

  const handleToggleProvider = useCallback((providerName: string) => {
    if (expandedProvider) resetProviderDraft(expandedProvider);
    setExpandedProvider(expandedProvider === providerName ? null : providerName);
  }, [expandedProvider, resetProviderDraft]);

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

  const toggleProviderKeyVisibility = (providerName: string) => {
    const isVisible = visibleProviderKeys[providerName];
    setVisibleProviderKeys((prev) => ({ ...prev, [providerName]: !isVisible }));
  };

  const toggleProviderKeyEditing = (providerName: string) => {
    setEditingProviderKeys((prev) => {
      const nextEditing = !prev[providerName];
      if (!nextEditing) {
        setProviderForms((forms) => ({
          ...forms,
          [providerName]: {
            apiKey: "",
            apiBase: forms[providerName]?.apiBase ?? "",
            model: forms[providerName]?.model ?? "",
          },
        }));
        setVisibleProviderKeys((visible) => ({ ...visible, [providerName]: false }));
      }
      return { ...prev, [providerName]: nextEditing };
    });
  };

  const renderSection = () => {
    if (!settings) return null;
    switch (activeSection) {
      case "overview":
        return (
          <OverviewSettings
            settings={settings}
            requiresRestart={hasPendingRestart}
            onRestart={onRestart}
            isRestarting={isRestarting}
            onSelectSection={setActiveSection}
          />
        );
      case "appearance":
        return (
          <AppearanceSettings
            theme={theme}
            onToggleTheme={onToggleTheme}
            localPrefs={localPrefs}
            onChangeLocalPrefs={setLocalPrefs}
          />
        );
      case "models_providers":
        return (
          <ModelsProvidersSettings
            settings={settings}
            expandedProvider={expandedProvider}
            providerForms={providerForms}
            visibleProviderKeys={visibleProviderKeys}
            editingProviderKeys={editingProviderKeys}
            providerSaving={providerSaving}
            query={providerQuery}
            onQueryChange={setProviderQuery}
            onToggleProvider={handleToggleProvider}
            onToggleProviderKey={toggleProviderKeyVisibility}
            onToggleProviderKeyEditing={toggleProviderKeyEditing}
            onChangeProviderForm={(provider, value) =>
              setProviderForms((prev) => ({
                ...prev,
                [provider]: {
                  apiKey: prev[provider]?.apiKey ?? "",
                  apiBase: prev[provider]?.apiBase ?? "",
                  model: prev[provider]?.model ?? "",
                  ...value,
                },
              }))
            }
            onSaveProvider={saveProvider}
            onDeleteProvider={deleteProvider}
            onResetProviderDraft={resetProviderDraft}
            onSetDefaultProvider={setDefaultProvider}
            imageProviderRestartPending={pendingRestartSections.image}
            onRestart={onRestart}
            isRestarting={isRestarting}
            highlightProvider={highlightProvider}
            onHighlightConsumed={() => setHighlightProvider(null)}
          />
        );
      case "image":
        return (
          <ImageGenerationSettings
            settings={settings}
            form={imageGenerationForm}
            dirty={imageGenerationDirty}
            saving={imageGenerationSaving}
            onChangeForm={setImageGenerationForm}
            onSave={saveImageGenerationSettings}
            onOpenProviders={(provider) => {
              setHighlightProvider(provider ?? null);
              setActiveSection("models_providers");
            }}
            onRestart={onRestart}
            isRestarting={isRestarting}
            requiresRestartPending={pendingRestartSections.image}
          />
        );
      case "web":
        return (
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
        );
      case "runtime":
        return (
          <RuntimeSettings
            form={form}
            setForm={setForm}
            settings={settings}
            dirty={runtimeDirty}
            saving={saving}
            onSave={saveRuntimeSettings}
            onRestart={onRestart}
            isRestarting={isRestarting}
            requiresRestartPending={pendingRestartSections.runtime}
          />
        );
      case "desktop":
        return <DesktopSettings />;
      case "shortcuts":
        return <ShortcutsSettings />;
      case "advanced":
        return <AdvancedSettings settings={settings} />;
      case "about":
        return <AboutSettings />;
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_0%,hsl(var(--muted))_0%,hsl(var(--background))_42%)] md:flex-row">
      <SettingsSidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onBackToChat={onBackToChat}
      />

      <main className="min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 lg:py-12">
          <div className="mb-7">
            <p className="mb-2 text-[13px] font-medium text-muted-foreground">
              {t("settings.sidebar.title")}
            </p>
            <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[34px]">
              {text(`settings.nav.${activeSection}`, titleForSection(activeSection))}
            </h1>
          </div>

          {loading ? (
            <div className="flex h-48 items-center justify-center rounded-[24px] border border-border/50 bg-card/75 text-sm text-muted-foreground shadow-[0_20px_70px_rgba(15,23,42,0.07)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("settings.status.loading")}
            </div>
          ) : error && !settings ? (
            <SettingsGroup>
              <SettingsRow title={t("settings.status.loadError")}>
                <span className="max-w-[520px] text-sm text-muted-foreground">{error}</span>
              </SettingsRow>
            </SettingsGroup>
          ) : settings ? (
            <div className="space-y-5">
              {error ? (
                <div className="rounded-[18px] border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                  {error}
                </div>
              ) : null}
              {renderSection()}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

const SETTINGS_NAV_ITEMS: Array<{ key: SettingsSectionKey; icon: LucideIcon; fallback: string; desktopOnly?: boolean }> = [
  { key: "overview", icon: Activity, fallback: "Overview" },
  { key: "appearance", icon: Palette, fallback: "Appearance" },
  { key: "models_providers", icon: SlidersHorizontal, fallback: "模型供应商" },
  { key: "image", icon: ImageIcon, fallback: "Image" },
  { key: "web", icon: Globe2, fallback: "Web" },
  { key: "runtime", icon: Server, fallback: "Runtime" },
  { key: "desktop", icon: Monitor, fallback: "桌面", desktopOnly: true },
  { key: "shortcuts", icon: Keyboard, fallback: "快捷键", desktopOnly: true },
  { key: "advanced", icon: ShieldCheck, fallback: "Advanced" },
  { key: "about", icon: Info, fallback: "关于" },
];

function titleForSection(section: SettingsSectionKey): string {
  return SETTINGS_NAV_ITEMS.find((item) => item.key === section)?.fallback ?? "Settings";
}

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
    <aside className="flex w-full shrink-0 flex-col border-b border-border/55 bg-card/62 px-4 pb-3 pt-4 shadow-[inset_0_-1px_0_rgba(255,255,255,0.55)] backdrop-blur-xl dark:bg-card/45 dark:shadow-none md:w-[17rem] md:border-b-0 md:border-r md:px-3 md:py-4 md:shadow-[inset_-1px_0_0_rgba(255,255,255,0.55)]">
      <button
        type="button"
        onClick={onBackToChat}
        className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground md:mb-3"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        {t("settings.backToChat")}
      </button>
      <div className="mb-3 px-1 md:mb-4 md:px-2">
        <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-foreground">
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
            <button
              key={key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelectSection(key)}
              className={cn(
                "flex h-9 w-auto shrink-0 items-center gap-2 rounded-full px-3 text-left text-[13px] font-medium transition-colors md:w-full md:rounded-[10px] md:px-2.5",
                active
                  ? "bg-muted/90 text-foreground shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)]"
                  : "text-muted-foreground/78 hover:bg-muted/45 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              <span className="truncate">{t(`settings.nav.${key}`, { defaultValue: fallback })}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function OverviewSettings({
  settings,
  requiresRestart,
  onRestart,
  isRestarting,
  onSelectSection,
}: {
  settings: SettingsPayload;
  requiresRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onSelectSection: (section: SettingsSectionKey) => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const configuredCount = settings.providers.filter((provider) => provider.configured).length;
  const activePreset = settings.agent.model_preset || "default";
  const activeProvider = settings.agent.resolved_provider ?? settings.agent.provider;
  const webStatus = settings.web.enable
    ? tx("settings.values.enabled", "Enabled")
    : tx("settings.values.disabled", "Disabled");
  const imageStatus = settings.image_generation.enabled
    ? tx("settings.values.enabled", "Enabled")
    : tx("settings.values.disabled", "Disabled");
  const imageCaption = `${providerLabel(settings.image_generation.providers, settings.image_generation.provider)} · ${
    settings.image_generation.provider_configured
      ? tx("settings.values.configured", "Configured")
      : tx("settings.values.notConfigured", "Not configured")
  }`;
  return (
    <div className="space-y-7">
      <section>
        <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[16px] bg-muted text-foreground/82 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)] dark:bg-muted/70">
                <Bot className="h-6 w-6" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-muted-foreground">mona</div>
                <div className="mt-0.5 truncate text-[18px] font-semibold leading-6 text-foreground">
                  {settings.agent.model}
                </div>
                <div className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">
                  {activeProvider} · {activePreset}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <StatusPill tone={requiresRestart ? "neutral" : "success"}>
                {requiresRestart
                  ? tx("settings.values.restartPending", "Restart pending")
                  : tx("settings.values.ready", "Ready")}
              </StatusPill>
              {requiresRestart && onRestart ? (
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
            </div>
          </div>
        </div>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.ai", "AI")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Bot}
            title={tx("settings.overview.model", "Current model")}
            value={settings.agent.model}
            caption={`${activeProvider} · ${activePreset}`}
            onClick={() => onSelectSection("models_providers")}
          />
          <OverviewListRow
            icon={KeyRound}
            title={tx("settings.overview.providers", "Providers")}
            value={tx("settings.overview.configuredCount", "{{count}} configured").replace(
              "{{count}}",
              String(configuredCount),
            )}
            caption={tx("settings.overview.totalProviders", "{{count}} available").replace(
              "{{count}}",
              String(settings.providers.length),
            )}
            onClick={() => onSelectSection("models_providers")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.capabilities", "Capabilities")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Globe2}
            title={tx("settings.overview.webSearch", "Web search")}
            value={providerLabel(settings.web_search.providers, settings.web_search.provider)}
            caption={webStatus}
            onClick={() => onSelectSection("web")}
          />
          <OverviewListRow
            icon={ImageIcon}
            title={tx("settings.overview.imageGeneration", "Image generation")}
            value={imageStatus}
            caption={imageCaption}
            onClick={() => onSelectSection("image")}
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.system", "System")}</SettingsSectionTitle>
        <SettingsGroup>
          <OverviewListRow
            icon={Server}
            title={tx("settings.rows.gateway", "Gateway")}
            value={`${settings.runtime.gateway_host}:${settings.runtime.gateway_port}`}
            caption={
              requiresRestart
                ? tx("settings.values.restartPending", "Restart pending")
                : tx("settings.values.ready", "Ready")
            }
            onClick={() => onSelectSection("runtime")}
          />
          <OverviewListRow
            icon={HardDrive}
            title={tx("settings.overview.workspace", "Workspace")}
            value={settings.runtime.workspace_path}
            caption={settings.runtime.config_path}
            onClick={() => onSelectSection("runtime")}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

function AppearanceSettings({
  theme,
  onToggleTheme,
  localPrefs,
  onChangeLocalPrefs,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  localPrefs: LocalPreferences;
  onChangeLocalPrefs: Dispatch<SetStateAction<LocalPreferences>>;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{t("settings.sections.interface")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={t("settings.rows.theme")}
            description={t("settings.help.theme")}
          >
            <button
              type="button"
              onClick={onToggleTheme}
              className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-[12px] font-medium text-muted-foreground"
            >
              <span
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  theme === "light" && "bg-background text-foreground shadow-sm",
                )}
              >
                {t("settings.values.light")}
              </span>
              <span
                className={cn(
                  "rounded-full px-3 py-1 transition-colors",
                  theme === "dark" && "bg-background text-foreground shadow-sm",
                )}
              >
                {t("settings.values.dark")}
              </span>
            </button>
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
        <SettingsSectionTitle>{tx("settings.sections.localPreferences", "Local preferences")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.density", "Density")}
            description={tx("settings.help.density", "Stored only in this browser.")}
          >
            <SegmentedControl
              value={localPrefs.density}
              options={[
                { value: "comfortable", label: tx("settings.values.comfortable", "Comfortable") },
                { value: "compact", label: tx("settings.values.compact", "Compact") },
              ]}
              onChange={(density) =>
                onChangeLocalPrefs((prev) => ({ ...prev, density: density as LocalDensity }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.activityMode", "Activity detail")}
            description={tx("settings.help.activityMode", "Choose how much agent activity chrome to show by default.")}
          >
            <SegmentedControl
              value={localPrefs.activityMode}
              options={[
                { value: "auto", label: tx("settings.values.auto", "Auto") },
                { value: "expanded", label: tx("settings.values.expanded", "Expanded") },
              ]}
              onChange={(activityMode) =>
                onChangeLocalPrefs((prev) => ({ ...prev, activityMode: activityMode as LocalActivityMode }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.codeWrap", "Code wrapping")}
            description={tx("settings.help.codeWrap", "Keep long code lines readable on smaller screens.")}
          >
            <ToggleButton
              checked={localPrefs.codeWrap}
              onChange={(codeWrap) => onChangeLocalPrefs((prev) => ({ ...prev, codeWrap }))}
              label={localPrefs.codeWrap ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
        </SettingsGroup>
      </section>
    </div>
  );
}

function ModelsProvidersSettings({
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
  imageProviderRestartPending,
  onRestart,
  isRestarting,
  highlightProvider,
  onHighlightConsumed,
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
  imageProviderRestartPending: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  highlightProvider?: string | null;
  onHighlightConsumed?: () => void;
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const highlightRef = useRef<HTMLDivElement>(null);

  // --- Provider list logic ---
  const configuredProviders = settings.providers.filter((provider) => provider.configured);
  const sortedConfiguredProviders = useMemo(() => {
    const free = configuredProviders.filter((p) => p.free_default_model);
    const rest = configuredProviders.filter((p) => !p.free_default_model);
    return [...free, ...rest];
  }, [configuredProviders]);
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
    const expanded = expandedProvider === provider.name && !provider.free_default_model;
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
          "divide-y divide-border/45",
          highlighted && "ring-2 ring-inset ring-primary/40 rounded-[18px]",
        )}
      >
        <button
          type="button"
          onClick={() => !provider.free_default_model && onToggleProvider(provider.name)}
          className={cn(
            "flex min-h-[70px] w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors sm:px-5",
            provider.free_default_model ? "cursor-default" : "hover:bg-muted/35",
          )}
        >
          <span className="flex min-w-0 items-center gap-3">
            <ProviderIcon provider={provider.name} />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[15px] font-semibold leading-5 text-foreground">
                  {provider.label}
                </span>
                {settings.agent.provider === provider.name ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    <Star className="h-2.5 w-2.5" aria-hidden />
                    默认
                  </span>
                ) : null}
                {settings.image_generation.provider === provider.name ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    <ImageIcon className="h-2.5 w-2.5" aria-hidden />
                    {tx("settings.image.badge", "Image")}
                  </span>
                ) : null}
              </span>
              {!provider.free_default_model && (
                <span className="block truncate text-[12px] text-muted-foreground">
                  {provider.api_base || provider.default_api_base || provider.name}
                </span>
              )}
            </span>
          </span>
          <StatusPill
            tone={
              provider.free_default_model
                ? "info"
                : provider.configured
                  ? "success"
                  : "neutral"
            }
          >
            {provider.free_default_model
              ? tx("settings.byok.builtin", "内置")
              : provider.configured
                ? t("settings.byok.configured")
                : t("settings.byok.notConfigured")}
          </StatusPill>
        </button>

        {expanded ? (
          <div className="space-y-3 bg-muted/18 px-4 py-4 sm:px-5">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
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
                      className="h-9 rounded-full pr-11 text-[13px]"
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
                    <div className="flex h-9 items-center rounded-full border border-input bg-background px-3 pr-11 text-[13px] text-muted-foreground">
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
              <span className="text-[12px] font-medium text-muted-foreground">
                {t("settings.byok.apiBase")}
              </span>
              <Input
                value={form.apiBase}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { apiBase: event.target.value })
                }
                placeholder={provider.default_api_base ?? t("settings.byok.apiBasePlaceholder")}
                className="h-9 rounded-full text-[13px]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">
                模型 ID
              </span>
              <Input
                value={form.model}
                onChange={(event) =>
                  onChangeProviderForm(provider.name, { model: event.target.value })
                }
                placeholder="例如 qwen3-plus, deepseek-chat"
                className="h-9 rounded-full text-[13px]"
              />
            </label>
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
                    className="rounded-full text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
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
      {/* 供应商配置区 */}
      <section>
        <SettingsSectionTitle>供应商</SettingsSectionTitle>
        {imageProviderRestartPending && onRestart ? (
          <div className="flex min-h-[48px] items-center justify-between gap-3 border-y border-border/55 py-3 mb-4">
            <p className="text-[13px] leading-5 text-muted-foreground">
              {tx("settings.status.imageProviderRestart", "Image provider changes saved. Restart when ready.")}
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
            className="h-10 rounded-full pl-9 text-[13px]"
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
}) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const selectedProvider =
    settings.image_generation.providers.find((provider) => provider.name === form.provider) ??
    settings.image_generation.providers[0];
  const providerConfigured = !!selectedProvider?.configured;
  const missingCredential = form.enabled && !providerConfigured;
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
        <SettingsSectionTitle>{tx("settings.sections.imageGeneration", "Image generation")}</SettingsSectionTitle>
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
              onChange={(provider) => onChangeForm((prev) => ({ ...prev, provider }))}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.imageProviderStatus", "Provider status")}
            description={tx("settings.help.imageProviderStatus", "Image generation reuses provider credentials from Providers.")}
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill tone={providerConfigured ? "success" : "neutral"}>
                {providerConfigured
                  ? tx("settings.values.configured", "Configured")
                  : tx("settings.values.notConfigured", "Not configured")}
              </StatusPill>
              {!providerConfigured ? (
                <Button size="sm" variant="outline" onClick={() => onOpenProviders(form.provider)} className="rounded-full">
                  {tx("settings.image.configureProvider", "Configure provider")}
                </Button>
              ) : null}
            </div>
          </SettingsRow>
          <SettingsRow title={tx("settings.rows.imageProviderBase", "Provider base")}>
            <span className="max-w-[320px] truncate text-right text-[13px] text-muted-foreground">
              {selectedProvider?.api_base || selectedProvider?.default_api_base || selectedProvider?.name || tx("settings.values.notAvailable", "Not available")}
            </span>
          </SettingsRow>
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.imageDefaults", "Defaults")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title="图片模型"
            description="图片生成使用的模型 ID，与聊天模型不同"
          >
            <Input
              value={form.model}
              onChange={(event) => onChangeForm((prev) => ({ ...prev, model: event.target.value }))}
              placeholder="例如 agnes-image-21-flash, gpt-image-1"
              className="h-8 w-[min(300px,70vw)] rounded-full text-[13px]"
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
        <SettingsSectionTitle>{tx("settings.sections.webSearch", "Web search")}</SettingsSectionTitle>
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

          {selectedProvider?.credential === "none" ? (
            <SettingsRow
              title={t("settings.byok.webSearch.credentials")}
              description={t("settings.byok.webSearch.noCredentialHelp")}
            >
              <StatusPill tone="success">{t("settings.byok.webSearch.noCredentialRequired")}</StatusPill>
            </SettingsRow>
          ) : null}

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
                      className="h-9 rounded-full pr-11 text-[13px]"
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
                    <div className="flex h-9 items-center rounded-full border border-input bg-background px-3 pr-11 text-[13px] text-muted-foreground">
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
                className="h-9 w-[280px] rounded-full text-[13px]"
              />
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.webBehavior", "Behavior")}</SettingsSectionTitle>
        <SettingsGroup>
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

function RuntimeSettings({
  form,
  setForm,
  settings,
  dirty,
  saving,
  onSave,
  onRestart,
  isRestarting,
  requiresRestartPending,
}: {
  form: AgentSettingsDraft;
  setForm: Dispatch<SetStateAction<AgentSettingsDraft>>;
  settings: SettingsPayload;
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
        <SettingsSectionTitle>{tx("settings.sections.identity", "Identity")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow title={tx("settings.rows.botName", "Bot name")} description={tx("settings.help.botName", "Shown in runtime surfaces that use the configured bot identity.")}>
            <Input
              value={form.botName}
              onChange={(event) => setForm((prev) => ({ ...prev, botName: event.target.value }))}
              className="h-8 w-[220px] rounded-full text-[13px]"
            />
          </SettingsRow>
          <SettingsRow title={tx("settings.rows.botIcon", "Bot icon")} description={tx("settings.help.botIcon", "Short emoji or text shown beside the bot name.")}>
            <Input
              value={form.botIcon}
              onChange={(event) => setForm((prev) => ({ ...prev, botIcon: event.target.value }))}
              className="h-8 w-[120px] rounded-full text-center text-[13px]"
            />
          </SettingsRow>
          <SettingsRow title={tx("settings.rows.timezone", "Timezone")} description={tx("settings.help.timezone", "IANA timezone used by runtime context and schedules.")}>
            <Input
              value={form.timezone}
              onChange={(event) => setForm((prev) => ({ ...prev, timezone: event.target.value }))}
              className="h-8 w-[220px] rounded-full text-[13px]"
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

      <section>
        <SettingsSectionTitle>{t("settings.sections.system")}</SettingsSectionTitle>
        <SettingsGroup>
          {onRestart && !requiresRestartPending ? (
            <SettingsRow
              title={t("settings.rows.restart")}
              description={t("app.system.restartHint")}
            >
              <Button
                size="sm"
                variant="outline"
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
            </SettingsRow>
          ) : null}
          <ReadOnlyRow title={t("settings.rows.configPath")} value={settings.runtime.config_path} />
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
                className="h-8 w-[min(280px,60vw)] rounded-full text-[13px]"
              />
              {isTauri() ? (
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  className="h-8 w-8 shrink-0 rounded-full"
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
          <ReadOnlyRow title={tx("settings.rows.heartbeat", "Heartbeat")} value={settings.runtime.heartbeat.enabled ? `${settings.runtime.heartbeat.interval_s}s` : tx("settings.values.disabled", "Disabled")} />
          <ReadOnlyRow title={tx("settings.rows.dream", "Dream")} value={settings.runtime.dream.schedule} />
          <ReadOnlyRow title={tx("settings.rows.unifiedSession", "Unified session")} value={settings.runtime.unified_session ? tx("settings.values.enabled", "Enabled") : tx("settings.values.disabled", "Disabled")} />
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

  useEffect(() => {
    checkLicense();
    loadMachineId();
  }, []);

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
        <SettingsSectionTitle>{tx("settings.about.product", "产品信息")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow title={tx("settings.about.productName", "产品名称")}>
            <span className="text-[13px] text-muted-foreground">Mona</span>
          </SettingsRow>
          <SettingsRow title={tx("settings.about.version", "版本号")}>
            <span className="text-[13px] text-muted-foreground">0.1.0</span>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.about.machineId", "机器码")}
            description={tx("settings.about.machineIdDesc", "复制此机器码，到授权页面换取 License 文件")}
          >
            <div className="flex items-center gap-2">
              <code className="max-w-[200px] truncate rounded bg-muted px-2 py-0.5 text-[12px] font-mono text-muted-foreground">
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

      <section>
        <SettingsSectionTitle>{tx("settings.about.license", "授权")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.about.activationStatus", "激活状态")}
            description={
              licenseStatus === "active"
                ? tx("settings.about.activatedDesc", "Pro 功能（DB AI、笔记 AI、终端 AI、知识库 AI）已解锁")
                : licenseStatus === "expired"
                  ? tx("settings.about.expiredDesc", "授权已过期，Pro 功能已锁定")
                  : tx("settings.about.notActivatedDesc", "激活后可使用 Pro 功能：DB AI、笔记 AI、终端 AI、知识库 AI")
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
              "px-4 py-2.5 text-[13px] sm:px-5",
              importMessage.type === "success" && "text-emerald-700 dark:text-emerald-300",
              importMessage.type === "error" && "text-destructive",
            )}>
              {importMessage.text}
            </div>
          ) : null}
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.about.freeFeatures", "免费功能")}</SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow title="Agent 对话" value={tx("settings.values.enabled", "已启用")} />
          <ReadOnlyRow title={tx("settings.about.imageGeneration", "图片生成")} value={tx("settings.values.enabled", "已启用")} />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.about.proFeatures", "Pro 功能")}</SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow title="DB AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="笔记 AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title="终端 AI" value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
          <ReadOnlyRow title={tx("settings.about.knowledgeBaseAI", "知识库 AI")} value={licenseStatus === "active" ? tx("settings.values.enabled", "已启用") : tx("settings.values.disabled", "未启用")} />
        </SettingsGroup>
      </section>
    </div>
  );
}

function AdvancedSettings({ settings }: { settings: SettingsPayload }) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>{tx("settings.sections.safety", "Safety")}</SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow title={tx("settings.rows.restrictWorkspace", "Restrict to workspace")} value={settings.advanced.restrict_to_workspace ? tx("settings.values.enabled", "Enabled") : tx("settings.values.disabled", "Disabled")} />
          <ReadOnlyRow title={tx("settings.rows.execTool", "Exec tool")} value={settings.advanced.exec_enabled ? tx("settings.values.enabled", "Enabled") : tx("settings.values.disabled", "Disabled")} />
          <ReadOnlyRow title={tx("settings.rows.execSandbox", "Exec sandbox")} value={settings.advanced.exec_sandbox ?? tx("settings.values.notAvailable", "Not available")} />
          <ReadOnlyRow title={tx("settings.rows.ssrfWhitelist", "SSRF whitelist")} value={String(settings.advanced.ssrf_whitelist_count)} />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.sections.integrations", "Integrations")}</SettingsSectionTitle>
        <SettingsGroup>
          <ReadOnlyRow title={tx("settings.rows.mcpServers", "MCP servers")} value={String(settings.advanced.mcp_server_count)} />
          <ReadOnlyRow title={tx("settings.rows.pathAppend", "PATH append")} value={settings.advanced.exec_path_append_set ? tx("settings.values.configured", "Configured") : tx("settings.values.notConfigured", "Not configured")} />
        </SettingsGroup>
      </section>
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
            "h-8 w-[210px] justify-between rounded-full border-input bg-background px-3 text-[13px] font-normal shadow-none",
            "hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "text-muted-foreground",
          )}
        >
          <span className="truncate">{selectedProvider?.label ?? emptyLabel}</span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[18rem] w-[240px] overflow-y-auto rounded-[18px] border-border/65 bg-popover p-1.5 text-popover-foreground shadow-[0_18px_55px_rgba(15,23,42,0.18)] dark:border-white/10 dark:shadow-[0_22px_55px_rgba(0,0,0,0.45)]"
      >
        {providers.map((provider) => {
          const selected = provider.name === value;
          return (
            <DropdownMenuItem
              key={provider.name}
              onSelect={() => onChange(provider.name)}
              className={cn(
                "flex cursor-default items-center justify-between gap-2 rounded-[12px] px-3 py-2 text-[13px]",
                "focus:bg-muted focus:text-foreground",
                selected && "bg-primary/10 text-primary focus:bg-primary/12 focus:text-primary",
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
      <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.07)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.22)]">
        {count > 0 ? (
          <div className="divide-y divide-border/45">{children}</div>
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
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
        {title}
      </h2>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

function ByokEmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[18px] border border-dashed border-border/65 bg-card/45 px-4 py-5 text-[13px] text-muted-foreground">
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

function providerLabel(
  providers: Array<{ name: string; label: string }>,
  value: string,
): string {
  return providers.find((provider) => provider.name === value)?.label ?? value;
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
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-muted text-foreground/82 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.025)] dark:bg-muted/70">
      <Icon className="h-5 w-5" strokeWidth={2} aria-hidden />
    </span>
  );
}

function OverviewListRow({
  icon: Icon,
  title,
  value,
  caption,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  caption: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[68px] w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 sm:px-5"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[12px] bg-muted text-foreground/82 transition-colors group-hover:bg-muted/80 dark:bg-muted/70">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium leading-5 text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[12px] leading-5 text-muted-foreground">{caption}</span>
      </span>
      <span className="ml-auto flex min-w-0 max-w-[48%] items-center gap-2">
        <span className="truncate text-right text-[13px] leading-5 text-muted-foreground">
          {value}
        </span>
        <ChevronRight
          className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </span>
    </button>
  );
}

function SettingsSectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground/85">
      {children}
    </h2>
  );
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-border/45 bg-card/86 shadow-[0_18px_65px_rgba(15,23,42,0.075)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_18px_65px_rgba(0,0,0,0.24)]">
      <div className="divide-y divide-border/45">{children}</div>
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
        <div className="text-[14px] font-medium leading-5 text-foreground">{title}</div>
        {description ? (
          <div className="mt-0.5 max-w-[28rem] text-[12px] leading-5 text-muted-foreground">
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
      <span className="block max-w-[320px] truncate text-right text-[13px] text-muted-foreground">
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
      <div className="min-w-0 text-[13px] leading-5 text-muted-foreground">
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
              "bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.14)] dark:bg-blue-400 dark:shadow-[0_0_0_3px_rgba(96,165,250,0.18)]",
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
        "inline-flex max-w-[260px] items-center rounded-full px-2.5 py-1 text-[12px] font-medium",
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

function SegmentedControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex h-8 items-center rounded-full bg-muted p-0.5 text-[12px] font-medium text-muted-foreground">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-full px-3 py-1 transition-colors",
            value === option.value && "bg-background text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
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
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-8 min-w-[64px] items-center justify-center rounded-full px-3 text-[12px] font-medium transition-colors",
        checked
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
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
        className="h-8 w-24 rounded-full text-[13px]"
      />
      {suffix ? <span className="text-[12px] text-muted-foreground">{suffix}</span> : null}
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

function DesktopSettings() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [gatewayStatus, setGatewayStatus] = useState<{ running: boolean; port: number | null } | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await getDesktopSettings();
      setSettings(s);
      const status = await getGatewayStatus();
      setGatewayStatus(status);
    } catch (e) {
      console.error("Failed to load desktop settings:", e);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const updateSetting = async (patch: Partial<DesktopAppSettings>) => {
    if (!settings) return;
    try {
      const updated = await updateDesktopSettings({ ...settings, ...patch });
      setSettings(updated);
    } catch (e) {
      console.error("Failed to update setting:", e);
    }
  };

  const handleOpenInBrowser = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_in_browser");
    } catch (e) {
      console.error("Failed to open in browser:", e);
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
        <SettingsSectionTitle>{tx("settings.desktop.behavior", "窗口行为")}</SettingsSectionTitle>
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

      <section>
        <SettingsSectionTitle>{tx("settings.desktop.gateway", "网关")}</SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.desktop.gatewayStatus", "网关状态")}
            description={tx("settings.desktop.gatewayStatusHelp", "Mona 网关进程的当前状态。")}
          >
            <div className="flex items-center gap-2">
              <StatusPill tone={gatewayStatus?.running ? "success" : "neutral"}>
                {gatewayStatus?.running
                  ? tx("settings.desktop.running", "运行中")
                  : tx("settings.desktop.stopped", "已停止")}
              </StatusPill>
              {gatewayStatus?.port ? (
                <span className="text-[12px] text-muted-foreground">
                  :{gatewayStatus.port}
                </span>
              ) : null}
            </div>
          </SettingsRow>
          <SettingsRow
            title={tx("settings.desktop.openInBrowser", "在浏览器中打开")}
            description={tx("settings.desktop.openInBrowserHelp", "在默认浏览器中打开 WebUI。")}
          >
            <Button
              size="sm"
              variant="outline"
              onClick={handleOpenInBrowser}
              disabled={!gatewayStatus?.running}
              className="rounded-full"
            >
              {tx("settings.desktop.openBrowser", "打开浏览器")}
            </Button>
          </SettingsRow>
          <ReadOnlyRow
            title={tx("settings.desktop.gatewayPort", "网关端口")}
            value={String(settings.gateway_port)}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}

const SIDEBAR_SHORTCUT_ITEMS: Array<{ key: keyof SidebarShortcuts; label: string }> = [
  { key: "mona", label: "Mona" },
  { key: "note", label: "笔记" },
  { key: "ssh", label: "终端" },
  { key: "db", label: "数据库" },
  { key: "kb", label: "知识库" },
  { key: "ppt", label: "PPT制作" },
];

const DEFAULT_SIDEBAR_SHORTCUTS: SidebarShortcuts = {
  mona: "Alt+1",
  note: "Alt+2",
  ssh: "Alt+3",
  db: "Alt+4",
  kb: "Alt+5",
  ppt: "Alt+6",
};

function ShortcutsSettings() {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [settings, setSettings] = useState<DesktopAppSettings | null>(null);
  const [quickAskDraft, setQuickAskDraft] = useState("Ctrl+Alt+M");
  const [quickAskSaving, setQuickAskSaving] = useState(false);
  const [quickAskSaved, setQuickAskSaved] = useState(false);
  const [quickAskError, setQuickAskError] = useState<string | null>(null);
  const [sidebarDrafts, setSidebarDrafts] = useState<SidebarShortcuts>(DEFAULT_SIDEBAR_SHORTCUTS);
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const [sidebarSaved, setSidebarSaved] = useState(false);
  const [sidebarError, setSidebarError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const s = await getDesktopSettings();
      setSettings(s);
      setQuickAskDraft(s.quick_ask_shortcut || "Ctrl+Alt+M");
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

  const sidebarDirty = settings
    ? Object.keys(DEFAULT_SIDEBAR_SHORTCUTS).some(
        (key) => sidebarDrafts[key as keyof SidebarShortcuts] !== settings!.sidebar_shortcuts[key as keyof SidebarShortcuts],
      )
    : false;

  const saveQuickAsk = async () => {
    if (!settings || quickAskSaving || !quickAskDirty) return;
    setQuickAskSaving(true);
    setQuickAskError(null);
    setQuickAskSaved(false);
    try {
      const updated = await updateDesktopSettings({
        ...settings,
        quick_ask_shortcut: quickAskDraft.trim(),
      });
      setSettings(updated);
      setQuickAskDraft(updated.quick_ask_shortcut);
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
        <SettingsSectionTitle>{tx("settings.shortcuts.quickAsk", "快问快捷键")}</SettingsSectionTitle>
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
                  className="h-8 w-44 rounded-full text-right text-[13px]"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={saveQuickAsk}
                  disabled={!quickAskDirty || quickAskSaving}
                  className="rounded-full"
                >
                  {quickAskSaving
                    ? tx("settings.actions.saving", "保存中...")
                    : tx("settings.actions.save", "保存")}
                </Button>
              </div>
              <div className="max-w-[320px] text-right text-[12px] leading-5 text-muted-foreground">
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
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>{tx("settings.shortcuts.sidebarNav", "侧边栏导航快捷键")}</SettingsSectionTitle>
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
                className="h-8 w-44 rounded-full text-right text-[13px]"
              />
            </SettingsRow>
          ))}
          <div className="flex min-h-[58px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <div className="min-w-0 text-[13px] leading-5 text-muted-foreground">
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
