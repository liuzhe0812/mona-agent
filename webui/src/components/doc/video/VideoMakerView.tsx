import { useCallback, useEffect, useRef, useState } from "react";
import { History, Play, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useClient } from "@/providers/ClientProvider";
import {
  createVideoProject,
  downloadVideoRuntime,
  fetchVideoProject,
  fetchVideoProjects,
  fetchVideoRuntimeCheck,
  saveVideoChatId,
  type VideoProject,
  type VideoRuntimeStatus,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { DocChatPanel } from "../DocChatPanel";
import { VideoPreview } from "./VideoPreview";
import { VideoRuntimeDialog } from "./VideoRuntimeDialog";

type SidebarTab = "config" | "history";
type VideoPhase = "config" | "generating" | "done";
type VideoRatio = "16:9" | "9:16" | "1:1";
type VideoFps = 30 | 60;
type VideoQuality = "draft" | "standard" | "high";

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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("config");
  const [topic, setTopic] = useState("");
  const [ratio, setRatio] = useState<VideoRatio>("16:9");
  const [fps, setFps] = useState<VideoFps>(30);
  const [quality, setQuality] = useState<VideoQuality>("standard");
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
      const prompt = buildVideoPrompt({ topic, ratio, fps, quality, name, resolution });
      const displayText = `请生成视频。\n项目名：${name}`;
      // 2. Create project
      await createVideoProject(token, name, resolution);
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
  }, [refreshRuntimeStatus, client, topic, ratio, fps, quality, token]);

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
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-4">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                    视频主题
                  </label>
                  <Input
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="描述你想制作的视频内容..."
                    className="h-8 rounded-full text-[13px]"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                    画面比例
                  </label>
                  <div className="flex gap-2">
                    {RATIOS.map((r) => (
                      <Button
                        key={r.value}
                        variant={ratio === r.value ? "secondary" : "outline"}
                        size="sm"
                        className="h-auto flex-1 flex-col rounded-lg py-1.5"
                        onClick={() => setRatio(r.value)}
                      >
                        <span className="text-[12px]">{r.label}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {r.resolution}
                        </span>
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                    帧率
                  </label>
                  <div className="flex gap-2">
                    {FPS_OPTIONS.map((f) => (
                      <Button
                        key={f.value}
                        variant={fps === f.value ? "secondary" : "outline"}
                        size="sm"
                        className="h-8 flex-1 rounded-lg text-[12px]"
                        onClick={() => setFps(f.value)}
                      >
                        {f.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                    质量
                  </label>
                  <div className="flex gap-2">
                    {QUALITY_OPTIONS.map((q) => (
                      <Button
                        key={q.value}
                        variant={quality === q.value ? "secondary" : "outline"}
                        size="sm"
                        className="h-8 flex-1 rounded-lg text-[12px]"
                        onClick={() => setQuality(q.value)}
                      >
                        {q.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {!runtimeOk ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRuntimeDialogOpen(true)}
                    className="h-auto justify-start gap-1.5 rounded-lg border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Play className="h-3.5 w-3.5 shrink-0" />
                    <span>视频依赖未安装,点击此处下载</span>
                  </Button>
                ) : null}

                <Button
                  className="mt-auto rounded-full"
                  disabled={!topic.trim() || phase === "generating"}
                  onClick={handleStartGeneration}
                >
                  <Play className="mr-1.5 h-4 w-4" />
                  {phase === "generating" ? "生成中..." : "开始生成"}
                </Button>
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
                      <button
                        key={p.name}
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
}): string {
  const parts: string[] = [];
  parts.push("请生成一段视频。");
  parts.push(`项目名：${opts.name}`);
  parts.push(`项目目录：video_projects/${opts.name}`);
  parts.push(`分辨率：${opts.resolution}`);
  parts.push(`画面比例：${opts.ratio}`);
  parts.push(`帧率：${opts.fps}fps`);
  parts.push(`质量：${opts.quality}`);
  if (opts.topic.trim()) {
    parts.push(`主题：${opts.topic.trim()}`);
  }
  parts.push("");
  parts.push("请按照 mona-video SKILL 的流程执行：编写 HTML 场景 → lint → validate → inspect → render。");
  parts.push("完成后将最终视频文件输出到项目目录。");
  return parts.join("\n");
}
