import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Clapperboard,
  FilePlus2,
  Loader2,
  Music2,
  PanelLeft,
  PanelLeftClose,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  Square,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
  ApiError,
  confirmVideoProjectPlan,
  createVideoProject,
  deleteVideoSeries,
  fetchVideoProject,
  fetchVideoProjects,
  fetchVideoSeries,
  fetchVideoStyleTemplates,
  saveVideoChatId,
  updateVideoSeries,
  updateVideoProjectSettings,
  type VideoAssetRightsStatus,
  type VideoAspectVariant,
  type VideoProject,
  type VideoProjectPhase,
  type VideoProjectCreateOptions,
  type VideoSeries,
  type VideoStyleTemplate,
  type VideoStyleVersion,
  type VideoTtsConfig,
} from "@/lib/api";
import { generateProjectName } from "@/lib/project-name";
import type { AgentModelBinding } from "@/lib/types";
import { RoomCommandError } from "@/lib/mona-client";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import { DocChatPanel } from "../DocChatPanel";
import { StoryboardPhase } from "./StoryboardPhase";
import { ProducingPhase } from "./ProducingPhase";
import { VideoWorkbenchHeader, videoFocusQuote, type VideoFocus } from "./VideoWorkbenchHeader";
import { VideoStyleGallery } from "./VideoStyleGallery";
import { VideoHistory } from "./VideoHistory";
import { VideoStyleWorkspace, type StyleConversationState } from "./style/VideoStyleWorkspace";
import { SavedVideoStyleGallery } from "./style/SavedVideoStyleGallery";
import { copyVideoStyle } from "@/lib/video-style-api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetRightsDialog } from "./style/AssetRightsDialog";
import { VideoNarrationSettingsDialog } from "./VideoNarrationSettingsDialog";
import { VoicePreviewButton } from "./VoicePreviewButton";
import { useVideoModelBinding, useVideoSessionKind } from "./useVideoModelBinding";
import { VideoModelControl } from "./VideoModelControl";
import {
  EDGE_TTS_VOICES,
  TTS_PROVIDERS,
  TTS_RATE_OPTIONS,
  type TtsProvider,
} from "./video-tts-options";

export { EDGE_TTS_VOICES, TTS_PROVIDERS, TTS_RATE_OPTIONS } from "./video-tts-options";
export type { TtsProvider } from "./video-tts-options";

type VideoPhase = "config" | VideoProjectPhase;
type VideoRatio = VideoAspectVariant;
type ConfigSubview = "video" | "create-series" | "style-editor";

interface PendingVideoGeneration {
  name: string;
  prompt: string;
  displayText: string;
  chatId: string | null;
  chatIdSaved: boolean;
  modelBinding: AgentModelBinding | null;
  creation?: { resolution: string; options: VideoProjectCreateOptions };
}

export interface EmbeddedVideoProject {
  name: string;
  phase: VideoProjectPhase;
  chatId: string | null;
}

interface VideoMakerViewProps {
  embedded?: boolean;
  hostChatId?: string | null;
  sessionAgentKind?: string | null;
  onSessionKindResolved?: (chatId: string, kind: string | null) => void;
  onSessionError?: (message: string) => void;
  hostIsStreaming?: boolean;
  initialProject?: EmbeddedVideoProject | null;
  onProjectChange?: (project: EmbeddedVideoProject | null) => void;
  onSendVideoTurn?: (content: string, displayContent?: string, modelBinding?: AgentModelBinding | null) => void;
  onFocusChange?: (focus: VideoFocus | null) => void;
  onOpenChat?: () => void;
  visible?: boolean;
  onStyleWorkspaceChange?: (state: StyleConversationState | null) => void;
  styleConversationRequest?: number;
}

const RATIOS: Array<{ value: VideoRatio; label: string }> =
  [
    { value: "16:9", label: "横屏" },
    { value: "9:16", label: "竖屏" },
    { value: "1:1", label: "方形" },
  ];


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

function videoGenerationError(detail?: string): string {
  if (detail === "invalid_agent_kind_context") {
    return "视频会话未就绪，请重试准备分镜。";
  }
  return "视频任务未能启动，请重试。";
}

export function VideoMakerView({
  embedded = false,
  hostChatId = null,
  sessionAgentKind,
  onSessionKindResolved,
  onSessionError,
  hostIsStreaming = false,
  initialProject = null,
  onProjectChange,
  onSendVideoTurn,
  onOpenChat,
  onFocusChange,
  visible = true,
  onStyleWorkspaceChange,
  styleConversationRequest,
}: VideoMakerViewProps = {}) {
  const { client, token } = useClient();
  const focusRef = useRef<VideoFocus | null>(null);
  const handleFocusChange = useCallback((focus: VideoFocus | null) => {
    focusRef.current = focus;
    onFocusChange?.(focus);
  }, [onFocusChange]);
  useEffect(() => () => { onFocusChange?.(null); }, [onFocusChange]);
  const bp = useBreakpoint();
  const [topic, setTopic] = useState("");
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [moreSettingsOpen, setMoreSettingsOpen] = useState(false);
  const [draftProjectName, setDraftProjectName] = useState("");
  const [ratio, setRatio] = useState<VideoRatio>("16:9");
  const [templateId, setTemplateId] = useState<string>("auto");
  const [styleTemplates, setStyleTemplates] = useState<VideoStyleTemplate[]>([]);
  const [styleTemplatesError, setStyleTemplatesError] = useState(false);
  const [styleLoadKey, setStyleLoadKey] = useState(0);
  useEffect(() => {
    let active = true;
    setStyleTemplatesError(false);
    void Promise.resolve().then(() => fetchVideoStyleTemplates(token)).then(({templates}) => {
      if (active) setStyleTemplates(templates);
    }).catch(() => { if (active) setStyleTemplatesError(true); });
    return () => { active = false; };
  }, [token, styleLoadKey]);
  const [singleStyleSource, setSingleStyleSource] = useState<"template" | "series">("template");
  const [styleSeriesId, setStyleSeriesId] = useState<string | null>(null);
  const [configSubview, setConfigSubview] = useState<ConfigSubview>("video");
  const [styleLibraryTab, setStyleLibraryTab] = useState("builtin");
  const [creatingBaseStyle, setCreatingBaseStyle] = useState<VideoStyleTemplate>();
  const [restoredStyleId, setRestoredStyleId] = useState<string | null>(null);
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
  const [narrationEnabled, setNarrationEnabled] = useState(true);
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
  const [workspaceView, setWorkspaceView] = useState<"director" | "preview">(initialProject?.phase && initialProject.phase !== "storyboard" ? "preview" : "director");
  const [contentOpen, setContentOpen] = useState(false);
  const [chatId, setChatId] = useState<string | null>(initialProject?.chatId ?? hostChatId);
  const [createdVideoChatId, setCreatedVideoChatId] = useState<string | null>(null);
  const session = useVideoSessionKind(chatId, chatId && chatId === createdVideoChatId ? "video" : chatId === (initialProject?.chatId ?? hostChatId) ? sessionAgentKind : undefined);
  const videoSession = !chatId || session.agentKind === "video";
  const sessionUnavailable = Boolean(chatId && session.agentKind === undefined);
  const videoModel = useVideoModelBinding(chatId, null, videoSession);
  const [projectName, setProjectName] = useState<string | null>(initialProject?.name ?? null);
  const [createError, setCreateError] = useState<string | null>(null);
  useEffect(() => {
    if (visible && session.error) (onSessionError ?? setCreateError)(session.error);
  }, [onSessionError, session.error, visible]);
  useEffect(() => {
    if (chatId && session.agentKind !== undefined) onSessionKindResolved?.(chatId, session.agentKind);
  }, [chatId, onSessionKindResolved, session.agentKind]);

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
  const [agentActivity, setAgentActivity] = useState<string | null>(null);
  const [agentStartedAt, setAgentStartedAt] = useState<number | null>(null);
  const onProjectChangeRef = useRef(onProjectChange);
  const pendingGenerationRef = useRef<PendingVideoGeneration | null>(null);
  const changeVideoModel = useCallback(async (value: AgentModelBinding | null) => {
    const saved = await videoModel.changeBinding(value);
    if (pendingGenerationRef.current) pendingGenerationRef.current.modelBinding = saved;
  }, [videoModel.changeBinding]);
  const storyboardFlushRef = useRef<(() => Promise<boolean>) | null>(null);
  const [leavingStoryboard, setLeavingStoryboard] = useState(false);
  const [planDetails, setPlanDetails] = useState({ planRevision: null as number | null, sceneCount: 0, duration: 0 });
  const planDetailsRef = useRef(planDetails);
  const [approvedRevision, setApprovedRevision] = useState<number | null>(null);
  const [currentPlanRevision, setCurrentPlanRevision] = useState<number | null>(null);
  const [requiresApproval, setRequiresApproval] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [projectSettings, setProjectSettings] = useState<VideoTtsConfig>({ narrationEnabled: true });
  const [narrationSettingsOpen, setNarrationSettingsOpen] = useState(false);
  const [narrationSettingsSaving, setNarrationSettingsSaving] = useState(false);
  const [narrationSettingsError, setNarrationSettingsError] = useState<string | null>(null);
  const loadedProjectRef = useRef<string | null>(null);
  const activeProjectRef = useRef(projectName);
  activeProjectRef.current = projectName;
  const [elapsed, setElapsed] = useState(0);
  const reusableStyleSeries = series.filter(
    (item) => !item.archivedAt && Boolean(item.latestStyleVersion),
  );
  const selectedStyleSeries = reusableStyleSeries.find(
    (item) => item.id === styleSeriesId,
  ) ?? null;

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
    const boundChatId = initialProject?.chatId ?? hostChatId;
    if (boundChatId) setChatId(boundChatId);
    if (initialProject) {
      setProjectName(initialProject.name);
      setPhase(initialProject.phase);
    }
  }, [embedded, hostChatId, initialProject?.chatId, initialProject?.name, initialProject?.phase]);

  useEffect(() => {
    if (!agentStartedAt || !(isChatRunning || hostIsStreaming)) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor(Date.now() / 1000 - agentStartedAt)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [agentStartedAt, isChatRunning, hostIsStreaming]);

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
    setAgentStartedAt(client.getRunStartedAt(chatId));
    return client.onRunStatus((id, startedAt) => {
      if (id !== chatId) return;
      const running = startedAt !== null;
      setIsChatRunning(running);
      setAgentStartedAt(startedAt);
      if (!running) setAgentActivity(null);
      if (running) setGenerationError(null);
      handleTurnState(running);
    });
  }, [chatId, client, handleTurnState]);

  useEffect(() => {
    if (!chatId) return;
    return client.onChat(chatId, (event) => {
      if (event.event === "error" && (!event.message_rejected || !event.task_id || event.request_id)) {
        setGenerationError(videoGenerationError(event.detail));
      }
      if (event.event === "turn_end") {
        setIsChatRunning(false);
        setAgentActivity(null);
        handleTurnState(false);
      }
      if (event.event === "file_edit") {
        const path = event.edits?.at(-1)?.path ?? "";
        const match = path.match(/drafts[/\\]scene_(\d+)\.(?:html|tsx)$/);
        if (match) setAgentActivity(`正在准备第 ${Number(match[1])} 段画面草稿`);
      }
      if (event.event === "message") {
        const operation = [...(event.tool_events ?? [])].reverse().find((tool) => tool.name === "video");
        const parameters = operation?.arguments as Record<string, unknown> | undefined;
        const action = parameters?.action;
        const index = parameters?.scene_index;
        if (action === "plan") setAgentActivity("正在整理旁白与动画方案");
        if (action === "audio" && typeof index === "number") setAgentActivity(`正在生成第 ${index} 段配音`);
        if (action === "preview" && typeof index === "number") setAgentActivity(`正在检查第 ${index} 段动画`);
        if (action === "sync" && typeof index === "number") setAgentActivity(`正在处理第 ${index} 段画面`);
        if (action === "export") setAgentActivity("正在导出视频");
      }
    });
  }, [chatId, client, handleTurnState]);

  const refreshProject = useCallback(async () => {
    if (!projectName) return;
    const project = await fetchVideoProject(token, projectName);
    if (project.styleAuthoring?.seriesId) setRestoredStyleId(project.styleAuthoring.seriesId);
    if (activeProjectRef.current !== projectName) return;
    setProjectSettings(project.meta ?? {});
    const needsApproval = project.meta?.requirePlanApproval ?? project.requirePlanApproval ?? false;
    const approved = project.meta?.approvedPlanRevision ?? project.approvedPlanRevision ?? null;
    const revision = project.meta?.planRevision ?? project.planRevision;
    setCurrentPlanRevision(revision ?? null);
    setRequiresApproval(needsApproval);
    setApprovedRevision(approved);
    if (project.phase) setPhase(project.phase);
    if (loadedProjectRef.current !== projectName) {
      loadedProjectRef.current = projectName;
      setWorkspaceView(needsApproval && approved !== revision || project.phase === "storyboard" ? "director" : "preview");
    } else if (needsApproval && approved !== revision) {
      setWorkspaceView("director");
    }
  }, [projectName, token]);

  useEffect(() => {
    if (!projectName) return;
    void refreshProject().catch(() => setGenerationError("视频信息暂时无法读取，请重试。"));
  }, [refreshProject, aiTurnComplete]);

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

  const handleSelectStyleSeries = useCallback((value: VideoSeries) => {
    setSingleStyleSource("series");
    setStyleSeriesId(value.id);
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
          ? "部分视频的风格尚未保存完整，暂时无法删除。"
          : `删除失败：${message}`,
      );
    } finally {
      setSeriesDeleting(false);
    }
  }, [refreshSeries, seriesDeleting, seriesToDelete, token]);

  const handleRenameSeries = useCallback(async () => {
    if (!seriesToRename || !seriesRenameValue.trim() || seriesUpdating) return;
    setSeriesUpdating(true);
    setSeriesError(null);
    try {
      const result = await updateVideoSeries(token, seriesToRename.id, {
        name: seriesRenameValue.trim(),
      });
      if (!result.ok || !result.series) {
        throw new Error(result.error || "风格重命名失败");
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

  const handleStyleLocked = useCallback(
    (version: VideoStyleVersion) => {
      setSingleStyleSource("series");
      setStyleSeriesId(version.seriesId);
      setStyleLibraryTab("mine");
      setRestoredStyleId(null);
      if (projectName && restoredStyleId) { setProjectName(null); setPhase("config"); }
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
      setConfigSubview("video");
      void refreshSeries();
    },
    [refreshSeries, projectName, restoredStyleId],
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

  const resumePendingGeneration = useCallback(async () => {
    const pending = pendingGenerationRef.current;
    if (!pending) return;
    setGenerationError(null);
    if (pending.creation) {
      try {
        const existing = await fetchVideoProject(token, pending.name);
        if (existing.name !== pending.name) throw new Error("创建结果尚未确定");
      } catch (creationCheckError) {
        if (!(creationCheckError instanceof ApiError) || creationCheckError.status !== 404) {
          throw new Error("视频创建情况暂时无法确认，请稍后重试。");
        }
        const created = await createVideoProject(token, pending.name, pending.creation.resolution, pending.creation.options);
        if (!created.ok) throw new Error("视频未能创建，请重试。");
      }
      delete pending.creation;
    }
    const newChatId =
      pending.chatId ??
      (embedded && hostChatId ? hostChatId : await client.newChat(45_000, false, null, "video", pending.modelBinding));
    if (!newChatId) throw new Error("当前视频会话尚未就绪");
    if (!pending.chatId && !(embedded && hostChatId)) setCreatedVideoChatId(newChatId);
    pending.chatId = newChatId;
    setChatId(newChatId);
    if (!pending.chatIdSaved) {
      const saved = await saveVideoChatId(token, pending.name, newChatId);
      if (!saved?.ok) throw new Error("视频项目已创建，但会话信息尚未保存。请重试。");
      pending.chatIdSaved = true;
    }
    if (embedded && onSendVideoTurn && hostChatId === newChatId) {
      if (videoSession) onSendVideoTurn(pending.prompt, pending.displayText, pending.modelBinding);
      else onSendVideoTurn(pending.prompt, pending.displayText);
    } else {
      client.sendMessage(newChatId, pending.prompt, undefined, {
        ...(videoSession ? { agentKind: "video", modelBinding: pending.modelBinding } : {}),
        displayContent: pending.displayText,
      });
    }
    pendingGenerationRef.current = null;
    setPhase("storyboard");
    setWorkspaceView("director");
    setHistoryKey((current) => current + 1);
  }, [client, embedded, hostChatId, onSendVideoTurn, token, videoSession]);

  const handleStartGeneration = useCallback(async () => {
    if (generatingRef.current) return;
    if (sessionUnavailable || videoModel.loading || videoModel.saving || videoModel.error) return;
    setCreateError(null);
    generatingRef.current = true;
    setStarting(true);
    try {
      const pending = pendingGenerationRef.current;
      if (pending) {
        setProjectName(pending.name);
        setPhase("storyboard");
        await resumePendingGeneration();
        return;
      }
      if (!topic.trim() && sourcePaths.length === 0) return;
      if (musicPreset !== "none" && !musicFilePath) {
        throw new Error("请选择背景音乐文件并确认使用权");
      }
      if (singleStyleSource === "series" && !selectedStyleSeries) {
        throw new Error("请选择一个已保存的风格");
      }
      // 拉取已有项目名用于重名去重；失败不阻塞创建（服务端 409 兜底）
      let existingNames: string[] = [];
      try {
        const res = await fetchVideoProjects(token);
        existingNames = res.projects.map((p) => p.name);
      } catch {
        // best-effort
      }
      const name = generateProjectName(draftProjectName.trim() || topic, existingNames, "未命名视频");
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
        styleName: singleStyleSource === "series"
          ? selectedStyleSeries?.name
          : templateId === "auto" ? "由 Mona 根据内容推荐" : styleTemplates.find((style) => style.id === templateId)?.name,
        narrationEnabled,
        sourceCount: sourcePaths.length,
        hasMusic: musicPreset !== "none",
      });
      const displayText = topic.trim() || "请准备视频分镜。";
      const options: VideoProjectCreateOptions = {
        requirePlanApproval: true,
        ...(ttsConfig ?? {}),
        ...(singleStyleSource === "template"
          ? { templateId }
          : selectedStyleSeries
            ? {
                styleSeriesId: selectedStyleSeries.id,
                styleVersion: selectedStyleSeries.latestStyleVersion ?? undefined,
                aspectVariant: ratio,
              }
            : {}),
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
      };
      pendingGenerationRef.current = {
        name,
        prompt,
        displayText,
        chatId: null,
        chatIdSaved: false,
        modelBinding: videoModel.binding,
        creation: { resolution, options },
      };
      const created = await createVideoProject(token, name, resolution, options);
      if (!created.ok) {
        pendingGenerationRef.current = null;
        throw new Error("视频未能创建，请重试。");
      }
      delete pendingGenerationRef.current.creation;
      setProjectName(name);
      setPhase("storyboard");
      setWorkspaceView("director");
      loadedProjectRef.current = name;
      setRequiresApproval(true);
      setApprovedRevision(null);
      setHistoryKey((current) => current + 1);
      await resumePendingGeneration();
    } catch (e) {
      console.error("Failed to start video generation", e);
      if (pendingGenerationRef.current?.creation && e instanceof ApiError && e.status >= 400 && e.status < 500) {
        pendingGenerationRef.current = null;
      }
      const pending = pendingGenerationRef.current;
      if (pending) {
        setProjectName(pending.name);
        setPhase("storyboard");
        setGenerationError(
          e instanceof RoomCommandError && e.code === "invalid_model_binding" ? e.message : pending.creation
            ? "视频创建情况暂时无法确认，请点击继续准备分镜检查。"
            : "视频已创建，分镜方案尚未准备。请点击继续准备分镜。",
        );
        setHistoryKey((current) => current + 1);
      } else {
        setPhase("config");
        setProjectName(null);
        setCreateError("视频未能创建，请重试。");
      }
    } finally {
      generatingRef.current = false;
      setStarting(false);
    }
  }, [
    topic, draftProjectName, ratio, singleStyleSource, selectedStyleSeries,
    templateId, styleTemplates, narrationEnabled, ttsProvider, ttsVoice, ttsRate, subtitleMode,
    sourcePaths, musicFilePath, musicPreset, musicRights, resumePendingGeneration, sessionUnavailable, token, videoModel.binding, videoModel.loading, videoModel.saving, videoModel.error,
  ]);

  // Detect AI turn completion: streaming transitions from true → false.
  // This is more reliable than polling storyboard.md — the AI has finished
  // its reply (and any tool calls), so any storyboard.md it wrote is now on disk.
  const handleStreamingChange = useCallback((streaming: boolean) => {
    handleTurnState(streaming);
  }, [handleTurnState]);

  const registerStoryboardFlush = useCallback(
    (flush: (() => Promise<boolean>) | null) => {
      storyboardFlushRef.current = flush;
    },
    [],
  );

  const handlePlanChange = useCallback((next: typeof planDetails) => {
    planDetailsRef.current = next;
    setPlanDetails(next);
  }, []);

  const handlePlanEdited = useCallback(() => setApprovedRevision(null), []);

  const handleRetryStoryboardGeneration = useCallback(() => {
    if (!projectName || sessionUnavailable) return;
    setGenerationError(null);
    if (pendingGenerationRef.current) {
      void handleStartGeneration();
      return;
    }
    if (!chatId) {
      pendingGenerationRef.current = {
        name: projectName,
        prompt: buildVideoResumePrompt(projectName),
        displayText: "继续准备分镜",
        chatId: null,
        chatIdSaved: false,
        modelBinding: videoModel.binding,
      };
      void handleStartGeneration();
      return;
    }
    const prompt = buildVideoResumePrompt(projectName);
    if (embedded && onSendVideoTurn && hostChatId === chatId) {
      onSendVideoTurn(prompt, "继续准备分镜");
      return;
    }
    client.sendMessage(chatId, prompt, undefined, {
      ...(videoSession ? { agentKind: "video" } : {}),
      displayContent: "继续准备分镜",
    });
  }, [chatId, client, embedded, handleStartGeneration, hostChatId, onSendVideoTurn, projectName, sessionUnavailable, videoModel.binding, videoSession]);

  const handleRequestAgent = useCallback(async (request: string, displayText = request) => {
    if (!projectName || isChatRunning || hostIsStreaming || sessionUnavailable) return;
    const currentChatId = chatId ?? (embedded && hostChatId
      ? hostChatId
      : await client.newChat(45_000, false, null, "video", videoModel.binding));
    if (!currentChatId) throw new Error("视频会话尚未就绪，请稍后重试。");
    if (!chatId && !(embedded && hostChatId)) setCreatedVideoChatId(currentChatId);
    if (!chatId) {
      const saved = await saveVideoChatId(token, projectName, currentChatId);
      if (!saved.ok) throw new Error("会话尚未保存，请重试。");
      setChatId(currentChatId);
    }
    setGenerationError(null);
    const prompt = `当前视频：${projectName}\n${request}`;
    if (embedded && onSendVideoTurn && hostChatId === currentChatId) {
      onSendVideoTurn(prompt, displayText);
    } else {
      client.sendMessage(currentChatId, prompt, undefined, {
        ...(videoSession ? { agentKind: "video" } : {}),
        displayContent: displayText,
      });
    }
  }, [chatId, client, embedded, hostChatId, hostIsStreaming, isChatRunning, onSendVideoTurn, projectName, sessionUnavailable, token, videoModel.binding, videoSession]);

  const handleConfirmPlan = useCallback(async () => {
    if (!projectName || confirming || isChatRunning || hostIsStreaming || sessionUnavailable) return;
    setConfirming(true);
    setConfirmationError(null);
    try {
      if (!storyboardFlushRef.current || !await storyboardFlushRef.current()) return;
      const { planRevision, sceneCount } = planDetailsRef.current;
      if (planRevision === null || sceneCount === 0) throw new Error("请先准备好分镜方案，再确认生成。");
      const confirmed = await confirmVideoProjectPlan(token, projectName, planRevision);
      if (!confirmed.ok) throw new Error("分镜尚未确认，请检查方案后重试。");
      setApprovedRevision(confirmed.planRevision);
      setCurrentPlanRevision(confirmed.planRevision);
      await handleRequestAgent(buildVideoProductionPrompt(confirmed.planRevision), "确认分镜，开始生成视频");
      setWorkspaceView("preview");
      setPhase("producing");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConfirmationError("分镜方案已发生变化。请查看更新后的内容，再确认生成。");
        setAiTurnComplete((value) => value + 1);
      } else {
        setConfirmationError(error instanceof Error ? error.message : "生成尚未开始，请重试。");
      }
    } finally {
      setConfirming(false);
    }
  }, [confirming, handleRequestAgent, hostIsStreaming, isChatRunning, projectName, sessionUnavailable, token]);

  const handleContinueProduction = useCallback(() => {
    if (requiresApproval && (approvedRevision === null || approvedRevision !== currentPlanRevision)) {
      setWorkspaceView("director");
      return;
    }
    void handleRequestAgent(buildVideoProductionPrompt(approvedRevision), "继续制作视频");
  }, [approvedRevision, currentPlanRevision, handleRequestAgent, requiresApproval]);

  const handleSaveNarrationSettings = useCallback(async (settings: VideoTtsConfig) => {
    setNarrationSettingsSaving(true);
    setNarrationSettingsError(null);
    try {
      const result = await updateVideoProjectSettings(token, projectName ?? "", settings);
      if (!result.ok) throw new Error("保存失败");
      setProjectSettings(result.meta ?? settings);
      setNarrationSettingsOpen(false);
      setAiTurnComplete((value) => value + 1);
    } catch (error) {
      setNarrationSettingsError(error instanceof ApiError && [400, 409, 422].includes(error.status)
        ? error.message
        : "配音设置保存失败，请重试。");
    } finally {
      setNarrationSettingsSaving(false);
    }
  }, [projectName, token]);

  const leaveStoryboardWhenSaved = useCallback(
    (action: () => void) => {
      const flush = storyboardFlushRef.current;
      if ((workspaceView !== "director" && !contentOpen) || !projectName || !flush) {
        action();
        return;
      }
      if (leavingStoryboard) return;
      setLeavingStoryboard(true);
      void flush()
        .then((saved) => {
          if (saved) action();
        })
        .finally(() => setLeavingStoryboard(false));
    },
    [leavingStoryboard, projectName, contentOpen, workspaceView],
  );

  const handleSelectProject = useCallback(
    (project: VideoProject) => {
      leaveStoryboardWhenSaved(() => {
        setConfigSubview("video");
        setProjectName(project.name);
        setChatId(project.chatId);
        setPhase(project.phase);
        setWorkspaceView(project.phase === "storyboard" ? "director" : "preview");
        loadedProjectRef.current = null;
        setContentOpen(false);
      });
    },
    [leaveStoryboardWhenSaved],
  );

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
    leaveStoryboardWhenSaved(() => {
      setPhase("config");
      setConfigSubview("video");
      setContentOpen(false);
      setWorkspaceView("director");
      loadedProjectRef.current = null;
      pendingGenerationRef.current = null;
      setProjectName(null);
      setChatId(null);
      videoModel.setBinding(null);
      setCreateError(null);
      try {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
      } catch {}
    });
  }, [leaveStoryboardWhenSaved, videoModel.setBinding]);

  const handleProjectRenamed = useCallback(
    (oldName: string, newName: string) => {
      setProjectName((current) => (current === oldName ? newName : current));
      setHistoryKey((current) => current + 1);
    },
    [],
  );

  const handleProjectArchived = useCallback(
    (name: string, archived: boolean) => {
      if (archived && projectName === name) handleNewProject();
      setHistoryKey((current) => current + 1);
    },
    [handleNewProject, projectName],
  );

  const handleProjectPhaseChange = useCallback((next: VideoProjectPhase) => {
    setPhase((prev) => {
      if (prev === "config") return prev;
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
      if (!["phase", "status", "scenes", "settings"].includes(hint)) return;
      void (async () => {
        try {
          await refreshProject();
        } catch {
          // ignore transient errors
        }
      })();
    });
  }, [client, projectName, refreshProject]);

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
                  onProjectRenamed={handleProjectRenamed}
                  onProjectArchived={handleProjectArchived}
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
                onProjectRenamed={handleProjectRenamed}
                onProjectArchived={handleProjectArchived}
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
              className="mona-resize-handle absolute right-0 top-0 bottom-0 w-1 -translate-x-1/2 cursor-col-resize"
              data-resizing={isResizing || undefined}
              onMouseDown={startResize}
              aria-hidden="true"
            />
          </aside>
        ))}

        <div className="flex min-h-0 flex-1 flex-col">
          {(configSubview === "create-series" || configSubview === "style-editor" || restoredStyleId) ? (
            <VideoStyleWorkspace
              key={restoredStyleId ?? (configSubview === "style-editor" ? selectedSeries?.id : "new")}
              initialSeriesId={restoredStyleId ?? (configSubview === "style-editor" ? selectedSeries?.id : null)}
              baseStyle={creatingBaseStyle} aspectRatio={ratio} topic={topic} visible={visible} useOnSave={!restoredStyleId}
              initialModelBinding={videoModel.binding}
              tts={{ narrationEnabled, ttsProvider, ttsVoice, ttsRate, subtitleMode }}
              onConversationChange={onStyleWorkspaceChange}
              conversationRequest={styleConversationRequest}
              uploadChatId={hostChatId}
              onBack={() => { setConfigSubview("video"); if (restoredStyleId) { setRestoredStyleId(null); setProjectName(null); setPhase("config"); } void refreshSeries(); }}
              onSaved={handleStyleLocked}
            />
          ) : phase === "config" ? (
            <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover px-4 py-6">
              <div className="mx-auto w-full max-w-4xl space-y-5">
                <div>
                  <h2 className="text-title-sm font-medium">制作视频</h2>
                  <p className="mt-2 text-caption text-muted-foreground">先准备分镜方案，在导演台确认和调整后，再生成视频。</p>
                </div>
                <section>
                  <label htmlFor="video-brief" className="mb-2 block text-ui font-medium">想做什么视频？</label>
                  <Textarea
                    id="video-brief"
                    className="min-h-24 resize-none text-ui"
                    placeholder="例如：做一段一分钟的产品介绍，面向第一次了解它的人，清楚介绍用途和使用方法。"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    disabled={starting}
                  />
                </section>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1" role="group" aria-label="画面方向">
                    {RATIOS.map((option) => {
                      const Icon = option.value === "16:9" ? RectangleHorizontal : option.value === "9:16" ? RectangleVertical : Square;
                      return <Button key={option.value} variant="outline" size="sm" aria-label={option.label} aria-pressed={ratio === option.value}
                        disabled={starting} onClick={() => setRatio(option.value)} className={cn(ratio === option.value && "border-foreground/50 bg-accent")}>
                        <Icon className="mr-1.5 h-3.5 w-3.5" />{option.label}<span className="ml-1 text-micro text-muted-foreground">{option.value}</span>
                      </Button>;
                    })}
                  </div>
                  <Button variant="outline" size="sm" disabled={!isTauri() || starting} onClick={() => void handleAddSources()}><FilePlus2 className="mr-1.5 h-3.5 w-3.5" />添加资料</Button>
                </div>
                {sourcePaths.length ? <div className="flex flex-wrap gap-2">
                  {sourcePaths.map((path) => <span key={path} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-caption">
                    <span className="truncate">{path.split(/[\\/]/).pop()}</span><Button variant="ghost" size="icon" className="h-5 w-5" aria-label={`移除 ${path.split(/[\\/]/).pop()}`} onClick={() => setSourcePaths((current) => current.filter((item) => item !== path))}><Trash2 className="h-3 w-3" /></Button>
                  </span>)}
                </div> : null}
                <section className="space-y-3" aria-label="选择视频风格">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3"><h3 className="text-ui font-medium">风格</h3><Tabs value={styleLibraryTab} onValueChange={setStyleLibraryTab}><TabsList><TabsTrigger value="builtin">内置</TabsTrigger><TabsTrigger value="mine">我的</TabsTrigger></TabsList></Tabs></div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" aria-pressed={singleStyleSource === "template" && templateId === "auto"} onClick={() => { setSingleStyleSource("template"); setTemplateId("auto"); }}>由 Mona 推荐</Button>
                      <Button variant="outline" size="sm" onClick={() => { setCreatingBaseStyle(undefined); setConfigSubview("create-series"); }}>创建风格</Button>
                    </div>
                  </div>
                  {styleLibraryTab === "builtin" ? <VideoStyleGallery templates={styleTemplates} showHeader={false} selectedId={singleStyleSource === "template" ? templateId : null} disabled={starting}
                    onSelect={(id) => { setSingleStyleSource("template"); setTemplateId(id); }}
                    onCreateFrom={(style) => { setCreatingBaseStyle(style); setConfigSubview("create-series"); }} /> :
                    <SavedVideoStyleGallery token={token} series={series} selectedId={singleStyleSource === "series" ? styleSeriesId : null} loading={seriesLoading} disabled={seriesUpdating || starting}
                      onSelect={(value) => { handleSelectStyleSeries(value); setSelectedSeries(value); }}
                      onEdit={(value) => { setSelectedSeries(value); setCreatingBaseStyle(undefined); setConfigSubview("style-editor"); }}
                      onCreate={() => { setCreatingBaseStyle(undefined); setConfigSubview("create-series"); }}
                      onCopy={(value) => { void copyVideoStyle(token, value.id).then(async () => { await refreshSeries(); }).catch(() => { void refreshSeries(); setCreateError("风格复制结果暂时无法确认，请刷新列表后查看。"); }); }}
                      onDelete={(value) => { setSeriesDeleteError(null); setSeriesToDelete(value); }}
                      onRename={(value) => { setSeriesToRename(value); setSeriesRenameValue(value.name); }} />}
                  {styleTemplatesError ? <div className="flex items-center gap-2 text-caption text-muted-foreground">风格列表暂时无法读取<Button variant="outline" size="sm" onClick={() => setStyleLoadKey((value) => value + 1)}>重试</Button></div> : null}
                  {seriesError && styleLibraryTab === "mine" ? <p className="text-caption text-destructive">风格加载失败，请重试。</p> : null}
                </section>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMoreSettingsOpen((open) => !open)}
                  aria-expanded={moreSettingsOpen}
                  aria-controls="video-create-settings"
                >
                  <ChevronDown className={cn("mr-1.5 h-4 w-4 transition-transform", moreSettingsOpen && "rotate-180")} />
                  更多设置
                </Button>
                {moreSettingsOpen ? (
                  <div id="video-create-settings" className="space-y-5 border-t border-border/70 pt-4">
                    <section>
                      <label htmlFor="video-name" className="mb-1.5 block text-caption font-medium">视频名称</label>
                      <Input id="video-name" value={draftProjectName} onChange={(event) => setDraftProjectName(event.target.value)} placeholder="留空会根据描述命名" disabled={starting} />
                    </section>
                    <section>
                      <label className="flex items-center gap-2 text-caption font-medium">
                        <Checkbox checked={narrationEnabled} disabled={starting} onCheckedChange={(checked) => setNarrationEnabled(checked === true)} aria-label="配音" />
                        配音
                      </label>
                      {narrationEnabled ? (
                        <div className="mt-3 space-y-3">
                          <label className="block text-caption">声音服务
                            <Select className="mt-1" value={ttsProvider} onValueChange={(value) => { setTtsProvider(value as TtsProvider); setTtsVoice(""); }} options={TTS_PROVIDERS.map((option) => ({ value: option.value, label: option.label }))} aria-label="声音服务" />
                          </label>
                          {ttsProvider === "edge" ? (
                            <div className="text-caption"><span>声音</span>
                              <div className="mt-1 flex items-center gap-2"><Select className="min-w-0 flex-1" value={ttsVoice || "zh-CN-XiaoyiNeural"} onValueChange={setTtsVoice} options={EDGE_TTS_VOICES} aria-label="声音" />
                                <VoicePreviewButton provider={ttsProvider} voice={ttsVoice || "zh-CN-XiaoyiNeural"} rate={ttsRate || "+0%"} disabled={starting} />
                              </div>
                            </div>
                          ) : <div className="flex items-center gap-2"><Input value={ttsVoice} onChange={(event) => setTtsVoice(event.target.value)} placeholder="使用已配置的默认声音" aria-label="声音" /><VoicePreviewButton provider={ttsProvider} voice={ttsVoice} rate={ttsRate || "+0%"} disabled={starting} /></div>}
                          <label className="block text-caption">语速
                            <Select className="mt-1" value={ttsRate || "+0%"} onValueChange={setTtsRate} options={TTS_RATE_OPTIONS.map((rate) => ({ value: rate.value, label: rate.label }))} aria-label="语速" />
                          </label>
                          <label className="block text-caption">字幕
                            <Select className="mt-1" value={subtitleMode} onValueChange={(value) => setSubtitleMode(value as "burned" | "external" | "off")} options={[{ value: "burned", label: "显示在视频中" }, { value: "external", label: "单独保存字幕" }, { value: "off", label: "关闭" }]} aria-label="字幕" />
                          </label>
                        </div>
                      ) : null}
                    </section>
                    <section>
                      <h3 className="mb-1.5 text-caption font-medium">背景音乐</h3>
                      <Select value={musicPreset} onValueChange={(value) => setMusicPreset(value as typeof musicPreset)} options={[{ value: "none", label: "无" }, { value: "ambient", label: "轻背景" }, { value: "rhythmic", label: "有节奏" }, { value: "brand", label: "自选音乐" }]} aria-label="背景音乐" />
                      {musicPreset !== "none" ? (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span className="truncate text-caption text-muted-foreground">{musicFilePath?.split(/[\\/]/).pop() ?? "请选择音乐文件"}</span>
                          <Button variant="outline" size="sm" disabled={!isTauri()} onClick={() => void handlePickMusic()}><Music2 className="mr-1.5 h-3.5 w-3.5" />选择音乐</Button>
                        </div>
                      ) : null}
                    </section>
                  </div>
                ) : null}
                {createError ? <p className="text-caption text-destructive" role="alert">{createError}</p> : null}
              </div>
            </div>
              <div className="shrink-0 border-t border-border/70 px-4 py-2">
                <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
                {videoSession ? <VideoModelControl token={token} value={videoModel.binding} onChange={changeVideoModel} disabled={starting} loading={videoModel.loading} error={videoModel.error} onRetry={videoModel.reload} /> : null}
                <Button
                  size="sm"
                  disabled={sessionUnavailable || starting || videoModel.loading || videoModel.saving || Boolean(videoModel.error) || (!topic.trim() && sourcePaths.length === 0) || (singleStyleSource === "series" && !selectedStyleSeries) || (musicPreset !== "none" && !musicFilePath)}
                  onClick={() => void handleStartGeneration()}
                >
                  {starting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Clapperboard className="mr-1.5 h-4 w-4" />}
                  {starting ? "正在准备…" : "准备分镜"}
                </Button>
                </div>
              </div>
            </div>
          ) : workspaceView === "director" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <VideoWorkbenchHeader projectName={projectName ?? ""} activeView="director"
                previewAvailable={!requiresApproval || approvedRevision !== null && approvedRevision === currentPlanRevision}
                onViewChange={(view) => leaveStoryboardWhenSaved(() => setWorkspaceView(view))}>
                  {videoSession ? <VideoModelControl token={token} value={videoModel.binding} onChange={changeVideoModel} disabled={isChatRunning || hostIsStreaming || confirming} loading={videoModel.loading} error={videoModel.error} onRetry={videoModel.reload} /> : null}
                  <Button variant="ghost" size="sm" onClick={() => { setNarrationSettingsError(null); setNarrationSettingsOpen(true); }} disabled={isChatRunning || hostIsStreaming}>声音与字幕</Button>
              </VideoWorkbenchHeader>
              {isChatRunning || hostIsStreaming ? (
                <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-2 text-caption text-muted-foreground" role="status">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{agentActivity ?? (approvedRevision !== null && approvedRevision === currentPlanRevision ? "Mona 正在制作视频，这里是已确认的方案。" : "Mona 正在准备旁白和动画方案，完成后请在这里确认。")}</span>
                  {agentStartedAt !== null ? <span>已用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</span> : null}
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <StoryboardPhase
                  key={projectName}
                  projectName={projectName ?? ""}
                  refreshTrigger={aiTurnComplete}
                  onSaveFlushReady={registerStoryboardFlush}
                  onPlanChange={handlePlanChange}
                  onPlanEdited={handlePlanEdited}
                  onFocusChange={handleFocusChange}
                  readOnly={approvedRevision !== null && approvedRevision === currentPlanRevision}
                  busy={isChatRunning || hostIsStreaming || confirming}
                  chatPanel={embedded ? undefined : <DocChatPanel chatId={chatId} disabled={sessionUnavailable} getSendOptions={() => ({ ...(videoSession ? { agentKind: "video" as const } : {}), quote: videoFocusQuote(focusRef.current) })} onStreamingChange={handleStreamingChange} placeholder="告诉 Mona 分镜和动画要怎么调整…" />}
                />
              </div>
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 px-4 py-1.5">
                <div className="min-w-0 text-caption text-muted-foreground">
                  {generationError ? <span className="text-destructive">{generationError}</span> : planDetails.sceneCount ? approvedRevision !== null && approvedRevision === currentPlanRevision ? `${planDetails.sceneCount} 段 · ${planDetails.duration} 秒，可在对话中告诉 Mona 要改哪里。` : `${planDetails.sceneCount} 段 · 预计 ${planDetails.duration} 秒，修改会自动保存。` : "方案准备好后，会显示旁白和对应的动画安排。"}
                </div>
                {planDetails.sceneCount === 0 || generationError ? <Button variant="outline" size="sm" onClick={handleRetryStoryboardGeneration} disabled={sessionUnavailable || isChatRunning || hostIsStreaming || starting}>继续准备分镜</Button> : null}
                {approvedRevision !== null && approvedRevision === currentPlanRevision ? null : <Button size="sm" disabled={sessionUnavailable || isChatRunning || hostIsStreaming || confirming || planDetails.sceneCount === 0 || planDetails.planRevision === null} onClick={() => void handleConfirmPlan()}>
                  {confirming ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Clapperboard className="mr-1.5 h-4 w-4" />}
                  {confirming ? "正在开始…" : "确认并生成"}
                </Button>}
              </div>
            </div>
          ) : (
            <ProducingPhase
              projectName={projectName ?? ""}
              modelControl={videoSession ? <VideoModelControl token={token} value={videoModel.binding} onChange={changeVideoModel} disabled={isChatRunning || hostIsStreaming} loading={videoModel.loading} error={videoModel.error} onRetry={videoModel.reload} /> : undefined}
              onPhaseChange={handleProjectPhaseChange}
              onRequestAgent={handleRequestAgent}
              onFocusChange={handleFocusChange}
              agentRunning={isChatRunning || hostIsStreaming}
              agentActivity={agentActivity}
              agentStartedAt={agentStartedAt}
              onOpenChat={onOpenChat}
              refreshTrigger={aiTurnComplete}
              generationError={generationError}
              onRetryGeneration={handleContinueProduction}
              onEditContent={(section) => { if (section === "assets") setContentOpen(true); else setWorkspaceView("director"); }}
              chatPanel={embedded ? undefined : (
                <DocChatPanel chatId={chatId} disabled={sessionUnavailable} getSendOptions={() => ({ ...(videoSession ? { agentKind: "video" as const } : {}), quote: videoFocusQuote(focusRef.current) })} onStreamingChange={handleStreamingChange} placeholder="告诉 Mona 你想调整哪里…" />
              )}
            />
          )}
        </div>
      </div>

      <Dialog open={contentOpen} onOpenChange={(open) => {
        if (open) setContentOpen(true);
        else leaveStoryboardWhenSaved(() => setContentOpen(false));
      }}>
        <DialogContent className="flex h-[80vh] max-w-5xl flex-col" showCloseButton={!leavingStoryboard}>
          <DialogHeader>
            <DialogTitle>视频素材</DialogTitle>
            <DialogDescription>添加自己的图片、视频或声音，让 Mona 在制作中使用。</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1">
            {projectName ? <StoryboardPhase projectName={projectName} section="assets" refreshTrigger={aiTurnComplete} /> : null}
          </div>
          <DialogFooter><Button disabled={leavingStoryboard} onClick={() => leaveStoryboardWhenSaved(() => setContentOpen(false))}>{leavingStoryboard ? "保存中…" : "返回视频"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <VideoNarrationSettingsDialog open={narrationSettingsOpen} value={projectSettings} saving={narrationSettingsSaving} error={narrationSettingsError} onOpenChange={setNarrationSettingsOpen} onSave={handleSaveNarrationSettings} />
      <Dialog open={confirmationError !== null} onOpenChange={(open) => { if (!open) setConfirmationError(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>视频生成尚未开始</DialogTitle><DialogDescription>{confirmationError}</DialogDescription></DialogHeader>
          <DialogFooter><Button onClick={() => setConfirmationError(null)}>返回导演台</Button></DialogFooter>
        </DialogContent>
      </Dialog>

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
            <DialogTitle>重命名风格</DialogTitle>
            <DialogDescription>
              修改风格名称，不影响已有视频。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={seriesRenameValue}
            onChange={(event) => setSeriesRenameValue(event.target.value)}
            aria-label="风格新名称"
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
            <DialogTitle>删除风格“{seriesToDelete?.name}”？</DialogTitle>
            <DialogDescription>
              {(seriesToDelete?.episodeCount ?? 0) > 0
                ? `已有 ${seriesToDelete?.episodeCount} 个视频使用这个风格。删除后，这些视频仍会保留。`
                : "删除后，这个风格将无法恢复。"}
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
                ? "删除风格，保留视频"
                : "删除风格"}
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
  styleName?: string;
  narrationEnabled: boolean;
  sourceCount: number;
  hasMusic: boolean;
}): string {
  return [
    `请为视频「${opts.name}」准备分镜方案。`,
    `我的要求：${opts.topic.trim() || "请根据提供的资料制作视频。"}`,
    `画面：${RATIOS.find((option) => option.value === opts.ratio)?.label ?? "横屏"}。`,
    opts.styleName ? `使用风格：${opts.styleName}` : "",
    opts.narrationEnabled ? "配音已开启，请使用项目中保存的声音与字幕设置。" : "配音未开启。",
    opts.sourceCount ? `已添加 ${opts.sourceCount} 份资料，请阅读。` : "",
    opts.hasMusic ? "请使用已添加的背景音乐。" : "",
    "先阅读资料，设计完整口播内容及对应动画：每段包括标题、时长、旁白、画面内容、画面如何随口播展开或变化。用 video.plan 保存方案。",
    "本轮只准备方案，不编写场景源码、不生成图片或配音、不渲染或导出视频。保存后停下，等待用户在导演台确认。",
  ].filter(Boolean).join("\n");
}

function buildVideoResumePrompt(projectName: string): string {
  return [
    `请继续准备视频「${projectName}」的分镜方案。`,
    "先检查已有方案，完善口播及对应的动画设计，并用 video.plan 保存。只准备方案，不写场景源码、不生成配音或视频。等待用户在导演台确认。",
  ].join("\n");
}

function buildVideoProductionPrompt(planRevision: number | null): string {
  return [
    planRevision === null ? "请继续制作已有视频。" : `我已在导演台确认分镜方案，修订号 ${planRevision}，现在开始生成。`,
    "先用 video.inspect 核对当前已确认方案，保持旁白、时长和动画意图；如果方案已变化，先停下等待重新确认。",
    "制作与口播内容逐句对应的视频动画：设计动作、节奏、视觉关系及镜头变化，不能以静态 PPT 页面切换代替。",
    "使用 Remotion React 场景，源码写入 drafts/scene_NN.tsx，用 video.sync 同步；准备旁白时间后按实际口播调整动画，逐场预览检查并改进，完成视频。",
  ].join("\n");
}
