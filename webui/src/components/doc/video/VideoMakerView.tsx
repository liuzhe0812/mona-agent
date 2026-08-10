import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clapperboard, PanelLeft, PanelLeftClose, Play, Plus, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useClient } from "@/providers/ClientProvider";
import {
  createVideoProject,
  downloadVideoRuntime,
  fetchVideoProject,
  fetchVideoProjects,
  fetchVideoRuntimeCheck,
  saveVideoChatId,
  type VideoProject,
  type VideoProjectPhase,
  type VideoRuntimeStatus,
} from "@/lib/api";
import { EDGE_TTS_VOICES } from "@/lib/constants";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { cn } from "@/lib/utils";
import { DocChatPanel } from "../DocChatPanel";
import { StoryboardPhase } from "./StoryboardPhase";
import { ProducingPhase } from "./ProducingPhase";
import { VideoHistory } from "./VideoHistory";
import { VideoRuntimeDialog, type RuntimeDepKey } from "./VideoRuntimeDialog";

type VideoPhase = "config" | VideoProjectPhase;
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

function getStepStatus(
  stepIndex: number,
  currentPhase: VideoPhase,
): "completed" | "current" | "pending" {
  const currentStepIndex = STEPS.findIndex((s) => s.phases.includes(currentPhase));
  if (currentStepIndex === -1) return "pending";
  if (stepIndex < currentStepIndex) return "completed";
  if (stepIndex === currentStepIndex) return "current";
  return "pending";
}

export function VideoMakerView() {
  const { client, token } = useClient();
  const bp = useBreakpoint();
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

  const [runtimeStatus, setRuntimeStatus] = useState<VideoRuntimeStatus>(DEFAULT_RUNTIME_STATUS);
  const [runtimeOk, setRuntimeOk] = useState(true);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [installing, setInstalling] = useState<RuntimeDepKey | null>(null);
  const [installErrors, setInstallErrors] = useState<Partial<Record<RuntimeDepKey, string>>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const generatingRef = useRef(false);
  // Incremented when AI finishes a reply (streaming → false) to trigger storyboard refresh
  const [aiTurnComplete, setAiTurnComplete] = useState(0);
  const wasStreamingRef = useRef(false);

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

  // 初始化侧边栏折叠状态与宽度（从 localStorage 读取）
  useEffect(() => {
    try {
      const collapsedRaw = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      const widthRaw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (collapsedRaw === "true") setSidebarCollapsed(true);
      if (widthRaw) {
        const w = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parseInt(widthRaw, 10)));
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

  const handleSelectProject = useCallback((project: VideoProject) => {
    setProjectName(project.name);
    setChatId(project.chatId);
    // Route by the server-recorded phase: storyboard → 分镜页,其他均进入制作页
    setPhase(project.phase);
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
    setProjectName(null);
    setChatId(null);
    setCreateError(null);
    try {
      localStorage.removeItem(ACTIVE_PROJECT_KEY);
    } catch {}
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
  }, []);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        const next = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta));
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
        {sidebarCollapsed ? (
          <TooltipProvider delayDuration={100}>
            <div className="flex w-12 shrink-0 flex-col items-center border-r border-border/70 bg-muted/30 py-3">
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
            className="relative flex shrink-0 flex-col border-r border-border/70 bg-muted/30"
            style={{ width: sidebarWidth }}
          >
            {/* 顶部标题栏：模块标识 + 收起按钮 */}
            <div className="flex shrink-0 items-center justify-between border-b border-border/70 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Clapperboard className="h-3.5 w-3.5" />
                </div>
                <span className="text-[13px] font-semibold text-foreground">视频</span>
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
                className="h-9 w-full gap-1.5 text-[13px]"
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
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {/* 步骤条 */}
          <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border/70 bg-background px-4 py-3">
            {STEPS.map((step, i) => {
              const status = getStepStatus(i, phase);
              return (
                <div key={step.label} className="flex items-center">
                  {i > 0 && (
                    <div
                      className={cn(
                        "mx-2 h-px w-5",
                        getStepStatus(i - 1, phase) !== "pending" ? "bg-primary/40" : "bg-border",
                      )}
                    />
                  )}
                  <div className="flex items-center gap-1.5">
                    <div
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
                        status === "completed" && "bg-emerald-500/15 text-emerald-600",
                        status === "current" && "bg-primary text-primary-foreground",
                        status === "pending" && "border border-border bg-background text-muted-foreground",
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
                        "text-[11px] font-medium",
                        status === "completed" && "text-muted-foreground",
                        status === "current" && "text-foreground",
                        status === "pending" && "text-muted-foreground/50",
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {phase === "config" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scrollbar-hover px-4 py-8">
              <div className="w-full max-w-[560px]">
                <h2 className="mb-6 text-lg font-medium">新建视频</h2>

                {!runtimeOk ? (
                  <button
                    type="button"
                    onClick={() => setRuntimeDialogOpen(true)}
                    className="mb-4 flex w-full items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] font-normal text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Play className="h-3.5 w-3.5 shrink-0" />
                    <span>视频依赖未安装，点击此处下载</span>
                  </button>
                ) : null}

                <div className="space-y-5">
                  <section>
                    <h3 className="mb-1.5 text-[13px] font-medium text-foreground">
                      视频主题
                    </h3>
                    <Textarea
                      className="min-h-[96px] resize-none text-[13px]"
                      placeholder="描述你想制作的视频内容..."
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                    />
                  </section>

                  <section>
                    <h3 className="mb-1.5 text-[13px] font-medium text-foreground">
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
                            "rounded-md px-1.5 py-1.5 text-[13px] font-medium transition-all",
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
                      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                        <Volume2 className="h-3.5 w-3.5" />
                        旁白配音
                      </h3>
                      <button
                        type="button"
                        aria-pressed={narrationEnabled}
                        className={cn(
                          "rounded-full px-2.5 py-0.5 text-[12px] font-medium transition-colors",
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
                                  "rounded-md px-1 py-1.5 text-[13px] font-medium transition-all",
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
                              className="w-full rounded-lg border border-border/70 bg-transparent px-3 py-1.5 text-[13px] outline-none focus:border-primary"
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
                                className="mt-1.5"
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
                          />
                        </div>
                      </div>
                    ) : null}
                  </section>

                  {createError ? (
                    <div
                      className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
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
                    className="h-9 w-full gap-1.5 text-[13px]"
                    disabled={!topic.trim()}
                    onClick={handleStartGeneration}
                  >
                    <Play className="h-4 w-4" />
                    开始生成
                  </Button>
                </div>
              </div>
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
          ) : (
            <ProducingPhase
              projectName={projectName ?? ""}
              onPhaseChange={handleProjectPhaseChange}
            />
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
    return `${ts}-${rand}`;
  }

  const slug = raw
    .toLowerCase()
    .replace(/[^\w一-龥\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  if (!slug) {
    return `${ts}-${rand}`;
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
