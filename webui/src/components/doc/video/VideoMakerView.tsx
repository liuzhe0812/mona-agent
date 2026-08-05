import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderOpen, History, MoreHorizontal, Play, SlidersHorizontal, Trash2, Volume2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import {
  buildVideoDownloadUrl,
  createVideoProject,
  deleteVideoProject,
  downloadVideoRuntime,
  fetchVideoProject,
  fetchVideoProjects,
  fetchVideoRuntimeCheck,
  getApiBase,
  saveVideoChatId,
  type VideoProject,
  type VideoProjectPhase,
  type VideoRuntimeStatus,
} from "@/lib/api";
import { downloadMediaUrl, isTauri, openPathWithSystemApp } from "@/lib/tauri";
import { EDGE_TTS_VOICES } from "@/lib/constants";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";
import { DocChatPanel } from "../DocChatPanel";
import { StoryboardPhase } from "./StoryboardPhase";
import { ProducingPhase } from "./ProducingPhase";
import { VideoRuntimeDialog, type RuntimeDepKey } from "./VideoRuntimeDialog";

type SidebarTab = "config" | "history";
type VideoPhase = "config" | "storyboard" | "producing";
type VideoRatio = "16:9" | "9:16" | "1:1";
type TtsProvider = "edge" | "custom";

const RATIOS: Array<{ value: VideoRatio; label: string; resolution: string }> = [
  { value: "16:9", label: "横屏", resolution: "1920×1080" },
  { value: "9:16", label: "竖屏", resolution: "1080×1920" },
  { value: "1:1", label: "方形", resolution: "1080×1080" },
];

const TTS_PROVIDERS: Array<{ value: TtsProvider; label: string; hint: string }> = [
  { value: "edge", label: "Edge", hint: "免费" },
  { value: "custom", label: "自定义", hint: "使用设置页的全局语音合成配置" },
];

const PHASE_LABELS: Record<VideoProjectPhase, string> = {
  storyboard: "分镜中",
  producing: "制作中",
  exportable: "待导出",
  rendering: "导出中",
  done: "已完成",
};

const CUSTOM_VOICE_PLACEHOLDER = "alloy";

const RATIO_RESOLUTION_MAP: Record<VideoRatio, string> = {
  "16:9": "1920x1080",
  "9:16": "1080x1920",
  "1:1": "1080x1080",
};

const DEFAULT_RUNTIME_STATUS: VideoRuntimeStatus = {
  node: { ok: false },
  ffmpeg: { ok: false },
  chrome: { ok: false },
};

// Only the most-recent project name is persisted locally. The authoritative
// phase always comes from the server — never restore a stale local phase.
const ACTIVE_PROJECT_KEY = "mona.video.activeProject";

export function VideoMakerView() {
  const { client, token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("config");
  const [topic, setTopic] = useState("");
  const [ratio, setRatio] = useState<VideoRatio>("16:9");
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("edge");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsRate, setTtsRate] = useState("");
  const [phase, setPhase] = useState<VideoPhase>("config");
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const [historyProjects, setHistoryProjects] = useState<VideoProject[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<VideoRuntimeStatus>(DEFAULT_RUNTIME_STATUS);
  const [runtimeOk, setRuntimeOk] = useState(true);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [installing, setInstalling] = useState<RuntimeDepKey | null>(null);
  const [installErrors, setInstallErrors] = useState<Partial<Record<RuntimeDepKey, string>>>({});
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const generatingRef = useRef(false);
  // Incremented when AI finishes a reply (streaming → false) to trigger storyboard refresh
  const [aiTurnComplete, setAiTurnComplete] = useState(0);
  const wasStreamingRef = useRef(false);

  // Auto-switch to history tab when a project is active
  useEffect(() => {
    if (projectName) {
      setSidebarTab("history");
    }
  }, [projectName]);

  // Passive runtime status check — only drives the hint banner. Storyboard
  // generation does not depend on FFmpeg/Chrome, so this never blocks creation.
  useEffect(() => {
    let cancelled = false;
    fetchVideoRuntimeCheck(token)
      .then((status) => {
        if (cancelled) return;
        setRuntimeStatus(status);
        setRuntimeOk(status.node.ok && status.ffmpeg.ok && status.chrome.ok);
      })
      .catch(() => {
        // ignore — default to ok to avoid blocking on errors
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Load history projects when history tab is opened
  useEffect(() => {
    if (sidebarTab !== "history") return;
    let cancelled = false;
    fetchVideoProjects(token)
      .then((res) => {
        if (!cancelled) setHistoryProjects(res.projects ?? []);
      })
      .catch(() => {
        if (!cancelled) setHistoryProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarTab, token]);

  // Poll project status during storyboard phase (AI is generating storyboard.md)
  useEffect(() => {
    if (phase !== "storyboard" || !projectName) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetchVideoProject(token, projectName!);
        if (cancelled) return;
        if (res.hasStoryboard) {
          // Storyboard is ready — StoryboardPhase will load and display it
          return;
        }
      } catch {
        // ignore transient errors
      }
      if (!cancelled) {
        timer = setTimeout(poll, 2000);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, projectName, token]);

  const refreshRuntimeStatus = useCallback(async (): Promise<boolean> => {
    try {
      const status = await fetchVideoRuntimeCheck(token);
      setRuntimeStatus(status);
      const ok = status.node.ok && status.ffmpeg.ok && status.chrome.ok;
      setRuntimeOk(ok);
      return ok;
    } catch {
      return true;
    }
  }, [token]);

  const handleInstallRuntime = useCallback(
    async (component?: RuntimeDepKey) => {
      const targets: RuntimeDepKey[] = component
        ? [component]
        : (["node", "ffmpeg", "chrome"] as RuntimeDepKey[]).filter(
            (k) => !runtimeStatus[k].ok,
          );
      if (targets.length === 0) return;

      for (const dep of targets) {
        setInstalling(dep);
        setInstallErrors((prev) => {
          const next = { ...prev };
          delete next[dep];
          return next;
        });
        try {
          const res = await downloadVideoRuntime(token, dep);
          if (!res.ok) {
            setInstallErrors((prev) => ({
              ...prev,
              [dep]: res.error || "安装失败",
            }));
          }
        } catch (e) {
          setInstallErrors((prev) => ({ ...prev, [dep]: String(e) }));
        }
      }

      setInstalling(null);
      await refreshRuntimeStatus();
    },
    [runtimeStatus, token, refreshRuntimeStatus],
  );

  const handleStartGeneration = useCallback(async () => {
    if (generatingRef.current) return;
    setCreateError(null);
    generatingRef.current = true;
    try {
      const name = generateProjectName(topic);
      setProjectName(name);
      const resolution = RATIO_RESOLUTION_MAP[ratio];
      const ttsConfig = narrationEnabled
        ? {
            narrationEnabled: true,
            ttsProvider,
            ttsVoice: ttsVoice.trim(),
            ttsRate: ttsRate.trim(),
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
            }
          : undefined,
      });
      const displayText = topic.trim() || "请生成视频。";
      // 1. Create project
      const created = await createVideoProject(token, name, resolution, ttsConfig);
      if (!created.ok) {
        throw new Error(created.error || "创建项目失败");
      }
      // 2. Create session
      const newChatId = await client.newChat(5_000, false, null, "video");
      setChatId(newChatId);
      // 3. Save chat_id
      await saveVideoChatId(token, name, newChatId);
      // 4. Send prompt
      client.sendMessage(newChatId, prompt, undefined, { displayContent: displayText });
      setPhase("storyboard");
    } catch (e) {
      console.error("Failed to start video generation", e);
      setProjectName(null);
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      generatingRef.current = false;
    }
  }, [
    client,
    topic,
    ratio,
    narrationEnabled,
    ttsProvider,
    ttsVoice,
    ttsRate,
    token,
  ]);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!chatId) return;
      client.sendMessage(chatId, content);
    },
    [chatId, client],
  );

  // Detect AI turn completion: streaming transitions from true → false.
  // This is more reliable than polling storyboard.md — the AI has finished
  // its reply (and any tool calls), so any storyboard.md it wrote is now on disk.
  const handleStreamingChange = useCallback((streaming: boolean) => {
    if (wasStreamingRef.current && !streaming) {
      // AI just finished a reply — trigger storyboard refresh
      setAiTurnComplete((n) => n + 1);
    }
    wasStreamingRef.current = streaming;
  }, []);

  const handleSelectHistory = useCallback(
    (project: VideoProject) => {
      setProjectName(project.name);
      setChatId(project.chatId);
      // Route by the server-recorded phase: storyboard → 分镜页,其他均进入制作页
      setPhase(project.phase === "storyboard" ? "storyboard" : "producing");
    },
    [],
  );

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
    let cancelled = false;
    try {
      const savedName = localStorage.getItem(ACTIVE_PROJECT_KEY);
      if (!savedName) return;
      fetchVideoProjects(token)
        .then((res) => {
          if (cancelled) return;
          const project = res.projects?.find((p) => p.name === savedName);
          if (project) {
            handleSelectHistory(project);
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
  }, []);

  const handleDownloadVideo = useCallback(
    async (name: string) => {
      setHistoryError(null);
      try {
        const base = await getApiBase();
        const url = buildVideoDownloadUrl(base, token, name);
        await downloadMediaUrl(url, `${name}.mp4`);
      } catch (e) {
        console.error("Video download failed", e);
        setHistoryError(`下载失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [token],
  );

  const handleOpenProjectDir = useCallback(
    async (name: string) => {
      if (!isTauri() || !workspacePath) return;
      const dirPath = `${workspacePath}/video_projects/${name}`;
      try {
        await openPathWithSystemApp(dirPath);
      } catch (e) {
        console.error("Failed to open project directory", e);
        setHistoryError(`打开目录失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [workspacePath],
  );

  const handleDeleteProject = useCallback(
    async (name: string) => {
      if (deleting) return;
      setDeleting(name);
      setHistoryError(null);
      try {
        await deleteVideoProject(token, name);
        setHistoryProjects((prev) => prev.filter((p) => p.name !== name));
        if (name === projectName) {
          setPhase("config");
          setChatId(null);
          setProjectName(null);
        }
      } catch (e) {
        console.error("Failed to delete video project", e);
        setHistoryError(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setDeleting(null);
      }
    },
    [deleting, token, projectName],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {/* 左侧:新建 / 历史 */}
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-border/70">
          <div className="flex shrink-0 border-b border-border/70" role="tablist">
            <button
              role="tab"
              aria-selected={sidebarTab === "config"}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-2 text-[12px] font-medium transition-colors",
                sidebarTab === "config"
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSidebarTab("config")}
            >
              <SlidersHorizontal className="h-3 w-3" />
              新建
            </button>
            <button
              role="tab"
              aria-selected={sidebarTab === "history"}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-2 text-[12px] font-medium transition-colors",
                sidebarTab === "history"
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSidebarTab("history")}
            >
              <History className="h-3 w-3" />
              历史
            </button>
          </div>

          <div className="min-h-0 flex-1">
            {sidebarTab === "config" ? (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-3">
                  <section>
                    <h3 className="mb-1.5 text-[12px] font-medium text-foreground">
                      画面比例
                    </h3>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                      {RATIOS.map((r) => (
                        <button
                          key={r.value}
                          type="button"
                          title={r.resolution}
                          aria-pressed={ratio === r.value}
                          className={cn(
                            "rounded-md px-1.5 py-1 text-[12px] font-medium transition-all",
                            ratio === r.value
                              ? "bg-background text-foreground shadow"
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
                      <h3 className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                        <Volume2 className="h-3 w-3" />
                        旁白配音
                      </h3>
                      <button
                        type="button"
                        aria-pressed={narrationEnabled}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[12px] font-medium transition-colors",
                          narrationEnabled
                            ? "bg-primary/10 text-foreground"
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
                          <div className="mb-1 text-[11px] text-muted-foreground">
                            TTS 供应商
                          </div>
                          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                            {TTS_PROVIDERS.map((p) => (
                              <button
                                key={p.value}
                                type="button"
                                title={p.hint}
                                aria-pressed={ttsProvider === p.value}
                                className={cn(
                                  "rounded-md px-1 py-1 text-[12px] font-medium transition-all",
                                  ttsProvider === p.value
                                    ? "bg-background text-foreground shadow"
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
                            <div className="mb-1 text-[11px] text-muted-foreground">
                              音色
                            </div>
                            <select
                              aria-label="Edge 音色"
                              className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[12px] outline-none focus:border-primary"
                              value={
                                EDGE_TTS_VOICES.some((v) => v.value === ttsVoice)
                                  ? ttsVoice
                                  : ttsVoice
                                    ? "__custom__"
                                    : ""
                              }
                              onChange={(e) => {
                                const v = e.target.value;
                                if (v === "__custom__") {
                                  setTtsVoice("");
                                } else {
                                  setTtsVoice(v);
                                }
                              }}
                            >
                              <option value="">选择音色...</option>
                              {EDGE_TTS_VOICES.map((v) => (
                                <option key={v.value} value={v.value}>
                                  {v.label}
                                </option>
                              ))}
                              <option value="__custom__">自定义 ID...</option>
                            </select>
                            {(!EDGE_TTS_VOICES.some((v) => v.value === ttsVoice) || ttsVoice === "") && (
                              <Input
                                value={ttsVoice}
                                onChange={(e) => setTtsVoice(e.target.value)}
                                placeholder="zh-CN-XiaoyiNeural"
                                aria-label="自定义音色 ID"
                                className="mt-1.5 h-8 rounded-lg text-[12px]"
                              />
                            )}
                          </div>
                        ) : (
                          <div>
                            <div className="mb-1 text-[11px] text-muted-foreground">
                              Voice ID
                            </div>
                            <Input
                              value={ttsVoice}
                              onChange={(e) => setTtsVoice(e.target.value)}
                              placeholder={CUSTOM_VOICE_PLACEHOLDER}
                              aria-label="自定义 TTS Voice ID"
                              className="h-8 rounded-lg text-[12px]"
                            />
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              API 凭据使用「设置 → 语音合成」中的全局配置。
                            </div>
                          </div>
                        )}

                        <div>
                          <div className="mb-1 text-[11px] text-muted-foreground">
                            语速
                          </div>
                          <Input
                            value={ttsRate}
                            onChange={(e) => setTtsRate(e.target.value)}
                            placeholder="+0%"
                            aria-label="语速"
                            className="h-8 rounded-lg text-[12px]"
                          />
                        </div>
                      </div>
                    ) : null}
                  </section>

                  {!runtimeOk ? (
                    <button
                      type="button"
                      onClick={() => setRuntimeDialogOpen(true)}
                      className="flex w-full items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[12px] font-normal text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Play className="h-3.5 w-3.5 shrink-0" />
                      <span>视频依赖未安装,点击此处下载</span>
                    </button>
                  ) : null}
                </div>

                <div className="shrink-0 space-y-2 border-t border-border/70 p-3">
                  <div>
                    <h3 className="mb-1.5 text-[12px] font-medium text-foreground">
                      视频主题
                    </h3>
                    <Textarea
                      className="min-h-[80px] resize-none text-[12px]"
                      placeholder="描述你想制作的视频内容..."
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                    />
                  </div>
                  {createError ? (
                    <div
                      className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[12px] text-destructive"
                      role="alert"
                    >
                      <span className="min-w-0 flex-1 break-words">{createError}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-[12px] text-destructive hover:text-destructive"
                        onClick={() => void handleStartGeneration()}
                        disabled={!topic.trim()}
                      >
                        重试
                      </Button>
                    </div>
                  ) : null}
                  <Button
                    className="w-full"
                    disabled={!topic.trim()}
                    onClick={handleStartGeneration}
                  >
                    <Play className="mr-1.5 h-4 w-4" />
                    开始生成
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {historyError ? (
                  <div className="shrink-0 px-2 pt-2" role="alert">
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[12px] text-destructive">
                      {historyError}
                    </div>
                  </div>
                ) : null}
                {historyProjects.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
                    暂无历史项目
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2">
                    {historyProjects.map((p) => (
                      <div
                        key={p.name}
                        className={cn(
                          "group mb-1.5 flex items-center rounded-lg border border-border/60 transition-colors hover:bg-accent",
                          p.name === projectName ? "border-primary bg-accent" : "",
                        )}
                      >
                        <button
                          className="min-w-0 flex-1 px-2.5 py-2 text-left"
                          onClick={() => handleSelectHistory(p)}
                        >
                          <div className="truncate text-[12px] font-medium">
                            {p.name}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {p.resolution} · {PHASE_LABELS[p.phase] ?? p.phase}
                            {p.outputStale ? " · 内容已变化" : ""}
                          </div>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="mr-1 h-7 w-7 shrink-0"
                              aria-label={`项目 ${p.name} 更多操作`}
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent className="w-40" align="end">
                            {p.hasVideo && !p.outputStale ? (
                              <DropdownMenuItem
                                onClick={() => void handleDownloadVideo(p.name)}
                                className="text-[12px]"
                              >
                                <Download className="mr-2 h-3.5 w-3.5" />
                                下载 MP4
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              onClick={() => void handleOpenProjectDir(p.name)}
                              className="text-[12px]"
                            >
                              <FolderOpen className="mr-2 h-3.5 w-3.5" />
                              打开任务目录
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(p.name)}
                              disabled={deleting === p.name}
                              className="text-[12px] text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              {deleting === p.name ? "删除中..." : "删除项目"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* 右侧:预览 + 聊天(上下分割) */}
        <div className="flex min-h-0 flex-1 flex-col">
          {phase === "config" ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              输入主题后开始生成视频
            </div>
          ) : phase === "storyboard" ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <StoryboardPhase
                  projectName={projectName ?? ""}
                  onLocked={() => setPhase("producing")}
                  refreshTrigger={aiTurnComplete}
                />
              </div>
              <div className="w-[400px] shrink-0 border-l border-border/70">
                <DocChatPanel
                  chatId={chatId}
                  onSend={handleSendMessage}
                  onStreamingChange={handleStreamingChange}
                  placeholder="与视频助手对话调整分镜..."
                />
              </div>
            </div>
          ) : phase === "producing" ? (
            <ProducingPhase projectName={projectName ?? ""} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              未知状态
            </div>
          )}
        </div>
      </div>

      <VideoRuntimeDialog
        open={runtimeDialogOpen}
        onClose={() => setRuntimeDialogOpen(false)}
        runtimeStatus={runtimeStatus}
        installing={installing}
        installErrors={installErrors}
        onInstall={(component) => void handleInstallRuntime(component)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && deleting === null) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除项目「{deleteTarget}」吗？项目目录及其全部分镜、预览和导出结果将被删除，此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const name = deleteTarget;
                setDeleteTarget(null);
                if (name) void handleDeleteProject(name);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function generateProjectName(topic: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);

  const raw = topic.trim();
  if (!raw) {
    return `video-${ts}-${rand}`;
  }

  // 基于主题生成语义化目录名：保留中英文/数字/空格/连字符，空格转连字符，限制长度
  const slug = raw
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  if (!slug) {
    return `video-${ts}-${rand}`;
  }
  return `${slug}-${ts}-${rand}`;
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
  };
}): string {
  const parts: string[] = [];
  parts.push("请生成一段视频。");
  parts.push(`项目名：${opts.name}`);
  parts.push(`项目目录：video_projects/${opts.name}`);
  parts.push(`分辨率：${opts.resolution}`);
  parts.push(`画面比例：${opts.ratio}`);
  if (opts.narration) {
    parts.push(`旁白：启用`);
    parts.push(`TTS供应商：${opts.narration.provider}`);
    parts.push(
      `音色：${opts.narration.voice || (opts.narration.provider === "custom" ? CUSTOM_VOICE_PLACEHOLDER : "zh-CN-XiaoyiNeural")}（留空用默认）`,
    );
    parts.push(`语速：${opts.narration.rate || "+0%"}（留空用默认）`);
  } else {
    parts.push(`旁白：未启用`);
  }
  if (opts.topic.trim()) {
    parts.push(`主题：${opts.topic.trim()}`);
  }
  parts.push("");
  parts.push("请按照 mona-video SKILL 的流程执行 Step 1-4：源文件分析 → 项目初始化 → 内容分析 → 生成分镜草稿（storyboard.md）。");
  if (opts.narration) {
    parts.push(
      "每个场景的 storyboard.md 必须包含 - Narration: <纯文本> 字段，文本字数应与 Duration 匹配（中文约 4 字/秒）。",
    );
  }
  parts.push("");
  parts.push("重要：生成分镜草稿后必须停止。告知用户\"分镜草稿已就绪，请在右侧分镜审阅界面编辑确认\"，然后等待用户操作。");
  parts.push("- 不要主动写 storyboard_lock.md");
  parts.push("- 不要主动进入 Step 5 编写 HTML");
  parts.push("- 不要主动调用任何渲染脚本");
  parts.push("用户会在 UI 上编辑/增删/重排场景，确认后系统会自动解锁后续步骤。");
  return parts.join("\n");
}
