import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle,
  Clapperboard,
  Download,
  Eye,
  Film,
  FolderOpen,
  History,
  Loader2,
  Languages,
  ListVideo,
  MessageSquarePlus,
  Pause,
  Play,
  RefreshCw,
  Ratio,
  Square,
  Undo2,
  Volume2,
  Wand2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import {
  ApiError,
  buildVideoDownloadUrl,
  buildVideoPreviewFullUrl,
  cancelVideoExport,
  changeVideoProjectAspect,
  createVideoReview,
  exportVideoProject,
  fetchSceneNarrationBytes,
  fetchScenePreviewHtml,
  fetchVideoExportStatus,
  fetchVideoExportPreflight,
  fetchVideoProject,
  fetchVideoProjectVersions,
  fetchVideoReviews,
  fetchVideoRuntimeCheck,
  fetchVideoSceneTimeline,
  fetchVideoStoryboard,
  generateSceneHtml,
  getApiBase,
  getServicesHttpBase,
  localizeVideoProject,
  regenerateVideoScene,
  restoreVideoProjectVersion,
  resolveVideoReview,
  rewriteVideoScene,
  type VideoExportStatus,
  type VideoExportPreflight,
  type VideoLanguage,
  type VideoAspectVariant,
  type VideoProjectPhase,
  type VideoProjectVersion,
  type VideoReview,
  type VideoRuntimeComponent,
  type VideoRuntimeStatus,
  type VideoSceneTimeline,
  type VideoSceneWithHtml,
} from "@/lib/api";
import { downloadMediaUrl, revealItemInDir } from "@/lib/tauri";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";
import { VideoRuntimeDialog, type RuntimeDepKey } from "./VideoRuntimeDialog";
import {
  startVideoRuntimeDownloads,
  useVideoRuntimeDownloadStore,
} from "@/lib/video-runtime-download-store";

interface ProducingPhaseProps {
  projectName: string;
  /** 项目阶段变化时通知父组件（驱动外层步骤条与历史列表刷新）。 */
  onPhaseChange?: (phase: VideoProjectPhase) => void;
  onLocalized?: (projectName: string) => void;
}

type ExportQuality = "draft" | "standard" | "high";
type ReleaseType = "draft" | "final";

const VIDEO_LANGUAGE_OPTIONS: Array<{
  value: VideoLanguage;
  label: string;
}> = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
];

const EXPORT_QUALITY_OPTIONS: Array<{
  value: ExportQuality;
  label: string;
  hint: string;
}> = [
  { value: "draft", label: "快速草稿", hint: "24fps · 半分辨率，快速审阅" },
  { value: "standard", label: "标准成片", hint: "30fps · 原分辨率" },
  { value: "high", label: "高质量成片", hint: "60fps · 原分辨率" },
];

const DEFAULT_RUNTIME_STATUS: VideoRuntimeStatus = {
  node: { ok: false },
  ffmpeg: { ok: false },
  chrome: { ok: false },
};

function motionTargetLabel(target: string): string {
  const prefix = target.split(".", 1)[0];
  return (
    {
      title: "标题",
      body: "正文",
      visual: "主画面",
      brand: "品牌",
      item: "要点",
      step: "步骤",
      metric: "数据",
      comparison: "对比项",
    }[prefix] ?? "元素"
  );
}

/** Parse a resolution string like "1080x1920" or legacy "1920x1080@30fps". */
function parseResolution(raw: string | undefined): { w: number; h: number } {
  const m = /(\d+)\s*x\s*(\d+)/.exec(raw ?? "");
  if (m) {
    const w = Number.parseInt(m[1], 10);
    const h = Number.parseInt(m[2], 10);
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: 1920, h: 1080 };
}

/** Measure a container and compute the largest box with the given aspect
 * ratio that fits inside it (with padding). Recomputes on resize. */
function useFitSize(
  ref: RefObject<HTMLElement | null>,
  ratioW: number,
  ratioH: number,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const rect = el.getBoundingClientRect();
      const availW = rect.width - 32;
      const availH = rect.height - 32;
      if (availW <= 0 || availH <= 0) return;
      const scale = Math.min(availW / ratioW, availH / ratioH);
      setSize({
        width: Math.max(Math.floor(ratioW * scale), 1),
        height: Math.max(Math.floor(ratioH * scale), 1),
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, ratioW, ratioH]);
  return size;
}

/** Aspect-correct scene preview frame. The server-side preview HTML already
 * self-scales to whatever box the iframe provides; we just size the box. */
function ScenePreviewFrame({
  html,
  ratioW,
  ratioH,
  title,
  seekSeconds,
  showGuides = false,
}: {
  html: string;
  ratioW: number;
  ratioH: number;
  title: string;
  seekSeconds?: number;
  showGuides?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const size = useFitSize(containerRef, ratioW, ratioH);
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "mona-video-seek", seconds: seekSeconds ?? 0 },
      "*",
    );
  }, [html, seekSeconds]);
  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center overflow-hidden"
    >
      {size ? (
        <div
          className="relative overflow-hidden shadow-sm"
          style={{ width: size.width, height: size.height }}
        >
          <iframe
            ref={iframeRef}
            title={title}
            srcDoc={html}
            onLoad={() =>
              iframeRef.current?.contentWindow?.postMessage(
                { type: "mona-video-seek", seconds: seekSeconds ?? 0 },
                "*",
              )
            }
            className="h-full w-full border-0"
            sandbox="allow-scripts"
          />
          {showGuides && (
            <div className="pointer-events-none absolute inset-0 text-micro text-white/80">
              <div className="absolute inset-[8%] border border-dashed border-white/55">
                <span className="absolute left-1 top-0 -translate-y-full bg-black/55 px-1">
                  内容安全区
                </span>
              </div>
              <div className="absolute bottom-[8%] left-[8%] right-[8%] h-[18%] border border-dashed border-amber-300/80">
                <span className="absolute bottom-0 right-1 translate-y-full bg-black/55 px-1 text-amber-200">
                  字幕安全区
                </span>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ProducingPhase({
  projectName,
  onPhaseChange,
  onLocalized,
}: ProducingPhaseProps) {
  const { client, token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [scenes, setScenes] = useState<VideoSceneWithHtml[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionLabel, setActionLabel] = useState<string | null>(null);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriteText, setRewriteText] = useState("");
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullFilmOpen, setFullFilmOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<VideoProjectVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(
    null,
  );
  const [undoVersionId, setUndoVersionId] = useState<string | null>(null);
  const [localizeOpen, setLocalizeOpen] = useState(false);
  const [projectLanguage, setProjectLanguage] =
    useState<VideoLanguage>("zh-CN");
  const [targetLanguage, setTargetLanguage] = useState<VideoLanguage>("en-US");
  const [localizing, setLocalizing] = useState(false);
  const [aspectOpen, setAspectOpen] = useState(false);
  const [projectAspect, setProjectAspect] =
    useState<VideoAspectVariant>("16:9");
  const [targetAspect, setTargetAspect] = useState<VideoAspectVariant>("16:9");
  const [aspectChanging, setAspectChanging] = useState(false);
  const [fineTimelineOpen, setFineTimelineOpen] = useState(false);
  const [sceneTimeline, setSceneTimeline] = useState<VideoSceneTimeline | null>(
    null,
  );
  const [playheadMs, setPlayheadMs] = useState(0);
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [timelineAudioUrl, setTimelineAudioUrl] = useState<string | null>(null);
  const [timelineAudioLoading, setTimelineAudioLoading] = useState(false);
  const timelineAudioRef = useRef<HTMLAudioElement>(null);

  const [fullPreviewUrl, setFullPreviewUrl] = useState<string | null>(null);

  // Project-level metadata: resolution drives preview aspect ratio,
  // outputStale drives the "内容已变化" export state.
  const [ratio, setRatio] = useState<{ w: number; h: number }>({
    w: 1920,
    h: 1080,
  });
  const [outputStale, setOutputStale] = useState(false);
  const [seriesSummary, setSeriesSummary] = useState<string | null>(null);

  const [exportQuality, setExportQuality] = useState<ExportQuality>("standard");
  const [releaseType, setReleaseType] = useState<ReleaseType>("draft");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportStatus, setExportStatus] = useState<VideoExportStatus>({
    stage: "idle",
    progress: 0,
  });
  const [exportActionLoading, setExportActionLoading] = useState(false);
  const [exportPreflight, setExportPreflight] =
    useState<VideoExportPreflight | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDownloadUrl, setExportDownloadUrl] = useState<string | null>(
    null,
  );
  const exportPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reviews, setReviews] = useState<VideoReview[]>([]);
  const [reviewText, setReviewText] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);

  // Runtime dependency gate (checked lazily right before export)
  const [runtimeStatus, setRuntimeStatus] = useState<VideoRuntimeStatus>(
    DEFAULT_RUNTIME_STATUS,
  );
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const runtimeDownloadJobs = useVideoRuntimeDownloadStore(
    (state) => state.jobs,
  );

  const refreshProjectMeta = useCallback(async () => {
    try {
      const p = await fetchVideoProject(token, projectName);
      setRatio(parseResolution(p.resolution));
      setOutputStale(Boolean(p.outputStale));
      if (p.aspectVariant) {
        setProjectAspect(p.aspectVariant);
        setTargetAspect(p.aspectVariant);
      }
      if (
        p.language &&
        VIDEO_LANGUAGE_OPTIONS.some((option) => option.value === p.language)
      ) {
        setProjectLanguage(p.language as VideoLanguage);
      }
      setSeriesSummary(
        p.seriesId
          ? `${p.seriesName ?? p.seriesId} · 风格 v${p.styleVersion ?? "-"}`
          : null,
      );
      if (p.phase) onPhaseChange?.(p.phase);
    } catch {
      // keep defaults — project detail is best-effort here
    }
  }, [token, projectName, onPhaseChange]);

  useEffect(() => {
    void refreshProjectMeta();
  }, [refreshProjectMeta]);

  const refreshReviews = useCallback(async () => {
    try {
      const result = await fetchVideoReviews(token, projectName);
      setReviews(result.reviews ?? []);
    } catch {
      setReviews([]);
    }
  }, [projectName, token]);

  useEffect(() => {
    void refreshReviews();
  }, [refreshReviews]);

  const loadScenes = useCallback(async () => {
    try {
      const res = await fetchVideoStoryboard(token, projectName);
      if (res.ok && res.scenes) {
        setScenes(res.scenes as VideoSceneWithHtml[]);
        if (
          res.scenes.length > 0 &&
          !res.scenes.some((s) => s.index === selectedIndex)
        ) {
          setSelectedIndex(res.scenes[0].index);
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [token, projectName, selectedIndex]);

  useEffect(() => {
    loadScenes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectName]);

  const selectedScene = scenes.find((s) => s.index === selectedIndex) ?? null;

  useEffect(() => {
    setError(null);
  }, [selectedIndex]);

  const loadPreview = useCallback(async () => {
    if (!selectedScene) {
      setPreviewHtml(null);
      return;
    }
    const status = selectedScene.htmlStatus ?? "pending";
    if (status === "pending") {
      setPreviewHtml(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const { html, needsGeneration } = await fetchScenePreviewHtml(
        token,
        projectName,
        selectedIndex,
      );
      if (needsGeneration) {
        setPreviewHtml(null);
      } else {
        setPreviewHtml(html);
      }
    } catch (e) {
      console.error("Failed to load preview", e);
      setPreviewHtml(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedScene, token, projectName, selectedIndex]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview, selectedIndex]);

  useEffect(() => {
    let cancelled = false;
    setPlayheadMs(0);
    setTimelinePlaying(false);
    void fetchVideoSceneTimeline(token, projectName, selectedIndex)
      .then((timeline) => {
        if (!cancelled) setSceneTimeline(timeline);
      })
      .catch(() => {
        if (!cancelled) setSceneTimeline(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, selectedIndex, token]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    timelineAudioRef.current?.pause();
    setTimelineAudioUrl(null);
    if (!selectedScene?.narration?.trim()) {
      setTimelineAudioLoading(false);
      return;
    }
    setTimelineAudioLoading(true);
    void fetchSceneNarrationBytes(token, projectName, selectedIndex)
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setTimelineAudioUrl(objectUrl);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTimelineAudioLoading(false);
      });
    return () => {
      cancelled = true;
      timelineAudioRef.current?.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectName, selectedIndex, selectedScene?.narration, token]);

  useEffect(() => {
    if (!timelinePlaying) return;
    const durationMs =
      sceneTimeline?.durationMs ?? (selectedScene?.duration ?? 5) * 1000;
    if (!durationMs) return;
    const timer = window.setInterval(() => {
      setPlayheadMs((current) => {
        const audio = timelineAudioRef.current;
        const audioTime =
          timelineAudioUrl && audio && !audio.paused
            ? audio.currentTime * 1000
            : null;
        const next = Math.min(
          durationMs,
          audioTime !== null && Number.isFinite(audioTime)
            ? audioTime
            : current + 50,
        );
        if (next >= durationMs) {
          audio?.pause();
          setTimelinePlaying(false);
        }
        return next;
      });
    }, 50);
    return () => window.clearInterval(timer);
  }, [
    sceneTimeline?.durationMs,
    selectedScene?.duration,
    timelineAudioUrl,
    timelinePlaying,
  ]);

  const toggleTimelinePlayback = useCallback(async () => {
    const durationMs =
      sceneTimeline?.durationMs ?? (selectedScene?.duration ?? 5) * 1000;
    const audio = timelineAudioRef.current;
    if (timelinePlaying) {
      audio?.pause();
      setTimelinePlaying(false);
      return;
    }
    const startMs = playheadMs >= durationMs ? 0 : playheadMs;
    setPlayheadMs(startMs);
    if (timelineAudioUrl && audio) {
      audio.currentTime = startMs / 1000;
      try {
        await audio.play();
      } catch {
        // Keep the visual timeline available if the webview blocks media playback.
      }
    }
    setTimelinePlaying(true);
  }, [
    playheadMs,
    sceneTimeline?.durationMs,
    selectedScene?.duration,
    timelineAudioUrl,
    timelinePlaying,
  ]);

  // Build full-preview URL on mount / project change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await getServicesHttpBase();
      if (cancelled) return;
      setFullPreviewUrl(buildVideoPreviewFullUrl(base, token, projectName));
    })();
    return () => {
      cancelled = true;
    };
  }, [token, projectName]);

  useEffect(() => {
    if (!exportDialogOpen) return;
    let cancelled = false;
    setExportPreflight(null);
    void fetchVideoExportPreflight(token, projectName, exportQuality)
      .then((result) => {
        if (!cancelled) setExportPreflight(result);
      })
      .catch(() => {
        if (!cancelled) setExportPreflight(null);
      });
    return () => {
      cancelled = true;
    };
  }, [exportDialogOpen, exportQuality, projectName, token]);

  const refreshFullPreview = useCallback(async () => {
    const base = await getServicesHttpBase();
    setFullPreviewUrl(
      buildVideoPreviewFullUrl(base, token, projectName) + `&_t=${Date.now()}`,
    );
  }, [token, projectName]);

  // 打开整片预览弹窗时刷新 URL,确保看到最新场景内容
  const openFullFilm = useCallback(async () => {
    const base = await getServicesHttpBase();
    setFullPreviewUrl(
      buildVideoPreviewFullUrl(base, token, projectName) + `&_t=${Date.now()}`,
    );
    setFullFilmOpen(true);
  }, [token, projectName]);

  // Initial export status + download URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchVideoExportStatus(token, projectName);
        if (cancelled) return;
        setExportStatus(s);
        if (s.hasVideo) {
          const base = await getApiBase();
          if (cancelled) return;
          setExportDownloadUrl(buildVideoDownloadUrl(base, token, projectName));
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, projectName]);

  // Single refresh path shared by the WS push handler and the backstop poll.
  const refreshExportStatus = useCallback(async (): Promise<void> => {
    try {
      const s = await fetchVideoExportStatus(token, projectName);
      setExportStatus(s);
      if (s.stage === "done" && s.hasVideo) {
        const base = await getApiBase();
        setExportDownloadUrl(buildVideoDownloadUrl(base, token, projectName));
        setOutputStale(false);
        void refreshProjectMeta();
      } else if (s.stage === "error") {
        setExportError(s.message ?? "导出失败");
      } else if (s.stage === "cancelled") {
        setExportError(null);
        void refreshProjectMeta();
      }
    } catch {
      // ignore transient errors
    }
  }, [token, projectName, refreshProjectMeta]);

  // Poll while rendering — 10s backstop only; live frame-level progress and
  // the done/error transition arrive via WS video_project_changed pushes.
  useEffect(() => {
    if (
      exportStatus.stage !== "rendering" &&
      exportStatus.stage !== "cancelling"
    ) {
      if (exportPollRef.current) {
        clearTimeout(exportPollRef.current);
        exportPollRef.current = null;
      }
      return;
    }
    onPhaseChange?.("rendering");
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await refreshExportStatus();
      if (!cancelled) {
        exportPollRef.current = setTimeout(poll, 10000);
      }
    };
    exportPollRef.current = setTimeout(poll, 10000);
    return () => {
      cancelled = true;
      if (exportPollRef.current) {
        clearTimeout(exportPollRef.current);
        exportPollRef.current = null;
      }
    };
  }, [exportStatus.stage, onPhaseChange, refreshExportStatus]);

  // WS subscription: render progress/status, scene edits and phase migrations
  // pushed by the services process refresh the relevant slice of state.
  useEffect(() => {
    return client.onVideoProjectChanged(({ projectName: name, hint }) => {
      if (name !== projectName) return;
      if (hint === "progress" || hint === "status") {
        void refreshExportStatus();
      } else if (hint === "scenes") {
        void loadScenes();
        void refreshProjectMeta();
      } else if (hint === "phase") {
        void refreshProjectMeta();
      } else if (hint === "reviews") {
        void refreshReviews();
      }
    });
  }, [
    client,
    projectName,
    refreshExportStatus,
    loadScenes,
    refreshProjectMeta,
    refreshReviews,
  ]);

  const updateSceneStatus = useCallback((index: number, status: string) => {
    setScenes((prev) =>
      prev.map((s) =>
        s.index === index ? { ...s, htmlStatus: status as never } : s,
      ),
    );
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setActionLabel("正在生成场景画面...");
    setError(null);
    updateSceneStatus(selectedIndex, "generating");
    try {
      const res = await generateSceneHtml(token, projectName, selectedIndex);
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        const { html } = await fetchScenePreviewHtml(
          token,
          projectName,
          selectedIndex,
        );
        setPreviewHtml(html);
        await refreshFullPreview();
        void refreshProjectMeta();
      } else {
        setError(res.error || "生成失败");
        updateSceneStatus(selectedIndex, "pending");
      }
    } catch (e) {
      setError(String(e));
      updateSceneStatus(selectedIndex, "pending");
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    selectedScene,
    actionLoading,
    token,
    projectName,
    selectedIndex,
    updateSceneStatus,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handleGenerateAll = useCallback(async () => {
    if (actionLoading) return;
    const pending = scenes.filter(
      (s) => (s.htmlStatus ?? "pending") === "pending",
    );
    if (pending.length === 0) return;
    setActionLoading(true);
    setError(null);
    try {
      for (const scene of pending) {
        setActionLabel(`正在生成场景 ${scene.index}/${scenes.length}...`);
        updateSceneStatus(scene.index, "generating");
        const res = await generateSceneHtml(token, projectName, scene.index);
        if (res.ok && res.scene) {
          setScenes((prev) =>
            prev.map((s) => (s.index === scene.index ? res.scene! : s)),
          );
        } else {
          setError(res.error || `场景 ${scene.index} 生成失败`);
          updateSceneStatus(scene.index, "pending");
          break;
        }
      }
      // Refresh current scene preview and full preview
      if (selectedScene) {
        const { html } = await fetchScenePreviewHtml(
          token,
          projectName,
          selectedIndex,
        );
        setPreviewHtml(html);
      }
      await refreshFullPreview();
      void refreshProjectMeta();
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    actionLoading,
    scenes,
    token,
    projectName,
    selectedScene,
    selectedIndex,
    updateSceneStatus,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handleRegenerate = useCallback(async () => {
    if (!selectedScene || actionLoading) return;
    setActionLoading(true);
    setActionLabel("正在重新生成场景...");
    setError(null);
    updateSceneStatus(selectedIndex, "generating");
    try {
      const res = await regenerateVideoScene(token, projectName, selectedIndex);
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        const { html } = await fetchScenePreviewHtml(
          token,
          projectName,
          selectedIndex,
        );
        setPreviewHtml(html);
        await refreshFullPreview();
        // 重生成使旧确认与旧导出结果失效
        void refreshProjectMeta();
      } else {
        setError(res.error || "重新生成失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setActionLoading(false);
      setActionLabel(null);
    }
  }, [
    selectedScene,
    actionLoading,
    token,
    projectName,
    selectedIndex,
    updateSceneStatus,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handlePlayNarration = useCallback(async () => {
    if (!selectedScene || playingIndex !== null) return;
    setPlayingIndex(selectedIndex);
    try {
      const blob = await fetchSceneNarrationBytes(
        token,
        projectName,
        selectedIndex,
      );
      if (blob) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setPlayingIndex(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setPlayingIndex(null);
        };
        await audio.play();
      } else {
        setPlayingIndex(null);
      }
    } catch (e) {
      console.error("Narration playback failed", e);
      setPlayingIndex(null);
    }
  }, [selectedScene, playingIndex, token, projectName, selectedIndex]);

  const handleRewriteSubmit = useCallback(async () => {
    if (!rewriteText.trim() || rewriteLoading) return;
    setRewriteLoading(true);
    setError(null);
    try {
      const res = await rewriteVideoScene(
        token,
        projectName,
        selectedIndex,
        rewriteText.trim(),
      );
      if (res.ok && res.scene) {
        setScenes((prev) =>
          prev.map((s) => (s.index === selectedIndex ? res.scene! : s)),
        );
        setRewriteOpen(false);
        setRewriteText("");
        setUndoVersionId(res.undoVersionId ?? null);
        await refreshFullPreview();
        // 重写分镜使旧确认与旧导出结果失效
        void refreshProjectMeta();
      } else {
        setError(res.error || "重写失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRewriteLoading(false);
    }
  }, [
    rewriteText,
    rewriteLoading,
    token,
    projectName,
    selectedIndex,
    refreshFullPreview,
    refreshProjectMeta,
  ]);

  const handleOpenVersions = useCallback(async () => {
    setVersionsOpen(true);
    setVersionsLoading(true);
    try {
      const result = await fetchVideoProjectVersions(token, projectName);
      setVersions(result.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVersionsLoading(false);
    }
  }, [projectName, token]);

  const handleRestoreVersion = useCallback(
    async (versionId: string) => {
      if (restoringVersionId) return;
      setRestoringVersionId(versionId);
      setError(null);
      try {
        const result = await restoreVideoProjectVersion(
          token,
          projectName,
          versionId,
        );
        if (!result.ok) {
          setError(result.error ?? "恢复版本失败");
          return;
        }
        setUndoVersionId(null);
        setVersionsOpen(false);
        await loadScenes();
        await refreshProjectMeta();
        await refreshFullPreview();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRestoringVersionId(null);
      }
    },
    [
      loadScenes,
      projectName,
      refreshFullPreview,
      refreshProjectMeta,
      restoringVersionId,
      token,
    ],
  );

  const handleLocalizeProject = useCallback(async () => {
    if (localizing || targetLanguage === projectLanguage) return;
    setLocalizing(true);
    setError(null);
    try {
      const result = await localizeVideoProject(
        token,
        projectName,
        targetLanguage,
      );
      if (!result.ok || !result.name) {
        throw new Error(result.error || "创建语言版本失败");
      }
      setLocalizeOpen(false);
      onLocalized?.(result.name);
    } catch (localizeError) {
      setError(
        localizeError instanceof Error
          ? localizeError.message
          : String(localizeError),
      );
    } finally {
      setLocalizing(false);
    }
  }, [
    localizing,
    onLocalized,
    projectLanguage,
    projectName,
    targetLanguage,
    token,
  ]);

  const handleChangeAspect = useCallback(async () => {
    if (aspectChanging || targetAspect === projectAspect) return;
    setAspectChanging(true);
    setError(null);
    try {
      const result = await changeVideoProjectAspect(
        token,
        projectName,
        targetAspect,
      );
      if (!result.ok) throw new Error(result.error || "切换画幅失败");
      setProjectAspect(targetAspect);
      setAspectOpen(false);
      setPreviewHtml(null);
      await loadScenes();
      await refreshProjectMeta();
    } catch (aspectError) {
      setError(
        aspectError instanceof Error
          ? aspectError.message
          : String(aspectError),
      );
    } finally {
      setAspectChanging(false);
    }
  }, [
    aspectChanging,
    loadScenes,
    projectAspect,
    projectName,
    refreshProjectMeta,
    targetAspect,
    token,
  ]);

  const doExport = useCallback(async () => {
    const res = await exportVideoProject(token, projectName, {
      quality: exportQuality,
      releaseType,
    });
    if (!res.ok) {
      setExportError(res.error ?? "导出失败");
      return;
    }
    setExportDialogOpen(false);
    setExportStatus({
      stage: "rendering",
      progress: 0,
      message: "准备导出...",
      requestedEngine: res.requestedEngine,
    });
  }, [token, projectName, exportQuality, releaseType]);

  const handleAddReview = useCallback(async () => {
    const text = reviewText.trim();
    if (!text || reviewLoading) return;
    setReviewLoading(true);
    try {
      const result = await createVideoReview(
        token,
        projectName,
        selectedIndex,
        Math.round(playheadMs),
        text,
      );
      if (result.ok && result.review) {
        setReviews((current) => [...current, result.review!]);
        setReviewText("");
      } else {
        setError(result.error ?? "添加审阅意见失败");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewLoading(false);
    }
  }, [
    playheadMs,
    projectName,
    reviewLoading,
    reviewText,
    selectedIndex,
    token,
  ]);

  const handleResolveReview = useCallback(
    async (reviewId: string) => {
      if (reviewLoading) return;
      setReviewLoading(true);
      try {
        const result = await resolveVideoReview(
          token,
          projectName,
          reviewId,
          true,
        );
        if (result.ok && result.review) {
          setReviews((current) =>
            current.map((review) =>
              review.id === reviewId ? result.review! : review,
            ),
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setReviewLoading(false);
      }
    },
    [projectName, reviewLoading, token],
  );

  // Export entry from the confirmation dialog: gate on runtime deps first.
  const handleExportSubmit = useCallback(async () => {
    setExportError(null);
    setExportActionLoading(true);
    try {
      let runtimeOk = true;
      try {
        const status = await fetchVideoRuntimeCheck(token);
        setRuntimeStatus(status);
        runtimeOk = status.node.ok && status.ffmpeg.ok && status.chrome.ok;
      } catch {
        // Check failed — let the export attempt proceed; the server reports
        // need_download if the runtime is actually missing.
      }
      if (!runtimeOk) {
        // 保留质量选择,关闭导出弹窗并打开运行时安装;装完自动回到导出确认
        setExportDialogOpen(false);
        setRuntimeDialogOpen(true);
        return;
      }
      await doExport();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setExportError("所有场景生成后才能导出，请检查场景状态。");
      } else {
        setExportError(String(e));
      }
    } finally {
      setExportActionLoading(false);
    }
  }, [token, doExport]);

  const handleCancelExport = useCallback(async () => {
    if (
      exportActionLoading ||
      (exportStatus.stage !== "rendering" &&
        exportStatus.stage !== "cancelling")
    ) {
      return;
    }
    setExportActionLoading(true);
    try {
      await cancelVideoExport(token, projectName);
      setExportStatus((current) => ({
        ...current,
        stage: "cancelling",
        message: "正在安全停止导出...",
        recoverable: true,
      }));
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportActionLoading(false);
    }
  }, [exportActionLoading, exportStatus.stage, projectName, token]);

  const handleInstallRuntime = useCallback(
    async (component?: RuntimeDepKey) => {
      const targets: VideoRuntimeComponent[] = component
        ? component === "chrome"
          ? []
          : [component]
        : (["node", "ffmpeg"] as VideoRuntimeComponent[]).filter(
            (k) => !runtimeStatus[k].ok,
          );
      if (targets.length === 0) return;
      try {
        await startVideoRuntimeDownloads(token, targets);
        setRuntimeDialogOpen(false);
      } catch (error) {
        useVideoRuntimeDownloadStore
          .getState()
          .setError(error instanceof Error ? error.message : String(error));
      }
    },
    [runtimeStatus, token],
  );

  const handleRuntimeDialogClose = useCallback(() => {
    setRuntimeDialogOpen(false);
  }, []);

  useEffect(() => {
    const latest = runtimeDownloadJobs[0];
    if (!latest || latest.state === "running") return;
    void fetchVideoRuntimeCheck(token)
      .then(setRuntimeStatus)
      .catch(() => {});
  }, [runtimeDownloadJobs, token]);

  const [downloadLoading, setDownloadLoading] = useState(false);
  const [packageDownloadLoading, setPackageDownloadLoading] = useState(false);
  const [audioDownloadLoading, setAudioDownloadLoading] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!exportDownloadUrl) return;
    setDownloadLoading(true);
    try {
      await downloadMediaUrl(exportDownloadUrl, `${projectName}.mp4`);
    } catch (e) {
      setExportError(`下载失败: ${e}`);
    } finally {
      setDownloadLoading(false);
    }
  }, [exportDownloadUrl, projectName]);

  const handleDownloadPackage = useCallback(async () => {
    setPackageDownloadLoading(true);
    try {
      const base = await getApiBase();
      await downloadMediaUrl(
        buildVideoDownloadUrl(base, token, projectName, "package"),
        `${projectName}-交付包.zip`,
      );
    } catch (e) {
      setExportError(`下载交付包失败: ${e}`);
    } finally {
      setPackageDownloadLoading(false);
    }
  }, [projectName, token]);

  const handleDownloadAudio = useCallback(async () => {
    setAudioDownloadLoading(true);
    try {
      const base = await getApiBase();
      await downloadMediaUrl(
        buildVideoDownloadUrl(base, token, projectName, "audio"),
        `${projectName}-纯音频.m4a`,
      );
    } catch (e) {
      setExportError(`下载纯音频失败: ${e}`);
    } finally {
      setAudioDownloadLoading(false);
    }
  }, [projectName, token]);

  const handleOpenOldOutputDir = useCallback(async () => {
    if (!workspacePath) return;
    try {
      await revealItemInDir(
        `${workspacePath}/video_projects/${projectName}/renders/output.mp4`,
      );
    } catch (e) {
      setExportError(
        `打开目录失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }, [workspacePath, projectName]);

  // 场景列表键盘导航:上下方向键切换选中场景
  const handleSceneListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const order = scenes.map((s) => s.index);
      const pos = order.indexOf(selectedIndex);
      const next = e.key === "ArrowDown" ? order[pos + 1] : order[pos - 1];
      if (next === undefined) return;
      setSelectedIndex(next);
      requestAnimationFrame(() => {
        document.getElementById(`video-scene-item-${next}`)?.focus();
      });
    },
    [scenes, selectedIndex],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-ui text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载场景...
      </div>
    );
  }

  // P3: export gates on "ready" (scene HTML generated), not per-scene
  // confirmation — the render task snapshots scene HTML at start.
  const isSceneReady = (s: VideoSceneWithHtml) =>
    s.htmlStatus === "previewing" || s.htmlStatus === "confirmed";
  const readyCount = scenes.filter(isSceneReady).length;
  const allReady = scenes.length > 0 && readyCount === scenes.length;
  const isCancelling = exportStatus.stage === "cancelling";
  const isRendering = exportStatus.stage === "rendering" || isCancelling;
  const isExportDone = exportStatus.stage === "done" && exportStatus.hasVideo;
  const hasExportError = exportStatus.stage === "error";
  const selectedStatus = selectedScene?.htmlStatus ?? "pending";
  const timelineDurationMs =
    sceneTimeline?.durationMs ?? (selectedScene?.duration ?? 5) * 1000;
  const openReviews = reviews.filter((review) => review.status === "open");
  const selectedReviews = reviews.filter(
    (review) => review.sceneIndex === selectedIndex,
  );
  const finalDeliveryBlocked =
    openReviews.length > 0 ||
    exportPreflight === null ||
    !exportPreflight.assetRights.readyForCommercialUse;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <audio ref={timelineAudioRef} src={timelineAudioUrl ?? undefined} preload="auto" />
      <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
        {/* 左:场景状态列表 */}
        <ResizablePanel
          defaultSize="22%"
          minSize="18%"
          maxSize="32%"
          collapsible
          className="flex flex-col"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
              <div className="min-w-0">
                <div className="whitespace-nowrap text-micro font-medium text-muted-foreground">
                  场景制作 · {readyCount}/{scenes.length} 已生成
                </div>
                {seriesSummary ? (
                  <div className="mt-0.5 truncate text-micro text-muted-foreground/80">
                    {seriesSummary}
                  </div>
                ) : null}
              </div>
              {scenes.some(
                (s) => (s.htmlStatus ?? "pending") === "pending",
              ) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-micro text-primary"
                  onClick={handleGenerateAll}
                  disabled={actionLoading}
                >
                  <Wand2 className="mr-1 h-3 w-3" />
                  一键生成全部
                </Button>
              )}
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2"
              role="listbox"
              aria-label="场景列表"
              aria-activedescendant={`video-scene-item-${selectedIndex}`}
              tabIndex={0}
              onKeyDown={handleSceneListKeyDown}
            >
              {scenes.map((s) => {
                const status = s.htmlStatus ?? "pending";
                const selected = s.index === selectedIndex;
                return (
                  <button
                    key={s.index}
                    id={`video-scene-item-${s.index}`}
                    role="option"
                    aria-selected={selected}
                    aria-label={`场景 ${s.index} ${s.title || ""}，${statusLabel(status)}`}
                    onClick={() => {
                      setSelectedIndex(s.index);
                    }}
                    className={cn(
                      "mb-1 w-full rounded-md border px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "border-primary bg-accent"
                        : "border-border/60 hover:bg-accent",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0" aria-hidden="true">
                        {status === "confirmed" ? (
                          <Check className="h-3 w-3 text-emerald-500" />
                        ) : status === "generating" ? (
                          <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
                        ) : status === "previewing" ? (
                          <span className="text-micro text-sky-500">●</span>
                        ) : (
                          <span className="text-micro text-muted-foreground">
                            ○
                          </span>
                        )}
                      </span>
                      <span className="truncate text-caption font-medium">
                        {s.title || `场景 ${s.index}`}
                      </span>
                    </div>
                    <div className="mt-0.5 pl-4 text-micro text-muted-foreground">
                      {s.duration}s · {statusLabel(status)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* 中:预览区 */}
        <ResizablePanel
          defaultSize="50%"
          minSize="30%"
          className="flex flex-col"
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 border-b border-border/70 px-4 py-2">
              <div className="flex items-center justify-between">
                <div className="text-ui font-medium">
                  {selectedScene && (
                    <>
                      场景 {selectedScene.index}: {selectedScene.title || ""}
                      <span className="ml-2 text-micro text-muted-foreground">
                        {selectedScene.duration}s ·{" "}
                        {statusLabel(selectedScene.htmlStatus ?? "pending")}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <TooltipProvider delayDuration={300}>
                    {seriesSummary ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            aria-label="切换画幅"
                            onClick={() => {
                              setTargetAspect(projectAspect);
                              setAspectOpen(true);
                            }}
                          >
                            <Ratio className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>切换横屏、竖屏或方形</TooltipContent>
                      </Tooltip>
                    ) : null}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          aria-label="创建语言版本"
                          onClick={() => {
                            const next = VIDEO_LANGUAGE_OPTIONS.find(
                              (option) => option.value !== projectLanguage,
                            );
                            if (next) setTargetLanguage(next.value);
                            setLocalizeOpen(true);
                          }}
                        >
                          <Languages className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>创建语言版本</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          aria-label="版本历史"
                          onClick={handleOpenVersions}
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>版本历史</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 w-7 p-0",
                            fineTimelineOpen && "bg-accent",
                          )}
                          aria-label="精细时间轴"
                          aria-pressed={fineTimelineOpen}
                          onClick={() => setFineTimelineOpen((open) => !open)}
                        >
                          <ListVideo className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>精细时间轴</TooltipContent>
                    </Tooltip>
                    {previewHtml && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            aria-label="全屏预览当前场景"
                            onClick={() => setFullscreen(true)}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>全屏预览当前场景</TooltipContent>
                      </Tooltip>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          aria-label={
                            isExportDone
                              ? "播放整片视频"
                              : "整片预览（使用场景预览）"
                          }
                          onClick={openFullFilm}
                        >
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isExportDone
                          ? "播放整片视频"
                          : "整片预览（使用场景预览）"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
              {previewLoading ? (
                <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载预览...
                </div>
              ) : previewHtml ? (
                <ScenePreviewFrame
                  html={previewHtml}
                  ratioW={ratio.w}
                  ratioH={ratio.h}
                  title={`scene-${selectedIndex}-preview`}
                  seekSeconds={playheadMs / 1000}
                  showGuides={fineTimelineOpen}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-ui text-muted-foreground">
                  <div>该场景尚未生成画面</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleGenerate}
                    disabled={actionLoading}
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    生成场景画面
                  </Button>
                </div>
              )}
            </div>
            {fineTimelineOpen && (
              <div className="shrink-0 border-t border-border/70 bg-background px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    aria-label={
                      timelineAudioLoading
                        ? "正在准备旁白"
                        : timelinePlaying
                          ? "暂停时间轴"
                          : "播放时间轴"
                    }
                    onClick={() => void toggleTimelinePlayback()}
                    disabled={!previewHtml || timelineAudioLoading}
                  >
                    {timelineAudioLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : timelinePlaying ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <span className="w-20 text-xs tabular-nums text-muted-foreground">
                    {(playheadMs / 1000).toFixed(1)}s /{" "}
                    {(timelineDurationMs / 1000).toFixed(1)}s
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={timelineDurationMs}
                    step={50}
                    value={Math.min(playheadMs, timelineDurationMs)}
                    onChange={(event) => {
                      timelineAudioRef.current?.pause();
                      setTimelinePlaying(false);
                      const nextMs = Number(event.target.value);
                      setPlayheadMs(nextMs);
                      if (timelineAudioRef.current) {
                        timelineAudioRef.current.currentTime = nextMs / 1000;
                      }
                    }}
                    className="flex-1 accent-primary"
                    aria-label="场景播放位置"
                  />
                </div>
                <div className="mt-2 grid grid-cols-[52px_1fr] gap-x-2 gap-y-1.5 text-micro">
                  <span className="pt-1 text-muted-foreground">画面节拍</span>
                  <div className="relative h-6 overflow-hidden rounded bg-muted/60">
                    {(sceneTimeline?.motionPlan?.beats ?? []).map((beat) => (
                      <div
                        key={beat.id}
                        className="absolute top-1 h-4 overflow-hidden rounded bg-primary/75 px-1 leading-4 text-primary-foreground"
                        style={{
                          left: `${(beat.startMs / timelineDurationMs) * 100}%`,
                          width: `${Math.max(4, ((beat.endMs - beat.startMs) / timelineDurationMs) * 100)}%`,
                        }}
                        title={`${motionTargetLabel(beat.target)} · ${beat.effect}`}
                      >
                        {motionTargetLabel(beat.target)}
                      </div>
                    ))}
                  </div>
                  <span className="pt-1 text-muted-foreground">字幕</span>
                  <div className="relative h-6 overflow-hidden rounded bg-muted/60">
                    {(sceneTimeline?.subtitleTrack?.cues ?? []).map((cue) => (
                      <div
                        key={cue.id}
                        className="absolute top-1 h-4 overflow-hidden rounded bg-foreground/70 px-1 leading-4 text-background"
                        style={{
                          left: `${(cue.startMs / timelineDurationMs) * 100}%`,
                          width: `${Math.max(4, ((cue.endMs - cue.startMs) / timelineDurationMs) * 100)}%`,
                        }}
                        title={cue.text}
                      >
                        {cue.text}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* 右:操作面板 */}
        <ResizablePanel
          defaultSize="28%"
          minSize="22%"
          maxSize="38%"
          className="flex flex-col"
        >
          <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-3">
              {/* 场景操作 */}
              <div className="mb-5">
                <div className="mb-2 flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
                  <Clapperboard className="h-3.5 w-3.5" />
                  场景操作
                </div>
                {error && (
                  <div
                    className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-micro text-destructive"
                    role="alert"
                  >
                    {error}
                  </div>
                )}
                {actionLoading && actionLabel && (
                  <div
                    className="mb-2 flex items-center gap-2 text-micro text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>{actionLabel}</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Button
                    size="sm"
                    className="w-full text-caption"
                    onClick={handleGenerate}
                    disabled={
                      actionLoading ||
                      !selectedScene ||
                      selectedStatus !== "pending"
                    }
                  >
                    {actionLoading ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    生成场景画面
                  </Button>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-caption"
                      onClick={handleRegenerate}
                      disabled={
                        actionLoading ||
                        !selectedScene ||
                        selectedStatus === "pending" ||
                        selectedStatus === "generating"
                      }
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      重新生成
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-caption"
                      onClick={() => setRewriteOpen(true)}
                      disabled={!selectedScene}
                    >
                      <Wand2 className="mr-1.5 h-3.5 w-3.5" />
                      重写分镜
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full text-caption"
                    onClick={handlePlayNarration}
                    disabled={
                      playingIndex !== null || !selectedScene?.narration
                    }
                  >
                    {playingIndex === selectedIndex ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    试听旁白
                  </Button>
                </div>
              </div>

              <div className="mb-5 border-t border-border/70 pt-4">
                <div className="mb-2 flex items-center justify-between gap-2 text-caption font-medium text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    审阅意见
                  </span>
                  <span className="text-micro font-normal">
                    {openReviews.length} 条未解决
                  </span>
                </div>
                <Textarea
                  value={reviewText}
                  onChange={(event) => setReviewText(event.target.value)}
                  className="min-h-[64px] resize-none text-caption"
                  placeholder={`在场景 ${selectedIndex} · ${(playheadMs / 1000).toFixed(1)}s 添加意见`}
                  aria-label="审阅意见"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1.5 w-full text-caption"
                  onClick={handleAddReview}
                  disabled={!reviewText.trim() || reviewLoading}
                >
                  {reviewLoading ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  记录当前时间点
                </Button>
                {selectedReviews.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {selectedReviews
                      .slice(-4)
                      .reverse()
                      .map((review) => (
                        <div
                          key={review.id}
                          className={cn(
                            "rounded-md border p-2 text-micro",
                            review.status === "resolved"
                              ? "border-border/50 text-muted-foreground"
                              : "border-amber-500/30 bg-amber-500/5",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-micro text-muted-foreground">
                                {(review.timeMs / 1000).toFixed(1)}s
                              </div>
                              <div className="mt-0.5 break-words">
                                {review.text}
                              </div>
                            </div>
                            {review.status === "open" && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 shrink-0 px-1.5 text-micro text-primary"
                                onClick={() => handleResolveReview(review.id)}
                                disabled={reviewLoading}
                              >
                                解决
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              {/* 全局导出 */}
              <div>
                <div className="mb-2 flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
                  <Film className="h-3.5 w-3.5" />
                  导出与交付
                </div>

                {/* 渲染中:不确定进度动画 + 阶段文字 */}
                {isRendering && (
                  <div
                    className="mb-3 rounded-md border border-border/70 bg-muted/30 p-3"
                    role="status"
                  >
                    <div className="flex items-center gap-2 text-caption font-medium">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      正在导出
                      <span className="ml-auto text-micro font-normal text-muted-foreground">
                        {exportStatus.actualEngine === "hyperframes"
                          ? "HyperFrames"
                          : exportStatus.actualEngine === "legacy"
                            ? "兼容渲染器"
                            : "准备引擎"}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full bg-primary/70 transition-[width] duration-300",
                          exportStatus.progress <= 0 && "w-full animate-pulse",
                        )}
                        style={
                          exportStatus.progress > 0
                            ? {
                                width: `${Math.min(100, exportStatus.progress)}%`,
                              }
                            : undefined
                        }
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 text-micro text-muted-foreground">
                      <span>{exportStatus.message ?? "处理中..."}</span>
                      <span>{Math.round(exportStatus.progress)}%</span>
                    </div>
                    {exportStatus.fallbackReason ? (
                      <div className="mt-1.5 text-micro text-amber-700">
                        HyperFrames 已回退：{exportStatus.fallbackReason}
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 w-full text-micro"
                      onClick={handleCancelExport}
                      disabled={isCancelling || exportActionLoading}
                    >
                      {isCancelling ? (
                        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      ) : (
                        <Square className="mr-1.5 h-3 w-3" />
                      )}
                      {isCancelling ? "正在停止..." : "停止导出"}
                    </Button>
                  </div>
                )}
                {undoVersionId && (
                  <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 p-2 text-micro">
                    <span className="text-muted-foreground">
                      AI 已更新本场景，其他场景未改动
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-micro"
                      onClick={() => handleRestoreVersion(undoVersionId)}
                      disabled={restoringVersionId !== null}
                    >
                      {restoringVersionId === undoVersionId ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Undo2 className="mr-1 h-3 w-3" />
                      )}
                      撤销
                    </Button>
                  </div>
                )}

                {exportStatus.stage === "cancelled" && (
                  <div
                    className="mb-3 rounded-md border border-border/70 bg-muted/30 p-3"
                    role="status"
                  >
                    <div className="flex items-center gap-2 text-caption font-medium">
                      <Square className="h-3.5 w-3.5 text-muted-foreground" />
                      导出已停止
                    </div>
                    <div className="mt-1 text-micro text-muted-foreground">
                      项目内容已保留，可随时重新导出。
                    </div>
                  </div>
                )}

                {/* 错误:保留页面状态,可重试 */}
                {hasExportError && (
                  <div
                    className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3"
                    role="alert"
                  >
                    <div className="flex items-center gap-2 text-caption font-medium text-destructive">
                      <AlertCircle className="h-3.5 w-3.5" />
                      导出失败
                    </div>
                    <div className="mt-1 text-micro text-muted-foreground">
                      {exportError ?? exportStatus.message}
                    </div>
                    {exportStatus.needDownload && (
                      <div className="mt-2 text-micro text-muted-foreground">
                        运行环境缺失，
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => setRuntimeDialogOpen(true)}
                        >
                          点击安装视频运行环境
                        </button>
                        后重试
                      </div>
                    )}
                  </div>
                )}

                {/* 完成:区分输出是否过期 */}
                {isExportDone && outputStale && (
                  <div
                    className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
                    role="alert"
                  >
                    <div className="flex items-center gap-2 text-caption font-medium text-amber-700">
                      <AlertCircle className="h-3.5 w-3.5" />
                      内容已变化
                    </div>
                    <div className="mt-1 text-micro text-muted-foreground">
                      分镜或场景已修改，之前的 MP4
                      与当前内容不一致，需要重新导出。
                    </div>
                  </div>
                )}
                {isExportDone && !outputStale && (
                  <div className="mb-3 rounded-md border border-green-500/30 bg-green-500/5 p-3">
                    <div className="flex items-center gap-2 text-caption font-medium text-green-700">
                      <CheckCircle className="h-3.5 w-3.5" />
                      导出完成
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-micro text-muted-foreground">
                      {exportStatus.duration !== undefined && (
                        <>
                          <span>时长</span>
                          <span className="text-foreground">
                            {exportStatus.duration}s
                          </span>
                        </>
                      )}
                      {exportStatus.fps !== undefined && (
                        <>
                          <span>帧率</span>
                          <span className="text-foreground">
                            {exportStatus.fps}fps
                          </span>
                        </>
                      )}
                      {exportStatus.totalFrames !== undefined && (
                        <>
                          <span>总帧数</span>
                          <span className="text-foreground">
                            {exportStatus.totalFrames}
                          </span>
                        </>
                      )}
                      {exportStatus.resolution && (
                        <>
                          <span>分辨率</span>
                          <span className="text-foreground">
                            {exportStatus.resolution[0]}×
                            {exportStatus.resolution[1]}
                          </span>
                        </>
                      )}
                      {exportStatus.actualEngine && (
                        <>
                          <span>渲染引擎</span>
                          <span className="text-foreground">
                            {exportStatus.actualEngine === "hyperframes"
                              ? "HyperFrames"
                              : "兼容渲染器"}
                          </span>
                        </>
                      )}
                      {exportStatus.releaseType && (
                        <>
                          <span>交付版本</span>
                          <span className="text-foreground">
                            {exportStatus.releaseType === "final"
                              ? "正式版"
                              : "草稿版"}
                          </span>
                        </>
                      )}
                      <span>音轨</span>
                      <span className="text-foreground">
                        {exportStatus.audio ? "已合成旁白" : "无"}
                      </span>
                    </div>
                    {exportStatus.qualityStatus && (
                      <div
                        className={cn(
                          "mt-2 rounded px-2 py-1.5 text-micro",
                          exportStatus.qualityStatus === "passed"
                            ? "bg-green-500/10 text-green-700"
                            : "bg-amber-500/10 text-amber-700",
                        )}
                      >
                        {exportStatus.qualityStatus === "passed"
                          ? "交付检查已通过"
                          : "交付完成，建议复核字幕时间"}
                        {exportStatus.deliveryWarnings?.[0] ? (
                          <div className="mt-0.5 text-muted-foreground">
                            {exportStatus.deliveryWarnings[0]}
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}

                {exportError && !hasExportError && (
                  <div
                    className="mb-3 text-micro text-destructive"
                    role="alert"
                  >
                    {exportError}
                  </div>
                )}

                {/* 导出操作按钮 */}
                {!isExportDone ? (
                  <>
                    <Button
                      className="w-full text-caption"
                      onClick={() => {
                        setExportError(null);
                        setExportDialogOpen(true);
                      }}
                      disabled={isRendering || exportActionLoading || !allReady}
                    >
                      {isRendering || exportActionLoading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : hasExportError ? (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Film className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {hasExportError
                        ? "重试导出"
                        : isRendering
                          ? "渲染中..."
                          : "导出视频"}
                    </Button>
                    {!allReady && !isRendering && (
                      <div className="mt-1.5 text-micro text-muted-foreground">
                        生成全部场景后可导出（{readyCount}/{scenes.length}）
                      </div>
                    )}
                  </>
                ) : outputStale ? (
                  <div className="space-y-1.5">
                    <Button
                      className="w-full text-caption"
                      onClick={() => {
                        setExportError(null);
                        setExportDialogOpen(true);
                      }}
                      disabled={isRendering || exportActionLoading}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      重新导出
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full text-caption"
                      onClick={handleOpenOldOutputDir}
                      disabled={!workspacePath}
                    >
                      <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                      打开旧文件所在目录
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {exportStatus.deliveryArtifacts?.package && (
                      <Button
                        className="w-full text-caption"
                        onClick={handleDownloadPackage}
                        disabled={packageDownloadLoading}
                      >
                        {packageDownloadLoading ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {packageDownloadLoading ? "下载中..." : "下载交付包"}
                      </Button>
                    )}
                    {exportStatus.deliveryArtifacts?.audio ? (
                      <Button
                        variant="outline"
                        className="w-full text-caption"
                        onClick={() => void handleDownloadAudio()}
                        disabled={audioDownloadLoading}
                      >
                        {audioDownloadLoading ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Volume2 className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {audioDownloadLoading ? "下载中..." : "下载纯音频"}
                      </Button>
                    ) : null}
                    <Button
                      variant={
                        exportStatus.deliveryArtifacts?.package
                          ? "outline"
                          : "default"
                      }
                      className="w-full text-caption"
                      onClick={handleDownload}
                      disabled={downloadLoading}
                    >
                      {downloadLoading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {downloadLoading ? "下载中..." : "单独下载 MP4"}
                    </Button>
                    <Button
                      variant="ghost"
                      className="w-full text-caption"
                      onClick={() => {
                        setExportError(null);
                        setExportDialogOpen(true);
                      }}
                      disabled={isRendering || exportActionLoading}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      重新导出
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* 底部全局进度提示 */}
            {allReady && !isExportDone && !isRendering && (
              <div className="shrink-0 border-t border-border/70 p-3 text-micro text-muted-foreground">
                全部场景已生成，可以导出视频
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog open={aspectOpen} onOpenChange={setAspectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>切换视频画幅</DialogTitle>
            <DialogDescription>
              系统会保留脚本、配音、字幕和素材，只重新制作适配新画幅的场景。当前版本会自动备份。
            </DialogDescription>
          </DialogHeader>
          <div
            className="grid grid-cols-3 gap-2"
            role="radiogroup"
            aria-label="目标画幅"
          >
            {(
              [
                { value: "16:9", label: "横屏", hint: "1920×1080" },
                { value: "9:16", label: "竖屏", hint: "1080×1920" },
                { value: "1:1", label: "方形", hint: "1080×1080" },
              ] as const
            ).map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                role="radio"
                aria-checked={targetAspect === option.value}
                disabled={aspectChanging}
                onClick={() => setTargetAspect(option.value)}
                className={cn(
                  "h-auto flex-col gap-1 py-3",
                  targetAspect === option.value &&
                    "border-primary bg-primary/5",
                )}
              >
                <span>{option.label}</span>
                <span className="text-micro font-normal text-muted-foreground">
                  {option.hint}
                </span>
              </Button>
            ))}
          </div>
          <div className="rounded-md bg-muted/40 px-3 py-2 text-micro text-muted-foreground">
            已完成的旧成片会保留，但切换后需要重新生成场景并导出新版本。
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setAspectOpen(false)}
              disabled={aspectChanging}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleChangeAspect()}
              disabled={aspectChanging || targetAspect === projectAspect}
            >
              {aspectChanging ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ratio className="mr-1.5 h-3.5 w-3.5" />
              )}
              {aspectChanging ? "正在适配…" : "切换并重新制作"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={localizeOpen} onOpenChange={setLocalizeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>创建语言版本</DialogTitle>
            <DialogDescription>
              系统会复制当前风格、素材与权利台账，只翻译标题、画面说明和旁白。原项目不会改变。
            </DialogDescription>
          </DialogHeader>
          <div
            className="grid grid-cols-2 gap-2"
            role="radiogroup"
            aria-label="目标语言"
          >
            {VIDEO_LANGUAGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                role="radio"
                aria-checked={targetLanguage === option.value}
                disabled={option.value === projectLanguage || localizing}
                onClick={() => setTargetLanguage(option.value)}
                className={cn(
                  "justify-start",
                  targetLanguage === option.value &&
                    "border-primary bg-primary/5",
                )}
              >
                {option.label}
                {option.value === projectLanguage ? "（当前）" : ""}
              </Button>
            ))}
          </div>
          <div className="rounded-md bg-muted/40 px-3 py-2 text-micro text-muted-foreground">
            新版本会回到分镜审阅阶段；配音、字幕和动画将在目标语言下重新生成。
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setLocalizeOpen(false)}
              disabled={localizing}
            >
              取消
            </Button>
            <Button
              onClick={() => void handleLocalizeProject()}
              disabled={localizing || targetLanguage === projectLanguage}
            >
              {localizing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Languages className="mr-1.5 h-3.5 w-3.5" />
              )}
              {localizing ? "正在翻译..." : "创建语言版本"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={versionsOpen} onOpenChange={setVersionsOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>项目版本历史</DialogTitle>
            <DialogDescription>
              AI
              修改前会自动保存版本。恢复不会删除现有视频，但当前内容需要重新导出。
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[360px] space-y-2 overflow-y-auto">
            {versionsLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                加载版本...
              </div>
            ) : versions.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                暂无自动版本
              </div>
            ) : (
              versions.map((version) => (
                <div
                  key={version.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {version.label}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString("zh-CN")}
                      {version.changedSceneIndices.length > 0
                        ? ` · 场景 ${version.changedSceneIndices.join("、")}`
                        : ""}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestoreVersion(version.id)}
                    disabled={restoringVersionId !== null}
                  >
                    {restoringVersionId === version.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <History className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    恢复
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setVersionsOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重写分镜对话框 */}
      <Dialog open={rewriteOpen} onOpenChange={setRewriteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重写场景 {selectedIndex} 分镜</DialogTitle>
            <DialogDescription>
              描述你希望这个场景如何调整，AI
              会重写该场景的分镜内容（标题/画面/动画/旁白），其他场景不受影响。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rewriteText}
            onChange={(e) => setRewriteText(e.target.value)}
            className="min-h-[100px] resize-none text-caption"
            placeholder="例如：把开场改成产品 logo 从中心放大的动效，旁白改成'欢迎体验...'"
            aria-label="重写需求"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRewriteOpen(false)}
              disabled={rewriteLoading}
            >
              取消
            </Button>
            <Button
              onClick={handleRewriteSubmit}
              disabled={!rewriteText.trim() || rewriteLoading}
            >
              {rewriteLoading && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              提交重写
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 导出确认对话框:质量选择 + 运行时门禁 */}
      <Dialog
        open={exportDialogOpen}
        onOpenChange={(open) => {
          if (!exportActionLoading) setExportDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>导出与交付</DialogTitle>
            <DialogDescription>
              先选择交付版本，再选择质量。正式版要求全部审阅意见已解决。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <div className="text-caption font-medium text-muted-foreground">
              交付版本
            </div>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="交付版本"
            >
              <Button
                type="button"
                variant="outline"
                role="radio"
                aria-checked={releaseType === "draft"}
                onClick={() => setReleaseType("draft")}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left",
                  releaseType === "draft"
                    ? "border-primary bg-primary/5"
                    : "border-border/60",
                )}
              >
                <span className="block text-ui font-medium">草稿版</span>
                <span className="text-micro text-muted-foreground">
                  允许未解决意见
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                role="radio"
                aria-checked={releaseType === "final"}
                aria-disabled={finalDeliveryBlocked}
                disabled={finalDeliveryBlocked}
                onClick={() => setReleaseType("final")}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50",
                  releaseType === "final"
                    ? "border-primary bg-primary/5"
                    : "border-border/60",
                )}
              >
                <span className="block text-ui font-medium">正式版</span>
                <span className="text-micro text-muted-foreground">
                  {openReviews.length > 0
                    ? `先解决 ${openReviews.length} 条意见`
                    : exportPreflight === null
                      ? "正在检查交付条件"
                      : !exportPreflight.assetRights.readyForCommercialUse
                        ? `先确认 ${
                            exportPreflight.assetRights.unconfirmedAssets
                              .length +
                            exportPreflight.assetRights.missingAssetIds.length
                          } 个素材权利`
                        : "通过审阅与素材门禁"}
                </span>
              </Button>
            </div>
          </div>
          <div className="text-caption font-medium text-muted-foreground">
            导出质量
          </div>
          <div role="radiogroup" aria-label="导出质量" className="space-y-1.5">
            {EXPORT_QUALITY_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                type="button"
                variant="outline"
                role="radio"
                aria-checked={exportQuality === opt.value}
                disabled={exportActionLoading}
                onClick={() => setExportQuality(opt.value)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
                  exportQuality === opt.value
                    ? "border-primary bg-primary/5"
                    : "border-border/60 hover:bg-accent",
                )}
              >
                <span className="text-ui font-medium">{opt.label}</span>
                <span className="text-micro text-muted-foreground">
                  {opt.hint}
                </span>
              </Button>
            ))}
          </div>
          {exportPreflight && (
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-micro">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
                <span>预计时长</span>
                <span className="text-foreground">
                  {exportPreflight.duration}s
                </span>
                <span>渲染工作量</span>
                <span className="text-foreground">
                  {exportPreflight.estimatedFrames.toLocaleString()} 帧
                </span>
                <span>预计文件</span>
                <span className="text-foreground">
                  {(exportPreflight.estimatedOutputBytes / 1024 / 1024).toFixed(
                    1,
                  )}{" "}
                  MB
                </span>
                <span>Mona 积分</span>
                <span className="text-foreground">
                  {exportPreflight.billing.monaCredits}
                </span>
                <span>素材权利</span>
                <span
                  className={cn(
                    exportPreflight.assetRights.readyForCommercialUse
                      ? "text-emerald-700"
                      : "text-amber-700",
                  )}
                >
                  {exportPreflight.assetRights.readyForCommercialUse
                    ? "已通过"
                    : "待确认"}
                </span>
              </div>
              <div className="mt-1.5 text-muted-foreground">
                {exportPreflight.billing.note}
              </div>
            </div>
          )}
          {exportError && (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-caption text-destructive"
              role="alert"
            >
              {exportError}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setExportDialogOpen(false)}
              disabled={exportActionLoading}
            >
              取消
            </Button>
            <Button
              onClick={handleExportSubmit}
              disabled={
                exportActionLoading ||
                (releaseType === "final" && finalDeliveryBlocked)
              }
            >
              {exportActionLoading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Film className="mr-1.5 h-3.5 w-3.5" />
              )}
              开始导出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 运行时依赖安装弹窗 */}
      <VideoRuntimeDialog
        open={runtimeDialogOpen}
        onClose={() => void handleRuntimeDialogClose()}
        runtimeStatus={runtimeStatus}
        onInstall={(component) => void handleInstallRuntime(component)}
      />

      {/* 全屏预览:当前场景 */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="h-[90vh] max-w-[95vw] gap-0 p-0">
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="text-ui font-medium">
                场景 {selectedScene?.index} 全屏预览
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-micro"
                onClick={() => setFullscreen(false)}
              >
                关闭
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-muted/30">
              {previewHtml && (
                <ScenePreviewFrame
                  html={previewHtml}
                  ratioW={ratio.w}
                  ratioH={ratio.h}
                  title="scene-fullscreen-preview"
                  seekSeconds={playheadMs / 1000}
                  showGuides={fineTimelineOpen}
                />
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 整片预览:弹窗播放全片 */}
      <Dialog open={fullFilmOpen} onOpenChange={setFullFilmOpen}>
        <DialogContent className="h-[90vh] max-w-[95vw] gap-0 p-0">
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-2">
              <div className="text-ui font-medium">
                {projectName} · 整片预览
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-micro"
                onClick={() => setFullFilmOpen(false)}
              >
                关闭
              </Button>
            </div>
            <div className="min-h-0 flex-1 bg-black">
              {isExportDone && !outputStale && exportDownloadUrl ? (
                <video
                  src={exportDownloadUrl}
                  className="h-full w-full"
                  controls
                  autoPlay
                />
              ) : fullPreviewUrl ? (
                <iframe
                  src={fullPreviewUrl}
                  title={`${projectName} 整片预览`}
                  className="h-full w-full border-0 bg-background"
                  sandbox="allow-scripts allow-same-origin"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-ui text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载整片预览...
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "confirmed":
      return "已确认";
    case "generating":
      return "生成中";
    case "previewing":
      return "已预览";
    default:
      return "待制作";
  }
}
