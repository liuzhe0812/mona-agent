import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ImagePlus,
  Loader2,
  Palette,
  Save,
  ShieldCheck,
  Image,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Type,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  buildVideoBackgroundAssetPreviewUrl,
  applyVideoBrandKit,
  createVideoBrandKit,
  fetchVideoBrandKits,
  fetchVideoStyleDraft,
  getServicesHttpBase,
  lockVideoStyle,
  lockVideoBrandKit,
  previewVideoStyle,
  saveVideoStyleDraft,
  uploadVideoBackgroundAsset,
  uploadVideoBrandLogo,
  validateVideoStyle,
  type BackgroundAsset,
  type StyleValidationIssue,
  type VideoAssetRightsStatus,
  type VideoBackgroundSlot,
  type VideoAspectVariant,
  type VideoBrandKit,
  type VideoStyleConfig,
  type VideoStyleDraft,
  type VideoStyleDraftUpdate,
  type VideoStyleVersion,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { useClient } from "@/providers/ClientProvider";
import { AssetRightsDialog } from "./AssetRightsDialog";

export interface SeriesStyleEditorProps {
  seriesId: string;
  initialDraft?: VideoStyleDraft | null;
  onLocked?: (version: VideoStyleVersion) => void;
  onCancel?: () => void;
  onDraftChange?: (draft: VideoStyleDraft) => void;
  currentVersion?: number;
  defaultAspectRatio?: VideoAspectVariant;
  className?: string;
}

type EditorSection =
  "basics" | "background" | "components" | "motion" | "advanced";
type PreviewRole =
  | "cover"
  | "chapter"
  | "content"
  | "data"
  | "comparison"
  | "process"
  | "quote"
  | "outro";

const SECTIONS = [
  { id: "basics", label: "配色", hint: "颜色与卡片", icon: SlidersHorizontal },
  { id: "background", label: "背景", hint: "图片与可读性", icon: Image },
  { id: "components", label: "文字", hint: "字体与字号", icon: Type },
  { id: "motion", label: "字幕与动效", hint: "字幕和切换", icon: Sparkles },
  { id: "advanced", label: "更多设置", hint: "补充颜色", icon: Settings2 },
] as const;

const ASPECTS: Array<{ value: VideoAspectVariant; label: string }> = [
  { value: "16:9", label: "横屏" },
  { value: "9:16", label: "竖屏" },
  { value: "1:1", label: "方形" },
];

const PREVIEW_ROLES: Array<{ value: PreviewRole; label: string }> = [
  { value: "cover", label: "封面" },
  { value: "chapter", label: "章节" },
  { value: "content", label: "内容" },
  { value: "data", label: "数据" },
  { value: "comparison", label: "对比" },
  { value: "process", label: "流程" },
  { value: "quote", label: "引用" },
  { value: "outro", label: "片尾" },
];

const PREVIEW_DIMENSIONS: Record<
  VideoAspectVariant,
  { width: number; height: number }
> = {
  "16:9": { width: 432, height: 243 },
  "9:16": { width: 243, height: 432 },
  "1:1": { width: 360, height: 360 },
};

const TEMPLATE_NAMES: Record<string, string> = {
  "minimal-business": "简洁浅色",
  "tech-dark": "专业深色",
  "editorial-magazine": "编辑排版",
  "knowledge-cards": "清晰教学",
  custom: "自定义",
};

const COLOR_PRESETS = [
  "#315F9A",
  "#526A5D",
  "#A93A25",
  "#6B5A45",
  "#243243",
  "#1A1F27",
  "#F5F7FA",
  "#FFFFFF",
] as const;

const FONT_OPTIONS = [
  { value: "Noto Sans SC", label: "现代黑体" },
  { value: "Noto Serif SC", label: "现代宋体" },
  { value: "Microsoft YaHei", label: "微软雅黑" },
  { value: "SimHei", label: "经典黑体" },
  { value: "KaiTi", label: "楷体" },
];

const ENTER_PRESET_OPTIONS = [
  { value: "fade-rise", label: "淡入上浮" },
  { value: "stagger-rise", label: "依次上浮" },
  { value: "cross-fade", label: "柔和淡入" },
];

const EMPHASIS_PRESET_OPTIONS = [
  { value: "stagger-rise", label: "依次强调" },
  { value: "fade-rise", label: "淡入强调" },
];

const TRANSITION_PRESET_OPTIONS = [
  { value: "cross-fade", label: "交叉淡化" },
  { value: "fade-rise", label: "淡入切换" },
  { value: "stagger-rise", label: "分步切换" },
];

const SUBTITLE_STYLE_OPTIONS = [
  { value: "caption-rail", label: "底部字幕条" },
  { value: "caption-card", label: "柔和字幕卡" },
  { value: "caption-outline", label: "描边字幕" },
];

const DEFAULT_COLORS: Record<string, string> = {
  primary: "#91B2E8",
  secondary: "#A6C8EF",
  background: "#101318",
  surface: "#1A1F27",
  textPrimary: "#F2F4F7",
  textSecondary: "#C0C5CE",
  border: "#333B46",
};

const DEFAULT_COMPONENTS: Record<string, string> = {
  cover: "cover-split-v1",
  content: "content-outline-v1",
  data: "metric-large-number-v1",
  comparison: "comparison-columns-v1",
  outro: "outro-brand-v1",
};

function defaultBackground(mode: string): VideoBackgroundSlot {
  const dark = mode === "dark";
  return {
    assetPolicy: "fixed",
    assetId: null,
    fit: "cover",
    focalPoint: { x: 0.5, y: 0.45 },
    overlay: {
      type: "solid",
      color: dark ? "#101318" : "#F5F7FA",
      opacity: 0.56,
      direction: "none",
    },
    blur: 0,
    tint: 0,
    contrastMode: "auto",
    fallback: dark ? "#101318" : "#F5F7FA",
  };
}

function makeDraft(
  seriesId: string,
  source?: VideoStyleDraft | null,
  defaultAspectRatio: VideoAspectVariant = "16:9",
): VideoStyleDraft {
  const mode = source?.mode ?? "dark";
  const sourceTokens = source?.tokens;
  const sourceBackgrounds = source?.backgrounds;
  return {
    ...(source ?? {}),
    seriesId,
    revision: source?.revision ?? 0,
    schemaVersion: source?.schemaVersion ?? 1,
    baseTemplateId: source?.baseTemplateId ?? "tech-dark",
    mode,
    tokens: {
      ...(sourceTokens ?? {}),
      colors: { ...DEFAULT_COLORS, ...(sourceTokens?.colors ?? {}) },
      typography: {
        headingFamily: "Noto Sans SC",
        bodyFamily: "Noto Sans SC",
        scale: "standard",
        ...(sourceTokens?.typography ?? {}),
      },
      shape: {
        cardRadius: 20,
        cardStyle: "outline",
        density: "standard",
        ...(sourceTokens?.shape ?? {}),
      },
    },
    components: { ...DEFAULT_COMPONENTS, ...(source?.components ?? {}) },
    motion: {
      ...(source?.motion ?? {}),
      intensity: source?.motion?.intensity ?? "restrained",
      enterPreset: source?.motion?.enterPreset ?? "fade-rise",
      emphasisPreset:
        source?.motion?.emphasisPreset === "soft-pulse"
          ? "fade-rise"
          : (source?.motion?.emphasisPreset ?? "fade-rise"),
      transitionPreset: source?.motion?.transitionPreset ?? "cross-fade",
    },
    subtitle: {
      position: "bottom-center",
      style: "caption-rail",
      maxLines: 2,
      ...(source?.subtitle ?? {}),
    },
    backgrounds: {
      ...(sourceBackgrounds ?? {}),
      default: {
        ...defaultBackground(mode),
        ...(sourceBackgrounds?.default ?? {}),
      },
      roles: { ...(sourceBackgrounds?.roles ?? {}) },
    },
    aspectVariants: {
      "16:9": { enabled: true },
      "9:16": { enabled: false },
      "1:1": { enabled: false },
      ...(source?.aspectVariants ?? {}),
      [defaultAspectRatio]: {
        ...(source?.aspectVariants?.[defaultAspectRatio] ?? {}),
        enabled: true,
      },
    },
  };
}

function mergeDraft(
  current: VideoStyleDraft,
  patch: Partial<VideoStyleConfig> & { name?: string | null },
): VideoStyleDraft {
  const next = { ...current, ...patch } as VideoStyleDraft;
  if (patch.tokens) {
    next.tokens = {
      ...(current.tokens ?? {}),
      ...patch.tokens,
      colors: {
        ...(current.tokens?.colors ?? {}),
        ...(patch.tokens.colors ?? {}),
      },
      typography: {
        ...(current.tokens?.typography ?? {}),
        ...(patch.tokens.typography ?? {}),
      },
      shape: {
        ...(current.tokens?.shape ?? {}),
        ...(patch.tokens.shape ?? {}),
      },
    };
  }
  if (patch.motion)
    next.motion = { ...(current.motion ?? {}), ...patch.motion };
  if (patch.subtitle)
    next.subtitle = { ...(current.subtitle ?? {}), ...patch.subtitle };
  if (patch.backgrounds) {
    next.backgrounds = {
      ...(current.backgrounds ?? {}),
      ...patch.backgrounds,
      default: {
        ...(current.backgrounds?.default ?? {}),
        ...(patch.backgrounds.default ?? {}),
      },
      roles: {
        ...(current.backgrounds?.roles ?? {}),
        ...(patch.backgrounds.roles ?? {}),
      },
    };
  }
  if (patch.components) {
    next.components = { ...(current.components ?? {}), ...patch.components };
  }
  if (patch.aspectVariants) {
    next.aspectVariants = {
      ...(current.aspectVariants ?? {}),
      ...patch.aspectVariants,
    };
  }
  return next;
}

function draftPayload(draft: VideoStyleDraft): VideoStyleDraftUpdate {
  return { ...(draft as VideoStyleDraftUpdate), revision: draft.revision };
}

function colorValue(value: string | undefined, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? "") ? value! : fallback;
}

function ColorPresetField({
  label,
  value,
  fallback,
  onChange,
  disabled = false,
}: {
  label: string;
  value?: string;
  fallback: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = colorValue(value, fallback);
  return (
    <div className="rounded-md border border-border/70 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2 text-micro">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span
          className="h-5 w-5 rounded-full border border-black/10 shadow-inner"
          style={{ backgroundColor: selected }}
          aria-hidden="true"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {COLOR_PRESETS.map((color, index) => (
          <Button
            key={color}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${label}常用色 ${index + 1}`}
            aria-pressed={selected.toLowerCase() === color.toLowerCase()}
            disabled={disabled}
            className={cn(
              "h-7 w-7 rounded-full border border-black/10 p-0",
              selected.toLowerCase() === color.toLowerCase() &&
                "ring-2 ring-foreground/60 ring-offset-2 ring-offset-background",
            )}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
          />
        ))}
        <label
          className={cn(
            "relative flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground",
            disabled
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-accent hover:text-foreground",
          )}
          title={`自定义${label}`}
        >
          <Palette className="h-3.5 w-3.5" aria-hidden="true" />
          <input
            type="color"
            className="absolute inset-0 cursor-pointer opacity-0"
            value={selected}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`自定义${label}`}
            disabled={disabled}
          />
        </label>
      </div>
    </div>
  );
}

function ratioClass(ratio: VideoAspectVariant): string {
  if (ratio === "9:16") return "aspect-[9/16] max-h-[300px]";
  if (ratio === "1:1") return "aspect-square max-h-[300px]";
  return "aspect-video";
}

export function SeriesStyleEditor({
  seriesId,
  initialDraft,
  onLocked,
  onCancel,
  onDraftChange,
  currentVersion = 0,
  defaultAspectRatio = "16:9",
  className,
}: SeriesStyleEditorProps) {
  const { token } = useClient();
  const [draft, setDraft] = useState(() =>
    makeDraft(seriesId, initialDraft, defaultAspectRatio),
  );
  const [activeSection, setActiveSection] = useState<EditorSection>("basics");
  const [backgroundRole, setBackgroundRole] = useState("default");
  const [previewRatio, setPreviewRatio] =
    useState<VideoAspectVariant>(defaultAspectRatio);
  const [previewRole, setPreviewRole] = useState<PreviewRole>("cover");
  const [previewMode, setPreviewMode] = useState<"scene" | "background">(
    "scene",
  );
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialDraft);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "unsaved" | "error">(
    "saved",
  );
  const [canceling, setCanceling] = useState(false);
  const [validating, setValidating] = useState(false);
  const [locking, setLocking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingBackgroundPath, setPendingBackgroundPath] = useState<
    string | null
  >(null);
  const [backgroundRights, setBackgroundRights] =
    useState<VideoAssetRightsStatus>("unknown");
  const [issues, setIssues] = useState<StyleValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [asset, setAsset] = useState<BackgroundAsset | null>(null);
  const [assetPreviewUrl, setAssetPreviewUrl] = useState<string | null>(null);
  const [versionConfirmOpen, setVersionConfirmOpen] = useState(false);
  const [brandKits, setBrandKits] = useState<VideoBrandKit[]>([]);
  const [brandLoading, setBrandLoading] = useState(false);
  const [pendingBrandLogo, setPendingBrandLogo] = useState<{
    kit: VideoBrandKit;
    variant: "light" | "dark";
    path: string;
  } | null>(null);
  const [brandLogoRights, setBrandLogoRights] =
    useState<VideoAssetRightsStatus>("unknown");

  const dirtyRef = useRef(false);
  const latestDraftRef = useRef(draft);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const saveBlockedRef = useRef(false);
  const brandBinding = draft.brandKit as
    | { id?: string; version?: number; name?: string; lockedFields?: string[] }
    | undefined;
  const lockedBrandFields = new Set(brandBinding?.lockedFields ?? []);

  useEffect(() => {
    latestDraftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setPreviewRatio(defaultAspectRatio);
  }, [defaultAspectRatio]);

  useEffect(() => {
    let cancelled = false;
    void fetchVideoBrandKits(token)
      .then((result) => {
        if (!cancelled) setBrandKits(result.brandKits ?? []);
      })
      .catch(() => {
        if (!cancelled) setBrandKits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      void previewVideoStyle(
        token,
        seriesId,
        draftPayload(draft),
        previewRole,
        previewRatio,
      )
        .then((result) => {
          if (cancelled) return;
          setPreviewHtml(result.html);
          setPreviewError(null);
        })
        .catch((previewFailure) => {
          if (!cancelled) {
            setPreviewError(
              previewFailure instanceof Error
                ? previewFailure.message
                : String(previewFailure),
            );
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft, loading, previewRatio, previewRole, seriesId, token]);

  useEffect(() => {
    let cancelled = false;
    dirtyRef.current = false;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveState("saved");
    setIssues([]);
    if (initialDraft) {
      const next = makeDraft(seriesId, initialDraft, defaultAspectRatio);
      setDraft(next);
      latestDraftRef.current = next;
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    fetchVideoStyleDraft(token, seriesId)
      .then((value) => {
        if (cancelled) return;
        const next = makeDraft(seriesId, value, defaultAspectRatio);
        setDraft(next);
        latestDraftRef.current = next;
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [defaultAspectRatio, initialDraft, seriesId, token]);

  const persistDraft = useCallback((): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    if (!dirtyRef.current || saveBlockedRef.current)
      return Promise.resolve(!saveBlockedRef.current);

    const saveLoop = async (): Promise<boolean> => {
      setSaving(true);
      try {
        while (dirtyRef.current) {
          const value = latestDraftRef.current;
          setSaveState("unsaved");
          const result = await saveVideoStyleDraft(
            token,
            seriesId,
            draftPayload(value),
          );
          if (!result.ok) throw new Error(result.error || "保存风格失败");
          const nextRevision = result.revision ?? result.draft?.revision;
          if (nextRevision === undefined)
            throw new Error("保存风格失败，请重试");

          const latest = latestDraftRef.current;
          const changedDuringSave = latest !== value;
          const next = { ...latest, revision: nextRevision };
          latestDraftRef.current = next;
          dirtyRef.current = changedDuringSave;
          setDraft(next);
          setSaveState(changedDuringSave ? "unsaved" : "saved");
        }
        saveBlockedRef.current = false;
        if (savedHideTimerRef.current) clearTimeout(savedHideTimerRef.current);
        savedHideTimerRef.current = setTimeout(
          () => setSaveState("saved"),
          1500,
        );
        return true;
      } catch (e) {
        saveBlockedRef.current = true;
        setError(e instanceof Error ? e.message : String(e));
        setSaveState("error");
        return false;
      } finally {
        setSaving(false);
      }
    };

    const pending = saveLoop();
    savePromiseRef.current = pending;
    void pending.finally(() => {
      if (savePromiseRef.current === pending) savePromiseRef.current = null;
    });
    return pending;
  }, [seriesId, token]);

  useEffect(() => {
    if (loading || !dirtyRef.current || saveBlockedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistDraft();
    }, 650);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [draft, loading, persistDraft]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (savedHideTimerRef.current) clearTimeout(savedHideTimerRef.current);
    };
  }, []);

  const updateDraft = useCallback(
    (patch: Partial<VideoStyleConfig> & { name?: string | null }) => {
      setDraft((current) => {
        const next = mergeDraft(current, patch);
        latestDraftRef.current = next;
        onDraftChange?.(next);
        return next;
      });
      dirtyRef.current = true;
      if (savedHideTimerRef.current) {
        clearTimeout(savedHideTimerRef.current);
        savedHideTimerRef.current = null;
      }
      if (!saveBlockedRef.current) {
        setSaveState("unsaved");
        setError(null);
      }
    },
    [onDraftChange],
  );

  const handleCancel = useCallback(async () => {
    if (canceling) return;
    setCanceling(true);
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const saved = await persistDraft();
    setCanceling(false);
    if (saved) onCancel?.();
  }, [canceling, onCancel, persistDraft]);

  const handleRetrySave = useCallback(async () => {
    if (saving || !saveBlockedRef.current) return;
    saveBlockedRef.current = false;
    setError(null);
    setSaveState("unsaved");
    await persistDraft();
  }, [persistDraft, saving]);

  const updateColor = useCallback(
    (key: string, value: string) => {
      updateDraft({
        tokens: {
          ...(draft.tokens ?? {}),
          colors: { ...(draft.tokens?.colors ?? {}), [key]: value },
        },
      });
    },
    [draft.tokens, updateDraft],
  );

  const applyBrandDraft = useCallback(
    (next: VideoStyleDraft) => {
      dirtyRef.current = false;
      latestDraftRef.current = next;
      setDraft(next);
      setSaveState("saved");
      onDraftChange?.(next);
    },
    [onDraftChange],
  );

  const handleApplyBrandKit = useCallback(
    async (kit: VideoBrandKit) => {
      if (brandLoading || saveBlockedRef.current || kit.latestVersion < 1)
        return;
      setBrandLoading(true);
      setError(null);
      try {
        if (dirtyRef.current && !(await persistDraft())) return;
        const result = await applyVideoBrandKit(
          token,
          seriesId,
          kit.id,
          kit.latestVersion,
        );
        if (!result.ok || !result.draft) {
          throw new Error(result.error || "应用标识与配色失败");
        }
        applyBrandDraft(result.draft);
      } catch (brandError) {
        setError(
          brandError instanceof Error ? brandError.message : String(brandError),
        );
      } finally {
        setBrandLoading(false);
      }
    },
    [applyBrandDraft, brandLoading, persistDraft, seriesId, token],
  );

  const handleCreateBrandKit = useCallback(async () => {
    if (brandLoading || saveBlockedRef.current) return;
    setBrandLoading(true);
    setError(null);
    try {
      if (dirtyRef.current && !(await persistDraft())) return;
      const displayName = String(draft.name || seriesId);
      const result = await createVideoBrandKit(token, {
        name: `${displayName} 标识与配色`,
        displayName,
        tokens: {
          colors: draft.tokens?.colors,
          typography: draft.tokens?.typography,
        },
      });
      if (!result.ok || !result.brandKit || !result.version) {
        throw new Error(result.error || "保存标识与配色失败");
      }
      const kit = {
        ...result.brandKit,
        latestVersion: result.version.version,
      };
      setBrandKits((current) => [...current, kit]);
      const applied = await applyVideoBrandKit(
        token,
        seriesId,
        kit.id,
        kit.latestVersion,
      );
      if (!applied.ok || !applied.draft) {
        throw new Error(applied.error || "应用标识与配色失败");
      }
      applyBrandDraft(applied.draft);
    } catch (brandError) {
      setError(
        brandError instanceof Error ? brandError.message : String(brandError),
      );
    } finally {
      setBrandLoading(false);
    }
  }, [
    applyBrandDraft,
    brandLoading,
    draft.name,
    draft.tokens,
    persistDraft,
    seriesId,
    token,
  ]);

  const handlePickBrandLogo = useCallback(
    async (kit: VideoBrandKit, variant: "light" | "dark") => {
      if (!isTauri()) {
        setError("请在 Mona 桌面端选择标识图片");
        return;
      }
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [
            { name: "标识图片", extensions: ["png", "jpg", "jpeg", "webp"] },
          ],
        });
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (!path || typeof path !== "string") return;
        setBrandLogoRights("unknown");
        setPendingBrandLogo({ kit, variant, path });
      } catch (logoError) {
        setError(
          logoError instanceof Error ? logoError.message : String(logoError),
        );
      }
    },
    [],
  );

  const handleConfirmBrandLogo = useCallback(async () => {
    if (!pendingBrandLogo || brandLoading) return;
    setBrandLoading(true);
    setError(null);
    try {
      const uploaded = await uploadVideoBrandLogo(
        token,
        pendingBrandLogo.kit.id,
        pendingBrandLogo.path,
        pendingBrandLogo.variant,
        brandLogoRights,
      );
      if (!uploaded.ok || !uploaded.brandKit) {
        throw new Error(uploaded.error || "图片上传失败");
      }
      const locked = await lockVideoBrandKit(
        token,
        pendingBrandLogo.kit.id,
        uploaded.brandKit.revision,
      );
      if (!locked.ok || !locked.version) {
        throw new Error(locked.error || "保存标识与配色失败");
      }
      const nextKit: VideoBrandKit = {
        ...uploaded.brandKit,
        latestVersion: locked.version.version,
        brand: locked.version.brand,
      };
      setBrandKits((current) =>
        current.map((kit) => (kit.id === nextKit.id ? nextKit : kit)),
      );
      if (brandBinding?.id === nextKit.id) {
        const applied = await applyVideoBrandKit(
          token,
          seriesId,
          nextKit.id,
          nextKit.latestVersion,
        );
        if (!applied.ok || !applied.draft) {
          throw new Error(applied.error || "应用标识与配色失败");
        }
        applyBrandDraft(applied.draft);
      }
      setPendingBrandLogo(null);
    } catch (logoError) {
      setError(
        logoError instanceof Error ? logoError.message : String(logoError),
      );
    } finally {
      setBrandLoading(false);
    }
  }, [
    applyBrandDraft,
    brandBinding?.id,
    brandLoading,
    brandLogoRights,
    pendingBrandLogo,
    seriesId,
    token,
  ]);

  const defaultBackgroundSlot =
    draft.backgrounds?.default ?? defaultBackground(String(draft.mode));
  const backgroundSlot =
    backgroundRole === "default"
      ? defaultBackgroundSlot
      : {
          ...defaultBackgroundSlot,
          ...(draft.backgrounds?.roles?.[backgroundRole] ?? {}),
        };

  useEffect(() => {
    const assetId = backgroundSlot.assetId;
    if (!assetId) {
      setAssetPreviewUrl(null);
      return;
    }
    if (asset?.id === assetId && asset.previewUrl) {
      setAssetPreviewUrl(asset.previewUrl);
      return;
    }
    let cancelled = false;
    void getServicesHttpBase().then((base) => {
      if (!cancelled) {
        setAssetPreviewUrl(
          buildVideoBackgroundAssetPreviewUrl(base, token, seriesId, assetId),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asset, backgroundSlot.assetId, seriesId, token]);
  const colors = draft.tokens?.colors ?? DEFAULT_COLORS;
  const previewImage = assetPreviewUrl ?? asset?.previewUrl ?? null;

  const previewStyle = useMemo(() => {
    const overlay = backgroundSlot.overlay;
    const overlayColor =
      overlay?.color ?? colors.background ?? DEFAULT_COLORS.background;
    const overlayOpacity = Math.max(
      0,
      Math.min(1, Number(overlay?.opacity ?? 0.56)),
    );
    const overlayCss = /^#[0-9a-f]{6}$/i.test(overlayColor)
      ? `${overlayColor}${Math.round(overlayOpacity * 255)
          .toString(16)
          .padStart(2, "0")}`
      : overlayColor;
    const backgroundImage = previewImage
      ? `linear-gradient(${overlayCss}, ${overlayCss}), url("${previewImage}")`
      : `linear-gradient(${colors.background}, ${colors.surface})`;
    return {
      backgroundImage,
      backgroundColor: colors.background,
      backgroundPosition: `${(backgroundSlot.focalPoint?.x ?? 0.5) * 100}% ${(backgroundSlot.focalPoint?.y ?? 0.45) * 100}%`,
      backgroundSize: backgroundSlot.fit === "contain" ? "contain" : "cover",
      "--series-primary": colors.primary,
      "--series-secondary": colors.secondary,
      "--series-surface": colors.surface,
      "--series-text": colors.textPrimary,
      "--series-muted": colors.textSecondary,
    } as CSSProperties;
  }, [backgroundSlot, colors, previewImage]);

  const updateFocalPointFromPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activeSection !== "background") return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = Math.max(
        0,
        Math.min(1, (event.clientX - bounds.left) / bounds.width),
      );
      const y = Math.max(
        0,
        Math.min(1, (event.clientY - bounds.top) / bounds.height),
      );
      updateDraft({
        backgrounds: {
          ...(draft.backgrounds ?? {}),
          ...(backgroundRole === "default"
            ? { default: { ...defaultBackgroundSlot, focalPoint: { x, y } } }
            : {
                roles: {
                  ...(draft.backgrounds?.roles ?? {}),
                  [backgroundRole]: {
                    ...(draft.backgrounds?.roles?.[backgroundRole] ?? {}),
                    focalPoint: { x, y },
                  },
                },
              }),
        },
      });
    },
    [
      activeSection,
      backgroundRole,
      defaultBackgroundSlot,
      draft.backgrounds,
      updateDraft,
    ],
  );

  const validateDraft = useCallback(async (): Promise<boolean> => {
    setValidating(true);
    setError(null);
    try {
      const result = await validateVideoStyle(
        token,
        seriesId,
        draftPayload(latestDraftRef.current),
      );
      const nextIssues = result.issues ?? [];
      setIssues(nextIssues);
      if (!result.ok || !result.valid) {
        setError(
          result.error ||
            nextIssues.find((issue) => issue.severity === "error")?.message ||
            "请调整未通过的文字可读性设置",
        );
        return false;
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setValidating(false);
    }
  }, [seriesId, token]);

  const handleValidate = useCallback(async () => {
    if (saveBlockedRef.current) return;
    if (dirtyRef.current && !(await persistDraft())) return;
    await validateDraft();
  }, [persistDraft, validateDraft]);

  const handleLock = useCallback(async () => {
    if (locking || saveBlockedRef.current) return;
    setLocking(true);
    setError(null);
    try {
      if (dirtyRef.current && !(await persistDraft())) return;
      if (!(await validateDraft())) return;
      const result = await lockVideoStyle(
        token,
        seriesId,
        draftPayload(latestDraftRef.current),
      );
      if (!result.ok || !result.version) {
        throw new Error(result.error || "保存风格失败");
      }
      onLocked?.(result.version);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLocking(false);
    }
  }, [locking, onLocked, persistDraft, seriesId, token, validateDraft]);

  const handleUploadBackground = useCallback(async () => {
    if (!isTauri()) {
      setError("请在 Mona 桌面端选择本地图片");
      return;
    }
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [
          { name: "背景图片", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath || typeof filePath !== "string") return;
      setPendingBackgroundPath(filePath);
      setBackgroundRights("unknown");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleConfirmBackgroundImport = useCallback(async () => {
    if (!pendingBackgroundPath || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const sourceType =
        backgroundRights === "ai-generated"
          ? "ai-generated"
          : backgroundRights === "licensed"
            ? "licensed-library"
            : "user-upload";
      const result = await uploadVideoBackgroundAsset(
        token,
        seriesId,
        pendingBackgroundPath,
        {
          sourceType,
          rightsStatus: backgroundRights,
          licenseName:
            backgroundRights === "licensed" ? "已获商业授权" : undefined,
        },
      );
      if (!result.ok || !result.asset)
        throw new Error(result.error || "背景上传失败");
      setAsset(result.asset);
      if (result.asset.previewUrl) {
        setAssetPreviewUrl(result.asset.previewUrl);
      } else {
        const base = await getServicesHttpBase();
        setAssetPreviewUrl(
          buildVideoBackgroundAssetPreviewUrl(
            base,
            token,
            seriesId,
            result.asset.id,
          ),
        );
      }
      updateDraft({
        backgrounds: {
          ...(draft.backgrounds ?? {}),
          ...(backgroundRole === "default"
            ? {
                default: {
                  ...defaultBackgroundSlot,
                  assetId: result.asset.id,
                },
              }
            : {
                roles: {
                  ...(draft.backgrounds?.roles ?? {}),
                  [backgroundRole]: {
                    ...(draft.backgrounds?.roles?.[backgroundRole] ?? {}),
                    assetId: result.asset.id,
                  },
                },
              }),
        },
      });
      setPendingBackgroundPath(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }, [
    backgroundRights,
    backgroundRole,
    defaultBackgroundSlot,
    draft.backgrounds,
    pendingBackgroundPath,
    seriesId,
    token,
    updateDraft,
    uploading,
  ]);

  const setBackgroundField = useCallback(
    (patch: Partial<VideoBackgroundSlot>) => {
      updateDraft({
        backgrounds: {
          ...(draft.backgrounds ?? {}),
          ...(backgroundRole === "default"
            ? { default: { ...defaultBackgroundSlot, ...patch } }
            : {
                roles: {
                  ...(draft.backgrounds?.roles ?? {}),
                  [backgroundRole]: {
                    ...(draft.backgrounds?.roles?.[backgroundRole] ?? {}),
                    ...patch,
                  },
                },
              }),
        },
      });
    },
    [
      backgroundRole,
      defaultBackgroundSlot,
      draft.backgrounds,
      updateDraft,
    ],
  );

  const resetBackgroundRole = useCallback(() => {
    if (backgroundRole === "default") return;
    // null replaces the server's deep-merged role override; omission would retain it.
    updateDraft({
      backgrounds: {
        ...(draft.backgrounds ?? {}),
        roles: {
          ...(draft.backgrounds?.roles ?? {}),
          [backgroundRole]: null,
        } as unknown as NonNullable<VideoStyleConfig["backgrounds"]>["roles"],
      },
    });
  }, [backgroundRole, draft.backgrounds, updateDraft]);

  const hasRoleBackgroundOverride =
    backgroundRole !== "default" &&
    Object.keys(draft.backgrounds?.roles?.[backgroundRole] ?? {}).length > 0;

  if (loading) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center text-caption text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载风格草稿…
      </div>
    );
  }

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background", className)}
    >
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="w-full shrink-0 border-b border-border/70 lg:w-[188px] lg:border-b-0 lg:border-r">
          <div className="border-b border-border/70 px-3 py-2.5">
            <div className="text-ui font-medium">我的风格</div>
            <div className="mt-1 truncate text-micro text-muted-foreground">
              {draft.name || "风格设置"}
            </div>
          </div>
          <nav
            className="flex gap-1 overflow-x-auto p-2 lg:block lg:space-y-1"
            aria-label="风格设置"
          >
            {SECTIONS.map((section) => (
              <Button
                key={section.id}
                type="button"
                variant="ghost"
                aria-current={activeSection === section.id ? "page" : undefined}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  "min-w-max rounded-md px-2 py-2 text-left !text-caption transition-colors lg:flex lg:h-9 lg:w-full lg:items-center lg:gap-2",
                  activeSection === section.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <section.icon
                  className="hidden h-3.5 w-3.5 shrink-0 lg:block"
                  aria-hidden="true"
                />
                <span className="block truncate text-caption font-medium">
                  {section.label}
                </span>
                <span className="ml-auto hidden truncate text-micro text-muted-foreground xl:block">
                  {section.hint}
                </span>
              </Button>
            ))}
          </nav>
        </aside>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-4">
            {activeSection === "basics" && (
              <section
                className="mx-auto max-w-[560px] space-y-4"
                aria-labelledby="style-basics-heading"
              >
                <SectionHeading
                  id="style-basics-heading"
                  title="配色与样式"
                  description="这里保存一套可复用的画面颜色、字体和背景。"
                />
                <label className="block text-micro font-medium text-muted-foreground">
                  风格名称
                  <Input
                    className="mt-1 text-caption"
                    value={draft.name ?? ""}
                    placeholder="例如：品牌宣传视频"
                    onChange={(event) =>
                      updateDraft({ name: event.target.value })
                    }
                  />
                </label>
                <details className="rounded-lg border border-border/70 p-3">
                  <summary className="flex cursor-pointer items-center gap-1.5 text-caption font-medium">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    标识与配色（可选）
                  </summary>
                  <div className="mt-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-micro text-muted-foreground">
                          保存常用颜色和标识图片，之后可在其他风格中复用。
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCreateBrandKit()}
                        disabled={brandLoading}
                      >
                        {brandLoading ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        保存到我的标识与配色
                      </Button>
                    </div>
                    {brandBinding ? (
                      <div className="mt-3 rounded-md bg-primary/5 px-3 py-2 text-caption">
                        <span className="font-medium">
                          {brandBinding.name ?? brandBinding.id}
                        </span>
                        <span className="ml-1 text-muted-foreground">
                          版本 {brandBinding.version} · 已固定 {lockedBrandFields.size} 项设置
                        </span>
                      </div>
                    ) : null}
                    {brandKits.length > 0 ? (
                      <div className="mt-3 grid gap-1.5">
                        {brandKits.map((kit) => {
                          const applied = brandBinding?.id === kit.id;
                          return (
                            <div
                              key={kit.id}
                              className="flex items-center gap-1 rounded-md border border-border/70 p-1"
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                aria-label={`应用标识与配色：${kit.name}`}
                                disabled={
                                  brandLoading || kit.latestVersion < 1 || applied
                                }
                                onClick={() => void handleApplyBrandKit(kit)}
                                className="h-auto min-w-0 flex-1 justify-between px-2 py-1.5 text-left"
                              >
                                <span>
                                  <span className="block text-caption font-medium">
                                    {kit.name}
                                  </span>
                                  <span className="block text-micro text-muted-foreground">
                                    已保存版本 {kit.latestVersion} · 固定 {kit.lockedFields.length} 项设置
                                  </span>
                                </span>
                                <span className="text-micro">
                                  {applied ? "已应用" : "应用"}
                                </span>
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-micro"
                                aria-label={`${kit.name}深色背景标识图片`}
                                disabled={brandLoading}
                                onClick={() =>
                                  void handlePickBrandLogo(kit, "light")
                                }
                              >
                                <ImagePlus className="mr-1 h-3 w-3" />
                                深色背景图片
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-micro"
                                aria-label={`${kit.name}浅色背景标识图片`}
                                disabled={brandLoading}
                                onClick={() =>
                                  void handlePickBrandLogo(kit, "dark")
                                }
                              >
                                <ImagePlus className="mr-1 h-3 w-3" />
                                浅色背景图片
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                </details>
                <div className="rounded-md border border-border/70 px-3 py-2">
                  <div className="text-micro font-medium text-muted-foreground">
                    起始风格
                  </div>
                  <div className="mt-1 text-caption font-medium">
                    {TEMPLATE_NAMES[draft.baseTemplateId ?? ""] ?? "自定义"}
                  </div>
                  <div className="mt-0.5 text-micro text-muted-foreground">
                    仅提供画面风格参考，视频内容和排版由创作过程决定。
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-micro font-medium text-muted-foreground">
                    明暗模式
                  </div>
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                    {(["dark", "light"] as const).map((value) => (
                      <Button
                        key={value}
                        type="button"
                        variant="ghost"
                        aria-pressed={draft.mode === value}
                        className={cn(
                          "!text-caption",
                          draft.mode === value
                            ? "bg-card text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() =>
                          updateDraft({
                            mode: value,
                            backgrounds: {
                              default: {
                                ...defaultBackgroundSlot,
                                overlay: {
                                  ...(defaultBackgroundSlot.overlay ?? {}),
                                  color:
                                    value === "dark"
                                      ? colors.background
                                      : "#FFFFFF",
                                },
                                fallback:
                                  value === "dark"
                                    ? colors.background
                                    : "#FFFFFF",
                              },
                            },
                          })
                        }
                      >
                        {value === "dark" ? "深色" : "浅色"}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-micro font-medium text-muted-foreground">
                    颜色
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {[
                      ["primary", "主色", DEFAULT_COLORS.primary],
                      ["secondary", "辅助色", DEFAULT_COLORS.secondary],
                      ["background", "背景色", DEFAULT_COLORS.background],
                      ["surface", "卡片色", DEFAULT_COLORS.surface],
                    ].map(([key, label, fallback]) => (
                      <ColorPresetField
                        key={key}
                        label={label}
                        value={colors[key]}
                        fallback={fallback}
                        disabled={lockedBrandFields.has(`tokens.colors.${key}`)}
                        onChange={(value) => updateColor(key, value)}
                      />
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-micro font-medium text-muted-foreground">
                    卡片风格
                    <Select
                      className="mt-1 h-8 !text-caption"
                      value={String(
                        draft.tokens?.shape?.cardStyle ?? "outline",
                      )}
                      onValueChange={(value) =>
                        updateDraft({
                          tokens: {
                            ...(draft.tokens ?? {}),
                            shape: {
                              ...(draft.tokens?.shape ?? {}),
                              cardStyle: value,
                            },
                          },
                        })
                      }
                      options={[
                        { value: "solid", label: "纯色" },
                        { value: "outline", label: "描边" },
                        { value: "glass", label: "玻璃" },
                        { value: "none", label: "无卡片" },
                      ]}
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    信息密度
                    <Select
                      className="mt-1 h-8 !text-caption"
                      value={String(draft.tokens?.shape?.density ?? "standard")}
                      onValueChange={(value) =>
                        updateDraft({
                          tokens: {
                            ...(draft.tokens ?? {}),
                            shape: {
                              ...(draft.tokens?.shape ?? {}),
                              density: value,
                            },
                          },
                        })
                      }
                      options={[
                        { value: "compact", label: "紧凑" },
                        { value: "standard", label: "标准" },
                        { value: "spacious", label: "宽松" },
                      ]}
                    />
                  </label>
                </div>
                <label className="block text-micro font-medium text-muted-foreground">
                  圆角：{Number(draft.tokens?.shape?.cardRadius ?? 20)}px
                  <input
                    type="range"
                    min={0}
                    max={32}
                    value={Number(draft.tokens?.shape?.cardRadius ?? 20)}
                    onChange={(event) =>
                      updateDraft({
                        tokens: {
                          ...(draft.tokens ?? {}),
                          shape: {
                            ...(draft.tokens?.shape ?? {}),
                            cardRadius: Number(event.target.value),
                          },
                        },
                      })
                    }
                    className="mt-2 w-full accent-[hsl(var(--brand-red))]"
                  />
                </label>
              </section>
            )}

            {activeSection === "background" && (
              <section
                className="mx-auto max-w-[560px] space-y-4"
                aria-labelledby="style-background-heading"
              >
                <SectionHeading
                  id="style-background-heading"
                  title="背景图片"
                  description="背景图片只影响画面；文字留白会自动调整。"
                />
                <label className="block text-micro font-medium text-muted-foreground">
                  应用到
                  <Select
                    className="mt-1 h-8 !text-caption"
                    value={backgroundRole}
                    onValueChange={setBackgroundRole}
                    options={[
                      { value: "default", label: "全部画面" },
                      { value: "cover", label: "封面" },
                      { value: "chapter", label: "章节" },
                      { value: "content", label: "普通内容" },
                      { value: "data", label: "数据" },
                      { value: "comparison", label: "对比" },
                      { value: "process", label: "步骤" },
                      { value: "quote", label: "引用" },
                      { value: "outro", label: "结尾" },
                    ]}
                  />
                </label>
                <div className="rounded-lg border border-border/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-caption font-medium">
                        {backgroundRole === "default"
                          ? "默认背景"
                          : `${PREVIEW_ROLES.find((role) => role.value === backgroundRole)?.label ?? "画面"}背景`}
                      </div>
                      <div className="mt-0.5 text-micro text-muted-foreground">
                    {backgroundRole === "default"
                      ? "其他画面没有单独背景时使用"
                          : "其他画面继续使用默认背景"}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      {hasRoleBackgroundOverride ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 !text-micro"
                          onClick={resetBackgroundRole}
                        >
                          恢复默认
                        </Button>
                      ) : null}
                      {backgroundSlot.assetId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-8 !text-micro"
                          onClick={() => setBackgroundField({ assetId: null })}
                        >
                          移除图片
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 !text-micro"
                        onClick={() => void handleUploadBackground()}
                        disabled={uploading}
                      >
                        {uploading ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ImagePlus className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {uploading ? "上传中…" : "选择图片"}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-micro text-muted-foreground">
                      使用策略
                    </span>
                    <Select
                      className="h-8 flex-1 !text-caption"
                      value={String(backgroundSlot.assetPolicy ?? "fixed")}
                      onValueChange={(value) =>
                        setBackgroundField({ assetPolicy: value })
                      }
                      options={[
                        { value: "fixed", label: "固定背景" },
                        { value: "episode-replaceable", label: "每期可替换" },
                      ]}
                    />
                  </div>
                  <div className="mt-3 overflow-hidden rounded-md border border-border/70 bg-muted/30">
                    {previewImage ? (
                      <div
                        className="h-28 bg-cover bg-center"
                        style={{ backgroundImage: `url("${previewImage}")` }}
                        aria-label="当前背景预览"
                      />
                    ) : (
                      <div className="flex h-28 items-center justify-center text-micro text-muted-foreground">
                        尚未选择背景图片
                      </div>
                    )}
                  </div>
                  <div className="mt-2 text-micro text-muted-foreground">
                    支持 PNG、JPG、JPEG、WebP。
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-micro font-medium text-muted-foreground">
                    图片适配
                    <Select
                      className="mt-1 h-8 !text-caption"
                      value={String(backgroundSlot.fit ?? "cover")}
                      onValueChange={(value) =>
                        setBackgroundField({ fit: value })
                      }
                      options={[
                        { value: "cover", label: "铺满画面" },
                        { value: "contain", label: "完整显示" },
                      ]}
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    模板着色：
                    {Math.round(Number(backgroundSlot.tint ?? 0) * 100)}%
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={Number(backgroundSlot.tint ?? 0)}
                      onChange={(event) =>
                        setBackgroundField({ tint: Number(event.target.value) })
                      }
                      className="mt-2 w-full accent-[hsl(var(--brand-red))]"
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    水平焦点：
                    {Math.round((backgroundSlot.focalPoint?.x ?? 0.5) * 100)}%
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={backgroundSlot.focalPoint?.x ?? 0.5}
                      onChange={(event) =>
                        setBackgroundField({
                          focalPoint: {
                            ...(backgroundSlot.focalPoint ?? {
                              x: 0.5,
                              y: 0.45,
                            }),
                            x: Number(event.target.value),
                          },
                        })
                      }
                      className="mt-2 w-full accent-[hsl(var(--brand-red))]"
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    垂直焦点：
                    {Math.round((backgroundSlot.focalPoint?.y ?? 0.45) * 100)}%
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={backgroundSlot.focalPoint?.y ?? 0.45}
                      onChange={(event) =>
                        setBackgroundField({
                          focalPoint: {
                            ...(backgroundSlot.focalPoint ?? {
                              x: 0.5,
                              y: 0.45,
                            }),
                            y: Number(event.target.value),
                          },
                        })
                      }
                      className="mt-2 w-full accent-[hsl(var(--brand-red))]"
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    遮罩强度：
                    {Math.round(
                      Number(backgroundSlot.overlay?.opacity ?? 0.56) * 100,
                    )}
                    %
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={Number(backgroundSlot.overlay?.opacity ?? 0.56)}
                      onChange={(event) =>
                        setBackgroundField({
                          overlay: {
                            ...(backgroundSlot.overlay ?? {}),
                            opacity: Number(event.target.value),
                          },
                        })
                      }
                      className="mt-2 w-full accent-[hsl(var(--brand-red))]"
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    背景模糊：{Number(backgroundSlot.blur ?? 0)}px
                    <input
                      type="range"
                      min={0}
                      max={12}
                      step={1}
                      value={Number(backgroundSlot.blur ?? 0)}
                      onChange={(event) =>
                        setBackgroundField({ blur: Number(event.target.value) })
                      }
                      className="mt-2 w-full accent-[hsl(var(--brand-red))]"
                    />
                  </label>
                </div>
                <div className="rounded-md bg-muted/50 px-3 py-2 text-micro text-muted-foreground">
                  保存风格后，会检查文字是否清楚易读。
                </div>
              </section>
            )}

            {activeSection === "components" && (
              <section
                className="mx-auto max-w-[560px] space-y-4"
                aria-labelledby="style-components-heading"
              >
                <SectionHeading
                  id="style-components-heading"
                  title="文字与字号"
                  description="选择标题和正文使用的字体、字号。"
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-micro font-medium text-muted-foreground">
                    标题字体
                    <Select
                      aria-label="标题字体"
                      disabled={lockedBrandFields.has(
                        "tokens.typography.headingFamily",
                      )}
                      className="mt-1 h-8 !text-caption"
                      value={String(
                        draft.tokens?.typography?.headingFamily ??
                          "Noto Sans SC",
                      )}
                      onValueChange={(value) =>
                        updateDraft({
                          tokens: {
                            ...(draft.tokens ?? {}),
                            typography: {
                              ...(draft.tokens?.typography ?? {}),
                              headingFamily: value,
                            },
                          },
                        })
                      }
                      options={FONT_OPTIONS}
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    正文字体
                    <Select
                      aria-label="正文字体"
                      disabled={lockedBrandFields.has(
                        "tokens.typography.bodyFamily",
                      )}
                      className="mt-1 h-8 !text-caption"
                      value={String(
                        draft.tokens?.typography?.bodyFamily ?? "Noto Sans SC",
                      )}
                      onValueChange={(value) =>
                        updateDraft({
                          tokens: {
                            ...(draft.tokens ?? {}),
                            typography: {
                              ...(draft.tokens?.typography ?? {}),
                              bodyFamily: value,
                            },
                          },
                        })
                      }
                      options={FONT_OPTIONS}
                    />
                  </label>
                </div>
                <label className="block text-micro font-medium text-muted-foreground">
                  字号层级
                  <Select
                    className="mt-1 h-8 !text-caption"
                    value={String(
                      draft.tokens?.typography?.scale ?? "standard",
                    )}
                    onValueChange={(value) =>
                      updateDraft({
                        tokens: {
                          ...(draft.tokens ?? {}),
                          typography: {
                            ...(draft.tokens?.typography ?? {}),
                            scale: value,
                          },
                        },
                      })
                    }
                    options={[
                      { value: "compact", label: "紧凑" },
                      { value: "standard", label: "标准" },
                      { value: "large", label: "大标题" },
                    ]}
                  />
                </label>
              </section>
            )}

            {activeSection === "motion" && (
              <section
                className="mx-auto max-w-[560px] space-y-4"
                aria-labelledby="style-motion-heading"
              >
                <SectionHeading
                  id="style-motion-heading"
                  title="字幕与动效"
                  description="默认使用简单淡入；字幕会自动留在清晰、安全的位置。"
                />
                <label className="block text-micro font-medium text-muted-foreground">
                  动效多少
                  <Select
                    className="mt-1 h-8 !text-caption"
                    value={String(draft.motion?.intensity ?? "restrained")}
                    onValueChange={(value) =>
                      updateDraft({
                        motion: { ...(draft.motion ?? {}), intensity: value },
                      })
                    }
                    options={[
                      { value: "restrained", label: "克制" },
                      { value: "standard", label: "标准" },
                      { value: "active", label: "活跃" },
                    ]}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-micro font-medium text-muted-foreground">
                    画面出现
                    <Select
                      aria-label="入场方式"
                      className="mt-1 h-8 !text-caption"
                      value={String(draft.motion?.enterPreset ?? "fade-rise")}
                      onValueChange={(value) =>
                        updateDraft({
                          motion: {
                            ...(draft.motion ?? {}),
                            enterPreset: value,
                          },
                        })
                      }
                      options={ENTER_PRESET_OPTIONS}
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    重点提示
                    <Select
                      aria-label="强调方式"
                      className="mt-1 h-8 !text-caption"
                      value={String(
                        draft.motion?.emphasisPreset ?? "soft-pulse",
                      )}
                      onValueChange={(value) =>
                        updateDraft({
                          motion: {
                            ...(draft.motion ?? {}),
                            emphasisPreset: value,
                          },
                        })
                      }
                      options={EMPHASIS_PRESET_OPTIONS}
                    />
                  </label>
                  <label className="text-micro font-medium text-muted-foreground">
                    场景之间的切换
                    <Select
                      aria-label="场景切换"
                      className="mt-1 h-8 !text-caption"
                      value={String(
                        draft.motion?.transitionPreset ?? "cross-fade",
                      )}
                      onValueChange={(value) =>
                        updateDraft({
                          motion: {
                            ...(draft.motion ?? {}),
                            transitionPreset: value,
                          },
                        })
                      }
                      options={TRANSITION_PRESET_OPTIONS}
                    />
                  </label>
                </div>
                <div className="border-t border-border/70 pt-4">
                  <div className="mb-2 text-caption font-medium">字幕</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-micro text-muted-foreground">
                      位置
                      <Select
                        aria-label="字幕位置"
                        className="mt-1 h-8 !text-caption"
                        value={String(
                          draft.subtitle?.position ?? "bottom-center",
                        )}
                        onValueChange={(value) =>
                          updateDraft({
                            subtitle: {
                              ...(draft.subtitle ?? {}),
                              position: value,
                            },
                          })
                        }
                        options={[
                          { value: "bottom-center", label: "底部居中" },
                          { value: "bottom-left", label: "底部左侧" },
                          { value: "top-center", label: "顶部居中" },
                        ]}
                      />
                    </label>
                    <label className="text-micro text-muted-foreground">
                      样式
                      <Select
                        aria-label="字幕样式"
                        className="mt-1 h-8 !text-caption"
                        value={String(draft.subtitle?.style ?? "caption-rail")}
                        onValueChange={(value) =>
                          updateDraft({
                            subtitle: {
                              ...(draft.subtitle ?? {}),
                              style: value,
                            },
                          })
                        }
                        options={SUBTITLE_STYLE_OPTIONS}
                      />
                    </label>
                  </div>
                  <div className="mt-3 text-micro text-muted-foreground">
                    最大行数
                    <div className="mt-1 grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
                      {[1, 2, 3].map((lines) => (
                        <Button
                          key={lines}
                          type="button"
                          variant="ghost"
                          aria-pressed={
                            Number(draft.subtitle?.maxLines ?? 2) === lines
                          }
                          className={cn(
                            "h-7 !text-caption",
                            Number(draft.subtitle?.maxLines ?? 2) === lines &&
                              "bg-card text-foreground",
                          )}
                          onClick={() =>
                            updateDraft({
                              subtitle: {
                                ...(draft.subtitle ?? {}),
                                maxLines: lines,
                              },
                            })
                          }
                        >
                          {lines} 行
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            )}

            {activeSection === "advanced" && (
              <section
                className="mx-auto max-w-[560px] space-y-4"
                aria-labelledby="style-advanced-heading"
              >
                <SectionHeading
                  id="style-advanced-heading"
                  title="其他颜色与画幅"
                  description="常用设置已够用；需要时可在这里调整更多颜色和比例。"
                />
                <div className="rounded-md border border-border/70 px-3 py-2 text-micro text-muted-foreground">
                  保存新风格后，不会改变已经完成的视频。
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    ["textPrimary", "主文字色", "#FFFFFF"],
                    ["textSecondary", "辅助文字色", "#B7BCCB"],
                    ["border", "边框色", "#2B3040"],
                  ].map(([key, label, fallback]) => (
                    <ColorPresetField
                      key={key}
                      label={label}
                      value={colors[key]}
                      fallback={fallback}
                      disabled={lockedBrandFields.has(`tokens.colors.${key}`)}
                      onChange={(value) => updateColor(key, value)}
                    />
                  ))}
                </div>
                <div>
                  <div className="mb-2 text-micro font-medium text-muted-foreground">
                    启用画面比例
                  </div>
                  <div className="mb-2 text-micro text-muted-foreground">
                    默认画幅始终启用，确保风格始终能用于创作。
                  </div>
                  <div className="space-y-2">
                    {ASPECTS.map((aspect) => {
                      const aspectState =
                        draft.aspectVariants?.[aspect.value];
                      const isDefaultAspect =
                        aspect.value === defaultAspectRatio;
                      return (
                        <label
                          key={aspect.value}
                          className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2 text-caption"
                        >
                          <span>
                            {aspect.label}{" "}
                            <span className="ml-1 text-micro text-muted-foreground">
                              {aspect.value}
                            </span>
                            {isDefaultAspect ? (
                              <span className="ml-2 text-micro text-muted-foreground">
                                默认，始终启用
                              </span>
                            ) : null}
                          </span>
                          <Checkbox
                            checked={aspectState?.enabled !== false}
                            disabled={isDefaultAspect}
                            onCheckedChange={(checked) => {
                              if (isDefaultAspect) return;
                              updateDraft({
                                aspectVariants: {
                                  ...(draft.aspectVariants ?? {}),
                                  [aspect.value]: {
                                    ...(aspectState ?? {}),
                                    enabled: checked === true,
                                  },
                                },
                              });
                            }}
                            aria-label={`启用${aspect.label}`}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}
          </div>

          <section
            className="flex min-h-[320px] w-full shrink-0 flex-col border-t border-border/70 bg-muted/20 p-4 lg:w-[48%] lg:border-l lg:border-t-0"
            aria-label="样式预览"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-caption font-medium">样式预览</div>
                <div className="text-micro text-muted-foreground">
                  预览会随设置更新
                </div>
              </div>
              <div className="flex gap-1 rounded-md bg-muted p-1">
                {ASPECTS.map((aspect) => (
                  <Button
                    key={aspect.value}
                    type="button"
                    variant="ghost"
                    aria-pressed={previewRatio === aspect.value}
                    className={cn(
                      "!text-micro",
                      previewRatio === aspect.value
                        ? "bg-card text-foreground"
                        : "text-muted-foreground",
                    )}
                    onClick={() => setPreviewRatio(aspect.value)}
                  >
                    {aspect.value}
                  </Button>
                ))}
              </div>
            </div>

            {activeSection === "background" ? (
              <div className="mb-2 flex gap-1 rounded-md bg-muted p-1">
                {(["scene", "background"] as const).map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    variant="ghost"
                    aria-pressed={previewMode === mode}
                    className={cn(
                      "h-7 flex-1 !text-micro",
                      previewMode === mode && "bg-card text-foreground",
                    )}
                    onClick={() => setPreviewMode(mode)}
                  >
                    {mode === "scene" ? "看整体效果" : "调整背景位置"}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg border border-border/70 bg-black/20 p-4">
              {previewMode === "background" &&
              activeSection === "background" ? (
                <div
                  className={cn(
                    "relative w-full max-w-[540px] cursor-crosshair overflow-hidden rounded-md shadow-lg",
                    ratioClass(previewRatio),
                  )}
                  style={previewStyle}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId);
                    updateFocalPointFromPointer(event);
                  }}
                  onPointerMove={(event) => {
                    if (
                      event.currentTarget.hasPointerCapture(event.pointerId)
                    ) {
                      updateFocalPointFromPointer(event);
                    }
                  }}
                  onPointerUp={(event) =>
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                >
                  <div className="absolute inset-0 bg-black/10" />
                  <div
                    className="pointer-events-none absolute z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--series-secondary)] shadow"
                    style={{
                      left: `${(backgroundSlot.focalPoint?.x ?? 0.5) * 100}%`,
                      top: `${(backgroundSlot.focalPoint?.y ?? 0.45) * 100}%`,
                    }}
                    aria-hidden="true"
                  />
                  <div className="relative flex h-full items-center justify-center p-8 text-center text-caption font-medium text-white">
                    拖动调整背景焦点
                  </div>
                </div>
              ) : previewHtml ? (
                <iframe
                  title={`${PREVIEW_ROLES.find((item) => item.value === previewRole)?.label ?? "场景"}真实预览`}
                  srcDoc={previewHtml}
                  sandbox="allow-scripts"
                  className="shrink-0 border-0 shadow-lg"
                  style={PREVIEW_DIMENSIONS[previewRatio]}
                />
              ) : (
                <div className="text-caption text-muted-foreground">
                  正在生成真实预览…
                </div>
              )}
              {previewLoading ? (
                <div className="absolute inset-0 flex items-center justify-center bg-background/55 backdrop-blur-[1px]">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : null}
            </div>

            {previewError ? (
              <div className="mt-2 text-micro text-destructive" role="alert">
                预览暂不可用：{previewError}
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-4 gap-1.5">
              {PREVIEW_ROLES.map((item) => (
                <Button
                  key={item.value}
                  type="button"
                  variant="ghost"
                  aria-pressed={previewRole === item.value}
                  className={cn(
                    "h-8 border border-border/70 !text-micro",
                    previewRole === item.value
                      ? "border-foreground/50 bg-card text-foreground"
                      : "bg-background text-muted-foreground",
                  )}
                  onClick={() => {
                    setPreviewRole(item.value);
                    setPreviewMode("scene");
                  }}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </section>
        </div>
      </div>

      <footer className="shrink-0 border-t border-border/70 px-4 py-3">
        {error ? (
          <div
            className="mb-2 flex items-start gap-1.5 text-micro text-destructive"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
        {issues.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {issues.map((issue, index) => (
              <span
                key={`${issue.code ?? issue.message}-${index}`}
                className={cn(
                  "rounded-md px-2 py-1 text-micro",
                  issue.severity === "error"
                    ? "bg-destructive/10 text-destructive"
                    : issue.severity === "warning"
                      ? "bg-amber-500/10 text-amber-700"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {issue.message}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-micro text-muted-foreground">
            {saving || saveState === "unsaved" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                保存中…
              </>
            ) : saveState === "error" ? (
              <>
                <AlertCircle className="h-3 w-3 text-destructive" />
                保存失败
              </>
            ) : (
              <>
                <Check className="h-3 w-3 text-emerald-600" />
                已保存
              </>
            )}
          </div>
          <div className="flex gap-2">
            {saveState === "error" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 !text-caption"
                onClick={() => void handleRetrySave()}
                disabled={saving}
              >
                重试保存
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 !text-caption"
              onClick={() => void handleCancel()}
              disabled={canceling}
            >
              {canceling ? "保存后返回…" : "取消"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 !text-caption"
              onClick={() => void handleValidate()}
              disabled={validating || saving}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {validating ? "检查中…" : "检查文字可读性"}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 !text-caption"
              onClick={() =>
                currentVersion > 0
                  ? setVersionConfirmOpen(true)
                  : void handleLock()
              }
              disabled={locking || saving || validating}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {locking ? "保存中…" : "保存风格"}
            </Button>
          </div>
        </div>
      </footer>

      <AssetRightsDialog
        open={pendingBackgroundPath !== null}
        fileName={pendingBackgroundPath?.split(/[\\/]/).pop() ?? "背景图片"}
        value={backgroundRights}
        loading={uploading}
        title="确认背景图片使用权"
        onChange={setBackgroundRights}
        onCancel={() => setPendingBackgroundPath(null)}
        onConfirm={() => void handleConfirmBackgroundImport()}
      />

      <AssetRightsDialog
        open={pendingBrandLogo !== null}
        fileName={pendingBrandLogo?.path.split(/[\\/]/).pop() ?? "标识图片"}
        value={brandLogoRights}
        loading={brandLoading}
        title="确认标识图片使用权"
        onChange={setBrandLogoRights}
        onCancel={() => setPendingBrandLogo(null)}
        onConfirm={() => void handleConfirmBrandLogo()}
      />

      <Dialog open={versionConfirmOpen} onOpenChange={setVersionConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>保存为风格版本 {currentVersion + 1}</DialogTitle>
            <DialogDescription>
              保存为新版本后，已经完成的视频保持不变。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-caption">
            <div className="flex items-start gap-2 rounded-md border border-foreground/30 p-3">
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                aria-hidden="true"
              />
              <span>
                <span className="block font-medium">
                  新视频使用版本 {currentVersion + 1}
                </span>
                <span className="mt-0.5 block text-micro text-muted-foreground">
                  已完成的视频不会自动重新生成
                </span>
              </span>
            </div>
            <div className="rounded-md border border-border/70 p-3 text-muted-foreground">
              如果需要，也可以之后单独更新某个视频。
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="!text-caption"
              onClick={() => setVersionConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              className="!text-caption"
              onClick={() => {
                setVersionConfirmOpen(false);
                void handleLock();
              }}
            >
              保存版本 {currentVersion + 1}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 id={id} className="text-body font-medium">
        {title}
      </h2>
      <p className="mt-1 text-micro text-muted-foreground">{description}</p>
    </div>
  );
}
