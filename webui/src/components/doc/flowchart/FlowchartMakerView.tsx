import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, History, SlidersHorizontal, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useClient } from "@/providers/ClientProvider";
import {
  createFlowchartProject,
  downloadFlowchartRuntime,
  exportFlowchartProject,
  fetchFlowchartProject,
  fetchFlowchartProjectXml,
  fetchFlowchartProjects,
  fetchFlowchartRuntimeCheck,
  saveFlowchartChatId,
  saveFlowchartProject,
  type FlowchartProject,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { DocChatPanel } from "../DocChatPanel";
import { DrawioEditor } from "./DrawioEditor";
import { FlowchartRuntimeDialog } from "./FlowchartRuntimeDialog";

type SidebarTab = "config" | "history";
type FlowchartPhase = "config" | "generating" | "done";
type DiagramType = "flowchart" | "architecture" | "er" | "sequence" | "mindmap";

const DIAGRAM_TYPES: Array<{ value: DiagramType; label: string }> = [
  { value: "flowchart", label: "流程图" },
  { value: "architecture", label: "架构图" },
  { value: "er", label: "ER 图" },
  { value: "sequence", label: "时序图" },
  { value: "mindmap", label: "思维导图" },
];

const DIAGRAM_TYPE_LABEL: Record<DiagramType, string> = {
  flowchart: "流程图",
  architecture: "架构图",
  er: "ER 图",
  sequence: "时序图",
  mindmap: "思维导图",
};

export function FlowchartMakerView() {
  const { client, token } = useClient();
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("config");
  const [description, setDescription] = useState("");
  const [diagramType, setDiagramType] = useState<DiagramType>("flowchart");
  const [phase, setPhase] = useState<FlowchartPhase>("config");
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [historyProjects, setHistoryProjects] = useState<FlowchartProject[]>([]);
  const [xml, setXml] = useState<string | null>(null);
  const [runtimeOk, setRuntimeOk] = useState(true);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const generatingRef = useRef(false);

  // Auto-switch to history tab when generation starts or completes
  useEffect(() => {
    if (phase === "generating" || phase === "done") {
      setSidebarTab("history");
    }
  }, [phase]);

  // Initial draw.io runtime status check
  useEffect(() => {
    let cancelled = false;
    fetchFlowchartRuntimeCheck(token)
      .then((status) => {
        if (!cancelled) setRuntimeOk(status.drawio.ok);
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
    fetchFlowchartProjects(token)
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

  // Poll for diagram.drawio file appearance during generation
  useEffect(() => {
    if (phase !== "generating" || !projectName) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      try {
        const project = await fetchFlowchartProject(token, projectName!);
        if (cancelled) return;
        if (project.hasDiagram) {
          // Load the XML once diagram appears
          try {
            const xmlRes = await fetchFlowchartProjectXml(token, projectName!);
            if (!cancelled && xmlRes.ok && xmlRes.xml) {
              setXml(xmlRes.xml);
            }
          } catch {
            // ignore — will retry on next poll
          }
          setPhase("done");
          setHistoryKey((k) => k + 1);
          generatingRef.current = false;
          return;
        }
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
      const status = await fetchFlowchartRuntimeCheck(token);
      setRuntimeOk(status.drawio.ok);
      return status.drawio.ok;
    } catch {
      return true;
    }
  }, [token]);

  const handleDownloadRuntime = useCallback(async () => {
    setDownloadProgress(0);
    // Simulate incremental progress while download runs
    const progressTimer = setInterval(() => {
      setDownloadProgress((prev) =>
        prev === null ? prev : Math.min(prev + 10, 90),
      );
    }, 500);
    try {
      await downloadFlowchartRuntime(token);
    } catch (e) {
      console.error("Failed to download draw.io runtime", e);
    }
    clearInterval(progressTimer);
    setDownloadProgress(100);
    // Brief delay to show completion before refreshing
    setTimeout(() => {
      setDownloadProgress(null);
    }, 500);
    await refreshRuntimeStatus();
  }, [token, refreshRuntimeStatus]);

  const handleStartGeneration = useCallback(async () => {
    if (generatingRef.current) return;

    // Check draw.io runtime before starting
    const ok = await refreshRuntimeStatus();
    if (!ok) {
      setRuntimeDialogOpen(true);
      return;
    }

    try {
      generatingRef.current = true;
      const name = generateProjectName();
      setProjectName(name);
      setXml(null);
      const prompt = buildFlowchartPrompt({ diagramType, description, name });
      const displayText = `请生成${DIAGRAM_TYPE_LABEL[diagramType]}。\n项目名：${name}`;
      // 1. Create project
      await createFlowchartProject(token, name);
      // 2. Create session
      const newChatId = await client.newChat(5_000, false, null, "flowchart");
      setChatId(newChatId);
      // 3. Save chat_id
      await saveFlowchartChatId(token, name, newChatId);
      // 4. Send prompt
      client.sendMessage(newChatId, prompt, undefined, { displayContent: displayText });
      setPhase("generating");
    } catch (e) {
      console.error("Failed to start flowchart generation", e);
      generatingRef.current = false;
    }
  }, [refreshRuntimeStatus, client, diagramType, description, token]);

  const handleSendMessage = useCallback(
    (content: string) => {
      if (!chatId) return;
      client.sendMessage(chatId, content);
    },
    [chatId, client],
  );

  const handleSaveXml = useCallback(
    (newXml: string) => {
      setXml(newXml);
      if (projectName) {
        saveFlowchartProject(token, projectName, newXml).catch((e) => {
          console.error("Failed to save flowchart XML", e);
        });
      }
    },
    [projectName, token],
  );

  const handleExport = useCallback(
    (format: string, data: string) => {
      // The DrawioEditor already produces the export data via postMessage;
      // here we trigger a server-side export as well for persistence, and
      // download the result client-side.
      if (!projectName) return;
      exportFlowchartProject(token, projectName, format).catch((e) => {
        console.error("Failed to export flowchart", e);
      });
      // Client-side download from the data returned by draw.io
      try {
        const mime = format === "png" ? "image/png" : format === "svg" ? "image/svg+xml" : "application/octet-stream";
        const blob = base64ToBlob(data, mime);
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${projectName}.${format}`;
        link.click();
        URL.revokeObjectURL(url);
      } catch (e) {
        console.error("Failed to download export", e);
      }
    },
    [projectName, token],
  );

  const handleSelectHistory = useCallback(
    async (project: FlowchartProject) => {
      setProjectName(project.name);
      setChatId(project.chatId);
      setXml(null);
      const isDone = project.status === "done" || project.hasDiagram;
      setPhase(isDone ? "done" : "generating");
      if (project.hasDiagram) {
        try {
          const xmlRes = await fetchFlowchartProjectXml(token, project.name);
          if (xmlRes.ok && xmlRes.xml) {
            setXml(xmlRes.xml);
          }
        } catch (e) {
          console.error("Failed to load flowchart XML", e);
        }
      }
    },
    [token],
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
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                    图类型
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {DIAGRAM_TYPES.map((t) => (
                      <Button
                        key={t.value}
                        variant={diagramType === t.value ? "secondary" : "outline"}
                        size="sm"
                        className="h-8 rounded-lg text-[12px]"
                        onClick={() => setDiagramType(t.value)}
                      >
                        {t.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-foreground">
                    需求描述
                  </label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="描述你要绘制的流程图..."
                    className="min-h-[100px] resize-none rounded-lg text-[13px]"
                    rows={5}
                  />
                </div>

                {!runtimeOk ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRuntimeDialogOpen(true)}
                    className="h-auto justify-start gap-1.5 rounded-lg border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Workflow className="h-3.5 w-3.5 shrink-0" />
                    <span>draw.io 组件未安装,点击此处下载</span>
                  </Button>
                ) : null}

                <Button
                  className="mt-auto rounded-full"
                  disabled={!description.trim() || phase === "generating"}
                  onClick={handleStartGeneration}
                >
                  <GitBranch className="mr-1.5 h-4 w-4" />
                  {phase === "generating" ? "生成中..." : "生成流程图"}
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
                          {p.status}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* 右侧:编辑器 + 聊天(上下分割) */}
        <div className="flex min-h-0 flex-1 flex-col">
          {phase === "config" && !xml ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              选择图类型并输入描述后开始生成
            </div>
          ) : (
            <ResizablePanelGroup direction="vertical" className="min-h-0 flex-1">
              <ResizablePanel defaultSize={55} minSize={20}>
                <DrawioEditor
                  xml={xml}
                  onSave={handleSaveXml}
                  onExport={handleExport}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={45} minSize={15}>
                <DocChatPanel
                  chatId={chatId}
                  onSend={handleSendMessage}
                  placeholder="输入消息与流程图助手对话..."
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      </div>

      <FlowchartRuntimeDialog
        open={runtimeDialogOpen}
        onClose={() => setRuntimeDialogOpen(false)}
        runtimeOk={runtimeOk}
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
  return `flowchart-${ts}-${rand}`;
}

function buildFlowchartPrompt(opts: {
  diagramType: DiagramType;
  description: string;
  name: string;
}): string {
  const parts: string[] = [];
  parts.push(`请生成一份${DIAGRAM_TYPE_LABEL[opts.diagramType]}。`);
  parts.push(`项目名：${opts.name}`);
  parts.push(`项目目录：flowchart_projects/${opts.name}`);
  parts.push(`图类型：${DIAGRAM_TYPE_LABEL[opts.diagramType]}`);
  if (opts.description.trim()) {
    parts.push(`需求描述：${opts.description.trim()}`);
  }
  parts.push("");
  parts.push("请按照 mona-flowchart SKILL 的流程执行：分析需求 → 生成 mxGraph XML → 保存到 diagram.drawio。");
  parts.push("生成的 XML 必须是合法的 draw.io/mxGraph 格式，可直接在 draw.io 编辑器中打开。");
  return parts.join("\n");
}

function base64ToBlob(base64: string, mime: string): Blob {
  const byteString = atob(baseString(base64));
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/** Extract the base64 payload from a data URL (or return input as-is). */
function baseString(data: string): string {
  const idx = data.indexOf(",");
  return idx >= 0 ? data.slice(idx + 1) : data;
}
