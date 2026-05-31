import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import { getApiBase } from "@/lib/api";
import { PptConfigPanel } from "./PptConfigPanel";
import { PptChatPanel } from "./PptChatPanel";
import { PptPreview } from "./PptPreview";
import { PptHistory } from "./PptHistory";

type PptPhase = "config" | "generating" | "done";

interface PptConfig {
  templateKey: string | null;
  templateKind: "layout" | "deck" | null;
  canvasFormat: string;
  stylePreference: string;
  sourceFiles: string[];
  topic: string;
}

const DEFAULT_CONFIG: PptConfig = {
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

  useEffect(() => {
    const id = chatId;
    return () => {
      if (id) {
        client.deleteChat(id);
      }
    };
  }, []);

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

  const handleDownload = useCallback(async () => {
    if (!projectName) return;
    const base = await getApiBase();
    window.open(
      `${base}/api/ppt/download?project=${encodeURIComponent(projectName)}&token=${encodeURIComponent(token)}`,
      "_blank",
    );
  }, [projectName, token]);

  const handleSelectProject = useCallback((name: string) => {
    setProjectName(name);
    setPhase("done");
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
        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg text-muted-foreground">
          <Settings className="h-4 w-4" />
        </Button>
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
            <PptHistory onSelect={handleSelectProject} onDownload={handleDownload} />
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
              {phase === "done" && projectName && (
                <div className="shrink-0 flex items-center gap-2 border-t border-border/70 px-3 py-2">
                  <Button onClick={handleDownload} className="gap-2" size="sm">
                    <Download className="h-3.5 w-3.5" />
                    下载 PPTX
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPhase("config");
                      setChatId(null);
                      setProjectName(null);
                    }}
                  >
                    新建项目
                  </Button>
                </div>
              )}
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
    parts.push(`源文件：${config.sourceFiles.join(", ")}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}（请先进行主题研究）`);
  }
  return parts.join("\n");
}
