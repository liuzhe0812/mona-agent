import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  writeMonaProviderConfig,
  writeMonaModelConfig,
  startGateway,
  type MonaConfigStatus,
} from "@/lib/tauri";

interface ProviderOption {
  name: string;
  label: string;
  description: string;
  defaultApiBase?: string;
  needsApiBase?: boolean;
  noApiKey?: boolean;
}

const PROVIDERS: ProviderOption[] = [
  {
    name: "zen",
    label: "内置供应商",
    description: "免费，无需 API Key，开箱即用",
    noApiKey: true,
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    description: "Access 200+ models via one API key",
    defaultApiBase: "https://openrouter.ai/api/v1",
  },
  {
    name: "openai",
    label: "OpenAI",
    description: "GPT-4o, GPT-4, etc.",
  },
  {
    name: "anthropic",
    label: "Anthropic",
    description: "Claude Opus, Sonnet, Haiku",
  },
  {
    name: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek V3 / R1",
    defaultApiBase: "https://api.deepseek.com",
  },
  {
    name: "dashscope",
    label: "DashScope (通义千问)",
    description: "Qwen models",
    defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    name: "gemini",
    label: "Google Gemini",
    description: "Gemini Pro, Flash, etc.",
    defaultApiBase: "https://generativelanguage.googleapis.com/v1beta/openai/",
  },
  {
    name: "custom",
    label: "Custom (OpenAI-compatible)",
    description: "Any OpenAI-compatible endpoint",
    needsApiBase: true,
  },
];

const DEFAULT_MODELS: Record<string, string> = {
  zen: "deepseek-v4-flash-free",
  openrouter: "anthropic/claude-sonnet-4",
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  deepseek: "deepseek-chat",
  dashscope: "qwen-plus",
  gemini: "gemini-2.0-flash",
  custom: "",
};

type WizardStep = "provider" | "apikey" | "model" | "starting";

interface SetupWizardProps {
  configStatus: MonaConfigStatus;
  onComplete: () => void;
  onSkip: () => void;
}

export function SetupWizard({ configStatus, onComplete, onSkip }: SetupWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(
    !configStatus.has_provider ? "provider" : "model"
  );
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleProviderSelect = useCallback((provider: ProviderOption) => {
    setSelectedProvider(provider.name);
    if (provider.defaultApiBase) {
      setApiBase(provider.defaultApiBase);
    } else {
      setApiBase("");
    }
    setModel(DEFAULT_MODELS[provider.name] || "");
    if (provider.noApiKey) {
      // Skip API key step for free providers
      setStep("model");
    } else {
      setStep("apikey");
    }
  }, []);

  const handleApiKeySubmit = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await writeMonaProviderConfig(
        selectedProvider,
        apiKey.trim(),
        apiBase.trim() || undefined,
      );
      setStep("model");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, apiKey, apiBase]);

  const handleModelSubmit = useCallback(async () => {
    if (!model.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await writeMonaModelConfig(model.trim(), selectedProvider);
      setStep("starting");
      await startGateway();
      onComplete();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [model, selectedProvider, onComplete]);

  const selectedProviderInfo = PROVIDERS.find((p) => p.name === selectedProvider);

  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex w-full max-w-lg flex-col gap-8 px-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="text-4xl">🐈</div>
          <h1 className="text-2xl font-bold">
            {t("setup.title", "Welcome to Mona")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("setup.subtitle", "Let's set up your AI assistant in a few steps.")}
          </p>
        </div>

        {step === "provider" && (
          <div className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">
              {t("setup.selectProvider", "Choose your AI provider")}
            </h2>
            <div className="grid grid-cols-1 gap-2">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  onClick={() => handleProviderSelect(provider)}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors hover:bg-accent",
                    selectedProvider === provider.name && "border-primary bg-accent"
                  )}
                >
                  <span className="font-medium">{provider.label}</span>
                  <span className="text-xs text-muted-foreground">{provider.description}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-center pt-2">
              <Button variant="ghost" size="sm" onClick={onSkip}>
                {t("setup.skip", "Skip — configure later in Settings")}
              </Button>
            </div>
          </div>
        )}

        {step === "apikey" && selectedProviderInfo && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep("provider")}>
                ← {t("setup.back", "Back")}
              </Button>
            </div>
            <h2 className="text-lg font-semibold">
              {t("setup.enterApiKey", "Enter your {{provider}} API key", {
                provider: selectedProviderInfo.label,
              })}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("setup.apiKeyHint", "Your API key is stored locally and never shared.")}
            </p>
            <Input
              type="password"
              placeholder={t("setup.apiKeyPlaceholder", "sk-...")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoFocus
            />
            {selectedProviderInfo.needsApiBase && (
              <Input
                type="text"
                placeholder={t("setup.apiBasePlaceholder", "https://api.example.com/v1")}
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
              />
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              onClick={handleApiKeySubmit}
              disabled={!apiKey.trim() || saving}
              className="w-full"
            >
              {saving
                ? t("setup.saving", "Saving...")
                : t("setup.next", "Next")}
            </Button>
          </div>
        )}

        {step === "model" && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep(selectedProviderInfo?.noApiKey ? "provider" : "apikey")}>
                ← {t("setup.back", "Back")}
              </Button>
            </div>
            <h2 className="text-lg font-semibold">
              {t("setup.selectModel", "Choose your model")}
            </h2>
            <Input
              type="text"
              placeholder={t("setup.modelPlaceholder", "e.g. gpt-4o, claude-sonnet-4")}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "setup.modelHint",
                "You can change this later in Settings → Models."
              )}
            </p>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              onClick={handleModelSubmit}
              disabled={!model.trim() || saving}
              className="w-full"
            >
              {saving
                ? t("setup.starting", "Starting Mona...")
                : t("setup.finish", "Start Mona")}
            </Button>
          </div>
        )}

        {step === "starting" && (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground/40" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground/60" />
              </span>
              {t("setup.startingGateway", "Starting gateway...")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
