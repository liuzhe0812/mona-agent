import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Database,
  Loader2,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SystemTab } from "./mockData";
import {
  collectSystemEvidence,
  executeSystemAction,
  requestSystemPlan,
  type SystemActionResult,
  type SystemAgentAction,
  type SystemAgentPlan,
} from "./systemAgentApi";
import { primaryButtonClass, secondaryButtonClass, StatusPill } from "./SystemUi";
import type { StorageCleanupResult, StorageScanResult } from "./useSystemData";
import { SystemAgentChat } from "./SystemAgentChat";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";

type AgentStage = "idle" | "diagnosing" | "plan" | "running" | "done";
type AssistantViewMode = "planner" | "agent";

const DEFAULT_GOAL = "根据当前配置生成可执行的系统调整方案";
const suggestions = ["释放 C 盘可清理空间", "减少不必要的开机启动项", "调整系统配置提升响应速度"];
const evidenceSources: SystemTab[] = ["overview", "storage", "software", "startup", "optimization", "maintenance"];

const tabLabels: Record<SystemTab, string> = {
  overview: "概览",
  storage: "存储空间",
  software: "软件管理",
  startup: "启动项",
  optimization: "系统优化",
  maintenance: "维护记录",
};

function actionRisk(action: SystemAgentAction): "green" | "orange" {
  return action.risk === "low" ? "green" : "orange";
}

function actionRiskLabel(action: SystemAgentAction): string {
  return action.risk === "low" ? "低风险" : "需确认";
}

function cleanupResult(action: SystemAgentAction, cleanup: StorageCleanupResult): SystemActionResult {
  const success = cleanup.failures.length === 0;
  return {
    actionId: action.id,
    success,
    verified: success,
    detail: success
      ? `实际释放 ${cleanup.freedGb.toFixed(2)} GB`
      : `实际释放 ${cleanup.freedGb.toFixed(2)} GB；${cleanup.failures.join("；")}`,
  };
}

interface SystemAssistantProps {
  tab: SystemTab;
  requestId: number;
  storage: { result: StorageScanResult | null; clean: (ids: string[]) => Promise<StorageCleanupResult> };
  onNavigate: (tab: SystemTab) => void;
  collapsed: boolean;
  handoffTask: SystemAgentHandoffTask | null;
  onHandoffTaskHandled: (taskId: string) => void;
  onCollapse: () => void;
  analysisRequest: { goal: string; nonce: number } | null;
}

export function SystemAssistant({ tab, requestId, storage, onNavigate, collapsed, handoffTask, onHandoffTaskHandled, onCollapse, analysisRequest }: SystemAssistantProps) {
  const [stage, setStage] = useState<AgentStage>("idle");
  const [viewMode, setViewMode] = useState<AssistantViewMode>("planner");
  const [agentChatId, setAgentChatId] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [plan, setPlan] = useState<SystemAgentPlan | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<SystemActionResult[]>([]);
  const [error, setError] = useState("");
  const requestVersion = useRef(0);
  const wasCollapsed = useRef(collapsed);

  const startGoal = async (nextGoal: string) => {
    const normalizedGoal = nextGoal.trim();
    if (!normalizedGoal) return;
    setViewMode("planner");
    const version = ++requestVersion.current;
    setGoal(normalizedGoal);
    setPlan(null);
    setResults([]);
    setError("");
    setSelectedIds(new Set());
    setStage("diagnosing");
    setDrawerOpen(true);

    try {
      const evidence = await collectSystemEvidence(storage.result);
      const nextPlan = await requestSystemPlan(normalizedGoal, evidence);
      if (version !== requestVersion.current) return;
      setPlan(nextPlan);
      setSelectedIds(new Set(nextPlan.actions.map((action) => action.id)));
      setStage("plan");
    } catch (planError) {
      if (version !== requestVersion.current) return;
      setError(String(planError));
      setStage("idle");
    }
  };

  useEffect(() => {
    if (requestId > 0) {
      setDrawerOpen(true);
      void startGoal(DEFAULT_GOAL);
    }
  }, [requestId]);

  useEffect(() => {
    if (analysisRequest && analysisRequest.nonce > 0) {
      setDrawerOpen(true);
      void startGoal(analysisRequest.goal);
    }
  }, [analysisRequest?.nonce]);

  useEffect(() => {
    if (wasCollapsed.current && !collapsed && window.innerWidth < 1280) setDrawerOpen(true);
    wasCollapsed.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    if (!handoffTask) return;
    setDrawerOpen(true);
    setViewMode("agent");
  }, [handoffTask]);

  const navigateTo = (nextTab: SystemTab) => {
    onNavigate(nextTab);
    setDrawerOpen(false);
  };

  const closeAssistant = () => {
    setDrawerOpen(false);
    onCollapse();
  };

  const toggleAction = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const executeAction = async (action: SystemAgentAction): Promise<SystemActionResult> => {
    if (action.type === "storage_clean") return cleanupResult(action, await storage.clean(action.targetIds));
    return executeSystemAction(action);
  };

  const executePlan = async () => {
    if (!plan) return;
    const actions = plan.actions.filter((action) => selectedIds.has(action.id));
    if (actions.length === 0) return;
    setStage("running");
    setError("");
    const nextResults: SystemActionResult[] = [];
    for (const action of actions) {
      try {
        nextResults.push(await executeAction(action));
      } catch (actionError) {
        nextResults.push({ actionId: action.id, success: false, verified: false, detail: String(actionError) });
      }
      setResults([...nextResults]);
    }
    try {
      await collectSystemEvidence(storage.result);
    } catch {
      // The per-action result remains the source of truth when a broad refresh is unavailable.
    }
    setStage("done");
  };

  const selectedCount = selectedIds.size;
  const verifiedCount = results.filter((result) => result.verified).length;
  const failedCount = results.filter((result) => !result.success).length;

  return (
    <>
      {drawerOpen && <button type="button" aria-label="关闭 Mona 系统管家" onClick={closeAssistant} className="absolute inset-0 z-40 bg-slate-950/20 backdrop-blur-[1px] xl:hidden" />}

      <aside
        aria-label="Mona 系统管家"
        aria-hidden={collapsed}
        className={`absolute inset-y-0 right-0 z-50 flex min-h-0 w-full flex-col border-l border-border/70 bg-card shadow-2xl transition-transform duration-200 sm:w-[360px] xl:static xl:z-auto xl:w-auto xl:translate-x-0 xl:shadow-none ${collapsed ? "xl:pointer-events-none xl:bg-transparent" : "xl:bg-card"} ${drawerOpen ? "translate-x-0" : "translate-x-full xl:translate-x-0"}`}
      >
        <div className={`flex min-h-0 flex-1 flex-col ${collapsed ? "xl:hidden" : ""}`}>
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/70 px-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400"><Sparkles className="h-4 w-4" /></span>
          <div className="min-w-0"><h2 className="truncate text-sm font-semibold">Mona 系统管家</h2><p className="mt-0.5 text-[10px] text-muted-foreground">跨模块诊断与受控处置</p></div>
          {viewMode === "agent" && <button type="button" onClick={() => setViewMode("planner")} className="ml-auto text-xs text-blue-600 hover:underline">返回系统方案</button>}
          <button type="button" aria-label="关闭 Mona 系统管家" onClick={closeAssistant} className={`flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground xl:hidden ${viewMode === "agent" ? "" : "ml-auto"}`}><X className="h-4 w-4" /></button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          {viewMode === "agent" ? (
            <SystemAgentChat
              chatId={agentChatId}
              task={handoffTask}
              onChatCreated={setAgentChatId}
              onTaskHandled={onHandoffTaskHandled}
            />
          ) : (
            <>
          <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-hover">
            {stage === "idle" && (
              <div className="flex min-h-full flex-col">
                {error && <div role="alert" className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs leading-5 text-red-700 dark:text-red-400">{error}<button type="button" onClick={() => void startGoal(goal || DEFAULT_GOAL)} className="ml-2 underline">重试</button></div>}
                <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 via-background to-violet-500/10 p-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm"><Target className="h-5 w-5" /></span>
                  <h3 className="mt-4 text-base font-semibold">从一个问题开始</h3>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">我会基于当前证据解释方案；需要执行时逐项确认，完成后自动复查。</p>
                </div>
                <div className="mt-5"><p className="text-xs font-medium">常用目标</p><div className="mt-2 space-y-2">{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => void startGoal(suggestion)} className="flex w-full items-center justify-between rounded-xl border border-border/70 bg-background px-3 py-2.5 text-left text-xs transition hover:border-blue-500/30 hover:bg-blue-500/5">{suggestion}<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /></button>)}</div></div>
              </div>
            )}

            {stage === "diagnosing" && (
              <div className="flex min-h-full flex-col items-center justify-center py-8 text-center">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600"><Loader2 className="h-6 w-6 animate-spin" /></span>
                <h3 className="mt-4 text-base font-semibold">正在整理系统证据</h3>
                <p className="mt-2 max-w-[260px] text-xs leading-5 text-muted-foreground">{goal}</p>
                <div className="mt-6 w-full space-y-2 text-left text-xs">{["读取当前系统状态", "整理软件、启动项与维护记录", "由 AI 生成可确认的处理顺序"].map((item) => <div key={item} className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2.5"><span className="h-1.5 w-1.5 rounded-full bg-blue-500" />{item}</div>)}</div>
              </div>
            )}

            {stage === "plan" && plan && (
              <div>
                <div className="rounded-xl border border-border/70 bg-muted/35 p-3"><p className="text-[10px] text-muted-foreground">当前目标</p><p className="mt-1 text-sm font-medium leading-5">{goal}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{plan.summary}</p></div>
                {plan.findings.length > 0 && <section className="mt-4"><h3 className="text-xs font-medium">诊断依据</h3><ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">{plan.findings.map((finding) => <li key={finding} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-blue-500" />{finding}</li>)}</ul></section>}
                <section className="mt-5"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">方案待确认</h3><span className="text-[10px] text-muted-foreground">{selectedCount} 项已选择</span></div>
                  {plan.actions.length === 0 ? <p className="mt-3 rounded-xl border border-border/70 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">当前证据中没有可安全自动执行的操作。你可以查看对应依据或补充目标后重新诊断。</p> : <div className="mt-3 space-y-2.5">{plan.actions.map((action) => <label key={action.id} className="block cursor-pointer rounded-xl border border-border/70 bg-background p-3 transition hover:border-blue-500/30"><div className="flex items-start gap-2.5"><input type="checkbox" checked={selectedIds.has(action.id)} onChange={() => toggleAction(action.id)} className="mt-0.5 h-4 w-4 rounded border-blue-400 accent-blue-600" /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-xs font-medium" title={action.title}>{action.title}</p><span className="ml-auto shrink-0"><StatusPill tone={actionRisk(action)}>{actionRiskLabel(action)}</StatusPill></span></div><p className="mt-1 text-[10px] leading-4 text-muted-foreground">{action.reason}</p><p className="mt-1 truncate text-[10px] text-muted-foreground" title={action.targetNames.join("、")}>对象：{action.targetNames.join("、")}</p><button type="button" aria-label={`查看${tabLabels[action.evidenceTab]}依据`} onClick={(event) => { event.preventDefault(); navigateTo(action.evidenceTab); }} className="mt-2 inline-flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-700"><Database className="h-3 w-3" />查看依据</button></div></div></label>)}</div>}
                </section>
                <section className="mt-5"><h3 className="text-xs font-medium">本次证据来源</h3><div className="mt-2 flex flex-wrap gap-2">{evidenceSources.map((source) => <button key={source} type="button" onClick={() => navigateTo(source)} className="rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-[10px] text-muted-foreground transition hover:border-blue-500/30 hover:text-blue-600">{tabLabels[source]}</button>)}</div></section>
                {plan.actions.length > 0 && <button type="button" disabled={selectedCount === 0} onClick={() => void executePlan()} className={`${primaryButtonClass} mt-5 w-full disabled:cursor-not-allowed disabled:opacity-50`}><ShieldCheck className="mr-1.5 h-3.5 w-3.5" />确认并执行</button>}
              </div>
            )}

            {stage === "running" && (
              <div className="flex min-h-full flex-col justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /><h3 className="mt-4 text-base font-semibold">正在执行已确认操作</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">仅调用已验证的系统命令，并在每项操作后记录实际结果。</p><div className="mt-5 space-y-2">{results.map((result) => <p key={result.actionId} className="rounded-lg bg-muted/60 px-3 py-2 text-xs">{result.detail}</p>)}</div></div>
            )}

            {stage === "done" && (
              <div className="flex min-h-full flex-col justify-center py-8"><span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${failedCount === 0 ? "bg-emerald-500/10 text-emerald-600" : "bg-orange-500/10 text-orange-600"}`}><CheckCircle2 className="h-6 w-6" /></span><h3 className="mt-4 text-base font-semibold">验证完成</h3><p className="mt-2 text-xs leading-5 text-muted-foreground">已执行 {results.length} 项，{verifiedCount} 项完成复检{failedCount > 0 ? `，${failedCount} 项失败` : ""}。</p><div className="mt-5 space-y-2">{results.map((result) => <div key={result.actionId} className={`rounded-xl border p-3 text-xs leading-5 ${result.success ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400" : "border-red-500/20 bg-red-500/5 text-red-700 dark:text-red-400"}`}><p>{result.detail}</p>{!result.verified && result.success && <p className="mt-1">命令已完成，但当前状态尚未通过复检。</p>}</div>)}</div><div className="mt-5 flex gap-2"><button type="button" onClick={() => navigateTo("maintenance")} className={`${secondaryButtonClass} flex-1`}>查看维护记录</button><button type="button" onClick={() => { setGoal(""); setPlan(null); setResults([]); setStage("idle"); }} className={`${primaryButtonClass} flex-1`}>开始新任务</button></div></div>
            )}
          </div>

          <form className="shrink-0 border-t border-border/70 p-3" onSubmit={(event) => { event.preventDefault(); const nextGoal = input.trim(); if (!nextGoal) return; setInput(""); void startGoal(nextGoal); }}>
            <div className="flex items-center gap-2 rounded-xl border border-border/80 bg-background p-2 shadow-sm"><input value={input} onChange={(event) => setInput(event.target.value)} placeholder={`问 Mona，当前查看：${tabLabels[tab]}`} className="min-w-0 flex-1 bg-transparent px-1 text-xs outline-none" /><button type="submit" aria-label="发送给 Mona" disabled={!input.trim()} className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-40"><Send className="h-3.5 w-3.5" /></button></div>
            <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground"><CircleAlert className="h-3 w-3" />AI 仅基于当前系统证据规划；系统改动需确认。</p>
          </form>
            </>
          )}
        </div>
        </div>
      </aside>
    </>
  );
}
