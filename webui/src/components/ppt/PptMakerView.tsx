import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import { fetchPptProjects, getApiBase } from "@/lib/api";
import { PptConfigPanel } from "./PptConfigPanel";
import { PptChatPanel } from "./PptChatPanel";
import { PptPreview } from "./PptPreview";
import { PptHistory } from "./PptHistory";

type PptPhase = "config" | "generating" | "done";

export interface PptConfig {
  templateKey: string | null;
  templateKind: "layout" | "deck" | null;
  canvasFormat: string;
  stylePreference: string;
  sourceFiles: string[];
  topic: string;
}

export const DEFAULT_CONFIG: PptConfig = {
  templateKey: null,
  templateKind: null,
  canvasFormat: "ppt169",
  stylePreference: "",
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
  const knownProjectsRef = useRef<Set<string>>(new Set());

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
    if (phase !== "generating") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetchPptProjects(token);
        if (cancelled) return;
        for (const p of res.projects) {
          if (!knownProjectsRef.current.has(p.name)) {
            knownProjectsRef.current.add(p.name);
            setProjectName(p.name);
            setPhase("done");
            return;
          }
        }
      } catch {}
      if (!cancelled) {
        timer = setTimeout(poll, 3000);
      }
    }

    fetchPptProjects(token).then((res) => {
      if (!cancelled) {
        for (const p of res.projects) {
          knownProjectsRef.current.add(p.name);
        }
        poll();
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, token]);

  const handleStartGeneration = useCallback(async () => {
    try {
      const newChatId = await client.newChat(5_000, true);
      setChatId(newChatId);
      const prompt = buildPptPrompt(config);
      client.sendMessage(newChatId, prompt);
      setPhase("generating");
    } catch (e) {
      console.error("Failed to start PPT generation", e);
    }
  }, [client, config]);

  const handleDownload = useCallback(async (name?: string) => {
    const project = name ?? projectName;
    if (!project) return;
    const base = await getApiBase();
    const link = document.createElement("a");
    link.href = `${base}/api/ppt/download?project=${encodeURIComponent(project)}&token=${encodeURIComponent(token)}`;
    link.download = `${project}.pptx`;
    link.click();
  }, [projectName, token]);

  const handleSelectProject = useCallback((name: string) => {
    setProjectName(name);
    setChatId(null);
    setPhase("done");
  }, []);

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
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PptConfigPanel
              config={config}
              setConfig={setConfig}
              phase={phase}
              onStart={handleStartGeneration}
            />
          </div>
          <div className="shrink-0 border-t border-border/70">
            <PptHistory
              key={historyKey}
              onSelect={handleSelectProject}
              onDownload={handleDownload}
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
                <PptPreview projectName={projectName} />
              </div>
              <div className="shrink-0 h-[240px] border-t border-border/70">
                <PptChatPanel chatId={chatId} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildPptPrompt(config: PptConfig): string {
  const parts: string[] = [];
  parts.push("请制作一份 PPT。");
  if (config.templateKey && config.templateKind) {
    const kindLabel = config.templateKind === "deck" ? "品牌套件" : "布局模板";
    const subdir = config.templateKind === "deck" ? "decks" : "layouts";
    parts.push(`使用模板：${kindLabel} ${config.templateKey}（路径：scripts/templates_full/${subdir}/${config.templateKey}）`);
  }
  parts.push(`画布格式：${config.canvasFormat}`);
  if (config.stylePreference) {
    parts.push(`风格偏好：${config.stylePreference}`);
  }
  if (config.sourceFiles.length > 0) {
    const filePaths = config.sourceFiles.map((p) => `  - ${p}`).join("\n");
    parts.push(`源文件（请先读取以下文件内容再制作）：\n${filePaths}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}（请先进行主题研究）`);
  }
  return parts.join("\n");
}
