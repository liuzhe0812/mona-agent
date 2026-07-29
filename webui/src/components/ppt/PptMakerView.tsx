import { useCallback, useEffect, useRef, useState } from "react";
import { History, PanelLeft, SlidersHorizontal } from "lucide-react";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useClient } from "@/providers/ClientProvider";
import { fetchPptExportStatus, markPptGenerating, savePptChatId, getApiBase } from "@/lib/api";
import { isTauri, httpFetch } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { PptProject } from "@/lib/types";
import { PptConfigPanel } from "./PptConfigPanel";
import { PptChatPanel } from "./PptChatPanel";
import type { PptChatPanelHandle } from "./PptChatPanel";
import { PptPreview } from "./PptPreview";
import { PptHistory } from "./PptHistory";
import { PptOutlinePhase } from "./PptOutlinePhase";
import { PptReviewPhase } from "./PptReviewPhase";

export type PptPhase = "config" | "generating" | "outline" | "producing" | "review" | "exporting" | "done";
export type PptMode = "design" | "template";
export type PptImageMode = "none" | "key-pages" | "rich";
export type PptVisualMode = "auto" | "data" | "process";
export type PptStyleMode = "general" | "consulting" | "top-consulting";
export type PptIconApproach = "emoji" | "ai" | "builtin" | "custom";
export type PptIconLibrary = "chunk-filled" | "tabler-filled" | "tabler-outline" | "phosphor-duotone";
export type PptFormulaPolicy = "mixed" | "render-all" | "text-only";
export type PptImageApproach = "none" | "user" | "ai" | "web" | "placeholder";
export type PptPageTransition = "fade" | "push" | "wipe" | "split" | "strips" | "cover" | "random" | "none";
export type PptEntranceAnimation = "auto" | "none" | "fade" | "fly" | "zoom" | "wipe" | "mixed";
export type PptAnimationTrigger = "after-previous" | "with-previous" | "on-click";

export interface PptConfig {
  // --- Basic ---
  mode: PptMode;
  templateKey: string | null;
  templateKind: "layout" | "brand" | "native" | null;
  templateFile: string | null;
  canvasFormat: string;
  imageMode: PptImageMode;
  visualMode: PptVisualMode;
  sourceFiles: string[];
  topic: string;

  // --- Design Preferences ---
  styleMode: PptStyleMode | null;
  styleDescriptor: string;
  pageCount: number | null;
  audience: string;
  primaryColor: string;
  iconApproach: PptIconApproach | null;
  iconLibrary: PptIconLibrary | null;
  formulaPolicy: PptFormulaPolicy | null;
  imageApproach: PptImageApproach | null;

  // --- Animation & Export ---
  pageTransition: PptPageTransition;
  entranceAnimation: PptEntranceAnimation;
  animationTrigger: PptAnimationTrigger;
  autoAdvance: number | null;
  enableNarration: boolean;
  mergeParagraphs: boolean;
}

export const DEFAULT_CONFIG: PptConfig = {
  mode: "design",
  templateKey: null,
  templateKind: null,
  templateFile: null,
  canvasFormat: "ppt169",
  imageMode: "key-pages",
  visualMode: "auto",
  sourceFiles: [],
  topic: "",

  styleMode: null,
  styleDescriptor: "",
  pageCount: null,
  audience: "",
  primaryColor: "",
  iconApproach: null,
  iconLibrary: null,
  formulaPolicy: null,
  imageApproach: null,

  pageTransition: "fade",
  entranceAnimation: "auto",
  animationTrigger: "after-previous",
  autoAdvance: null,
  enableNarration: false,
  mergeParagraphs: false,
};

const ACTIVE_PROJECT_KEY = "mona.ppt.activeProject";

interface ActiveProjectState {
  name: string;
  chatId: string | null;
  phase: PptPhase;
}

export function PptMakerView() {
  const { client, token } = useClient();
  const [phase, setPhase] = useState<PptPhase>("config");
  const [config, setConfig] = useState<PptConfig>(DEFAULT_CONFIG);
  const [chatId, setChatId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const chatIdRef = useRef<string | null>(null);
  const generationStartRef = useRef<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasPptxOutput, setHasPptxOutput] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<string>("init");
  const [sidebarTab, setSidebarTab] = useState<"config" | "history">("config");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const chatPanelRef = useRef<PptChatPanelHandle>(null);
  const [displayContentMap, setDisplayContentMap] = useState<Record<string, string>>({});

  // Auto-switch to history tab when generation starts or completes
  useEffect(() => {
    if (phase === "generating" || phase === "done" || phase === "producing" || phase === "exporting") {
      setSidebarTab("history");
    }
  }, [phase]);

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  // V2 §7.4: persist active project to localStorage for cross-session recovery
  useEffect(() => {
    if (projectName && phase !== "config") {
      const state: ActiveProjectState = { name: projectName, chatId, phase };
      try {
        localStorage.setItem(ACTIVE_PROJECT_KEY, JSON.stringify(state));
      } catch {}
    } else if (phase === "config" && !projectName) {
      try {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
      } catch {}
    }
  }, [projectName, chatId, phase]);

  // V2 §7.4: restore active project on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_PROJECT_KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as ActiveProjectState;
      if (!state?.name) return;
      setProjectName(state.name);
      setChatId(state.chatId ?? null);
      setPhase(state.phase);
      setHistoryKey((k) => k + 1);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NOTE: Do NOT delete the chat on unmount. PPT chats are persistent
  // and should remain accessible from the history panel.

  // V2 polling: detect phase transitions from backend status
  useEffect(() => {
    if (!projectName) return;
    if (phase !== "generating" && phase !== "producing" && phase !== "exporting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;

      if (generationStartRef.current && phase === "generating") {
        const elapsed = Date.now() - generationStartRef.current;
        if (elapsed > 30 * 60 * 1000) {
          return;
        }
      }

      try {
        const res = await fetchPptExportStatus(token, projectName!);
        if (cancelled) return;
        setHasPptxOutput(res.hasPptxOutput);
        setPipelineStage(res.pipelineStage ?? "init");

        // V2 phase transitions
        const v2Phase = (res as { phase?: string }).phase;
        if (v2Phase) {
          if (v2Phase === "outline" && phase === "generating") {
            setPhase("outline");
            generationStartRef.current = null;
            return;
          }
          if (v2Phase === "review" && phase === "producing") {
            setPhase("review");
            return;
          }
          if (v2Phase === "done") {
            await markPptGenerating(token, projectName!, "finish").catch(() => {});
            setPhase("done");
            setHistoryKey((k) => k + 1);
            generationStartRef.current = null;
            return;
          }
        }

        // Fallback: legacy done detection
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
      const displayText = config.mode === "template"
        ? `请基于模版制作一份 PPT。\n项目名：${name}`
        : `请制作一份 PPT。\n项目名：${name}`;
      await markPptGenerating(token, name, "start");
      const newChatId = await client.newChat(5_000, false, null, "ppt");
      setChatId(newChatId);
      setDisplayContentMap((prev) => ({ ...prev, [newChatId]: displayText }));
      await savePptChatId(token, name, newChatId);
      client.sendMessage(newChatId, prompt);
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to start PPT generation", e);
    }
  }, [client, config, token]);

  // V2: Outline locked → wake up Agent to continue with spec_lock generation
  const handleOutlineLocked = useCallback(async () => {
    if (!projectName || !chatId) return;
    setPhase("producing");
    const wakeMsg = [
      "PPT 大纲已在 UI 中确认。",
      "请读取当前项目 page_visual_plan.json，按其页面顺序和内容同步重建 design_spec.md，",
      "再按 templates/spec_lock_reference.md 生成完整 spec_lock.md。",
      "随后继续 Step 5 和 Step 6；全部 SVG 通过质量检查且备注齐全后写入 .review_ready，",
      "停止在 Step 7 之前，等待逐页确认。",
    ].join("");
    client.sendMessage(chatId, wakeMsg);
    generationStartRef.current = Date.now();
  }, [projectName, chatId, client]);

  // V2 §5.4: single page regenerate → wake up Agent
  const handlePageRegenerate = useCallback(
    async (file: string) => {
      if (!projectName || !chatId) return;
      setPhase("producing");
      const wakeMsg = [
        `请重新生成当前 PPT 项目的 ${file}。`,
        "只修改该页，保留其他页面；完成后重新运行 SVG 质量检查，",
        "通过后更新 .review_ready，并再次停止在 Step 7 之前。",
      ].join("");
      client.sendMessage(chatId, wakeMsg);
      generationStartRef.current = Date.now();
    },
    [projectName, chatId, client],
  );

  // V2 §5.5: all pages confirmed → request export via Agent
  const handleAllConfirmed = useCallback(async () => {
    if (!projectName || !chatId) return;
    setPhase("exporting");
    const wakeMsg = [
      "所有 PPT 页面已在 UI 中确认。请执行 Step 7 后处理与导出，",
      "保持现有模版、动画、音频和导出参数约束。完成后报告导出文件。",
    ].join("");
    client.sendMessage(chatId, wakeMsg);
    generationStartRef.current = Date.now();
  }, [projectName, chatId, client]);

  const handleDownload = useCallback(async (name?: string) => {
    const project = name ?? projectName;
    if (!project) return;
    const base = await getApiBase();
    const url = `${base}/api/ppt/download?project=${encodeURIComponent(project)}&token=${encodeURIComponent(token)}`;

    if (isTauri()) {
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        const filePath = await save({
          defaultPath: `${project}.pptx`,
          filters: [{ name: "PowerPoint", extensions: ["pptx"] }],
        });
        if (!filePath) return;
        const res = await httpFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.arrayBuffer();
        await writeFile(filePath, new Uint8Array(blob));
      } catch (e) {
        console.error("PPT download failed", e);
      }
      return;
    }

    const link = document.createElement("a");
    link.href = url;
    link.download = `${project}.pptx`;
    link.click();
  }, [projectName, token]);

  const handleSelectProject = useCallback((project: PptProject) => {
    setProjectName(project.name);
    setChatId(project.chatId);
    setHasPptxOutput(project.hasPptxOutput);
    const isDone = project.status === "done" || project.hasExport;
    // V2: use backend phase if available, otherwise fallback to legacy
    const v2Phase = (project as PptProject & { phase?: string }).phase;
    if (v2Phase) {
      setPhase(v2Phase as PptPhase);
    } else {
      setPhase(isDone ? "done" : "generating");
    }
    // Set displayContent for historical project's chat
    if (project.chatId && !displayContentMap[project.chatId]) {
      setDisplayContentMap((prev) => ({
        ...prev,
        [project.chatId!]: `请制作一份 PPT。\n项目名：${project.name}`,
      }));
    }
  }, [displayContentMap]);

  const handleDeleteProject = useCallback((name: string) => {
    if (name === projectName) {
      setPhase("config");
      setChatId(null);
      setProjectName(null);
      try {
        localStorage.removeItem(ACTIVE_PROJECT_KEY);
      } catch {}
    };
  }, [projectName]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        {sidebarCollapsed ? (
          <div className="flex w-[40px] shrink-0 flex-col items-center border-r border-border/70 bg-muted/30 py-2">
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => setSidebarCollapsed(false)}
              title="展开侧栏"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
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
                <PptConfigPanel
                  config={config}
                  setConfig={setConfig}
                  phase={phase}
                  onStart={handleStartGeneration}
                />
              ) : (
                <PptHistory
                  key={historyKey}
                  onSelect={handleSelectProject}
                  onDownload={handleDownload}
                  onDelete={handleDeleteProject}
                />
              )}
            </div>
          </aside>
        )}

        <div className="flex min-h-0 flex-1 flex-col">
          {phase === "config" ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              选择模板和输入主题后开始生成
            </div>
          ) : phase === "outline" && projectName ? (
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">
                <PptOutlinePhase
                  projectName={projectName}
                  token={token}
                  onLocked={handleOutlineLocked}
                />
              </div>
              <div className="w-[400px] shrink-0 border-l border-border/70">
                <PptChatPanel
                  key={chatId ?? "empty"}
                  chatId={chatId}
                  onStreamingChange={setIsStreaming}
                  displayContentMap={displayContentMap}
                  ref={chatPanelRef}
                />
              </div>
            </div>
          ) : phase === "review" && projectName ? (
            <PptReviewPhase
              projectName={projectName}
              token={token}
              chatId={chatId}
              displayContentMap={displayContentMap}
              isStreaming={isStreaming}
              onStreamingChange={setIsStreaming}
              onRegenerate={handlePageRegenerate}
              onAllConfirmed={handleAllConfirmed}
            />
          ) : (
            <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
              <ResizablePanel defaultSize={60} minSize={25}>
                <PptPreview projectName={projectName} isStreaming={isStreaming} hasPptxOutput={hasPptxOutput} pipelineStage={pipelineStage} />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={40} minSize={20}>
                <PptChatPanel key={chatId ?? "empty"} chatId={chatId} onStreamingChange={setIsStreaming} displayContentMap={displayContentMap} ref={chatPanelRef} />
              </ResizablePanel>
            </ResizablePanelGroup>
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

  if (config.mode === "template" && config.templateFile) {
    return buildTemplateModePrompt(config, projectName);
  }

  const usesNativeTemplate = Boolean(
    config.templateKey && config.templateKind === "native",
  );

  const hasPptxSource = config.sourceFiles.some((f) =>
    f.toLowerCase().endsWith(".pptx"),
  );

  if (hasPptxSource) {
    parts.push("请将现有 PPT 转换为网页版 PPT，保留原有内容和设计意图。");
  } else {
    parts.push("请制作一份 PPT。");
  }

  // Project identity
  parts.push(`项目名：${projectName}`);
  parts.push(`项目目录：ppt_projects/（init 时加 --dir ppt_projects）`);

  // --- Mandatory reference reads ---
  // The SKILL.md is already injected as an always-skill. These reminders
  // reinforce the most frequently violated rules — keep them short.
  parts.push("");
  parts.push("⚠️ 关键规则提醒（详见 mona-ppt SKILL.md）：");
  parts.push("- Step 5：当 design_spec 有需要图片的行时，用 web_search 搜图，用 web_fetch 下载一张到 <project_path>/images/，然后审查图片质量和内容相关性；如果不符合要求，继续下载其他搜索结果；如果 web_search 不可用，再用 generate_image 工具生图");
  if (usesNativeTemplate) {
    parts.push("- 自定义模板模式：仍按正常 SVG 高质量管线生成和质检，导出时用 svg_to_pptx.py 加 --template-underlay");
  } else {
    parts.push("- Step 7：导出只能用 svg_to_pptx.py，禁止自创脚本（convert.js / pptxgenjs 等）");
    parts.push("- SVG 颜色用 #RRGGBB 格式，不要用 rgba()，渐变透明度用 stop-opacity 属性");
  }

  // --- Eight Confirmations pre-fill ---
  // User has already configured preferences in the UI. Present these as
  // the confirmed Eight Confirmations — the AI should output the full
  // confirmation block and auto-proceed (user already confirmed via UI).

  const confirmations: string[] = [];

  // a. Canvas format
  confirmations.push(`画布格式：${config.canvasFormat}`);

  // b. Page count
  if (config.pageCount != null) {
    confirmations.push(`页数：${config.pageCount} 页`);
  } else {
    confirmations.push("页数：AI 推荐");
  }

  // c. Audience
  if (config.audience.trim()) {
    confirmations.push(`目标受众：${config.audience.trim()}`);
  } else {
    confirmations.push("目标受众：AI 推荐");
  }

  // d. Style mode + descriptor
  if (config.styleMode) {
    const modeLabel: Record<PptStyleMode, string> = {
      general: "General Versatile（视觉冲击优先）",
      consulting: "General Consulting（数据清晰优先）",
      "top-consulting": "Top Consulting（逻辑说服优先）",
    };
    confirmations.push(`风格模式：${modeLabel[config.styleMode]}`);
  } else {
    confirmations.push("风格模式：AI 推荐");
  }
  if (config.styleDescriptor.trim()) {
    confirmations.push(`视觉风格描述：${config.styleDescriptor.trim()}`);
  }

  // e. Color scheme
  if (config.primaryColor.trim()) {
    confirmations.push(`主色调：${config.primaryColor.trim()}`);
  } else {
    confirmations.push("主色调：AI 推荐");
  }

  // f. Icon approach + library
  if (config.iconApproach) {
    const iconLabel: Record<PptIconApproach, string> = {
      emoji: "Emoji",
      ai: "AI 生成图标",
      builtin: "内置图标库",
      custom: "自定义图标",
    };
    confirmations.push(`图标方案：${iconLabel[config.iconApproach]}`);
    if (config.iconApproach === "builtin" && config.iconLibrary) {
      confirmations.push(`图标库：${config.iconLibrary}`);
    }
  } else {
    confirmations.push("图标方案：AI 推荐");
  }

  // g. Formula policy
  if (config.formulaPolicy) {
    const formulaLabel: Record<PptFormulaPolicy, string> = {
      mixed: "混合（复杂公式渲染为图片，简单公式保留文本）",
      "render-all": "全部渲染为图片",
      "text-only": "全部保留为可编辑文本",
    };
    confirmations.push(`公式渲染策略：${formulaLabel[config.formulaPolicy]}`);
  } else {
    confirmations.push("公式渲染策略：AI 推荐（默认 mixed）");
  }

  // h. Image approach
  const effectiveImageApproach = config.imageApproach ?? (
    config.imageMode === "none" ? "none"
    : config.imageMode === "rich" ? "ai"
    : null
  );
  if (effectiveImageApproach) {
    const imgLabel: Record<PptImageApproach, string> = {
      none: "不使用图片",
      user: "仅使用用户提供的图片",
      ai: "AI 生成图片",
      web: "网络搜索图片",
      placeholder: "使用占位图",
    };
    confirmations.push(`图片方案：${imgLabel[effectiveImageApproach]}`);
  } else if (config.imageMode === "key-pages") {
    confirmations.push("图片方案：仅在关键页使用 AI 图片（必须执行 Step 5 Image Acquisition Phase，为封面页和关键内容页生成 AI 图片）");
  } else {
    confirmations.push("图片方案：AI 推荐");
  }

  // Visual mode
  if (config.visualMode !== "auto") {
    const visualModeText: Record<Exclude<PptVisualMode, "auto">, string> = {
      data: "数据图表优先",
      process: "流程图/架构图优先",
    };
    confirmations.push(`表达策略：${visualModeText[config.visualMode]}`);
  }

  parts.push("");
  parts.push("以下为用户在 UI 中已确认的八项确认内容，请在 Step 4 展示完整确认结果后自动推进（用户已确认，无需再询问）：");
  parts.push(confirmations.map((c) => `- ${c}`).join("\n"));

  // --- Template selection ---
  // Important: no template selected means no template instructions at all.
  // This preserves the existing PPT generation path.
  if (config.templateKey && config.templateKind) {
    if (usesNativeTemplate) {
      parts.push(`使用自定义模板：${config.templateKey}（路径：mona/skills/mona-ppt/templates/native/${config.templateKey}）`);
      parts.push("⚠️ 自定义模板硬约束（必须遵守）：");
      parts.push("- 读取 references/native-pptx-template-mode.md");
      parts.push("- 把该 PPTX 的第一页当作每页通用底板，不要判断封面/目录/致谢等角色");
      parts.push("- Step 4/5/6 仍按正常 SVG 管线执行：design_spec、spec_lock、AI 图片、图表、流程图、SVG 质量检查都不能跳过");
      parts.push("- 不要输出 native_content_plan.json，不要使用 native_pptx_builder.py");
      parts.push("- Step 7 导出命令必须加底板参数：python mona/skills/mona-ppt/scripts/svg_to_pptx.py <project_path> --template-underlay mona/skills/mona-ppt/templates/native/<template_id>/template.pptx");
    } else if (config.templateKind === "brand") {
      parts.push(`使用品牌：${config.templateKey}（路径：mona/skills/mona-ppt/templates/brands/${config.templateKey}）`);
      parts.push("⚠️ 品牌模板只控制视觉风格（颜色、字体、Logo），不固定页面版式");
      parts.push("⚠️ 品牌模板导出时 Step 7.3 必须加 --template 参数：python mona/skills/mona-ppt/scripts/svg_to_pptx.py <project_path> --template <brand_dir>/template.pptx");
    } else {
      const kindLabel = "布局模板";
      parts.push(`使用模板：${kindLabel} ${config.templateKey}（路径：mona/skills/mona-ppt/templates/layouts/${config.templateKey}）`);
    }
  }

  // --- Source material ---
  if (config.sourceFiles.length > 0) {
    const filePaths = config.sourceFiles.map((p) => `  - ${p}`).join("\n");
    parts.push(`源文件：\n${filePaths}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}`);
  }

  // --- Export options ---
  const exportOpts: string[] = [];
  if (config.pageTransition !== "fade") {
    exportOpts.push(`页面过渡：${config.pageTransition}`);
  }
  if (config.entranceAnimation !== "auto") {
    exportOpts.push(`入场动画：${config.entranceAnimation}`);
  }
  if (config.animationTrigger !== "after-previous") {
    exportOpts.push(`动画触发：${config.animationTrigger}`);
  }
  if (config.autoAdvance != null) {
    exportOpts.push(`自动翻页：${config.autoAdvance} 秒`);
  }
  if (config.enableNarration) {
    exportOpts.push("启用朗读：是（导出时运行 generate-audio 工作流）");
  }
  if (config.mergeParagraphs) {
    exportOpts.push("合并段落：是（--merge-paragraphs）");
  }
  if (exportOpts.length > 0) {
    parts.push(`导出选项：${exportOpts.join("；")}`);
  }

  return parts.join("\n");
}

function buildTemplateModePrompt(config: PptConfig, projectName: string): string {
  const parts: string[] = [];

  parts.push("请基于用户提供的 PPTX 模版制作一份 PPT（模版编辑模式）。");
  parts.push("");
  parts.push(`项目名：${projectName}`);
  parts.push(`项目目录：ppt_projects/（init 时加 --dir ppt_projects）`);
  parts.push(`模版文件：${config.templateFile}`);
  parts.push("");
  parts.push("⚠️ 关键规则提醒（详见 mona-ppt SKILL.md 的模版编辑模式）：");
  parts.push("- 读取 references/template-edit-mode.md 并严格遵守其执行纪律");
  parts.push("- 本模式使用 officecli 直接编辑模版副本，禁止走 SVG 管线，禁止使用 svg_to_pptx.py / native_pptx_builder.py");
  parts.push("- 先用 officecli get 分析模版结构（slide master / layout / placeholder / 主题色 / 字体），再制定内容映射计划");
  parts.push("- 所有修改用 officecli set/add/batch 完成，保持模版原有母版、版式、字体、配色不变");
  parts.push("- 完成后将最终 pptx 复制到 <project_path>/exports/ 目录");

  if (config.pageCount != null) {
    parts.push(`页数：${config.pageCount} 页`);
  }
  if (config.audience.trim()) {
    parts.push(`目标受众：${config.audience.trim()}`);
  }

  if (config.sourceFiles.length > 0) {
    const filePaths = config.sourceFiles.map((p) => `  - ${p}`).join("\n");
    parts.push(`源文件：\n${filePaths}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}`);
  }

  return parts.join("\n");
}
