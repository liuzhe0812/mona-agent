import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Mic, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import { fetchPptExportStatus, markPptGenerating, savePptChatId, getApiBase } from "@/lib/api";
import type { PptProject } from "@/lib/types";
import { PptConfigPanel } from "./PptConfigPanel";
import { PptChatPanel } from "./PptChatPanel";
import { PptPreview } from "./PptPreview";
import { PptHistory } from "./PptHistory";

type PptPhase = "config" | "generating" | "done";

export interface PptConfig {
  templateKey: string | null;
  templateKind: "layout" | "deck" | null;
  canvasFormat: string;
  sourceFiles: string[];
  topic: string;
}

export const DEFAULT_CONFIG: PptConfig = {
  templateKey: null,
  templateKind: null,
  canvasFormat: "ppt169",
  sourceFiles: [],
  topic: "",
};

interface PptMakerViewProps {
  onBack: () => void;
}

export function PptMakerView({ onBack }: PptMakerViewProps) {
  const { client, token } = useClient();
  const [phase, setPhase] = useState<PptPhase>("config");
  const [config, setConfig] = useState<PptConfig>(DEFAULT_CONFIG);
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const chatIdRef = useRef<string | null>(null);
  const generationStartRef = useRef<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  useEffect(() => {
    return () => {
      const id = chatIdRef.current;
      if (id) {
        client.deleteChat(id);
      }
    };
  }, [client]);

  useEffect(() => {
    if (phase !== "generating" || !projectName) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setTimedOut(false);

    async function poll() {
      if (cancelled) return;

      if (generationStartRef.current) {
        const elapsed = Date.now() - generationStartRef.current;
        if (elapsed > 30 * 60 * 1000) {
          setTimedOut(true);
          return;
        }
      }

      try {
        const res = await fetchPptExportStatus(token, projectName!);
        if (cancelled) return;
        if (res.status === "done" && res.hasExport) {
          await markPptGenerating(token, projectName!, "finish").catch(() => {});
          setPhase("done");
          setHistoryKey((k) => k + 1);
          generationStartRef.current = null;
          return;
        }
      } catch {}
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

  const handleStartGeneration = useCallback(async () => {
    try {
      const name = generateProjectName();
      setProjectName(name);
      const prompt = buildPptPrompt(config, name);
      markPptGenerating(token, name, "start").catch(() => {});
      const newChatId = await client.newChat(5_000, true);
      setChatId(newChatId);
      savePptChatId(token, name, newChatId).catch(() => {});
      client.sendMessage(newChatId, prompt);
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to start PPT generation", e);
    }
  }, [client, config, token]);

  const handleDownload = useCallback(async (name?: string) => {
    const project = name ?? projectName;
    if (!project) return;
    const base = await getApiBase();
    const link = document.createElement("a");
    link.href = `${base}/api/ppt/download?project=${encodeURIComponent(project)}&token=${encodeURIComponent(token)}`;
    link.download = `${project}.pptx`;
    link.click();
  }, [projectName, token]);

  const handleResume = useCallback(async (name: string, existingChatId?: string | null, hasSpecLock?: boolean) => {
    try {
      markPptGenerating(token, name, "start").catch(() => {});
      setProjectName(name);

      const useResumeExecute = hasSpecLock || !existingChatId;
      let resumeChatId: string;
      let prompt: string;

      if (useResumeExecute) {
        resumeChatId = await client.newChat(5_000, true);
        setChatId(resumeChatId);
        savePptChatId(token, name, resumeChatId).catch(() => {});
        prompt = `继续生成 projects/${name}\n\n请先读取 skills/ppt-master/SKILL.md 了解 resume-execute 工作流，然后继续执行。`;
      } else {
        resumeChatId = existingChatId!;
        setChatId(resumeChatId);
        prompt = `继续生成 PPT 项目 projects/${name}。请检查当前项目状态，从上次中断的地方继续执行。不要重新开始已完成的步骤。`;
      }

      client.sendMessage(resumeChatId, prompt);
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to resume PPT generation", e);
    }
  }, [client, token]);

  const handleGenerateAudio = useCallback(async () => {
    if (!projectName || !chatId) return;
    try {
      markPptGenerating(token, projectName, "start").catch(() => {});
      client.sendMessage(
        chatId,
        `请为当前 PPT 项目生成配音旁白。使用 Edge TTS 默认语音，生成后重新导出带配音的 PPTX。`,
      );
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to start TTS generation", e);
    }
  }, [client, chatId, projectName, token]);

  const handleSelectProject = useCallback((project: PptProject) => {
    setProjectName(project.name);
    setChatId(project.chatId);
    setPhase(project.status === "done" || project.hasExport ? "done" : "generating");
  }, []);

  const handleDeleteProject = useCallback((name: string) => {
    if (name === projectName) {
      setPhase("config");
      setChatId(null);
      setProjectName(null);
    };
  }, [projectName]);

  const handleNewProject = useCallback(() => {
    setPhase("config");
    setChatId(null);
    setProjectName(null);
    setHistoryKey((k) => k + 1);
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 rounded-lg">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-[14px] font-semibold">PPT 制作</h1>
        </div>
        <div className="flex items-center gap-1">
          {timedOut && phase === "generating" && (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              生成超时，请检查聊天面板
            </span>
          )}
          {phase === "done" && projectName && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleDownload()}
              className="h-7 gap-1.5 rounded-lg text-[12px] text-muted-foreground"
            >
              <Download className="h-3.5 w-3.5" />
              下载 PPTX
            </Button>
          )}
          {phase === "done" && projectName && chatId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleGenerateAudio}
              className="h-7 gap-1.5 rounded-lg text-[12px] text-muted-foreground"
            >
              <Mic className="h-3.5 w-3.5" />
              生成配音
            </Button>
          )}
          {phase === "done" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNewProject}
              className="h-7 rounded-lg text-[12px] text-muted-foreground"
            >
              新建
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground">
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[320px] shrink-0 flex-col border-r border-border/70">
          <PptConfigPanel
            config={config}
            setConfig={setConfig}
            phase={phase}
            onStart={handleStartGeneration}
          />
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/70">
            <PptHistory
              key={historyKey}
              onSelect={handleSelectProject}
              onDownload={handleDownload}
              onResume={handleResume}
              onDelete={handleDeleteProject}
            />
          </div>
        </aside>

        <div className="flex min-h-0 flex-1 flex-col">
          {phase === "config" ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              选择模板和输入主题后开始生成
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1">
                <PptPreview projectName={projectName} isStreaming={isStreaming} />
              </div>
              <div className="shrink-0 h-[320px] border-t border-border/70">
                <PptChatPanel chatId={chatId} onStreamingChange={setIsStreaming} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function generateProjectName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `ppt-${ts}-${rand}`;
}

function buildPptPrompt(config: PptConfig, projectName: string): string {
  const parts: string[] = [];
  const hasPptxSource = config.sourceFiles.some((f) =>
    f.toLowerCase().endsWith(".pptx"),
  );

  if (hasPptxSource) {
    parts.push("请将现有 PPT 转换为网页版 PPT，保留原有内容和设计意图。");
  } else {
    parts.push("请制作一份 PPT。");
  }

  parts.push(`项目名使用：${projectName}`);
  if (config.templateKey && config.templateKind) {
    const kindLabel = config.templateKind === "deck" ? "品牌套件" : "布局模板";
    const subdir = config.templateKind === "deck" ? "decks" : "layouts";
    parts.push(`使用模板：${kindLabel} ${config.templateKey}（路径：scripts/templates_full/${subdir}/${config.templateKey}）`);
  }
  if (config.canvasFormat && config.canvasFormat !== "ppt169") {
    parts.push(`画布格式偏好：${config.canvasFormat}（请在八项确认中优先采用此格式）`);
  }
  if (config.sourceFiles.length > 0) {
    const filePaths = config.sourceFiles.map((p) => `  - ${p}`).join("\n");
    parts.push(`源文件（请先读取以下文件内容再制作）：\n${filePaths}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}（请先进行主题研究）`);
  }
  return parts.join("\n");
}
