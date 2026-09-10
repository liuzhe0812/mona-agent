import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCircle2, Download, FolderOpen, Loader2, MessageSquareText, PanelLeft, PanelLeftClose, Pencil, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useClient } from "@/providers/ClientProvider";
import { fetchPptExportStatus, fetchPptProjectPath, fetchPptProjects, markPptGenerating, savePptChatId, getApiBase } from "@/lib/api";
import { generateProjectName } from "@/lib/project-name";
import { isTauri, httpFetch } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useBreakpoint, type Breakpoint } from "@/hooks/useBreakpoint";
import type { PptProject } from "@/lib/types";
import { PptConfigWizard } from "./PptConfigWizard";
import { PptChatPanel } from "./PptChatPanel";
import type { PptChatPanelHandle } from "./PptChatPanel";
import { PptPreview } from "./PptPreview";
import { PptHistory } from "./PptHistory";
import { PptOutlinePhase } from "./PptOutlinePhase";
import type { PptGenerationMode } from "./PptOutlinePhase";
import { PptProducingPhase } from "./PptProducingPhase";

export type PptPhase = "config" | "generating" | "outline" | "producing" | "exporting" | "done";
export type PptMode = "design" | "template";

// Export options — collected at export time, not at startup.
export type PptPageTransition = "fade" | "push" | "wipe" | "split" | "strips" | "cover" | "random" | "none";
export type PptEntranceAnimation = "auto" | "none" | "fade" | "fly" | "zoom" | "wipe" | "mixed";
export type PptAnimationTrigger = "after-previous" | "with-previous" | "on-click";

export interface PptConfig {
  // --- Basic ---
  mode: PptMode;
  templateKey: string | null;
  templateKind: "layout" | "brand" | "native" | null;
  templateFile: string | null;
  sourceFiles: string[];
  topic: string;

  // --- Design Preferences (minimal — AI recommends the rest) ---
  pageCount: number | null;
}

export interface EmbeddedPptProject {
  name: string;
  phase: PptPhase;
}

interface PptMakerViewProps {
  embedded?: boolean;
  hostChatId?: string | null;
  hostIsStreaming?: boolean;
  initialProject?: EmbeddedPptProject | null;
  onProjectChange?: (project: EmbeddedPptProject | null) => void;
  onSendPptTurn?: (content: string, displayContent?: string) => void;
  onRequestPptCreation?: (request: string) => void;
  onOpenGeneratedPptx?: (projectName: string) => void | Promise<void>;
}

export interface PptExportOptions {
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
  sourceFiles: [],
  topic: "",

  pageCount: null,
};

export const DEFAULT_EXPORT_OPTIONS: PptExportOptions = {
  pageTransition: "fade",
  entranceAnimation: "auto",
  animationTrigger: "after-previous",
  autoAdvance: null,
  enableNarration: false,
  mergeParagraphs: false,
};

const ACTIVE_PROJECT_KEY = "mona.ppt.activeProject";
const SIDEBAR_COLLAPSED_KEY = "mona.ppt.sidebarCollapsed";
const SIDEBAR_WIDTH_KEY = "mona.ppt.sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 360;

interface ActiveProjectState {
  name: string;
  chatId: string | null;
  phase: PptPhase;
}

/** Valid phase transitions. Stale responses must not regress the phase. */
const PHASE_ORDER: Record<PptPhase, number> = {
  config: 0, generating: 1, outline: 2, producing: 3, exporting: 4, done: 5,
};

/** Return the next phase, or null if the transition is invalid/regressive.
 *  Exported for unit tests (phase machine regression locks). */
export function resolveNextPhase(current: PptPhase, backend: string): PptPhase | null {
  const target = backend as PptPhase;
  if (!(target in PHASE_ORDER)) return null;
  // Only allow forward transitions (or staying at the same phase)
  if (PHASE_ORDER[target] < PHASE_ORDER[current]) return null;
  return target;
}

const STEPS: ReadonlyArray<{ label: string; phases: PptPhase[] }> = [
  { label: "准备内容", phases: ["config", "generating"] },
  { label: "确认大纲", phases: ["outline"] },
  { label: "逐页设计", phases: ["producing"] },
  { label: "导出交付", phases: ["exporting", "done"] },
];

function getStepStatus(stepIndex: number, currentPhase: PptPhase): "completed" | "current" | "pending" {
  const currentStepIndex = STEPS.findIndex((s) => s.phases.includes(currentPhase));
  if (currentStepIndex === -1) return "pending";
  if (stepIndex < currentStepIndex) return "completed";
  if (stepIndex === currentStepIndex) return "current";
  return "pending";
}

export function PptMakerView({
  embedded = false,
  hostChatId = null,
  hostIsStreaming = false,
  initialProject = null,
  onProjectChange,
  onSendPptTurn,
  onRequestPptCreation,
  onOpenGeneratedPptx,
}: PptMakerViewProps = {}) {
  const { client, token } = useClient();
  const windowBp = useBreakpoint();
  const rootRef = useRef<HTMLDivElement>(null);
  const [embeddedWidth, setEmbeddedWidth] = useState(0);
  const bp: Breakpoint = embedded
    ? embeddedWidth > 0 && embeddedWidth < 480
      ? "narrow"
      : embeddedWidth > 0 && embeddedWidth <= 800
        ? "medium"
        : "wide"
    : windowBp;
  const [phase, setPhase] = useState<PptPhase>(initialProject?.phase ?? "config");
  const [config, setConfig] = useState<PptConfig>(DEFAULT_CONFIG);
  const [exportOptions, setExportOptions] = useState<PptExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [chatId, setChatId] = useState<string | null>(hostChatId);
  const [projectName, setProjectName] = useState<string | null>(initialProject?.name ?? null);
  const [startError, setStartError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const chatIdRef = useRef<string | null>(null);
  const generationStartRef = useRef<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [hasPptxOutput, setHasPptxOutput] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<string>("init");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  const chatPanelRef = useRef<PptChatPanelHandle>(null);
  const [displayContentMap, setDisplayContentMap] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [requestingWorkflow, setRequestingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);

  // V3 streaming→refresh trigger: increments when AI finishes a reply
  // (streaming transitions from true → false). PptOutlinePhase and
  // PptProducingPhase subscribe to this counter to refresh their data
  // immediately, mirroring the VideoMakerView pattern.
  const wasStreamingRef = useRef(false);
  const onProjectChangeRef = useRef(onProjectChange);

  useEffect(() => {
    onProjectChangeRef.current = onProjectChange;
  }, [onProjectChange]);
  const refreshStatusRef = useRef<(() => Promise<void>) | null>(null);
  const [aiTurnComplete, setAiTurnComplete] = useState(0);

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  useEffect(() => {
    if (!embedded) return;
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setEmbeddedWidth(entry?.contentRect.width ?? root.clientWidth);
    });
    observer.observe(root);
    setEmbeddedWidth(root.clientWidth);
    return () => observer.disconnect();
  }, [embedded]);

  useEffect(() => {
    if (!embedded) return;
    setChatId(hostChatId);
  }, [embedded, hostChatId]);

  useEffect(() => {
    if (!embedded || !initialProject) return;
    setRequestingWorkflow(false);
    setProjectName(initialProject.name);
    setPhase(initialProject.phase);
  }, [embedded, initialProject?.name, initialProject?.phase]);

  useEffect(() => {
    if (!embedded) return;
    setIsStreaming(hostIsStreaming);
    if (wasStreamingRef.current && !hostIsStreaming) {
      setAiTurnComplete((value) => value + 1);
      void refreshStatusRef.current?.();
    }
    wasStreamingRef.current = hostIsStreaming;
  }, [embedded, hostIsStreaming]);

  useEffect(() => {
    if (!embedded) return;
    onProjectChangeRef.current?.(projectName ? { name: projectName, phase } : null);
  }, [embedded, phase, projectName]);

  // V2 §7.4: persist active project to localStorage for cross-session recovery
  // 必须等恢复流程完成后才开始持久化：挂载时本 effect 先于恢复 effect 执行，
  // 若此时 projectName/phase 还是初始值，会把待恢复的存储状态提前清空。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (embedded) return;
    if (!restoredRef.current) return;
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
  }, [embedded, projectName, chatId, phase]);


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

  // 校验项目在后端实际存在，避免恢复已删除的项目导致后续 API 持续 404；
  // 同时用后端权威 phase 校正 localStorage 中可能过期的 phase。
  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(ACTIVE_PROJECT_KEY);
        if (!raw) return;
        const state = JSON.parse(raw) as ActiveProjectState;
        if (!state?.name) return;
        // 校验项目存在性：fetchPptExportStatus 在项目不存在时抛 ApiError(404)
        let backendPhase: string | null = null;
        try {
          const res = await fetchPptExportStatus(token, state.name);
          backendPhase = (res as { phase?: string }).phase ?? null;
        } catch {
          // 项目不存在，清理 localStorage 并回到 config
          try { localStorage.removeItem(ACTIVE_PROJECT_KEY); } catch {}
          return;
        }
        if (cancelled) return;
        setProjectName(state.name);
        setChatId(state.chatId ?? null);
        // 用后端 phase 校正 localStorage 中可能过期的 phase；
        // 仅允许前进迁移（resolveNextPhase 语义），防止过期响应回退阶段。
        const corrected = backendPhase
          ? (resolveNextPhase(state.phase, backendPhase) ?? state.phase)
          : state.phase;
        setPhase(corrected);
        if (corrected !== state.phase) {
          try {
            localStorage.setItem(
              ACTIVE_PROJECT_KEY,
              JSON.stringify({ ...state, phase: corrected }),
            );
          } catch {}
        }
        setHistoryKey((k) => k + 1);
      } catch {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded]);

  // NOTE: Do NOT delete the chat on unmount. PPT chats are persistent
  // and should remain accessible from the history panel.

  // V2: refresh project status from backend. Shared by the
  // ``ppt_phase_changed`` WebSocket push and the fallback polling below.
  const refreshStatus = useCallback(async () => {
    if (!projectName) return;
    try {
      const res = await fetchPptExportStatus(token, projectName);
      setHasPptxOutput(res.hasPptxOutput);
      setPipelineStage(res.pipelineStage ?? "init");

      const v2Phase = (res as { phase?: string }).phase;
      // 通过 resolveNextPhase 校验迁移方向，过期的响应不得回退阶段
      const next = v2Phase ? resolveNextPhase(phase, v2Phase) : null;
      if (next === "done") {
        setWorkflowError(null);
        await markPptGenerating(token, projectName, "finish").catch(() => {});
        setPhase("done");
        setHistoryKey((k) => k + 1);
        generationStartRef.current = null;
        return;
      }
      // 前进迁移：generating → outline / producing 等，由后端阶段驱动
      if (next && next !== phase) {
        setWorkflowError(null);
        setPhase(next);
        return;
      }

      // Fallback: legacy done detection
      if (res.status === "done" && res.hasExport) {
        setWorkflowError(null);
        await markPptGenerating(token, projectName, "finish").catch(() => {});
        setPhase("done");
        setHistoryKey((k) => k + 1);
        generationStartRef.current = null;
        return;
      }
      if (embedded && phase === "generating" && !hostIsStreaming) {
        setWorkflowError("大纲文件没有生成完成，请在对话中重新发送制作要求。");
      } else {
        setWorkflowError(null);
      }
    } catch {
      if (!embedded || !hostIsStreaming) {
        setWorkflowError("无法读取 PPT 制作状态，请重新检查。");
      }
    }
  }, [embedded, hostIsStreaming, phase, projectName, token]);
  refreshStatusRef.current = refreshStatus;

  const sendPptTurn = useCallback((content: string, displayContent?: string) => {
    if (!chatId) return;
    if (embedded) {
      if (onSendPptTurn) onSendPptTurn(content, displayContent);
      else client.sendMessage(chatId, content, undefined, { agentKind: "ppt", displayContent });
    } else {
      client.sendMessage(chatId, content);
    }
  }, [chatId, client, embedded, onSendPptTurn]);

  // AI 结束一次回复时立即刷新项目阶段：大纲/页面文件由 Agent 在 chat 中写入，
  // generating → outline 没有服务端推送源，不能干等 30s 兜底轮询。
  const handleStreamingChange = useCallback(
    (streaming: boolean) => {
      setIsStreaming(streaming);
      if (wasStreamingRef.current && !streaming) {
        // AI just finished a reply — trigger refresh in outline/producing phases
        setAiTurnComplete((n) => n + 1);
        void refreshStatus();
      }
      wasStreamingRef.current = streaming;
    },
    [refreshStatus],
  );

  // PPT-302: server pushes phase changes over WebSocket; refresh immediately.
  // The event is only a trigger — authoritative state comes from refreshStatus.
  useEffect(() => {
    if (!projectName) return;
    return client.onPptPhaseChanged(({ projectName: changed }) => {
      if (changed !== projectName) return;
      void refreshStatus();
    });
  }, [client, projectName, refreshStatus]);

  // Fallback polling (30s): covers WebSocket disconnects; the primary trigger
  // is the ppt_phase_changed broadcast above.
  useEffect(() => {
    if (!projectName) return;
    if (phase !== "generating" && phase !== "producing" && phase !== "exporting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      await refreshStatus();
      if (!cancelled) {
        timer = setTimeout(poll, 30000);
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, projectName, refreshStatus]);



  const handleStartGeneration = useCallback(async () => {
    setStartError(null);
    if (embedded && onRequestPptCreation) {
      const request = [
        "请制作一份 PPT。",
        config.topic ? `主题：${config.topic}` : "",
        config.pageCount != null ? `页数：${config.pageCount} 页` : "",
      ].filter(Boolean).join("\n");
      setRequestingWorkflow(true);
      onRequestPptCreation(request);
      return;
    }
    // 拉取已有项目名用于重名去重；失败不阻塞创建
    let existingNames: string[] = [];
    try {
      const res = await fetchPptProjects(token);
      existingNames = res.projects.map((p) => p.name);
    } catch {
      // best-effort
    }
    const name = generateProjectName(config.topic, existingNames, "未命名演示");
    try {
      setProjectName(name);
      const prompt = buildPptPrompt(config, name);
      const displayText = config.mode === "template"
        ? `请基于模版制作一份 PPT。\n项目名：${name}`
        : `请制作一份 PPT。\n项目名：${name}`;
      await markPptGenerating(token, name, "start");
      const newChatId = embedded
        ? hostChatId
        : await client.newChat(5_000, false, null, "ppt");
      if (!newChatId) throw new Error("当前主会话尚未就绪");
      setChatId(newChatId);
      setDisplayContentMap((prev) => ({ ...prev, [newChatId]: displayText }));
      await savePptChatId(token, name, newChatId);
      if (embedded) {
        if (onSendPptTurn) onSendPptTurn(prompt, displayText);
        else client.sendMessage(newChatId, prompt, undefined, { agentKind: "ppt", displayContent: displayText });
      } else {
        client.sendMessage(newChatId, prompt);
      }
      setPhase("generating");
      generationStartRef.current = Date.now();
    } catch (e) {
      console.error("Failed to start PPT generation", e);
      // 启动失败：清理项目状态，尽力结束后端 generating 标记，保留配置并展示错误
      setProjectName(null);
      setChatId(null);
      await markPptGenerating(token, name, "finish").catch(() => {});
      setStartError(e instanceof Error ? e.message : "启动生成失败，请重试");
    }
  }, [client, config, embedded, hostChatId, onRequestPptCreation, onSendPptTurn, token]);

  // V3: Outline locked → generate page-by-page or finish the full deck.
  // 用户在大纲阶段可编辑页面内容（增删/重排/每页规格）和全局设计规格
  // （8 项确认在规格面板中直接修改，写回 design_spec_summary.json）。
  // [OUTLINE_CONFIRMED] 告知 AI 读取最新的 design_spec_summary.json 同步
  // design_spec.md，再生成 spec_lock.md。
  const handleOutlineLocked = useCallback(async (mode: PptGenerationMode) => {
    if (!projectName || !chatId) return;
    setPhase("producing");
    const shared = [
      `project_path: ppt_projects/${projectName}`,
      "",
      "1. 读取最终 page_visual_plan.json 和 design_spec_summary.json，以最新内容同步重建 design_spec.md。",
      "2. 按 templates/spec_lock_reference.md 生成完整 spec_lock.md。",
      "3. 如需 Step 5 图片获取，执行完毕。",
    ];
    const wakeMsg = mode === "all"
      ? [
          "[OUTLINE_CONFIRMED_ALL]",
          ...shared,
          "4. 启动 Flask live preview，并输出设计参数确认。",
          "5. 按 page_visual_plan.json 顺序手写全部页面 SVG；每页输出 required trace、完成该页质量检查并写入 notes/ 备注，不在页面之间等待确认。",
          "6. 全部页面完成后运行全量 svg_quality_checker.py，修复全部 error。",
          "7. 依次运行 total_md_split.py、finalize_svg.py、svg_to_pptx.py 完成导出。",
          "8. 报告最终 PPTX 路径。",
        ].join("\n")
      : [
          "[OUTLINE_CONFIRMED]",
          ...shared,
          "4. 启动 Flask live preview。",
          "5. 仅生成第 1 页 SVG，写入 svg_output/，输出 required trace line。",
          "6. 对该页运行 svg_quality_checker.py，修复 error。",
          "7. 写该页备注到 notes/。",
          "8. 停止，告知用户第 1 页已生成，请预览确认。",
          "9. 不要生成其他页，不要进入 Step 7，不要写 .review_ready。",
        ].join("\n");
    sendPptTurn(
      wakeMsg,
      mode === "all" ? "已确认 PPT 大纲，开始全部生成" : "已确认 PPT 大纲，继续逐页设计",
    );
    generationStartRef.current = Date.now();
  }, [projectName, chatId, sendPptTurn]);

  // V3: page confirmed → request next page generation
  const handlePageConfirmed = useCallback(
    async (confirmedPageId: string, confirmedPageIndex: number, nextPageId: string, nextPageIndex: number) => {
      if (!projectName || !chatId) return;
      const wakeMsg = [
        "[PAGE_CONFIRMED_NEXT]",
        `project_path: ppt_projects/${projectName}`,
        `confirmed_page: ${confirmedPageId}`,
        `confirmed_page_index: ${confirmedPageIndex}`,
        `next_page_index: ${nextPageIndex}`,
        `next_page_id: ${nextPageId}`,
        "next_action: generate_next_page",
        "",
        `第 ${confirmedPageIndex} 页已确认。请生成第 ${nextPageIndex} 页：`,
        "1. 读取 spec_lock.md，确认锁定参数未变。",
        `2. 手写 svg_output/${nextPageId}.svg，输出 required trace line。`,
        "3. 对该页运行 svg_quality_checker.py，修复 error。",
        "4. 写该页备注到 notes/。",
        `5. 仅生成这一页，停止并告知用户第 ${nextPageIndex} 页已生成，请预览确认。`,
      ].join("\n");
      sendPptTurn(wakeMsg, `已确认第 ${confirmedPageIndex} 页，继续生成下一页`);
      generationStartRef.current = Date.now();
    },
    [projectName, chatId, sendPptTurn],
  );

  // V3: page redo (with optional spec edit) → wake up Agent
  const handlePageRegenerate = useCallback(
    async (pageIndex: number, pageId: string, feedback?: string, pageSpec?: Record<string, unknown>) => {
      if (!projectName || !chatId) return;
      const lines = [
        "[PAGE_REDO_REQUESTED]",
        `project_path: ppt_projects/${projectName}`,
        `page_index: ${pageIndex}`,
        `page_id: ${pageId}`,
      ];
      if (pageSpec && Object.keys(pageSpec).length > 0) {
        lines.push("page_spec:");
        for (const [k, v] of Object.entries(pageSpec)) {
          lines.push(`  ${k}: ${JSON.stringify(v)}`);
        }
      }
      lines.push(`feedback: ${feedback ?? ""}`);
      lines.push("next_action: redo_single_page");
      lines.push("");
      lines.push(`用户要求重做第 ${pageIndex} 页，规格可能已修改。`);
      lines.push("请按以下顺序处理：");
      lines.push("1. 如消息携带 page_spec，读取 page_visual_plan.json 中该页的最新规格（UI 已更新）。");
      lines.push("2. 重新读取 spec_lock.md，确认锁定的颜色/字体/图标/版式未变。");
      lines.push("3. 如规格涉及内容或数据修改，先同步 design_spec.md 和 notes/ 中该页备注。");
      lines.push(`4. 按新规格手写 svg_output/${pageId}.svg，输出 required trace line。`);
      lines.push("5. 对该页运行 svg_quality_checker.py，修复 error。");
      lines.push(`6. 停止，告知用户第 ${pageIndex} 页已重做，请预览确认。`);
      lines.push("7. 不要重新进入 Step 7 导出，不要改写其他页。");
      sendPptTurn(lines.join("\n"), `重新生成第 ${pageIndex} 页`);
      generationStartRef.current = Date.now();
    },
    [projectName, chatId, sendPptTurn],
  );

  // V3: skip to generate a specific page
  const handlePageGenerate = useCallback(
    async (pageIndex: number, pageId: string) => {
      if (!projectName || !chatId) return;
      const wakeMsg = [
        "[PAGE_GENERATE_REQUESTED]",
        `project_path: ppt_projects/${projectName}`,
        `page_index: ${pageIndex}`,
        `page_id: ${pageId}`,
        "next_action: generate_single_page",
        "",
        `请生成第 ${pageIndex} 页 svg_output/${pageId}.svg。`,
        "1. 读取 spec_lock.md，确认锁定参数未变。",
        "2. 手写该页 SVG，输出 required trace line。",
        "3. 对该页运行 svg_quality_checker.py，修复 error。",
        "4. 写该页备注到 notes/。",
        `5. 完成后停止，告知用户第 ${pageIndex} 页已生成，请预览确认。`,
      ].join("\n");
      sendPptTurn(wakeMsg, `生成第 ${pageIndex} 页`);
      generationStartRef.current = Date.now();
    },
    [projectName, chatId, sendPptTurn],
  );

  // V3: all pages confirmed → request export via Agent
  const handleAllConfirmed = useCallback(async () => {
    if (!projectName || !chatId) return;
    setPhase("exporting");

    // Build export options string from user-selected export settings
    const exportOpts: string[] = [];
    if (exportOptions.pageTransition !== "fade") {
      exportOpts.push(`页面过渡：${exportOptions.pageTransition}`);
    }
    if (exportOptions.entranceAnimation !== "auto") {
      exportOpts.push(`入场动画：${exportOptions.entranceAnimation}`);
    }
    if (exportOptions.animationTrigger !== "after-previous") {
      exportOpts.push(`动画触发：${exportOptions.animationTrigger}`);
    }
    if (exportOptions.autoAdvance != null) {
      exportOpts.push(`自动翻页：${exportOptions.autoAdvance} 秒`);
    }
    if (exportOptions.enableNarration) {
      exportOpts.push("为演示生成旁白音频");
    }
    if (exportOptions.mergeParagraphs) {
      exportOpts.push("合并连续文本段落");
    }

    const wakeMsg = [
      "[ALL_PAGES_CONFIRMED]",
      `project_path: ppt_projects/${projectName}`,
      "next_action: run_step_7_export",
      "",
      "用户已逐页确认所有页面。请执行 Step 7 后处理与导出：",
      "1. 运行全量 svg_quality_checker.py 作为最终门控。",
      "2. 依次运行：total_md_split.py → finalize_svg.py → svg_to_pptx.py。",
      "3. 报告完整项目相对路径。",
      ...(exportOpts.length > 0 ? ["", `导出选项：${exportOpts.join("；")}`] : []),
    ].join("\n");
    sendPptTurn(wakeMsg, "所有页面已确认，开始导出 PPTX");
    generationStartRef.current = Date.now();
  }, [projectName, chatId, exportOptions, sendPptTurn]);

  const handleOpenProjectDir = useCallback(async () => {
    if (!projectName) return;
    setOpenError(null);
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      const { path } = await fetchPptProjectPath(token, projectName);
      await openPath(path);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "无法打开项目目录");
    }
  }, [projectName, token]);

  const handleDownload = useCallback(async (name?: string) => {
    const project = name ?? projectName;
    if (!project) return;
    setDownloading(true);
    setDownloadError(null);
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
        if (!filePath) {
          setDownloading(false);
          return;
        }
        const res = await httpFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.arrayBuffer();
        await writeFile(filePath, new Uint8Array(blob));
      } catch (e) {
        console.error("PPT download failed", e);
        setDownloadError(e instanceof Error ? e.message : "下载失败");
      } finally {
        setDownloading(false);
      }
      return;
    }

    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project}.pptx`;
      link.click();
    } catch (e) {
      console.error("PPT download failed", e);
      setDownloadError(e instanceof Error ? e.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  }, [projectName, token]);

  const handleSelectProject = useCallback((project: PptProject) => {
    setProjectName(project.name);
    setChatId(project.chatId);
    setHasPptxOutput(project.hasPptxOutput);
    setDownloadError(null);
    const isDone = project.status === "done" || project.hasExport;
    const v2Phase = (project as PptProject & { phase?: string }).phase;
    // 从 config 基线解析后端阶段：校验阶段名合法，非法值回退到 done/outline 推断
    const restored = v2Phase ? resolveNextPhase("config", v2Phase) : null;
    setPhase(restored ?? (isDone ? "done" : "outline"));
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
    }
  }, [projectName]);

  const handleNewProject = useCallback(() => {
    setPhase("config");
    setProjectName(null);
    setChatId(null);
    setStartError(null);
    setDownloadError(null);
    setDownloading(false);
    setConfig(DEFAULT_CONFIG);
    setHasPptxOutput(false);
    setPipelineStage("init");
    try {
      localStorage.removeItem(ACTIVE_PROJECT_KEY);
    } catch {}
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
  const currentStepIndex = Math.max(0, STEPS.findIndex((step) => step.phases.includes(phase)));

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-background">
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
                <PptHistory
                  key={historyKey}
                  currentProjectName={projectName}
                  collapsed
                  onSelect={handleSelectProject}
                  onDownload={handleDownload}
                  onDelete={handleDeleteProject}
                />
              </div>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={handleNewProject}
                    aria-label="新建演示文稿"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  新建演示文稿
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
                  <FolderOpen className="h-3.5 w-3.5" />
                </div>
                <span className="text-[13px] font-semibold text-foreground">PPT</span>
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
              <PptHistory
                key={historyKey}
                currentProjectName={projectName}
                onSelect={handleSelectProject}
                onDownload={handleDownload}
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
                新建演示文稿
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
        ))}

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Step bar */}
          {embedded && bp !== "wide" ? (
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border/70 bg-background px-3 text-[11px]">
              <span className="font-medium text-foreground">
                {STEPS[currentStepIndex].label} · {currentStepIndex + 1}/4
              </span>
              <span className="text-muted-foreground">PPT 工作流</span>
            </div>
          ) : (
            <div className="flex shrink-0 items-center justify-center gap-1 border-b border-border/70 bg-background px-4 py-3">
              {STEPS.map((step, i) => {
                const status = getStepStatus(i, phase);
                return (
                  <div key={step.label} className="flex items-center">
                    {i > 0 && (
                      <div
                        className={cn(
                          "mx-2 h-px w-5",
                          getStepStatus(i - 1, phase) !== "pending" ? "bg-foreground/30" : "bg-border",
                        )}
                      />
                    )}
                    <div className="flex items-center gap-1.5">
                      <div
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
                          status === "completed" && "bg-emerald-500/15 text-emerald-600",
                          status === "current" && "bg-action text-white",
                          status === "pending" && "border border-border bg-background text-muted-foreground",
                        )}
                      >
                        {status === "completed" ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
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
          )}

          {embedded && requestingWorkflow ? (
            <div className="flex min-h-0 flex-1 items-center justify-center bg-editor-surface">
              <div className="flex flex-col items-center gap-3 text-[13px] text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <span className="font-medium">正在启动 PPT 工作流</span>
                <span className="text-[11px] text-muted-foreground/70">Mona 正在创建项目并准备大纲</span>
              </div>
            </div>
          ) : phase === "config" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto scrollbar-hover px-4 py-8">
              <div className="w-full max-w-[640px]">
                <h2 className="mb-6 text-title-sm font-medium">新建演示文稿</h2>
                <PptConfigWizard
                  config={config}
                  setConfig={setConfig}
                  phase={phase}
                  onStart={handleStartGeneration}
                />
                {startError && (
                  <div className="mt-4 text-[13px] text-destructive">
                    启动失败：{startError}
                  </div>
                )}
              </div>
            </div>
          ) : phase === "generating" && projectName ? (
            <ResponsiveChatLayout
              bp={bp}
              showChat={!embedded}
              chatOpen={chatSheetOpen}
              onChatOpenChange={setChatSheetOpen}
              chat={
                <PptChatPanel
                  key={chatId ?? "empty"}
                  chatId={chatId}
                  onStreamingChange={handleStreamingChange}
                  displayContentMap={displayContentMap}
                  ref={chatPanelRef}
                />
              }
            >
              <div className="flex min-h-0 flex-1 items-center justify-center bg-editor-surface">
                <div className="flex flex-col items-center gap-3 text-[13px] text-muted-foreground">
                  {workflowError ? (
                    <>
                      <span className="font-medium text-destructive">大纲生成未完成</span>
                      <span className="text-[11px] text-muted-foreground/70">{workflowError}</span>
                      <Button variant="outline" size="sm" onClick={() => void refreshStatus()}>
                        重新检查
                      </Button>
                    </>
                  ) : (
                    <>
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      <span className="font-medium">正在处理</span>
                      <span className="text-[11px] text-muted-foreground/70">
                        AI 正在分析素材并生成大纲，请稍候…
                      </span>
                    </>
                  )}
                </div>
              </div>
            </ResponsiveChatLayout>
          ) : phase === "outline" && projectName ? (
            <ResponsiveChatLayout
              bp={bp}
              showChat={!embedded}
              chatOpen={chatSheetOpen}
              onChatOpenChange={setChatSheetOpen}
              chat={
                <PptChatPanel
                  key={chatId ?? "empty"}
                  chatId={chatId}
                  onStreamingChange={handleStreamingChange}
                  displayContentMap={displayContentMap}
                  ref={chatPanelRef}
                />
              }
            >
              <PptOutlinePhase
                projectName={projectName}
                token={token}
                onLocked={handleOutlineLocked}
                refreshTrigger={aiTurnComplete}
                bp={bp}
                disabled={embedded && isStreaming}
              />
            </ResponsiveChatLayout>
          ) : phase === "producing" && projectName ? (
            <PptProducingPhase
              projectName={projectName}
              token={token}
              chatId={chatId}
              displayContentMap={displayContentMap}
              isStreaming={isStreaming}
              onStreamingChange={handleStreamingChange}
              onPageConfirmed={handlePageConfirmed}
              onPageRegenerate={handlePageRegenerate}
              onPageGenerate={handlePageGenerate}
              onAllConfirmed={handleAllConfirmed}
              exportOptions={exportOptions}
              setExportOptions={setExportOptions}
              bp={bp}
              embedded={embedded}
            />
          ) : phase === "exporting" && projectName ? (
            <ResponsiveChatLayout
              bp={bp}
              showChat={!embedded}
              chatOpen={chatSheetOpen}
              onChatOpenChange={setChatSheetOpen}
              chat={
                <PptChatPanel
                  key={chatId ?? "empty"}
                  chatId={chatId}
                  onStreamingChange={handleStreamingChange}
                  displayContentMap={displayContentMap}
                  ref={chatPanelRef}
                />
              }
            >
              <div className="flex min-h-0 flex-1 items-center justify-center bg-editor-surface">
                <div className="flex flex-col items-center gap-3 text-[13px] text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                  <span className="font-medium">正在处理</span>
                  <span className="text-[11px] text-muted-foreground/70">
                    正在整理页面并生成 PPTX，请稍候…
                  </span>
                </div>
              </div>
            </ResponsiveChatLayout>
          ) : (
            <>
              {phase === "done" && (
                <div className="flex shrink-0 items-center justify-between border-b border-border/70 bg-background px-4 py-2">
                  <div className="flex items-center gap-2 text-[13px]">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    <span className="font-medium">PPT 已生成</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {onOpenGeneratedPptx && projectName ? (
                      <Button
                        size="sm"
                        onClick={() => void onOpenGeneratedPptx(projectName)}
                        className="h-7 text-caption"
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        继续编辑
                      </Button>
                    ) : null}
                    {isTauri() && (
                      <Button variant="outline" size="sm" onClick={handleOpenProjectDir} className="h-7 text-[11px]">
                        <FolderOpen className="mr-1 h-3 w-3" />
                        打开项目目录
                      </Button>
                    )}
                    <Button size="sm" onClick={() => handleDownload()} disabled={downloading} className="h-7 text-[11px]">
                      {downloading ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Download className="mr-1 h-3 w-3" />
                      )}
                      下载 PPTX
                    </Button>
                  </div>
                </div>
              )}
              {phase === "done" && downloadError && (
                <div className="flex shrink-0 items-center justify-between border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-[11px] text-destructive">
                  <span>下载失败：{downloadError}</span>
                  <button
                    type="button"
                    className="ml-2 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
                    onClick={() => handleDownload()}
                  >
                    重新下载
                  </button>
                </div>
              )}
              {phase === "done" && openError && (
                <div className="flex shrink-0 items-center justify-between border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-[11px] text-destructive">
                  <span>打开目录失败：{openError}</span>
                  <button
                    type="button"
                    className="ml-2 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
                    onClick={handleOpenProjectDir}
                  >
                    重试
                  </button>
                </div>
              )}
              {!embedded && bp === "wide" ? (
                <ResizablePanelGroup direction="horizontal" className="min-h-0 flex-1">
                  <ResizablePanel defaultSize="60%" minSize="25%">
                    <PptPreview projectName={projectName} isStreaming={isStreaming} hasPptxOutput={hasPptxOutput} pipelineStage={pipelineStage} />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel defaultSize="40%" minSize="20%">
                    <PptChatPanel key={chatId ?? "empty"} chatId={chatId} onStreamingChange={handleStreamingChange} displayContentMap={displayContentMap} ref={chatPanelRef} />
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1">
                    <PptPreview projectName={projectName} isStreaming={isStreaming} hasPptxOutput={hasPptxOutput} pipelineStage={pipelineStage} />
                  </div>
                  {!embedded && <Sheet open={chatSheetOpen} onOpenChange={setChatSheetOpen}>
                    <SheetContent side="right" className="w-[400px] p-0 sm:max-w-[400px]">
                      <SheetHeader className="sr-only">
                        <SheetTitle>与 AI 讨论</SheetTitle>
                      </SheetHeader>
                      <PptChatPanel key={chatId ?? "empty"} chatId={chatId} onStreamingChange={handleStreamingChange} displayContentMap={displayContentMap} ref={chatPanelRef} />
                    </SheetContent>
                  </Sheet>}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Responsive layout wrapper: wide = split with chat panel, medium/narrow = full main + Sheet chat. */
function ResponsiveChatLayout({
  bp,
  showChat = true,
  chatOpen,
  onChatOpenChange,
  chat,
  children,
}: {
  bp: import("@/hooks/useBreakpoint").Breakpoint;
  showChat?: boolean;
  chatOpen: boolean;
  onChatOpenChange: (open: boolean) => void;
  chat: React.ReactNode;
  children: React.ReactNode;
}) {
  if (!showChat) {
    return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
  }
  const showChatInline = bp === "wide";
  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
        {children}
        {!showChatInline && (
          <div className="absolute bottom-4 right-4 z-10">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 gap-1 rounded-full shadow-md text-[11px]"
              onClick={() => onChatOpenChange(true)}
              aria-label="与 AI 讨论"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              与 AI 讨论
            </Button>
          </div>
        )}
      </div>
      {showChatInline && (
        <div className="w-[400px] shrink-0 border-l border-border/70">
          {chat}
        </div>
      )}
      {!showChatInline && (
        <Sheet open={chatOpen} onOpenChange={onChatOpenChange}>
          <SheetContent side="right" className="w-[400px] p-0 sm:max-w-[400px]">
            <SheetHeader className="sr-only">
              <SheetTitle>与 AI 讨论</SheetTitle>
            </SheetHeader>
            {chat}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

export function buildPptPrompt(config: PptConfig, projectName: string): string {
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

  // 激活 V3 UI 检查点模式：Agent 在 Step 4 生成大纲后停止等待 UI 确认，
  // 用户再选择逐页确认或一次生成全部页面。
  parts.push("PPT_UI_CHECKPOINTS=1");

  // Project identity
  parts.push(`项目名：${projectName}`);
  parts.push(`项目目录：ppt_projects/（init 时加 --dir ppt_projects）`);

  // --- Mandatory reference reads ---
  parts.push("");
  parts.push("⚠️ 关键规则提醒（详见 mona-ppt SKILL.md）：");
  parts.push("- Step 5：当 design_spec 有需要图片的行时，用 web_search 搜图，用 web_fetch 下载一张到 <project_path>/images/，然后审查图片质量和内容相关性；如果不符合要求，继续下载其他搜索结果；如果 web_search 不可用，再用 generate_image 工具生图");
  if (usesNativeTemplate) {
    parts.push("- 自定义模板模式：仍按正常 SVG 高质量管线生成和质检，导出时用 svg_to_pptx.py 加 --template-underlay");
  } else {
    parts.push("- Step 7：导出只能用 svg_to_pptx.py，禁止自创脚本（convert.js / pptxgenjs 等）");
    parts.push("- SVG 颜色用 #RRGGBB 格式，不要用 rgba()，渐变透明度用 stop-opacity 属性");
  }

  // --- User preferences (minimal — AI recommends the rest) ---
  const confirmations: string[] = [];

  // Page count (only if user specified)
  if (config.pageCount != null) {
    confirmations.push(`页数：${config.pageCount} 页`);
  } else {
    confirmations.push("页数：AI 推荐");
  }

  // All other 8-item confirmations are left to AI recommendation
  confirmations.push("风格模式：AI 推荐");
  confirmations.push("画布格式：AI 推荐（默认 ppt169）");
  confirmations.push("目标受众：AI 推荐");
  confirmations.push("主色调：AI 推荐");
  confirmations.push("图标方案：AI 推荐");
  confirmations.push("字体方案：AI 推荐");
  confirmations.push("图片方案：AI 推荐");

  parts.push("");
  parts.push("以下为用户在 UI 中已预填的偏好（值为「AI 推荐」的项由你按内容分析选定具体值）：");
  parts.push(confirmations.map((c) => `- ${c}`).join("\n"));
  parts.push("");
  parts.push("⚠️ V3 UI 检查点模式（PPT_UI_CHECKPOINTS=1）执行纪律：");
  parts.push("- Step 4：基于上述用户偏好完成八项确认分析，**不要把 8 项推荐作为聊天消息发出来等待用户回复**（这会阻塞 UI 流程）。");
  parts.push("- Step 4 必须写以下三个文件后停止：");
  parts.push("  1. design_spec.md（完整草稿，按 templates/design_spec_reference.md 结构）");
  parts.push("  2. page_visual_plan.json（schemaVersion=2, revision=0, pages 数组；每页必须含中文 title/summary/bullets/visual_type/layout/image_plan/notes/file/page 字段）");
  parts.push("  3. design_spec_summary.json（八项确认的结构化摘要，schema 见 SKILL.md V3 章节；用户偏好已明确的项直接填入，「AI 推荐」项由你选定具体值，不要写「AI 推荐」字符串到 JSON）");
  parts.push("- Step 4 禁止：不写 spec_lock.md；不进入 Step 5 图片获取；不进入 Step 6 SVG 生成；不写 .review_ready。");
  parts.push("- Step 4 结束时输出一行简短提示（不超过 2 句话）告知用户「大纲草稿已生成，请在 PPT 页面编辑每页内容后确认；如需调整全局设计规格请在规格面板中直接修改」，然后结束当前 turn。**不要在 chat 中重复 8 项推荐内容**——它们已经写入 design_spec_summary.json，UI 会读取展示。");
  parts.push("- 用户会在 UI 上编辑/增删/重排页面，确认后选择逐页生成或全部生成。收到 [OUTLINE_CONFIRMED] 时逐页生成；收到 [OUTLINE_CONFIRMED_ALL] 时一次生成全部页面并完成导出。");
  parts.push("- 用户可在 UI 的规格面板中直接修改全局 8 项规格（修改写回 design_spec_summary.json）。收到 [OUTLINE_CONFIRMED] 时务必重新读取 design_spec_summary.json，以其中最新值为准同步 design_spec.md 和 spec_lock.md。");

  // --- Template selection ---
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

  if (config.sourceFiles.length > 0) {
    const filePaths = config.sourceFiles.map((p) => `  - ${p}`).join("\n");
    parts.push(`源文件：\n${filePaths}`);
  } else if (config.topic) {
    parts.push(`主题：${config.topic}`);
  }

  return parts.join("\n");
}
