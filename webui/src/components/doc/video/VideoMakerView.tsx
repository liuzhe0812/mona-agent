import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderOpen, History, Play, SlidersHorizontal, Trash2, Volume2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
  type VideoRuntimeStatus,
} from "@/lib/api";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";
import { DocChatPanel } from "../DocChatPanel";
import { VideoPreview } from "./VideoPreview";
import { VideoRuntimeDialog } from "./VideoRuntimeDialog";

type SidebarTab = "config" | "history";
type VideoPhase = "config" | "generating" | "done";
type VideoRatio = "16:9" | "9:16" | "1:1";
type VideoFps = 30 | 60;
type VideoQuality = "draft" | "standard" | "high";
type TtsProvider = "edge" | "minimax" | "cosyvoice";

const RATIOS: Array<{ value: VideoRatio; label: string; resolution: string }> = [
  { value: "16:9", label: "横屏", resolution: "1920×1080" },
  { value: "9:16", label: "竖屏", resolution: "1080×1920" },
  { value: "1:1", label: "方形", resolution: "1080×1080" },
];

const FPS_OPTIONS: Array<{ value: VideoFps; label: string }> = [
  { value: 30, label: "30fps" },
  { value: 60, label: "60fps" },
];

const QUALITY_OPTIONS: Array<{ value: VideoQuality; label: string }> = [
  { value: "draft", label: "Draft" },
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
];

const TTS_PROVIDERS: Array<{ value: TtsProvider; label: string; hint: string }> = [
  { value: "edge", label: "Edge", hint: "免费" },
  { value: "minimax", label: "MiniMax", hint: "需 Key" },
  { value: "cosyvoice", label: "CosyVoice", hint: "需 Key" },
];

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

export function VideoMakerView() {
  const { client, token } = useClient();
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("config");
  const [topic, setTopic] = useState("");
  const [ratio, setRatio] = useState<VideoRatio>("16:9");
  const [fps, setFps] = useState<VideoFps>(30);
  const [quality, setQuality] = useState<VideoQuality>("standard");
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("edge");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsRate, setTtsRate] = useState("");
  const [phase, setPhase] = useState<VideoPhase>("config");
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [historyProjects, setHistoryProjects] = useState<VideoProject[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<VideoRuntimeStatus>(DEFAULT_RUNTIME_STATUS);
  const [runtimeOk, setRuntimeOk] = useState(true);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    component: string;
    progress: number;
  } | null>(null);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<{
    stage: "idle" | "lint" | "validate" | "inspect" | "render" | "complete" | "error";
    progress: number;
    message?: string;
  }>({ stage: "idle", progress: 0 });
  const [deleting, setDeleting] = useState<string | null>(null);
  const generatingRef = useRef(false);

  // Auto-switch to history tab when generation starts or completes
  useEffect(() => {
    if (phase === "generating" || phase === "done") {
      setSidebarTab("history");
    }
  }, [phase]);

  // Initial video runtime status check
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
  }, [sidebarTab, token, historyKey]);

  // Poll project status during generation
  useEffect(() => {
    if (phase !== "generating" || !projectName) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      try {
        const res = await fetchVideoProject(token, projectName!);
        if (cancelled) return;
        setPreviewPort(res.previewPort ?? null);
        setVideoUrl(res.videoUrl ?? null);
        if (res.status === "done" && res.hasVideo) {
          setPhase("done");
          setRenderStatus({ stage: "complete", progress: 100 });
          setHistoryKey((k) => k + 1);
          generatingRef.current = false;
          return;
        }
        if (res.status === "error") {
          setRenderStatus({
            stage: "error",
            progress: 0,
            message: "渲染失败",
          });
          generatingRef.current = false;
          return;
        }
        setRenderStatus((prev) => ({
          stage: prev.stage === "idle" ? "lint" : "render",
          progress: Math.min(prev.progress + 5, 95),
          message: prev.message,
        }));
      } catch {
        // ignore transient errors
      }
      if (!cancelled) {
        timer = setTimeout(poll, 3000);
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

  const handleDownloadRuntime = useCallback(async () => {
    const status = runtimeStatus;
    const missing: Array<{ key: "node" | "ffmpeg" | "chrome"; label: string }> = [];
    if (!status.node.ok) missing.push({ key: "node", label: "Node.js" });
    if (!status.ffmpeg.ok) missing.push({ key: "ffmpeg", label: "FFmpeg" });
    if (!status.chrome.ok) missing.push({ key: "chrome", label: "Chrome" });
    if (missing.length === 0) return;

    for (const dep of missing) {
      setDownloadProgress({ component: dep.label, progress: 0 });
      // Simulate incremental progress while download runs
      const progressTimer = setInterval(() => {
        setDownloadProgress((prev) =>
          prev && prev.component === dep.label
            ? { ...prev, progress: Math.min(prev.progress + 10, 90) }
            : prev,
        );
      }, 500);
      try {
        await downloadVideoRuntime(token, dep.key);
      } catch (e) {
        console.error(`Failed to download ${dep.label}`, e);
      }
      clearInterval(progressTimer);
      setDownloadProgress({ component: dep.label, progress: 100 });
    }

    setDownloadProgress(null);
    await refreshRuntimeStatus();
  }, [runtimeStatus, token, refreshRuntimeStatus]);

  const handleStartGeneration = useCallback(async () => {
    if (generatingRef.current) return;
    // 1. Check runtime dependencies
    const ready = await refreshRuntimeStatus();
    if (!ready) {
      setRuntimeDialogOpen(true);
      return;
    }

    try {
      generatingRef.current = true;
      const name = generateProjectName();
      setProjectName(name);
      const resolution = `${RATIO_RESOLUTION_MAP[ratio]}@${fps}fps`;
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
        fps,
        quality,
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
      const displayText = `请生成视频。\n项目名：${name}`;
      // 2. Create project
      await createVideoProject(token, name, resolution, ttsConfig);
      // 3. Create session
      const newChatId = await client.newChat(5_000, false, null, "video");
      setChatId(newChatId);
      // 4. Save chat_id
      await saveVideoChatId(token, name, newChatId);
      // 5. Send prompt
      client.sendMessage(newChatId, prompt, undefined, { displayContent: displayText });
      setPhase("generating");
      setRenderStatus({ stage: "lint", progress: 0 });
    } catch (e) {
      console.error("Failed to start video generation", e);
      generatingRef.current = false;
    }
  }, [
    refreshRuntimeStatus,
    client,
    topic,
    ratio,
    fps,
    quality,
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

  const handleSelectHistory = useCallback(
    (project: VideoProject) => {
      setProjectName(project.name);
      setChatId(project.chatId);
      const isDone = project.status === "done" || project.hasVideo;
      setPhase(isDone ? "done" : "generating");
      setRenderStatus(
        isDone
          ? { stage: "complete", progress: 100 }
          : { stage: "lint", progress: 0 },
      );
    },
    [],
  );

  const handleDownloadVideo = useCallback(
    async (name: string) => {
      const base = await getApiBase();
      const url = buildVideoDownloadUrl(base, token, name);

      if (isTauri()) {
        try {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const { writeFile } = await import("@tauri-apps/plugin-fs");
          const filePath = await save({
            defaultPath: `${name}.mp4`,
            filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
          });
          if (!filePath) return;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.arrayBuffer();
          await writeFile(filePath, new Uint8Array(blob));
        } catch (e) {
          console.error("Video download failed", e);
        }
        return;
      }

      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.mp4`;
      link.click();
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
      }
    },
    [workspacePath],
  );

  const handleDeleteProject = useCallback(
    async (name: string) => {
      if (deleting) return;
      setDeleting(name);
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
      } finally {
        setDeleting(null);
      }
    },
    [deleting, token, projectName],
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {/* 左侧:配置 / 历史 */}
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-border/70">
          <div className="flex shrink-0 border-b border-border/70">
            <button
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors",
                sidebarTab === "config"
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSidebarTab("config")}
            >
              <SlidersHorizontal className="h-3 w-3" />
              配置
            </button>
            <button
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors",
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
                      视频主题
                    </h3>
                    <Textarea
                      className="min-h-[80px] resize-none text-[12px]"
                      placeholder="描述你想制作的视频内容..."
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      disabled={phase === "generating"}
                    />
                  </section>

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
                          className={cn(
                            "rounded-md px-1.5 py-1 text-[11px] font-medium transition-all",
                            ratio === r.value
                              ? "bg-background text-foreground shadow"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => setRatio(r.value)}
                          disabled={phase === "generating"}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3 className="mb-1.5 text-[12px] font-medium text-foreground">
                      帧率
                    </h3>
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                      {FPS_OPTIONS.map((f) => (
                        <button
                          key={f.value}
                          type="button"
                          className={cn(
                            "rounded-md px-1.5 py-1 text-[11px] font-medium transition-all",
                            fps === f.value
                              ? "bg-background text-foreground shadow"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => setFps(f.value)}
                          disabled={phase === "generating"}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3 className="mb-1.5 text-[12px] font-medium text-foreground">
                      质量
                    </h3>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                      {QUALITY_OPTIONS.map((q) => (
                        <button
                          key={q.value}
                          type="button"
                          className={cn(
                            "rounded-md px-1.5 py-1 text-[11px] font-medium transition-all",
                            quality === q.value
                              ? "bg-background text-foreground shadow"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => setQuality(q.value)}
                          disabled={phase === "generating"}
                        >
                          {q.label}
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
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                          narrationEnabled
                            ? "bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                        )}
                        onClick={() => setNarrationEnabled((v) => !v)}
                        disabled={phase === "generating"}
                      >
                        {narrationEnabled ? "已启用" : "未启用"}
                      </button>
                    </div>
                    {narrationEnabled ? (
                      <div className="mt-2 space-y-3">
                        <div>
                          <div className="mb-1 text-[10px] text-muted-foreground">
                            TTS 供应商
                          </div>
                          <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                            {TTS_PROVIDERS.map((p) => (
                              <button
                                key={p.value}
                                type="button"
                                title={p.hint}
                                className={cn(
                                  "rounded-md px-1 py-1 text-[11px] font-medium transition-all",
                                  ttsProvider === p.value
                                    ? "bg-background text-foreground shadow"
                                    : "text-muted-foreground hover:text-foreground",
                                )}
                                onClick={() => setTtsProvider(p.value)}
                                disabled={phase === "generating"}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="mb-1 text-[10px] text-muted-foreground">
                            音色 ID
                          </div>
                          <Input
                            value={ttsVoice}
                            onChange={(e) => setTtsVoice(e.target.value)}
                            placeholder="zh-CN-XiaoyiNeural"
                            className="h-8 rounded-lg text-[12px]"
                            disabled={phase === "generating"}
                          />
                        </div>
                        <div>
                          <div className="mb-1 text-[10px] text-muted-foreground">
                            语速
                          </div>
                          <Input
                            value={ttsRate}
                            onChange={(e) => setTtsRate(e.target.value)}
                            placeholder="+0%"
                            className="h-8 rounded-lg text-[12px]"
                            disabled={phase === "generating"}
                          />
                        </div>
                      </div>
                    ) : null}
                  </section>

                  {!runtimeOk ? (
                    <button
                      type="button"
                      onClick={() => setRuntimeDialogOpen(true)}
                      className="flex w-full items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] font-normal text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Play className="h-3.5 w-3.5 shrink-0" />
                      <span>视频依赖未安装,点击此处下载</span>
                    </button>
                  ) : null}
                </div>

                <div className="shrink-0 border-t border-border/70 p-3">
                  <Button
                    className="w-full"
                    disabled={!topic.trim() || phase === "generating"}
                    onClick={handleStartGeneration}
                  >
                    <Play className="mr-1.5 h-4 w-4" />
                    {phase === "generating" ? "生成中..." : "开始生成"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {historyProjects.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
                    暂无历史项目
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {historyProjects.map((p) => (
                      <ContextMenu key={p.name}>
                        <ContextMenuTrigger asChild>
                          <button
                            className={cn(
                              "mb-1.5 w-full rounded-lg border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-accent",
                              p.name === projectName ? "border-primary bg-accent" : "",
                            )}
                            onClick={() => handleSelectHistory(p)}
                          >
                            <div className="truncate text-[12px] font-medium">
                              {p.name}
                            </div>
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {p.resolution} · {p.status}
                            </div>
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent className="w-40">
                          {p.hasVideo ? (
                            <ContextMenuItem
                              onClick={() => handleDownloadVideo(p.name)}
                              className="text-[12px]"
                            >
                              <Download className="mr-2 h-3.5 w-3.5" />
                              下载 MP4
                            </ContextMenuItem>
                          ) : null}
                          <ContextMenuItem
                            onClick={() => handleOpenProjectDir(p.name)}
                            className="text-[12px]"
                          >
                            <FolderOpen className="mr-2 h-3.5 w-3.5" />
                            打开任务目录
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onClick={() => handleDeleteProject(p.name)}
                            disabled={deleting === p.name}
                            className="text-[12px] text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            {deleting === p.name ? "删除中..." : "删除项目"}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
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
          ) : (
            <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
              <ResizablePanel defaultSize={55} minSize={20}>
                <VideoPreview
                  projectName={projectName ?? ""}
                  previewPort={previewPort}
                  renderStatus={renderStatus}
                  videoUrl={videoUrl}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={45} minSize={15}>
                <DocChatPanel
                  chatId={chatId}
                  onSend={handleSendMessage}
                  placeholder="输入消息与视频助手对话..."
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      </div>

      <VideoRuntimeDialog
        open={runtimeDialogOpen}
        onClose={() => setRuntimeDialogOpen(false)}
        runtimeStatus={runtimeStatus}
        onDownload={handleDownloadRuntime}
        downloadProgress={downloadProgress}
      />
    </div>
  );
}

function generateProjectName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `video-${ts}-${rand}`;
}

function buildVideoPrompt(opts: {
  topic: string;
  ratio: VideoRatio;
  fps: VideoFps;
  quality: VideoQuality;
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
  parts.push(`帧率：${opts.fps}fps`);
  parts.push(`质量：${opts.quality}`);
  if (opts.narration) {
    parts.push(`旁白：启用`);
    parts.push(`TTS供应商：${opts.narration.provider}`);
    parts.push(
      `音色：${opts.narration.voice || "zh-CN-XiaoyiNeural"}（留空用默认）`,
    );
    parts.push(`语速：${opts.narration.rate || "+0%"}（留空用默认）`);
  } else {
    parts.push(`旁白：未启用`);
  }
  if (opts.topic.trim()) {
    parts.push(`主题：${opts.topic.trim()}`);
  }
  parts.push("");
  if (opts.narration) {
    parts.push(
      "请按照 mona-video SKILL 的流程执行：编写 HTML 场景 → lint → validate → inspect → render → 生成旁白音频(Step 6.5) → 导出含音轨的最终视频。",
    );
    parts.push(
      "每个场景的 storyboard.md 必须包含 - Narration: <纯文本> 字段，文本字数应与 Duration 匹配（中文约 4 字/秒）。",
    );
  } else {
    parts.push(
      "请按照 mona-video SKILL 的流程执行：编写 HTML 场景 → lint → validate → inspect → render。",
    );
  }
  parts.push("完成后将最终视频文件输出到项目目录。");
  return parts.join("\n");
}
