import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Clapperboard,
  FilePlus2,
  ImagePlus,
  ListChecks,
  Loader2,
  Music2,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plus,
  Trash2,
  Volume2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useClient } from "@/providers/ClientProvider";
import {
  createVideoProject,
  deleteVideoSeries,
  buildVideoBackgroundAssetPreviewUrl,
  fetchVideoProject,
  fetchVideoProjects,
  fetchVideoSeries,
  getServicesHttpBase,
  planVideoProject,
  saveVideoChatId,
  uploadVideoBackgroundAsset,
  updateVideoSeries,
  type BackgroundAsset,
  type VideoAssetRightsStatus,
  type VideoProject,
  type VideoProjectPhase,
  type VideoProjectPlan,
  type VideoSeries,
  type VideoStyleDraft,
  type VideoStyleVersion,
} from "@/lib/api";
import { EDGE_TTS_VOICES } from "@/lib/constants";
import { generateProjectName } from "@/lib/project-name";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { DocChatPanel } from "../DocChatPanel";
import { StoryboardPhase } from "./StoryboardPhase";
import { ProducingPhase } from "./ProducingPhase";
import { VideoHistory } from "./VideoHistory";
import { CreateVideoSeriesView } from "./style/CreateVideoSeriesView";
import { SeriesStyleEditor } from "./style/SeriesStyleEditor";
import { AssetRightsDialog } from "./style/AssetRightsDialog";
import { VideoSeriesSelector } from "./style/VideoSeriesSelector";

type VideoPhase = "config" | VideoProjectPhase;
type VideoRatio = "16:9" | "9:16" | "1:1";
type TtsProvider = "edge" | "custom";
type VideoCreationMode = "single" | "series";
type ConfigSubview = "video" | "create-series" | "style-editor";

export interface EmbeddedVideoProject {
  name: string;
  phase: VideoProjectPhase;
  chatId: string | null;
}

interface VideoMakerViewProps {
  embedded?: boolean;
  hostChatId?: string | null;
  hostIsStreaming?: boolean;
  initialProject?: EmbeddedVideoProject | null;
  onProjectChange?: (project: EmbeddedVideoProject | null) => void;
  onSendVideoTurn?: (content: string, displayContent?: string) => void;
}

const RATIOS: Array<{ value: VideoRatio; label: string; resolution: string }> =
  [
    { value: "16:9", label: "横屏", resolution: "1920×1080" },
    { value: "9:16", label: "竖屏", resolution: "1080×1920" },
    { value: "1:1", label: "方形", resolution: "1080×1080" },
  ];

const TTS_PROVIDERS: Array<{
  value: TtsProvider;
  label: string;
  hint: string;
}> = [
  { value: "edge", label: "内置配音", hint: "无需额外配置" },
  { value: "custom", label: "我的语音服务", hint: "使用设置中的默认音色" },
];

/** 语速选项（百分比），默认 0 表示正常语速。 */
const TTS_RATE_OPTIONS = [
  { value: "+0%", label: "正常" },
  { value: "+10%", label: "稍快 (+10%)" },
  { value: "+20%", label: "较快 (+20%)" },
  { value: "+30%", label: "很快 (+30%)" },
  { value: "-10%", label: "稍慢 (-10%)" },
  { value: "-20%", label: "较慢 (-20%)" },
  { value: "-30%", label: "很慢 (-30%)" },
] as const;

const RATIO_RESOLUTION_MAP: Record<VideoRatio, string> = {
  "16:9": "1920x1080",
  "9:16": "1080x1920",
  "1:1": "1080x1080",
};

// Only the most-recent project name is persisted locally. The authoritative
// phase always comes from the server — never restore a stale local phase.
const ACTIVE_PROJECT_KEY = "mona.video.activeProject";
const SIDEBAR_COLLAPSED_KEY = "mona.video.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "mona.video.sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 360;

const STEPS: ReadonlyArray<{ label: string; phases: VideoPhase[] }> = [
  { label: "配置主题", phases: ["config"] },
  { label: "编辑分镜", phases: ["storyboard"] },
  { label: "制作场景", phases: ["producing"] },
  { label: "导出交付", phases: ["exportable", "rendering", "done"] },
];

function videoGenerationError(detail?: string): string {
  if (detail === "membership_required") {
    return "视频助手需要有效的 Mona Pro 订阅或试用。";
  }
  if (detail === "invalid_agent_kind_context") {
    return "视频助手会话未就绪，请重新发送分镜任务。";
  }
  return "分镜生成未能启动，请重新发送分镜任务。";
}

function getStepStatus(
  stepIndex: number,
  currentPhase: VideoPhase,
): "completed" | "current" | "pending" {
  const currentStepIndex = STEPS.findIndex((s) =>
    s.phases.includes(currentPhase),
  );
  if (currentStepIndex === -1) return "pending";
  if (stepIndex < currentStepIndex) return "completed";
  if (stepIndex === currentStepIndex) return "current";
  return "pending";
}

export function VideoMakerView({
  embedded = false,
  hostChatId = null,
  hostIsStreaming = false,
  initialProject = null,
  onProjectChange,
  onSendVideoTurn,
}: VideoMakerViewProps = {}) {
  const { client, token } = useClient();
  const bp = useBreakpoint();
  const [topic, setTopic] = useState("");
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const [plan, setPlan] = useState<VideoProjectPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [ratio, setRatio] = useState<VideoRatio>("16:9");
  const [creationMode, setCreationMode] = useState<VideoCreationMode>("single");
  const [configSubview, setConfigSubview] = useState<ConfigSubview>("video");
  const [series, setSeries] = useState<VideoSeries[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [selectedSeries, setSelectedSeries] = useState<VideoSeries | null>(
    null,
  );
  const [seriesToDelete, setSeriesToDelete] = useState<VideoSeries | null>(
    null,
  );
  const [seriesDeleting, setSeriesDeleting] = useState(false);
  const [seriesDeleteError, setSeriesDeleteError] = useState<string | null>(
    null,
  );
  const [seriesToRename, setSeriesToRename] = useState<VideoSeries | null>(
    null,
  );
  const [seriesRenameValue, setSeriesRenameValue] = useState("");
  const [seriesUpdating, setSeriesUpdating] = useState(false);
  const [styleDraft, setStyleDraft] = useState<VideoStyleDraft | null>(null);
  const [customEpisodeBackground, setCustomEpisodeBackground] = useState(false);
  const [episodeBackground, setEpisodeBackground] =
    useState<BackgroundAsset | null>(null);
  const [episodeBackgroundPreview, setEpisodeBackgroundPreview] = useState<
    string | null
  >(null);
  const [backgroundUploading, setBackgroundUploading] = useState(false);
  const [pendingEpisodeBackgroundPath, setPendingEpisodeBackgroundPath] =
    useState<string | null>(null);
  const [episodeBackgroundRights, setEpisodeBackgroundRights] =
    useState<VideoAssetRightsStatus>("unknown");
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("edge");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsRate, setTtsRate] = useState("");
  const [subtitleMode, setSubtitleMode] = useState<
    "burned" | "external" | "off"
  >("burned");
  const [musicPreset, setMusicPreset] = useState<
    "none" | "ambient" | "rhythmic" | "brand"
  >("none");
  const [musicFilePath, setMusicFilePath] = useState<string | null>(null);
  const [pendingMusicPath, setPendingMusicPath] = useState<string | null>(null);
  const [musicRights, setMusicRights] =
    useState<VideoAssetRightsStatus>("unknown");
  const [phase, setPhase] = useState<VideoPhase>(initialProject?.phase ?? "config");
  // 视图模式与服务端 phase 解耦：phase 驱动步骤条高亮，viewMode 驱动视图。
  // 步骤条点击回退只改 viewMode，不回退服务端阶段。
  const [viewMode, setViewMode] = useState<"storyboard" | "producing">(
    "storyboard",
  );
  const [chatId, setChatId] = useState<string | null>(initialProject?.chatId ?? hostChatId);
  const [projectName, setProjectName] = useState<string | null>(initialProject?.name ?? null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const generatingRef = useRef(false);
  // Incremented when AI finishes a reply (streaming → false) to trigger storyboard refresh
  const [aiTurnComplete, setAiTurnComplete] = useState(0);
  const wasStreamingRef = useRef(false);
  const [isChatRunning, setIsChatRunning] = useState(
    () => (chatId ? client.getRunStartedAt(chatId) !== null : false),
  );
  const [generationError, setGenerationError] = useState<string | null>(null);
  const onProjectChangeRef = useRef(onProjectChange);

  const handleTurnState = useCallback((streaming: boolean) => {
    if (wasStreamingRef.current && !streaming) {
      setAiTurnComplete((current) => current + 1);
    }
    wasStreamingRef.current = streaming;
  }, []);

  useEffect(() => {
    onProjectChangeRef.current = onProjectChange;
  }, [onProjectChange]);

  useEffect(() => {
    if (!embedded) return;
    setChatId(initialProject?.chatId ?? hostChatId);
    if (initialProject) {
      setProjectName(initialProject.name);
      setPhase(initialProject.phase);
      setViewMode(initialProject.phase === "storyboard" ? "storyboard" : "producing");
    }
  }, [embedded, hostChatId, initialProject?.chatId, initialProject?.name, initialProject?.phase]);

  useEffect(() => {
    if (!embedded) return;
    handleTurnState(hostIsStreaming);
  }, [embedded, handleTurnState, hostIsStreaming]);

  useEffect(() => {
    if (!chatId) {
      setIsChatRunning(false);
      return;
    }
    setIsChatRunning(client.getRunStartedAt(chatId) !== null);
    return client.onRunStatus((id, startedAt) => {
      if (id !== chatId) return;
      const running = startedAt !== null;
      setIsChatRunning(running);
      if (running) setGenerationError(null);
      handleTurnState(running);
    });
  }, [chatId, client, handleTurnState]);

  useEffect(() => {
    if (!chatId) return;
    return client.onChat(chatId, (event) => {
      if (event.event === "error") {
        setGenerationError(videoGenerationError(event.detail));
      }
    });
  }, [chatId, client]);

  useEffect(() => {
    if (!embedded) return;
    onProjectChangeRef.current?.(projectName && phase !== "config"
      ? { name: projectName, phase, chatId }
      : null);
  }, [chatId, embedded, phase, projectName]);

  const refreshSeries = useCallback(async () => {
    setSeriesLoading(true);
    try {
      const result = await fetchVideoSeries(token, true);
      setSeries(result.series ?? []);
      setSelectedSeries((current) =>
        current
          ? (result.series.find((item) => item.id === current.id) ?? null)
          : current,
      );
      setSeriesError(null);
    } catch (error) {
      setSeriesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSeriesLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refreshSeries();
  }, [refreshSeries]);

  const handleSelectSeries = useCallback((value: VideoSeries) => {
    setSelectedSeries(value);
    setCustomEpisodeBackground(false);
    setEpisodeBackground(null);
    setEpisodeBackgroundPreview(null);
    const aspect = value.defaultAspectRatio;
    if (aspect === "16:9" || aspect === "9:16" || aspect === "1:1") {
      setRatio(aspect);
    }
  }, []);

  const handleDeleteSeries = useCallback(async () => {
    if (!seriesToDelete || seriesDeleting) return;
    setSeriesDeleting(true);
    setSeriesDeleteError(null);
    setSeriesError(null);
    try {
      await deleteVideoSeries(
        token,
        seriesToDelete.id,
        (seriesToDelete.episodeCount ?? 0) > 0,
      );
      setSeries((current) =>
        current.filter((item) => item.id !== seriesToDelete.id),
      );
      setSelectedSeries((current) =>
        current?.id === seriesToDelete.id ? null : current,
      );
      setSeriesToDelete(null);
      setHistoryKey((current) => current + 1);
      void refreshSeries();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSeriesDeleteError(
        message === "SERIES_DELETE_UNSAFE"
          ? "部分视频缺少风格快照，暂不能安全删除该系列"
          : `删除失败：${message}`,
      );
    } finally {
      setSeriesDeleting(false);
    }
  }, [refreshSeries, seriesDeleting, seriesToDelete, token]);

  const handleArchiveSeries = useCallback(
    async (value: VideoSeries, archived: boolean) => {
      if (seriesUpdating) return;
      setSeriesUpdating(true);
      setSeriesError(null);
      try {
        const result = await updateVideoSeries(token, value.id, { archived });
        if (!result.ok) throw new Error(result.error || "系列归档操作失败");
        if (archived) {
          setSelectedSeries((current) =>
            current?.id === value.id ? null : current,
          );
        }
        await refreshSeries();
      } catch (archiveError) {
        setSeriesError(
          archiveError instanceof Error
            ? archiveError.message
            : String(archiveError),
        );
      } finally {
        setSeriesUpdating(false);
      }
    },
    [refreshSeries, seriesUpdating, token],
  );

  const handleRenameSeries = useCallback(async () => {
    if (!seriesToRename || !seriesRenameValue.trim() || seriesUpdating) return;
    setSeriesUpdating(true);
    setSeriesError(null);
    try {
      const result = await updateVideoSeries(token, seriesToRename.id, {
        name: seriesRenameValue.trim(),
      });
      if (!result.ok || !result.series) {
        throw new Error(result.error || "系列重命名失败");
      }
      const updatedSeries = result.series;
      setSelectedSeries((current) =>
        current?.id === updatedSeries.id ? updatedSeries : current,
      );
      setSeriesToRename(null);
      await refreshSeries();
    } catch (renameError) {
      setSeriesError(
        renameError instanceof Error
          ? renameError.message
          : String(renameError),
      );
    } finally {
      setSeriesUpdating(false);
    }
  }, [refreshSeries, seriesRenameValue, seriesToRename, seriesUpdating, token]);

  const handleEpisodeBackgroundUpload = useCallback(async () => {
    if (!selectedSeries || !isTauri()) return;
    setCreateError(null);
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
      setPendingEpisodeBackgroundPath(filePath);
      setEpisodeBackgroundRights("unknown");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  }, [selectedSeries]);

  const handleConfirmEpisodeBackground = useCallback(async () => {
    if (!selectedSeries || !pendingEpisodeBackgroundPath || backgroundUploading)
      return;
    setBackgroundUploading(true);
    setCreateError(null);
    try {
      const sourceType =
        episodeBackgroundRights === "ai-generated"
          ? "ai-generated"
          : episodeBackgroundRights === "licensed"
            ? "licensed-library"
            : "user-upload";
      const result = await uploadVideoBackgroundAsset(
        token,
        selectedSeries.id,
        pendingEpisodeBackgroundPath,
        {
          sourceType,
          rightsStatus: episodeBackgroundRights,
          licenseName:
            episodeBackgroundRights === "licensed" ? "已获商业授权" : undefined,
        },
      );
      if (!result.ok || !result.asset)
        throw new Error(result.error || "背景上传失败");
      setEpisodeBackground(result.asset);
      const base = await getServicesHttpBase();
      setEpisodeBackgroundPreview(
        result.asset.previewUrl ??
          buildVideoBackgroundAssetPreviewUrl(
            base,
            token,
            selectedSeries.id,
            result.asset.id,
          ),
      );
      setPendingEpisodeBackgroundPath(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setBackgroundUploading(false);
    }
  }, [
    backgroundUploading,
    episodeBackgroundRights,
    pendingEpisodeBackgroundPath,
    selectedSeries,
    token,
  ]);

  const handleSeriesCreated = useCallback(
    (value: VideoSeries, draft: VideoStyleDraft) => {
      setSeries((current) => [
        ...current.filter((item) => item.id !== value.id),
        value,
      ]);
      setSelectedSeries(value);
      setStyleDraft(draft);
      setCreationMode("series");
      setConfigSubview("style-editor");
      const aspect = value.defaultAspectRatio;
      if (aspect === "16:9" || aspect === "9:16" || aspect === "1:1") {
        setRatio(aspect);
      }
    },
    [],
  );

  const handleStyleLocked = useCallback(
    (version: VideoStyleVersion) => {
      setSeries((current) =>
        current.map((item) =>
          item.id === version.seriesId
            ? { ...item, latestStyleVersion: version.version }
            : item,
        ),
      );
      setSelectedSeries((current) =>
        current?.id === version.seriesId
          ? { ...current, latestStyleVersion: version.version }
          : current,
      );
      setStyleDraft(null);
      setConfigSubview("video");
      void refreshSeries();
    },
    [refreshSeries],
  );

  // 初始化侧边栏折叠状态与宽度（从 localStorage 读取）
  useEffect(() => {
    try {
      const collapsedRaw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      const widthRaw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (collapsedRaw === "true") setSidebarCollapsed(true);
      if (widthRaw) {
        const w = Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, parseInt(widthRaw, 10)),
        );
        setSidebarWidth(w);
      }
    } catch {}
  }, []);

  // 窄屏自动折叠侧边栏，但保留用户手动展开的权利
  useEffect(() => {
    if (bp !== "wide") setSidebarCollapsed(true);
  }, [bp]);

  // 持久化侧边栏状态
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
    } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  const handleAddSources = useCallback(async () => {
    if (!isTauri()) return;
    setCreateError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "内容文档",
            extensions: ["pdf", "doc", "docx", "ppt", "pptx", "md", "txt"],
          },
        ],
      });
      const paths = (
        Array.isArray(selected) ? selected : selected ? [selected] : []
      )
        .filter((item): item is string => typeof item === "string")
        .slice(0, 10);
      if (!paths.length) return;
      setSourcePaths((current) =>
        Array.from(new Set([...current, ...paths])).slice(0, 10),
      );
      setPlan(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handlePickMusic = useCallback(async () => {
    if (!isTauri()) return;
    setCreateError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [
          { name: "背景音乐", extensions: ["mp3", "wav", "m4a", "webm"] },
        ],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path || typeof path !== "string") return;
      setPendingMusicPath(path);
      setMusicRights("unknown");
    } catch (musicError) {
      setCreateError(
        musicError instanceof Error ? musicError.message : String(musicError),
      );
    }
  }, []);

  const handleBuildPlan = useCallback(async () => {
    if (planning || (!topic.trim() && sourcePaths.length === 0)) return;
    setPlanning(true);
    setCreateError(null);
    try {
      const result = await planVideoProject(token, {
        topic: topic.trim(),
        sourcePaths,
      });
      if (!result.ok || !result.plan) {
        throw new Error(result.error || "制作方案生成失败");
      }
      setPlan(result.plan);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setPlanning(false);
    }
  }, [planning, sourcePaths, token, topic]);

  const removePlanItem = useCallback((id: string) => {
    setPlan((current) => {
      if (!current || current.outline.length <= 1) return current;
      const outline = current.outline.filter((item) => item.id !== id);
      return {
        ...current,
        outline,
        estimatedSceneCount: outline.length,
        estimatedDurationSeconds: outline.reduce(
          (total, item) => total + item.estimatedSeconds,
          0,
        ),
      };
    });
  }, []);

  const handleStartGeneration = useCallback(async () => {
    if (generatingRef.current) return;
    setCreateError(null);
    generatingRef.current = true;
    try {
      if (!plan || !plan.outline.length) {
        throw new Error("请先生成并确认制作方案");
      }
      if (musicPreset !== "none" && !musicFilePath) {
        throw new Error("请选择背景音乐文件并确认使用权");
      }
      if (
        creationMode === "series" &&
        (!selectedSeries || !selectedSeries.latestStyleVersion)
      ) {
        throw new Error("请先选择一个已锁定风格的系列");
      }
      if (
        creationMode === "series" &&
        customEpisodeBackground &&
        !episodeBackground
      ) {
        throw new Error("请选择本期背景图片");
      }
      // 拉取已有项目名用于重名去重；失败不阻塞创建（服务端 409 兜底）
      let existingNames: string[] = [];
      try {
        const res = await fetchVideoProjects(token);
        existingNames = res.projects.map((p) => p.name);
      } catch {
        // best-effort
      }
      const name = generateProjectName(topic, existingNames, "未命名视频");
      setProjectName(name);
      const resolution = RATIO_RESOLUTION_MAP[ratio];
      const ttsConfig = narrationEnabled
        ? {
            narrationEnabled: true,
            ttsProvider,
            ttsVoice: ttsVoice.trim(),
            ttsRate: ttsRate.trim(),
            subtitleMode,
          }
        : undefined;
      const prompt = buildVideoPrompt({
        topic,
        ratio,
        name,
        resolution,
        narration: narrationEnabled
          ? {
              provider: ttsProvider,
              voice: ttsVoice.trim(),
              rate: ttsRate.trim(),
              subtitleMode,
            }
          : undefined,
        series:
          creationMode === "series" && selectedSeries
            ? {
                id: selectedSeries.id,
                name: selectedSeries.name,
                styleVersion: selectedSeries.latestStyleVersion ?? 0,
              }
            : undefined,
        plan,
        music: {
          preset: musicPreset,
          fileName: musicFilePath?.split(/[\\/]/).pop() ?? "",
        },
      });
      const displayText = topic.trim() || "请生成视频。";
      // 1. Create project
      const created = await createVideoProject(token, name, resolution, {
        ...(ttsConfig ?? {}),
        ...(creationMode === "series" && selectedSeries
          ? {
              seriesId: selectedSeries.id,
              styleVersion: selectedSeries.latestStyleVersion ?? undefined,
              episodeNumber: (selectedSeries.episodeCount ?? 0) + 1,
              aspectVariant: ratio,
              ...(customEpisodeBackground && episodeBackground
                ? { backgroundBindings: { content: episodeBackground.id } }
                : {}),
            }
          : {}),
        plan,
        music:
          musicPreset === "none"
            ? { preset: "none" }
            : {
                preset: musicPreset,
                filePath: musicFilePath ?? undefined,
                rightsStatus: musicRights,
                sourceType:
                  musicRights === "licensed"
                    ? "licensed-library"
                    : musicRights === "ai-generated"
                      ? "ai-generated"
                      : "user-upload",
                licenseName:
                  musicRights === "licensed" ? "已获商业授权" : undefined,
              },
        sourcePaths,
      });
      if (!created.ok) {
        throw new Error(created.error || "创建项目失败");
      }
      // 2. Create session
      const newChatId = embedded
        ? hostChatId
        : await client.newChat(5_000, false, null, "video");
      if (!newChatId) throw new Error("当前视频会话尚未就绪");
      setChatId(newChatId);
      // 3. Save chat_id
      await saveVideoChatId(token, name, newChatId);
      // 4. Send prompt
      if (embedded && onSendVideoTurn) onSendVideoTurn(prompt, displayText);
      else client.sendMessage(newChatId, prompt, undefined, {
        agentKind: "video",
        displayContent: displayText,
      });
      setPhase("storyboard");
      setViewMode("storyboard");
      setHistoryKey((k) => k + 1);
    } catch (e) {
      console.error("Failed to start video generation", e);
      setProjectName(null);
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      generatingRef.current = false;
    }
  }, [
    client,
    embedded,
    hostChatId,
    onSendVideoTurn,
    topic,
    ratio,
    creationMode,
    selectedSeries,
    customEpisodeBackground,
    episodeBackground,
    narrationEnabled,
    ttsProvider,
    ttsVoice,
    ttsRate,
    subtitleMode,
    plan,
    sourcePaths,
    musicFilePath,
    musicPreset,
    musicRights,
    token,
  ]);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!chatId) return;
      if (embedded && onSendVideoTurn) onSendVideoTurn(content);
      else client.sendMessage(chatId, content, undefined, { agentKind: "video" });
    },
    [chatId, client, embedded, onSendVideoTurn],
  );

  // Detect AI turn completion: streaming transitions from true → false.
  // This is more reliable than polling storyboard.md — the AI has finished
  // its reply (and any tool calls), so any storyboard.md it wrote is now on disk.
  const handleStreamingChange = useCallback((streaming: boolean) => {
    handleTurnState(streaming);
  }, [handleTurnState]);

  const handleRetryStoryboardGeneration = useCallback(() => {
    if (!projectName || !chatId) return;
    setGenerationError(null);
    const prompt = buildStoryboardRetryPrompt(projectName);
    if (embedded && onSendVideoTurn) {
      onSendVideoTurn(prompt, "重新生成分镜");
      return;
    }
    client.sendMessage(chatId, prompt, undefined, {
      agentKind: "video",
      displayContent: "重新生成分镜",
    });
  }, [chatId, client, embedded, onSendVideoTurn, projectName]);

  const handleSelectProject = useCallback((project: VideoProject) => {
    setConfigSubview("video");
    setProjectName(project.name);
    setChatId(project.chatId);
    // Route by the server-recorded phase: storyboard → 分镜页,其他均进入制作页
    setPhase(project.phase);
    // 初始 viewMode 由服务端 phase 推导；之后步骤条点击只改 viewMode
    setViewMode(project.phase === "storyboard" ? "storyboard" : "producing");
  }, []);

  const handleDeleteProject = useCallback(
    (name: string) => {
      if (name === projectName) {
        setPhase("config");
        setChatId(null);
        setProjectName(null);
        try {
          localStorage.removeItem(ACTIVE_PROJECT_KEY);
        } catch {}
      }
    },
    [projectName],
  );

  const handleNewProject = useCallback(() => {
    setPhase("config");
    setConfigSubview("video");
    setViewMode("storyboard");
    setProjectName(null);
    setChatId(null);
    setCreateError(null);
    try {
      localStorage.removeItem(ACTIVE_PROJECT_KEY);
    } catch {}
  }, []);

  // StoryboardPhase 完成回调：首次锁定推进阶段到 producing；已锁定项目回看
  // 分镜后返回只切视图，不改服务端 phase（done/exportable 不回退）。
  const handleStoryboardDone = useCallback(() => {
    setPhase((prev) => (prev === "storyboard" ? "producing" : prev));
    setViewMode("producing");
  }, []);

  // ProducingPhase 阶段回传：驱动步骤条；渲染完成时刷新历史列表状态
  const handleProjectPhaseChange = useCallback((next: VideoProjectPhase) => {
    setPhase((prev) => {
      if (prev === "config" || prev === "storyboard") return prev;
      return prev === next ? prev : next;
    });
    if (next === "done") {
      setHistoryKey((k) => k + 1);
    }
  }, []);

  // WS-driven phase sync: the services process pushes video_project_changed on
  // phase migrations (lock / export start / render done|error). Replaces the
  // old 2s storyboard poll (which fetched but never applied anything).
  useEffect(() => {
    if (!projectName) return;
    return client.onVideoProjectChanged(({ projectName: name, hint }) => {
      if (name !== projectName) return;
      if (hint !== "phase" && hint !== "status") return;
      void (async () => {
        try {
          const res = await fetchVideoProject(token, projectName);
          if (res.phase) handleProjectPhaseChange(res.phase);
        } catch {
          // ignore transient errors
        }
      })();
    });
  }, [client, projectName, token, handleProjectPhaseChange]);

  // Persist only the active project name; the authoritative phase is always
  // read back from the server on restore.
  useEffect(() => {
    try {
      if (projectName) {
        localStorage.setItem(ACTIVE_PROJECT_KEY, projectName);
      } else {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
      }
    } catch {
      // ignore
    }
  }, [projectName]);

  // Restore active project on mount (handles page switching). The server
  // project record decides which phase to enter — local state is only a pointer.
  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    try {
      const savedName = localStorage.getItem(ACTIVE_PROJECT_KEY);
      if (!savedName) return;
      fetchVideoProjects(token)
        .then((res) => {
          if (cancelled) return;
          const project = res.projects?.find((p) => p.name === savedName);
          if (project) {
            handleSelectProject(project);
          } else {
            localStorage.removeItem(ACTIVE_PROJECT_KEY);
          }
        })
        .catch(() => {});
    } catch {
      // ignore
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta),
        );
        setSidebarWidth(next);
      };
      const handleUp = () => {
        setIsResizing(false);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [sidebarWidth],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {!embedded && (sidebarCollapsed ? (
          <TooltipProvider delayDuration={100}>
            <div className="flex w-12 shrink-0 flex-col items-center border-r border-border/70 bg-card py-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={() => setSidebarCollapsed(false)}
                    aria-label="展开侧栏"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  展开侧栏
                </TooltipContent>
              </Tooltip>

              <div className="min-h-0 w-full flex-1 overflow-y-auto py-2">
                <VideoHistory
                  key={historyKey}
                  refreshKey={historyKey}
                  currentProjectName={projectName}
                  collapsed
                  onSelect={handleSelectProject}
                  onDelete={handleDeleteProject}
                />
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleNewProject}
                    aria-label="新建视频"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  新建视频
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        ) : (
          <aside
            className="relative flex shrink-0 flex-col border-r border-border/70 bg-card"
            style={{ width: sidebarWidth }}
          >
            {/* 顶部标题栏：模块标识 + 收起按钮 */}
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-foreground">
                  <Clapperboard className="h-3.5 w-3.5" />
                </div>
                <span className="text-ui font-semibold text-foreground">
                  视频
                </span>
              </div>
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => setSidebarCollapsed(true)}
                      aria-label="收起侧栏"
                    >
                      <PanelLeftClose className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    收起侧栏
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            {/* 历史项目列表 */}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
              <VideoHistory
                key={historyKey}
                refreshKey={historyKey}
                currentProjectName={projectName}
                onSelect={handleSelectProject}
                onDelete={handleDeleteProject}
              />
            </div>

            {/* 底部主操作 */}
            <div className="shrink-0 border-t border-border/70 p-3">
              <Button
                className="h-9 w-full gap-1.5 text-ui"
                onClick={handleNewProject}
              >
                <Plus className="h-4 w-4" />
                新建视频
              </Button>
            </div>

            {/* 拖拽调整宽度 */}
            <div
              className={cn(
                "absolute right-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-col-resize transition-colors",
                isResizing ? "bg-primary/40" : "hover:bg-primary/25",
              )}
              onMouseDown={startResize}
              aria-hidden="true"
            />
          </aside>
        ))}

        <div className="flex min-h-0 flex-1 flex-col">
          {/* 步骤条：phase 驱动高亮；有项目时「编辑分镜」可点击回退，
              「制作场景」「导出交付」在分镜锁定后可点击前进（同一视图） */}
          {configSubview === "video" ? (
            <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border/70 bg-background px-4 py-3">
              {STEPS.map((step, i) => {
                const status = getStepStatus(i, phase);
                const navTarget =
                  i === 1
                    ? ("storyboard" as const)
                    : i === 2 || i === 3
                      ? ("producing" as const)
                      : null;
                const navEnabled =
                  navTarget === "storyboard"
                    ? projectName != null
                    : navTarget === "producing"
                      ? projectName != null &&
                        phase !== "config" &&
                        phase !== "storyboard"
                      : false;
                return (
                  <div key={step.label} className="flex items-center">
                    {i > 0 && (
                      <div
                        className={cn(
                          "mx-2 h-px w-5",
                          getStepStatus(i - 1, phase) !== "pending"
                            ? "bg-foreground/30"
                            : "bg-border",
                        )}
                      />
                    )}
                    <button
                      type="button"
                      disabled={!navEnabled}
                      onClick={
                        navTarget && navEnabled
                          ? () => setViewMode(navTarget)
                          : undefined
                      }
                      aria-label={
                        navTarget ? `切换到${step.label}` : step.label
                      }
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors",
                        navEnabled ? "hover:bg-accent" : "cursor-default",
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro font-medium",
                          status === "completed" &&
                            "bg-emerald-500/15 text-emerald-600",
                          status === "current" && "bg-action text-white",
                          status === "pending" &&
                            "border border-border bg-background text-muted-foreground",
                        )}
                      >
                        {status === "completed" ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <span>{i + 1}</span>
                        )}
                      </div>
                      <span
                        className={cn(
                          "text-micro font-medium",
                          status === "completed" && "text-muted-foreground",
                          status === "current" && "text-foreground",
                          status === "pending" && "text-muted-foreground/50",
                        )}
                      >
                        {step.label}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null}

          {phase === "config" && configSubview === "create-series" ? (
            <CreateVideoSeriesView
              onCancel={() => setConfigSubview("video")}
              onCreated={handleSeriesCreated}
            />
          ) : phase === "config" &&
            configSubview === "style-editor" &&
            selectedSeries ? (
            <SeriesStyleEditor
              seriesId={selectedSeries.id}
              initialDraft={styleDraft}
              currentVersion={selectedSeries.latestStyleVersion ?? 0}
              onCancel={() => setConfigSubview("video")}
              onLocked={handleStyleLocked}
            />
          ) : phase === "config" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scrollbar-hover px-4 py-8">
              <div className="w-full max-w-[560px]">
                <h2 className="mb-6 text-title-sm font-medium">新建视频</h2>

                <div className="space-y-5">
                  <section>
                    <h3 className="mb-1.5 text-ui font-medium text-foreground">
                      创建方式
                    </h3>
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                      {(["single", "series"] as VideoCreationMode[]).map(
                        (mode) => (
                          <Button
                            key={mode}
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-pressed={creationMode === mode}
                            className={cn(
                              "h-8 rounded-md px-2 text-ui font-medium transition-colors",
                              creationMode === mode
                                ? "bg-card text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                            onClick={() => {
                              setCreationMode(mode);
                              if (
                                mode === "series" &&
                                !selectedSeries &&
                                series[0]
                              ) {
                                handleSelectSeries(series[0]);
                              }
                            }}
                          >
                            {mode === "single" ? "单条视频" : "系列视频"}
                          </Button>
                        ),
                      )}
                    </div>
                  </section>

                  {creationMode === "series" ? (
                    <section>
                      <h3 className="mb-1.5 text-ui font-medium text-foreground">
                        选择系列
                      </h3>
                      <VideoSeriesSelector
                        series={series}
                        selectedSeriesId={selectedSeries?.id}
                        loading={seriesLoading}
                        onSelect={handleSelectSeries}
                        onDelete={(value) => {
                          setSeriesDeleteError(null);
                          setSeriesToDelete(value);
                        }}
                        onRename={(value) => {
                          setSeriesToRename(value);
                          setSeriesRenameValue(value.name);
                        }}
                        onArchive={(value, archived) =>
                          void handleArchiveSeries(value, archived)
                        }
                        disabled={seriesUpdating}
                        onCreate={() => setConfigSubview("create-series")}
                      />
                      {seriesError ? (
                        <div className="mt-1.5 text-caption text-destructive">
                          系列加载失败：{seriesError}
                        </div>
                      ) : null}
                      {selectedSeries ? (
                        <div className="mt-2 space-y-2">
                          <div className="flex items-center justify-between rounded-md border border-border/70 px-2.5 py-2">
                            <div className="min-w-0">
                              <div className="truncate text-caption font-medium">
                                {selectedSeries.styleSummary?.name ??
                                  "系列风格"}
                                {selectedSeries.latestStyleVersion
                                  ? ` · v${selectedSeries.latestStyleVersion}`
                                  : " · 尚未锁定"}
                              </div>
                              <div className="mt-0.5 text-micro text-muted-foreground">
                                {selectedSeries.defaultAspectRatio ?? "16:9"} ·
                                配色、字幕与背景规则自动继承
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 shrink-0 px-2 text-caption"
                              onClick={() => {
                                setStyleDraft(selectedSeries.draft ?? null);
                                setConfigSubview("style-editor");
                              }}
                            >
                              {selectedSeries.latestStyleVersion
                                ? "编辑风格"
                                : "设置风格"}
                            </Button>
                          </div>

                          <div>
                            <div className="mb-1 flex items-center justify-between">
                              <span className="text-caption font-medium text-muted-foreground">
                                本期背景
                              </span>
                              <div className="flex rounded-md bg-muted p-0.5">
                                {[false, true].map((custom) => (
                                  <Button
                                    key={String(custom)}
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "h-6 rounded px-2 text-micro",
                                      customEpisodeBackground === custom
                                        ? "bg-card text-foreground"
                                        : "text-muted-foreground",
                                    )}
                                    onClick={() =>
                                      setCustomEpisodeBackground(custom)
                                    }
                                  >
                                    {custom ? "自定义本期" : "使用系列默认"}
                                  </Button>
                                ))}
                              </div>
                            </div>
                            {customEpisodeBackground ? (
                              <div className="flex items-center gap-2 rounded-md border border-border/70 p-2">
                                {episodeBackgroundPreview ? (
                                  <img
                                    src={episodeBackgroundPreview}
                                    alt="本期背景预览"
                                    className="h-12 w-20 rounded object-cover"
                                  />
                                ) : (
                                  <div className="flex h-12 w-20 items-center justify-center rounded bg-muted">
                                    <ImagePlus className="h-4 w-4 text-muted-foreground" />
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-caption font-medium">
                                    {episodeBackground?.name ?? "尚未选择图片"}
                                  </div>
                                  <div className="mt-0.5 text-micro text-muted-foreground">
                                    仅替换图片，遮罩、字体与裁切规则继续继承
                                  </div>
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 shrink-0 px-2 text-micro"
                                  disabled={!isTauri() || backgroundUploading}
                                  onClick={() =>
                                    void handleEpisodeBackgroundUpload()
                                  }
                                >
                                  {backgroundUploading
                                    ? "上传中…"
                                    : episodeBackground
                                      ? "更换"
                                      : "选择图片"}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <section>
                    <h3 className="mb-1.5 text-ui font-medium text-foreground">
                      视频主题
                    </h3>
                    <Textarea
                      className="min-h-[96px] resize-none text-ui"
                      placeholder="描述你想制作的视频内容..."
                      value={topic}
                      onChange={(event) => {
                        setTopic(event.target.value);
                        setPlan(null);
                      }}
                    />
                  </section>

                  <section>
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-ui font-medium text-foreground">
                          来源文档
                        </h3>
                        <div className="mt-0.5 text-micro text-muted-foreground">
                          支持 PDF、Word、PPT、Markdown 和文本，最多 10 个
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!isTauri() || planning}
                        onClick={() => void handleAddSources()}
                      >
                        <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
                        添加文档
                      </Button>
                    </div>
                    {sourcePaths.length ? (
                      <div className="space-y-1.5">
                        {sourcePaths.map((path) => (
                          <div
                            key={path}
                            className="flex items-center gap-2 rounded-md border border-border/70 px-2.5 py-2"
                          >
                            <span className="min-w-0 flex-1 truncate text-caption">
                              {path.split(/[\\/]/).pop()}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              aria-label={`移除 ${path.split(/[\\/]/).pop()}`}
                              onClick={() => {
                                setSourcePaths((current) =>
                                  current.filter((item) => item !== path),
                                );
                                setPlan(null);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </section>

                  {plan ? (
                    <section className="rounded-lg border border-primary/25 bg-primary/[0.03] p-3">
                      <div className="flex items-start gap-2">
                        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-ui font-medium">
                            制作方案待确认
                          </h3>
                          <p className="mt-1 text-caption text-muted-foreground">
                            {plan.contentSummary ||
                              "请检查内容范围，删除不需要的章节后再生成分镜。"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-md bg-card px-2 py-2">
                          <div className="text-ui font-semibold">
                            {plan.estimatedSceneCount}
                          </div>
                          <div className="text-micro text-muted-foreground">
                            场景
                          </div>
                        </div>
                        <div className="rounded-md bg-card px-2 py-2">
                          <div className="text-ui font-semibold">
                            {Math.max(
                              1,
                              Math.round(plan.estimatedDurationSeconds / 60),
                            )}{" "}
                            分钟
                          </div>
                          <div className="text-micro text-muted-foreground">
                            预计时长
                          </div>
                        </div>
                        <div className="rounded-md bg-card px-2 py-2">
                          <div className="text-ui font-semibold">
                            {plan.estimatedAssetCount}
                          </div>
                          <div className="text-micro text-muted-foreground">
                            建议素材
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        {plan.outline.map((item, index) => (
                          <div
                            key={item.id}
                            className="flex items-start gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2"
                          >
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-micro font-medium">
                              {index + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-caption font-medium">
                                {item.title}
                              </div>
                              <div className="mt-0.5 line-clamp-2 text-micro text-muted-foreground">
                                {item.goal || item.keyPoints.join(" · ")}
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              disabled={plan.outline.length <= 1}
                              aria-label={`删除大纲：${item.title}`}
                              onClick={() => removePlanItem(item.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 text-micro text-muted-foreground">
                        {plan.billing.note}
                      </div>
                    </section>
                  ) : null}

                  <section>
                    <div className="mb-1.5 flex items-center justify-between">
                      <h3 className="text-ui font-medium text-foreground">
                        画面比例
                      </h3>
                      {creationMode === "series" ? (
                        <span className="text-micro text-muted-foreground">
                          继承系列
                        </span>
                      ) : null}
                    </div>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                      {RATIOS.map((r) => (
                        <button
                          key={r.value}
                          type="button"
                          title={r.resolution}
                          disabled={creationMode === "series"}
                          aria-pressed={ratio === r.value}
                          className={cn(
                            "rounded-md px-1.5 py-1.5 text-ui font-medium transition-all disabled:cursor-not-allowed disabled:opacity-70",
                            ratio === r.value
                              ? "bg-card text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => setRatio(r.value)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <div className="flex items-center justify-between">
                      <h3 className="flex items-center gap-1.5 text-ui font-medium text-foreground">
                        <Volume2 className="h-3.5 w-3.5" />
                        旁白配音
                      </h3>
                      <button
                        type="button"
                        aria-pressed={narrationEnabled}
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-caption font-medium transition-colors",
                          narrationEnabled
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                        )}
                        onClick={() => setNarrationEnabled((v) => !v)}
                      >
                        {narrationEnabled ? "已启用" : "未启用"}
                      </button>
                    </div>
                    {narrationEnabled ? (
                      <div className="mt-2 space-y-3">
                        <div>
                          <div className="mb-1 text-micro text-muted-foreground">
                            配音来源
                          </div>
                          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                            {TTS_PROVIDERS.map((p) => (
                              <button
                                key={p.value}
                                type="button"
                                title={p.hint}
                                aria-pressed={ttsProvider === p.value}
                                className={cn(
                                  "rounded-md px-1 py-1.5 text-ui font-medium transition-all",
                                  ttsProvider === p.value
                                    ? "bg-card text-foreground"
                                    : "text-muted-foreground hover:text-foreground",
                                )}
                                onClick={() => {
                                  setTtsProvider(p.value);
                                  setTtsVoice("");
                                }}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {ttsProvider === "edge" ? (
                          <div>
                            <div className="mb-1 text-micro text-muted-foreground">
                              音色
                            </div>
                            <Select
                              aria-label="配音音色"
                              value={ttsVoice || "zh-CN-XiaoyiNeural"}
                              options={EDGE_TTS_VOICES}
                              onValueChange={setTtsVoice}
                              className="h-8 text-caption"
                            />
                          </div>
                        ) : (
                          <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-micro text-muted-foreground">
                            使用「设置 →
                            语音合成」中已配置的默认音色，不需要在这里填写技术参数。
                          </div>
                        )}

                        <div>
                          <div className="mb-1 text-micro text-muted-foreground">
                            语速
                          </div>
                          <Select
                            aria-label="语速"
                            value={ttsRate || "+0%"}
                            options={TTS_RATE_OPTIONS.map((option) => ({
                              value: option.value,
                              label: option.label,
                            }))}
                            onValueChange={setTtsRate}
                            className="h-8 text-caption"
                          />
                        </div>
                        <div>
                          <div className="mb-1 text-micro text-muted-foreground">
                            字幕交付
                          </div>
                          <Select
                            aria-label="字幕交付方式"
                            value={subtitleMode}
                            options={[
                              { value: "burned", label: "视频内字幕" },
                              { value: "external", label: "外挂字幕文件" },
                              { value: "off", label: "关闭字幕" },
                            ]}
                            onValueChange={(value) =>
                              setSubtitleMode(
                                value as "burned" | "external" | "off",
                              )
                            }
                            className="h-8 text-caption"
                          />
                        </div>
                      </div>
                    ) : null}
                  </section>

                  <section>
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <h3 className="flex items-center gap-1.5 text-ui font-medium text-foreground">
                        <Music2 className="h-3.5 w-3.5" />
                        背景音乐
                      </h3>
                      <span className="text-micro text-muted-foreground">
                        自动压低音乐，优先保证旁白清晰
                      </span>
                    </div>
                    <Select
                      aria-label="背景音乐混音方式"
                      value={musicPreset}
                      options={[
                        { value: "none", label: "无背景音乐" },
                        { value: "ambient", label: "轻背景" },
                        { value: "rhythmic", label: "节奏增强" },
                        { value: "brand", label: "品牌原声" },
                      ]}
                      onValueChange={(value) => {
                        setMusicPreset(
                          value as "none" | "ambient" | "rhythmic" | "brand",
                        );
                        if (value === "none") setMusicFilePath(null);
                      }}
                      className="h-8 text-caption"
                    />
                    {musicPreset !== "none" ? (
                      <div className="mt-2 flex items-center gap-2 rounded-md border border-border/70 px-2.5 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-caption font-medium">
                            {musicFilePath?.split(/[\\/]/).pop() ??
                              "尚未选择音乐文件"}
                          </div>
                          <div className="mt-0.5 text-micro text-muted-foreground">
                            支持 MP3、WAV、M4A、WebM；正式导出会检查商业使用权
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!isTauri()}
                          onClick={() => void handlePickMusic()}
                        >
                          {musicFilePath ? "更换音乐" : "选择音乐"}
                        </Button>
                      </div>
                    ) : null}
                  </section>

                  {createError ? (
                    <div
                      className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive"
                      role="alert"
                    >
                      <span className="min-w-0 flex-1 break-words">
                        {createError}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-caption text-destructive hover:text-destructive"
                        onClick={() =>
                          void (plan
                            ? handleStartGeneration()
                            : handleBuildPlan())
                        }
                        disabled={
                          planning ||
                          (!topic.trim() && sourcePaths.length === 0) ||
                          (creationMode === "series" &&
                            !selectedSeries?.latestStyleVersion) ||
                          (creationMode === "series" &&
                            customEpisodeBackground &&
                            !episodeBackground) ||
                          (Boolean(plan) &&
                            musicPreset !== "none" &&
                            !musicFilePath)
                        }
                      >
                        重试
                      </Button>
                    </div>
                  ) : null}

                  <Button
                    className="h-9 w-full gap-1.5 text-ui"
                    disabled={
                      planning ||
                      (!topic.trim() && sourcePaths.length === 0) ||
                      (creationMode === "series" &&
                        !selectedSeries?.latestStyleVersion) ||
                      (creationMode === "series" &&
                        customEpisodeBackground &&
                        !episodeBackground) ||
                      (Boolean(plan) &&
                        musicPreset !== "none" &&
                        !musicFilePath)
                    }
                    onClick={() =>
                      void (plan ? handleStartGeneration() : handleBuildPlan())
                    }
                  >
                    {planning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : plan ? (
                      <Play className="h-4 w-4" />
                    ) : (
                      <ListChecks className="h-4 w-4" />
                    )}
                    {planning
                      ? "正在生成方案…"
                      : plan
                        ? "确认方案并生成分镜"
                        : "生成制作方案"}
                  </Button>
                </div>
              </div>
            </div>
          ) : viewMode === "storyboard" ? (
            <div className="h-full min-h-0">
              <StoryboardPhase
                projectName={projectName ?? ""}
                onLocked={handleStoryboardDone}
                refreshTrigger={aiTurnComplete}
                alreadyLocked={phase !== "storyboard"}
                generationError={generationError}
                generationRunning={isChatRunning}
                onRetryGeneration={handleRetryStoryboardGeneration}
                chatPanel={embedded ? undefined : (
                  <DocChatPanel
                    chatId={chatId}
                    onSend={handleSendMessage}
                    onStreamingChange={handleStreamingChange}
                    placeholder="与视频助手对话调整分镜..."
                  />
                )}
              />
            </div>
          ) : (
            <ProducingPhase
              projectName={projectName ?? ""}
              onPhaseChange={handleProjectPhaseChange}
              onLocalized={(localizedName) => {
                setProjectName(localizedName);
                setPhase("storyboard");
                setViewMode("storyboard");
                setHistoryKey((current) => current + 1);
              }}
            />
          )}
        </div>
      </div>

      <AssetRightsDialog
        open={pendingEpisodeBackgroundPath !== null}
        fileName={
          pendingEpisodeBackgroundPath?.split(/[\\/]/).pop() ?? "本期背景图片"
        }
        value={episodeBackgroundRights}
        loading={backgroundUploading}
        title="确认本期背景使用权"
        onChange={setEpisodeBackgroundRights}
        onCancel={() => setPendingEpisodeBackgroundPath(null)}
        onConfirm={() => void handleConfirmEpisodeBackground()}
      />
      <AssetRightsDialog
        open={pendingMusicPath !== null}
        fileName={pendingMusicPath?.split(/[\\/]/).pop() ?? "背景音乐"}
        value={musicRights}
        loading={false}
        title="确认背景音乐使用权"
        onChange={setMusicRights}
        onCancel={() => setPendingMusicPath(null)}
        onConfirm={() => {
          setMusicFilePath(pendingMusicPath);
          setPendingMusicPath(null);
        }}
      />

      <Dialog
        open={seriesToRename !== null}
        onOpenChange={(open) => {
          if (!open && !seriesUpdating) setSeriesToRename(null);
        }}
      >
        <DialogContent className="max-w-sm" showCloseButton={!seriesUpdating}>
          <DialogHeader>
            <DialogTitle>重命名视频系列</DialogTitle>
            <DialogDescription>
              只更新系列显示名称，已有视频、风格版本和素材快照都会保留。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={seriesRenameValue}
            onChange={(event) => setSeriesRenameValue(event.target.value)}
            aria-label="系列新名称"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={seriesUpdating}
              onClick={() => setSeriesToRename(null)}
            >
              取消
            </Button>
            <Button
              disabled={!seriesRenameValue.trim() || seriesUpdating}
              onClick={() => void handleRenameSeries()}
            >
              {seriesUpdating ? "保存中…" : "保存名称"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={seriesToDelete !== null}
        onOpenChange={(open) => {
          if (!open && !seriesDeleting) setSeriesToDelete(null);
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!seriesDeleting}>
          <DialogHeader>
            <DialogTitle>删除系列“{seriesToDelete?.name}”？</DialogTitle>
            <DialogDescription>
              {(seriesToDelete?.episodeCount ?? 0) > 0
                ? `系列内已有 ${seriesToDelete?.episodeCount} 个视频。删除系列后，视频会保留并转入“单条视频”，仍使用各自的本地风格快照。`
                : "该系列尚无视频。删除后，系列风格与草稿将无法恢复。"}
            </DialogDescription>
          </DialogHeader>
          {seriesDeleteError ? (
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive"
              role="alert"
            >
              {seriesDeleteError}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={seriesDeleting}
              onClick={() => setSeriesToDelete(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={seriesDeleting}
              onClick={() => void handleDeleteSeries()}
            >
              {seriesDeleting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : null}
              {(seriesToDelete?.episodeCount ?? 0) > 0
                ? "删除系列，保留视频"
                : "删除系列"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function buildVideoPrompt(opts: {
  topic: string;
  ratio: VideoRatio;
  name: string;
  resolution: string;
  narration?: {
    provider: TtsProvider;
    voice: string;
    rate: string;
    subtitleMode: "burned" | "external" | "off";
  };
  series?: {
    id: string;
    name: string;
    styleVersion: number;
  };
  plan: VideoProjectPlan;
  music: {
    preset: "none" | "ambient" | "rhythmic" | "brand";
    fileName: string;
  };
}): string {
  const parts: string[] = [];
  parts.push("请生成一段视频。");
  parts.push(`项目名：${opts.name}`);
  parts.push(`项目目录：video_projects/${opts.name}`);
  parts.push(`分辨率：${opts.resolution}`);
  parts.push(`画面比例：${opts.ratio}`);
  if (opts.series) {
    parts.push(`视频系列：${opts.series.name}（${opts.series.id}）`);
    parts.push(`锁定风格版本：v${opts.series.styleVersion}`);
    parts.push(
      "分镜必须使用 Role、Layout 和 Background Slot 字段，并且只选择锁定风格允许的值。",
    );
  }
  if (opts.narration) {
    parts.push(`旁白：启用`);
    parts.push(`TTS供应商：${opts.narration.provider}`);
    parts.push(
      `音色：${opts.narration.voice || (opts.narration.provider === "custom" ? "使用全局默认音色" : "zh-CN-XiaoyiNeural")}`,
    );
    parts.push(`语速：${opts.narration.rate || "+0%"}（留空用默认）`);
    parts.push(
      `字幕：${
        opts.narration.subtitleMode === "burned"
          ? "视频内字幕"
          : opts.narration.subtitleMode === "external"
            ? "仅外挂字幕文件"
            : "关闭"
      }`,
    );
  } else {
    parts.push(`旁白：未启用`);
  }
  if (opts.topic.trim()) {
    parts.push(`主题：${opts.topic.trim()}`);
  }
  parts.push("已确认制作方案：");
  opts.plan.outline.forEach((item, index) => {
    parts.push(
      `${index + 1}. ${item.title}｜目标：${item.goal || "讲清本节内容"}｜要点：${item.keyPoints.join("；")}｜建议角色：${item.role}｜预计 ${item.estimatedSeconds} 秒`,
    );
  });
  parts.push(
    `背景音乐：${
      opts.music.preset === "none"
        ? "无"
        : `${
            {
              ambient: "轻背景",
              rhythmic: "节奏增强",
              brand: "品牌原声",
            }[opts.music.preset]
          }（${opts.music.fileName}）`
    }`,
  );
  parts.push("");
  parts.push(
    "请按照 mona-video SKILL 的流程执行 Step 1-4，并严格依据已确认制作方案生成分镜草稿（storyboard.md）。不得恢复用户已删除的大纲项。",
  );
  if (opts.narration) {
    parts.push(
      "每个场景的 storyboard.md 必须包含 - Narration: <纯文本> 字段，文本字数应与 Duration 匹配（中文约 4 字/秒）。",
    );
  }
  parts.push("");
  parts.push(
    '重要：生成分镜草稿后必须停止。告知用户"分镜草稿已就绪，请在右侧分镜审阅界面编辑确认"，然后等待用户操作。',
  );
  parts.push("- 不要主动写 storyboard_lock.md");
  parts.push("- 不要主动进入 Step 5 编写 HTML");
  parts.push("- 不要主动调用任何渲染脚本");
  parts.push(
    "用户会在 UI 上编辑/增删/重排场景，确认后系统会自动解锁后续步骤。",
  );
  return parts.join("\n");
}

function buildStoryboardRetryPrompt(projectName: string): string {
  return [
    `请继续制作视频项目：${projectName}。`,
    `项目目录：video_projects/${projectName}`,
    "读取项目中的 outline.json 和现有风格配置，按照 mona-video SKILL 生成分镜草稿 storyboard.md。",
    "不要新建项目，不要修改已确认的大纲，不要写 storyboard_lock.md，也不要进入场景制作或渲染。",
    '完成后告知用户“分镜草稿已就绪，请在右侧分镜审阅界面编辑确认”，然后停止。',
  ].join("\n");
}
