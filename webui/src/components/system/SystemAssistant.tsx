import { Check, Loader2, Send, ShieldCheck, Stethoscope } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { StatusNotice } from "@/components/ui/status-notice";
import {
  collectSystemEvidence,
  executeSystemAction,
  requestSystemDiagnosis,
  requestSystemPlan,
  type SystemActionResult,
  type SystemAgentPlan,
  type SystemDiagnosisResult,
  type SystemEvidenceStage,
} from "./systemAgentApi";
import { buildInspectionCards, diagnosticLabel, type InspectionCard } from "./inspectionModel";
import { InspectionCards } from "./InspectionCards";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import { SystemAgentChat } from "./SystemAgentChat";
import type { SystemTab } from "./systemTabs";
import { StatusPill } from "./SystemUi";
import {
  useBootHistory,
  useMaintenanceHistory,
  useStartupItems,
  useSystemDiagnostics,
  type SoftwareCheckResult,
  type useStorageScan,
} from "./useSystemData";

type AssistantViewMode = "planner" | "agent";

interface SystemAssistantProps {
  tab: SystemTab;
  storage: ReturnType<typeof useStorageScan>;
  /** 软件更新数据由 SystemView 传入（winget 检查较重，避免重复调用） */
  software: SoftwareCheckResult | null;
  onNavigate: (tab: SystemTab) => void;
  collapsed: boolean;
  onCollapse: () => void;
  handoffTask: SystemAgentHandoffTask | null;
  onHandoffTaskHandled: (taskId: string) => void;
  analysisRequest: { goal: string; nonce: number; channel?: "plan" | "diagnose" } | null;
}

const evidenceStageLabels: Record<SystemEvidenceStage, string> = {
  overview: "正在整理系统证据",
  storage: "正在整理系统证据",
  software: "正在整理系统证据",
  startup: "正在整理系统证据",
  maintenance: "正在整理系统证据",
};

/** 诊断类意图：走 /api/system/diagnose 生成假设卡；其余走 planner 生成可执行方案 */
const DIAGNOSTIC_INTENT = /为什么|怎么|慢|卡|异常|报错|蓝屏|崩溃|发热/;

const CONFIDENCE_STYLES: Record<SystemDiagnosisResult["hypotheses"][number]["confidence"], { pill: string; label: string }> = {
  high: { pill: "bg-success/10 text-success", label: "高置信" },
  medium: { pill: "bg-warning/10 text-warning", label: "中置信" },
  low: { pill: "bg-muted text-muted-foreground", label: "低置信" },
};

export function SystemAssistant({
  tab,
  storage,
  software,
  onNavigate,
  collapsed,
  handoffTask,
  onHandoffTaskHandled,
  analysisRequest,
}: SystemAssistantProps) {
  // Agent 接管状态：handoffTask 到达后保持 agent 视图，即使用户切走再回来。
  const [agentTask, setAgentTask] = useState<SystemAgentHandoffTask | null>(null);
  const [agentChatId, setAgentChatId] = useState<string | null>(null);
  const [agentDismissed, setAgentDismissed] = useState(false);
  const viewMode: AssistantViewMode = agentTask && !agentDismissed ? "agent" : "planner";

  const [goal, setGoal] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<SystemAgentPlan | null>(null);
  const [diagnosis, setDiagnosis] = useState<SystemDiagnosisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [executing, setExecuting] = useState(false);
  const [results, setResults] = useState<SystemActionResult[]>([]);
  const lastAnalysisNonceRef = useRef<number | null>(null);

  // 巡检数据源：轻量命令组件内自取，与 SystemView 解耦；software 由 props 传入避免重复 winget 检查
  const diagnostics = useSystemDiagnostics();
  const startup = useStartupItems();
  const boot = useBootHistory();
  const maintenance = useMaintenanceHistory();

  const cards = useMemo(
    () =>
      buildInspectionCards({
        diagnostics: diagnostics.checks,
        storage: storage.result,
        software,
        startup: startup.data,
        boot: boot.data,
        maintenance: maintenance.data,
      }),
    [diagnostics.checks, storage.result, software, startup.data, boot.data, maintenance.data],
  );
  const inspectionPending = diagnostics.loading || startup.loading;

  useEffect(() => {
    if (!handoffTask) return;
    setAgentTask(handoffTask);
    setAgentDismissed(false);
  }, [handoffTask]);

  const requestPlan = useCallback(
    async (rawGoal: string, forceChannel?: "plan" | "diagnose") => {
      const trimmed = rawGoal.trim();
      if (!trimmed || planning) return;
      setPlanning(true);
      setError(null);
      setPlan(null);
      setDiagnosis(null);
      setResults([]);
      setSelectedIds([]);
      setStage("正在整理系统证据");
      try {
        const evidence = await collectSystemEvidence(storage.result, (s) =>
          setStage(evidenceStageLabels[s]),
        );
        const useDiagnose = forceChannel === "diagnose" || (!forceChannel && DIAGNOSTIC_INTENT.test(trimmed));
        if (useDiagnose) {
          setStage("正在生成诊断结论");
          // 诊断需要健康检查快照校验 evidenceIds
          setDiagnosis(await requestSystemDiagnosis(trimmed, { ...evidence, checks: diagnostics.checks }));
        } else {
          setStage("正在生成维护方案");
          const nextPlan = await requestSystemPlan(trimmed, evidence);
          setPlan(nextPlan);
          setSelectedIds(nextPlan.actions.map((action) => action.id));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "方案生成失败，请稍后重试");
      } finally {
        setPlanning(false);
        setStage(null);
      }
    },
    [planning, storage.result, diagnostics.checks],
  );

  // 面板内“交给 Mona 分析”入口：nonce 变化代表一次新的分析请求
  useEffect(() => {
    if (!analysisRequest) return;
    if (lastAnalysisNonceRef.current === analysisRequest.nonce) return;
    lastAnalysisNonceRef.current = analysisRequest.nonce;
    void requestPlan(analysisRequest.goal, analysisRequest.channel);
  }, [analysisRequest, requestPlan]);

  const handleReturnToPlanner = useCallback(() => {
    setAgentDismissed(true);
    if (agentTask) onHandoffTaskHandled(agentTask.id);
  }, [agentTask, onHandoffTaskHandled]);

  // 巡检卡动作：有 goal 交给 planner 生成方案，无 goal 仅跳转对应 Tab 查看
  const handleCardAction = useCallback(
    (card: InspectionCard) => {
      if (!card.goal) {
        onNavigate(card.tab);
        return;
      }
      setGoal(card.goal);
      void requestPlan(card.goal);
    },
    [onNavigate, requestPlan],
  );

  const toggleAction = (actionId: string, checked: boolean) => {
    setSelectedIds((previous) =>
      checked ? [...previous, actionId] : previous.filter((id) => id !== actionId),
    );
  };

  const executePlan = async () => {
    if (!plan || executing) return;
    const selected = plan.actions.filter((action) => selectedIds.includes(action.id));
    if (selected.length === 0) return;
    setExecuting(true);
    setError(null);
    try {
      const nextResults: SystemActionResult[] = [];
      for (const action of selected) {
        const result = await executeSystemAction(action);
        nextResults.push(result);
        setResults([...nextResults]);
        if (!result.success && !result.verified) break;
      }
    } finally {
      setExecuting(false);
    }
  };

  const tabLabel = (target: SystemTab) =>
    ({ overview: "概览", storage: "存储空间", software: "软件管理", startup: "启动项", optimization: "系统优化", maintenance: "维护记录" })[target];

  return (
    <aside
      aria-label="Mona 系统管家"
      aria-hidden={collapsed}
      className={cn(
        "flex min-h-0 flex-col border-l border-border/60 bg-background",
        collapsed && "hidden",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <h2 className="flex-1 text-ui font-semibold">Mona 系统管家</h2>
        {viewMode === "agent" && (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleReturnToPlanner}
            className="text-muted-foreground"
          >
            返回系统方案
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
        {viewMode === "agent" ? (
          <div className="flex min-h-full flex-col">
            <p className="border-b border-border/40 px-4 py-2 text-caption text-muted-foreground">
              Mona 正在接管维护任务，可继续对话补充要求
            </p>
            <SystemAgentChat
              chatId={agentChatId}
              task={agentTask}
              onChatCreated={setAgentChatId}
              onTaskHandled={onHandoffTaskHandled}
            />
          </div>
        ) : (
          <div className="space-y-4 p-4">
            <InspectionCards
              cards={cards}
              pending={inspectionPending}
              onAction={handleCardAction}
              disabled={planning || executing}
            />

            {error ? (
              <StatusNotice tone="danger">{error}</StatusNotice>
            ) : null}

            {diagnosis ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center gap-2">
                    <Stethoscope className="h-4 w-4 text-primary" />
                    <p className="text-body font-semibold">诊断结论</p>
                  </div>
                  <p className="mt-2 text-caption leading-relaxed text-muted-foreground">{diagnosis.summary}</p>
                </div>

                {diagnosis.hypotheses.map((hypothesis) => {
                  const confidence = CONFIDENCE_STYLES[hypothesis.confidence];
                  return (
                    <div key={hypothesis.title} className="rounded-lg border border-border/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-ui font-medium">{hypothesis.title}</p>
                        <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-micro font-medium", confidence.pill)}>{confidence.label}</span>
                      </div>
                      <p className="mt-1 text-caption leading-relaxed text-muted-foreground">{hypothesis.explanation}</p>
                      <p className="mt-2 text-caption text-foreground">建议：{hypothesis.nextStep}</p>
                      {hypothesis.evidenceIds.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {hypothesis.evidenceIds.map((id) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => onNavigate("overview")}
                              className="rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              {diagnosticLabel(id)}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                {diagnosis.cautions.length > 0 ? (
                  <ul className="space-y-1 text-caption text-muted-foreground">
                    {diagnosis.cautions.map((caution) => <li key={caution}>· {caution}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {plan ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-success" />
                    <p className="text-body font-semibold">{plan.summary}</p>
                  </div>
                  <ul className="mt-2 space-y-1 text-caption text-muted-foreground">
                    {plan.findings.map((finding) => <li key={finding}>· {finding}</li>)}
                  </ul>
                </div>

                <div className="space-y-2">
                  {plan.actions.map((action) => {
                    const checked = selectedIds.includes(action.id);
                    const result = results.find((entry) => entry.actionId === action.id);
                    return (
                      <div key={action.id} className="rounded-lg border border-border/60 p-3">
                        <div className="flex items-start gap-2.5">
                          <Checkbox
                            aria-label={`选择 ${action.title}`}
                            checked={checked}
                            onCheckedChange={(value) => toggleAction(action.id, value === true)}
                            disabled={executing || Boolean(result)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-ui font-medium">{action.title}</p>
                              <StatusPill tone={(({ low: "green", medium: "orange" }) as const)[action.risk]}>{({ low: "低风险", medium: "中风险" })[action.risk]}</StatusPill>
                            </div>
                            <p className="mt-1 text-caption text-muted-foreground">{action.reason}</p>
                            <div className="mt-2 flex items-center gap-2">
                              <Button variant="link" size="xs" className="h-auto px-0" onClick={() => onNavigate(action.evidenceTab)}>查看{tabLabel(action.evidenceTab)}依据</Button>
                              {result ? (
                                <span className={`inline-flex items-center gap-1 text-caption ${result.success ? "text-success" : "text-destructive"}`}>
                                  {result.success ? <Check className="h-3 w-3" /> : null}
                                  <span>{result.detail}</span>
                                  {result.verified ? <span>验证完成</span> : null}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {plan.actions.length > 0 && results.length === 0 ? (
                  <Button onClick={executePlan} disabled={executing || selectedIds.length === 0} className="w-full">
                    {executing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    确认并执行
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {viewMode === "planner" ? (
        <div className="shrink-0 border-t border-border/60 p-3">
          <div className="flex items-center gap-2">
            <Input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void requestPlan(goal); }}
              placeholder={`描述目标，当前上下文：${tabLabel(tab)}`}
              aria-label="描述系统维护目标"
              disabled={planning}
              className="flex-1"
            />
            <Button
              size="icon"
              onClick={() => void requestPlan(goal)}
              disabled={planning || !goal.trim()}
              aria-label="生成维护方案"
            >
              {planning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </Button>
          </div>
          {stage ? <p className="mt-2 text-caption text-muted-foreground">{stage}</p> : null}
        </div>
      ) : null}
    </aside>
  );
}
