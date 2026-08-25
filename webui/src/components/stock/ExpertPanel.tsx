import { useMemo, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { StockReportDocument } from "@/lib/stock-api";
import type { WorkflowRun, WorkflowStepRun } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface ExpertPanelProps {
  run: WorkflowRun | null;
  report: StockReportDocument | null;
  starting?: boolean;
  cancellingRun?: boolean;
  onStart: () => void;
  onCancel: () => void;
  historyCount?: number;
}

const ROLES = [
  ["technical", "技术分析师"],
  ["fundamental", "基本面分析师"],
  ["news", "行业资讯分析师"],
  ["bull", "多头研究员"],
  ["bear", "空头研究员"],
  ["referee", "主审"],
] as const;

function statusLabel(value: string | undefined, hasReport: boolean, runActive: boolean): string {
  if (value === "running" || value === "waiting_approval" || value === "queued") return "进行中";
  if (value === "succeeded") return "已完成";
  if (value === "failed") return "失败";
  if (value === "cancelled") return "已取消";
  if (value === "skipped") return "未执行";
  if (runActive) return "等待中";
  return hasReport ? "已完成" : "未启动";
}

function claimText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["summary", "conclusion", "claim", "text", "thesis"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return "";
}

function firstSentence(value: string): string {
  const sentence = value.split(/[。；;\n]/, 1)[0]?.trim() ?? "";
  return sentence || value.slice(0, 120).trim();
}

function roleConclusion(report: StockReportDocument | null, role: string): string {
  if (!report) return "";
  const raw = report as unknown as Record<string, unknown>;
  const panel = raw.expert_panel ?? raw.expertPanel;
  if (panel && typeof panel === "object" && !Array.isArray(panel)) {
    const roles = (panel as Record<string, unknown>).roles;
    if (roles && typeof roles === "object" && !Array.isArray(roles)) {
      const text = claimText((roles as Record<string, unknown>)[role]);
      if (text) return firstSentence(text);
    }
  }
  const views = raw.analyst_views ?? raw.analystViews;
  if (views && typeof views === "object" && !Array.isArray(views)) {
    const text = claimText((views as Record<string, unknown>)[role]);
    if (text) return firstSentence(text);
  }
  if (role === "referee") {
    return firstSentence(claimText(raw.summary));
  }
  return "";
}

function roleEvidence(report: StockReportDocument | null, role: string): string[] {
  if (!report) return [];
  const raw = report as unknown as Record<string, unknown>;
  const panel = raw.expert_panel ?? raw.expertPanel;
  const roles = panel && typeof panel === "object" && !Array.isArray(panel)
    ? (panel as Record<string, unknown>).roles
    : null;
  const item = roles && typeof roles === "object" && !Array.isArray(roles)
    ? (roles as Record<string, unknown>)[role]
    : null;
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const evidence = (item as Record<string, unknown>).evidence ?? (item as Record<string, unknown>).basis;
  if (!Array.isArray(evidence)) return [];
  return evidence.map(claimText).filter(Boolean).slice(0, 3);
}

function refereeSummary(report: StockReportDocument | null): Record<string, string> {
  if (!report) return {};
  const raw = report as unknown as Record<string, unknown>;
  const value = raw.debate_resolution ?? raw.debateResolution ?? raw.referee_summary ?? raw.refereeSummary;
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : raw.debate && typeof raw.debate === "object" && !Array.isArray(raw.debate)
      ? raw.debate as Record<string, unknown>
      : {};
  const read = (...keys: string[]) => {
    for (const key of keys) {
      const text = firstSentence(claimText(source[key]));
      if (text) return text;
    }
    return "";
  };
  return {
    disagreement: read("disagreement", "final_disagreement", "finalDisagreement"),
    accepted: read("accepted", "adopted", "采信理由", "adoption_reason", "adoptionReason"),
    risks: read("reserved_risks", "retained_risks", "risks", "保留风险"),
    conditions: read("change_conditions", "conclusion_change_conditions", "改变条件", "invalidation"),
  };
}

function stepStatus(run: WorkflowRun | null, role: string): WorkflowStepRun | undefined {
  return run?.steps?.[role];
}

export function ExpertPanel({
  run,
  report,
  starting = false,
  cancellingRun = false,
  onStart,
  onCancel,
  historyCount = 0,
}: ExpertPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const active = run?.status === "queued" || run?.status === "running" || run?.status === "waiting_approval";
  const failed = run?.status === "failed";
  const referee = useMemo(() => refereeSummary(report), [report]);
  const hasReport = report != null;

  return (
    <section className="space-y-4 px-4 py-4" data-testid="expert-panel">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold">专家团论证</h1>
          {!run && !report && <p className="mt-1 text-caption text-muted-foreground">六位专家会交叉复核 AI 诊股结论，耗时和数据调用较多，仅在你主动启动后运行。</p>}
        </div>
        {starting ? (
          <Button type="button" size="xs" variant="outline" disabled><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />准备中</Button>
        ) : active ? (
          <Button type="button" size="xs" variant="outline" onClick={onCancel} disabled={cancellingRun}>
            <Square className="mr-1 h-3.5 w-3.5" aria-hidden />{cancellingRun ? "取消中" : "取消论证"}
          </Button>
        ) : (
          <Button type="button" size="xs" onClick={onStart}>
            <Play className="mr-1 h-3.5 w-3.5" aria-hidden />{failed || hasReport ? "重新论证" : "启动专家团论证"}
          </Button>
        )}
      </header>

      {run?.status === "failed" && <p className="rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-caption text-destructive">本次专家团论证失败，请重新论证。</p>}
      {run?.status === "cancelled" && <p className="rounded border border-warning/30 bg-warning/5 px-3 py-2 text-caption text-warning">本次专家团论证已取消。</p>}

      {run || report ? (
        <div className="grid gap-2 sm:grid-cols-2" data-testid="expert-role-list">
          {ROLES.map(([id, label]) => {
            const status = statusLabel(stepStatus(run, id)?.status, hasReport, active);
            const conclusion = roleConclusion(report, id);
            const evidence = roleEvidence(report, id);
            const isOpen = expanded === id;
            return (
              <section key={id} className="rounded border bg-muted/10" data-testid={`expert-role-${id}`}>
                <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left" onClick={() => setExpanded(isOpen ? null : id)} aria-expanded={isOpen}>
                  <span className="text-caption font-medium">{label}</span>
                  <span className={cn("text-micro", status === "失败" ? "text-destructive" : status === "进行中" ? "text-info" : "text-muted-foreground")}>{status}</span>
                </button>
                <div className="border-t px-3 py-2 text-caption">
                  <p className="line-clamp-2">{conclusion || (status === "已完成" ? "报告未提供一句话结论" : status)}</p>
                  {isOpen && (
                    <div className="mt-2 space-y-1 border-t pt-2 text-micro text-muted-foreground" data-testid={`expert-role-${id}-evidence`}>
                      {evidence.length > 0 ? evidence.map((item) => <p key={item}>{item}</p>) : <p>报告未提供结构化依据。</p>}
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}

      {report && (
        <section className="rounded border px-3 py-3" data-testid="expert-referee-summary">
          <h2 className="text-caption font-semibold">主审裁决</h2>
          <dl className="mt-2 space-y-1 text-caption">
            <div><dt className="inline text-muted-foreground">最终分歧：</dt><dd className="inline">{referee.disagreement || "报告未提供"}</dd></div>
            <div><dt className="inline text-muted-foreground">采信理由：</dt><dd className="inline">{referee.accepted || "报告未提供"}</dd></div>
            <div><dt className="inline text-muted-foreground">保留风险：</dt><dd className="inline">{referee.risks || "报告未提供"}</dd></div>
            <div><dt className="inline text-muted-foreground">改变条件：</dt><dd className="inline">{referee.conditions || "报告未提供"}</dd></div>
          </dl>
        </section>
      )}

      {historyCount > 0 && <p className="text-micro text-muted-foreground" data-testid="expert-history-count">专家团历史记录：{historyCount} 份</p>}
    </section>
  );
}
