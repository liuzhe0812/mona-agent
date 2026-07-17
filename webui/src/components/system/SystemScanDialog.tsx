import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

import {
  collectSystemDiagnosticEvidence,
  diagnosticStages,
  requestSystemDiagnosis,
  type DiagnosticStage,
  type DiagnosticSymptom,
  type SystemDiagnosticEvidence,
  type SystemDiagnosticReport,
} from "./systemAgentApi";
import { primaryButtonClass, secondaryButtonClass, StatusPill } from "./SystemUi";

export type SystemScanStatus = "idle" | "scanning" | "ready" | "failed";

interface SystemScanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: SystemScanStatus;
  onStatusChange: (status: SystemScanStatus) => void;
}

const symptoms: Array<{ id: DiagnosticSymptom; label: string; detail: string }> = [
  { id: "performance", label: "电脑变慢或卡顿", detail: "排查系统状态、组件与异常设备" },
  { id: "boot", label: "开机速度变慢", detail: "结合启动状态判断可能原因" },
  { id: "power", label: "睡眠耗电或无法唤醒", detail: "检查唤醒来源与恢复状态" },
  { id: "network", label: "网络异常", detail: "检查代理与系统组件状态" },
  { id: "device", label: "设备或蓝屏问题", detail: "检查报告异常的设备与组件状态" },
  { id: "update", label: "安装或更新失败", detail: "检查待重启、组件与恢复环境" },
];

const stageMeta: Record<DiagnosticStage, { label: string; detail: string }> = {
  pending_reboot: { label: "待重启状态", detail: "Windows 更新与组件服务" },
  component_health: { label: "系统组件", detail: "DISM 组件存储检查" },
  driver_issues: { label: "设备状态", detail: "报告异常的即插即用设备" },
  power_events: { label: "电源唤醒", detail: "最近唤醒来源与计时器" },
  network_configuration: { label: "网络配置", detail: "当前用户代理设置" },
  recovery_status: { label: "恢复与保护", detail: "恢复环境与磁盘保护状态" },
};

function confidenceTone(confidence: "low" | "medium" | "high"): "neutral" | "orange" | "red" {
  if (confidence === "high") return "red";
  if (confidence === "medium") return "orange";
  return "neutral";
}

function confidenceLabel(confidence: "low" | "medium" | "high") {
  return confidence === "high" ? "较高置信" : confidence === "medium" ? "中等置信" : "低置信";
}

function symptomLabel(symptom: DiagnosticSymptom) {
  return symptom === "general" ? "全面故障诊断" : symptoms.find((item) => item.id === symptom)?.label ?? "故障诊断";
}

function CheckProgress({ stages, running, completed }: { stages: DiagnosticStage[]; running: Set<DiagnosticStage>; completed: Set<DiagnosticStage> }) {
  const completedCount = completed.size;
  const activeStage = stages.find((stage) => running.has(stage)) ?? stages.find((stage) => !completed.has(stage));
  return <section aria-live="polite" className="relative overflow-hidden rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.10] via-card to-violet-500/[0.08] p-5 shadow-lg shadow-blue-500/[0.05]">
    <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-blue-400/10 blur-3xl animate-pulse" />
    <div className="relative flex items-start justify-between gap-4"><div className="flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-500/25"><Loader2 className="h-5 w-5 animate-spin" /></span><div><p className="text-sm font-semibold">正在完成 Windows 本机检查</p><p className="mt-1 text-xs text-muted-foreground">{activeStage ? `正在检查：${stageMeta[activeStage].label}` : "正在整理检查结果"}</p></div></div><div className="rounded-xl border border-blue-500/15 bg-background/75 px-3 py-2 text-right shadow-sm"><p className="text-lg font-semibold leading-none text-blue-600">{completedCount} / {stages.length}</p><p className="mt-1 text-[10px] text-muted-foreground">项已完成</p></div></div>
    <div className="mt-5 h-2 overflow-hidden rounded-full bg-blue-500/10 p-0.5"><div className="h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500 transition-[width] duration-700 ease-out" style={{ width: `${(completedCount / stages.length) * 100}%` }} /></div>
    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{stages.map((stage, index) => { const done = completed.has(stage); const active = running.has(stage); return <div key={stage} className={`flex min-w-0 items-center gap-2 rounded-xl border px-2.5 py-2.5 transition-all duration-500 ${done ? "border-emerald-500/20 bg-emerald-500/[0.08]" : active ? "border-blue-500/25 bg-background/90 shadow-sm" : "border-border/60 bg-background/50 opacity-60"}`}><span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold ${done ? "bg-emerald-500 text-white" : active ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground"}`}>{done ? <CheckCircle2 className="h-3.5 w-3.5" /> : active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : index + 1}</span><span className="min-w-0"><span className="block truncate text-[11px] font-medium">{stageMeta[stage].label}</span><span className="block truncate text-[10px] text-muted-foreground">{stageMeta[stage].detail}</span></span></div>; })}</div>
    <p className="mt-4 text-[11px] leading-5 text-muted-foreground">每一步都是独立的只读 Windows 检查。Mona 会在检查完成后异步关联证据，不会在这里自动修改设置。</p>
  </section>;
}

export function SystemScanDialog({ open, onOpenChange, status, onStatusChange }: SystemScanDialogProps) {
  const [symptom, setSymptom] = useState<DiagnosticSymptom>("general");
  const [evidence, setEvidence] = useState<SystemDiagnosticEvidence | null>(null);
  const [report, setReport] = useState<SystemDiagnosticReport | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<Set<DiagnosticStage>>(new Set());
  const [completed, setCompleted] = useState<Set<DiagnosticStage>>(new Set());
  const scanIdRef = useRef(0);
  const stages = useMemo(() => diagnosticStages(symptom), [symptom]);
  const isCollecting = status === "scanning" && !evidence;
  const isAnalyzing = status === "scanning" && Boolean(evidence);

  const generateReport = (nextEvidence: SystemDiagnosticEvidence, scanId: number) => {
    void requestSystemDiagnosis(symptomLabel(nextEvidence.symptom), nextEvidence)
      .then((nextReport) => {
        if (scanIdRef.current !== scanId) return;
        setReport(nextReport);
        onStatusChange("ready");
      })
      .catch(() => {
        if (scanIdRef.current !== scanId) return;
        onStatusChange("ready");
      });
  };

  const startDiagnosis = async () => {
    const scanId = scanIdRef.current + 1;
    scanIdRef.current = scanId;
    onStatusChange("scanning");
    setEvidence(null);
    setReport(null);
    setError("");
    setRunning(new Set());
    setCompleted(new Set());
    try {
      const nextEvidence = await collectSystemDiagnosticEvidence(symptom, (stage, state) => {
        if (scanIdRef.current !== scanId) return;
        if (state === "running") setRunning((current) => new Set(current).add(stage));
        else { setRunning((current) => { const next = new Set(current); next.delete(stage); return next; }); setCompleted((current) => new Set(current).add(stage)); }
      });
      if (scanIdRef.current !== scanId) return;
      setEvidence(nextEvidence);
      generateReport(nextEvidence, scanId);
    } catch (diagnosticError) {
      if (scanIdRef.current !== scanId) return;
      setError(String(diagnosticError));
      onStatusChange("failed");
    }
  };

  const retryAnalysis = () => {
    if (!evidence) return;
    onStatusChange("scanning");
    generateReport(evidence, scanIdRef.current);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-[1040px] gap-0 overflow-hidden border-border/80 bg-background p-0 shadow-2xl" showCloseButton={false}>
      <header className="relative overflow-hidden border-b border-border/70 bg-gradient-to-r from-blue-500/[0.08] via-violet-500/[0.04] to-transparent px-5 py-4"><div className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-blue-400/10 blur-2xl" /><div className="relative flex items-start gap-3"><span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20"><Sparkles className="h-5 w-5" /></span><div className="min-w-0 flex-1"><DialogTitle className="text-lg">AI 故障诊断</DialogTitle><DialogDescription className="mt-1 text-xs">先读取与问题相关的 Windows 证据，再由 Mona 解释可能原因和最小、安全的下一步。</DialogDescription></div>{isAnalyzing && <StatusPill tone="blue">AI 分析中</StatusPill>}{status === "ready" && <StatusPill tone="green">诊断已完成</StatusPill>}<button type="button" aria-label="关闭 AI 故障诊断" onClick={() => onOpenChange(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-background/80 hover:text-foreground"><X className="h-4 w-4" /></button></div></header>
      <div className="max-h-[min(70vh,700px)] overflow-y-auto p-5 scrollbar-hover">
        {status === "idle" && <div className="mx-auto max-w-3xl py-2"><section className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.08] via-card to-violet-500/[0.06] p-5 shadow-sm"><StatusPill tone="blue">只读诊断</StatusPill><h3 className="mt-3 text-xl font-semibold tracking-tight">先告诉 Mona 你遇到了什么问题</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">诊断不是健康评分，也不会重新扫描已有看板。它会按症状选择 Windows 原生证据源，AI 只能基于这些证据给出结论。</p><div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{symptoms.map((item) => <button key={item.id} type="button" onClick={() => setSymptom(item.id)} className={`rounded-xl border p-3 text-left transition ${symptom === item.id ? "border-blue-500/45 bg-blue-500/[0.07] shadow-sm" : "border-border/70 bg-background/75 hover:border-blue-500/25"}`}><span className="text-xs font-semibold">{item.label}</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">{item.detail}</span></button>)}<button type="button" onClick={() => setSymptom("general")} className={`rounded-xl border p-3 text-left transition ${symptom === "general" ? "border-blue-500/45 bg-blue-500/[0.07] shadow-sm" : "border-border/70 bg-background/75 hover:border-blue-500/25"}`}><span className="text-xs font-semibold">不确定，做全面诊断</span><span className="mt-1 block text-[11px] leading-5 text-muted-foreground">读取所有可用的诊断证据</span></button></div><div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" onClick={() => void startDiagnosis()} className={`${primaryButtonClass} h-9 px-4 shadow-sm shadow-blue-500/20`}><Sparkles className="mr-1.5 h-4 w-4" />开始 AI 故障诊断</button><span className="text-[11px] text-muted-foreground">可关闭窗口，诊断和 AI 分析会继续在后台完成。</span></div></section></div>}
        {isCollecting && <div className="mx-auto max-w-3xl py-5"><CheckProgress stages={stages} running={running} completed={completed} /><div className="mt-5 flex justify-center"><button type="button" onClick={() => onOpenChange(false)} className={secondaryButtonClass}>关闭并在后台继续</button></div></div>}
        {status === "failed" && <div className="mx-auto max-w-xl py-10 text-center"><CircleAlert className="mx-auto h-8 w-8 text-red-500" /><h3 className="mt-3 text-lg font-semibold">本机诊断未完成</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{error || "读取 Windows 诊断证据时发生错误。"}</p><button type="button" onClick={() => void startDiagnosis()} className={`${primaryButtonClass} mt-6`}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重新诊断</button></div>}
        {evidence && (isAnalyzing || status === "ready") && <div className="space-y-4"><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]"><section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"><div className="flex items-center justify-between gap-3"><div><p className="text-xs text-muted-foreground">本机检查结果</p><h3 className="mt-1 text-base font-semibold">{symptomLabel(evidence.symptom)}</h3></div><StatusPill tone="blue">{evidence.checks.length} 项证据</StatusPill></div><div className="mt-4 space-y-2">{evidence.checks.map((check) => <article key={check.id} className={`rounded-xl border p-3 ${check.status === "attention" ? "border-orange-500/25 bg-orange-500/[0.04]" : check.status === "clear" ? "border-emerald-500/20 bg-emerald-500/[0.03]" : "border-border/70 bg-background"}`}><div className="flex items-start gap-2"><span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${check.status === "attention" ? "bg-orange-500/10 text-orange-600" : check.status === "clear" ? "bg-emerald-500/10 text-emerald-600" : "bg-blue-500/10 text-blue-600"}`}>{check.status === "attention" || check.status === "unavailable" ? <CircleAlert className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}</span><div className="min-w-0"><p className="text-xs font-medium">{check.summary}</p><p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">{check.detail}</p></div></div></article>)}</div></section><aside className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.10] via-violet-500/[0.06] to-card p-4 shadow-sm">{isAnalyzing ? <><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-500/25"><Loader2 className="h-4 w-4 animate-spin" /></span><p className="mt-4 text-sm font-semibold">Mona 正在关联证据</p><p className="mt-1.5 text-xs leading-5 text-muted-foreground">它会区分“已确认状态”和“可能原因”，不把相关性当成确定结论。</p><button type="button" onClick={() => onOpenChange(false)} className={`${secondaryButtonClass} mt-5 w-full`}>关闭并在后台继续</button></> : report ? <><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600"><CheckCircle2 className="h-4 w-4" /></span><p className="mt-4 text-sm font-semibold">诊断报告已准备好</p><p className="mt-1.5 text-xs leading-5 text-muted-foreground">以下结论均链接到本机检查；不会在此自动修改 Windows 配置。</p><button type="button" onClick={() => void startDiagnosis()} className={`${secondaryButtonClass} mt-5 w-full`}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重新诊断</button></> : <><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500/10 text-orange-600"><CircleAlert className="h-4 w-4" /></span><p className="mt-4 text-sm font-semibold">AI 结论暂未生成</p><p className="mt-1.5 text-xs leading-5 text-muted-foreground">本机检查结果已保留，可以稍后重试，不需要重复检查。</p><button type="button" onClick={retryAnalysis} className={`${primaryButtonClass} mt-5 w-full`}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重试 AI 分析</button></>}</aside></div>
          {report && status === "ready" && <><section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"><p className="text-xs text-muted-foreground">Mona 的诊断结论</p><h3 className="mt-1 text-base font-semibold leading-6">{report.summary}</h3></section>{report.hypotheses.length > 0 ? <section className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"><div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">可能原因与下一步</h3><p className="mt-1 text-[11px] text-muted-foreground">按证据强度排序，不等同于确定故障原因。</p></div><StatusPill tone="blue">{report.hypotheses.length} 个假设</StatusPill></div><div className="mt-4 grid gap-3 md:grid-cols-3">{report.hypotheses.map((hypothesis) => <article key={hypothesis.title} className="rounded-xl border border-border/70 bg-background p-3"><div className="flex items-start justify-between gap-2"><h4 className="text-sm font-semibold">{hypothesis.title}</h4><StatusPill tone={confidenceTone(hypothesis.confidence)}>{confidenceLabel(hypothesis.confidence)}</StatusPill></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{hypothesis.explanation}</p><p className="mt-3 border-t border-border/60 pt-3 text-xs leading-5 text-foreground"><strong>下一步：</strong>{hypothesis.nextStep}</p></article>)}</div></section> : <section className="rounded-2xl border border-border/70 bg-card p-5 text-sm text-muted-foreground">当前证据不足以给出可靠的可能原因。可以补充症状出现的时间、错误提示或复现步骤后，再让 Mona 分析。</section>}{report.cautions.length > 0 && <section className="rounded-xl border border-violet-500/15 bg-violet-500/[0.04] p-4"><p className="flex items-center gap-2 text-xs font-medium"><ShieldCheck className="h-4 w-4 text-violet-600" />诊断边界</p><ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">{report.cautions.map((caution) => <li key={caution} className="flex gap-2"><ChevronRight className="mt-1 h-3 w-3 shrink-0 text-violet-600" />{caution}</li>)}</ul></section>}</>}</div>}
      </div>
    </DialogContent>
  </Dialog>;
}
