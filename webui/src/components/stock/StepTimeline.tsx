import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { fetchFilePreviewBlob } from "@/lib/api";
import { stockClaimText, type StockReportDocument } from "@/lib/stock-api";
import type {
  ArtifactRef,
  ToolProgressEvent,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowStepStatus,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { stanceLabel } from "./labels";

const STEP_IDS = [
  "technical",
  "fundamental",
  "news",
  "bull",
  "bear",
  "referee",
] as const;

type StepId = (typeof STEP_IDS)[number];

const STEP_LABELS: Record<StepId, string> = {
  technical: "技术分析师",
  fundamental: "基本面分析师",
  news: "资讯分析师",
  bull: "多头研究员",
  bear: "空头研究员",
  referee: "主审",
};

const STEP_STATUS_LABELS: Record<WorkflowStepStatus, string> = {
  queued: "等待",
  running: "分析中",
  waiting_approval: "待确认",
  succeeded: "完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "跳过",
};

const STEP_PROGRESS_LABELS: Record<StepId, string> = {
  technical: "正在核对价格与趋势",
  fundamental: "正在整理公司经营数据",
  news: "正在核对公告与市场信息",
  bull: "正在整理支持理由",
  bear: "正在核对风险与反向证据",
  referee: "正在汇总三周期结论",
};

interface StructuredOpinion {
  stance?: string;
  summary?: string;
  points?: { claim: string; evidence?: string; source_ids?: string[] }[];
}

function artifactPath(uri: string): string {
  return uri.startsWith("artifact://") ? uri.slice("artifact://".length) : uri;
}

interface ArtifactReadRef {
  path: string;
  scope: "shared" | "room";
  room?: string | null;
  artifactId?: string | null;
}

function isArtifactRef(value: string | ArtifactRef): value is ArtifactRef {
  return typeof value !== "string";
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function visibleStanceLabel(value: string | null | undefined): string {
  if (value === "positive" || value === "neutral" || value === "negative" || value === "insufficient_data") {
    return stanceLabel(value);
  }
  return "观点待确认";
}

function reportClaimPoint(prefix: string, value: Parameters<typeof stockClaimText>[0]): { claim: string } | null {
  const text = stockClaimText(value).trim();
  return text ? { claim: `${prefix}${text}` } : null;
}

function StatusDot({ status }: { status: WorkflowStepStatus }) {
  if (status === "succeeded") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success-indicator/15 text-success-indicator">
        <Check className="h-2.5 w-2.5" aria-hidden />
      </span>
    );
  }
  if (status === "running" || status === "waiting_approval") {
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" aria-hidden />;
  }
  if (status === "failed") {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
        <X className="h-2.5 w-2.5" aria-hidden />
      </span>
    );
  }
  return <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/35" />;
}

function StepCard({
  stepId,
  stepRun,
  opinion,
  loading,
  overview = false,
}: {
  stepId: StepId;
  stepRun?: WorkflowStepRun;
  opinion?: StructuredOpinion;
  loading?: boolean;
  overview?: boolean;
}) {
  const status: WorkflowStepStatus = stepRun?.status ?? (opinion ? "succeeded" : "queued");
  const header = (
    <div className="flex items-center gap-2">
      <StatusDot status={status} />
      <h4 className={cn("min-w-0 flex-1 truncate font-medium", overview ? "text-ui" : "text-caption", stepId === "bull" && "text-stock-up", stepId === "bear" && "text-stock-down")}>
        {STEP_LABELS[stepId]}
      </h4>
      <span
        className={cn(
          overview ? "text-caption" : "text-micro",
          status === "running"
            ? "text-info"
            : status === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {STEP_STATUS_LABELS[status] ?? "状态待确认"}
      </span>
    </div>
  );
  const opinionBody = (
    <div className="mt-2">
      {opinion?.summary ? (
        <p className={cn("select-text break-words leading-relaxed text-muted-foreground", overview ? "text-ui" : "text-caption")}>
          {opinion.summary}
        </p>
      ) : (
        <p className="text-caption text-muted-foreground">
          {loading ? "正在读取该角色结论" : status === "running" ? STEP_PROGRESS_LABELS[stepId] : status === "queued" ? "等待该角色完成分析" : "该角色未生成可用结论"}
        </p>
      )}
      {opinion?.points && opinion.points.length > 0 && (
        <ul className={cn("mt-2 space-y-1.5 border-t pt-2 text-muted-foreground", overview ? "text-caption" : "text-micro")}>
          {opinion.points.map((point, index) => (
            <li key={`${point.claim}-${index}`} className="flex gap-1.5">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0 select-text break-words">
                {point.claim}
                {point.evidence && <span className="mt-0.5 block text-muted-foreground/80">{point.evidence}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <article
      data-testid={`research-step-${stepId}`}
      className={cn(
        "bg-background/40",
        overview ? "h-full px-3.5 py-3" : "px-2.5 py-2",
        status === "running" && "bg-info/5",
        status === "failed" && "bg-destructive/5",
        stepId === "bull" && status === "succeeded" && "bg-stock-up/5",
        stepId === "bear" && status === "succeeded" && "bg-stock-down/5",
      )}
    >
      <details data-testid={`research-step-details-${stepId}`}>
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{header}</summary>
        {opinionBody}
      </details>
      {status === "running" && (
        <p className="mt-2 text-micro text-muted-foreground" aria-live="polite">
          {STEP_PROGRESS_LABELS[stepId]}
        </p>
      )}
      {loading && !opinion && (
        <div className="mt-2 flex items-center gap-1.5 text-micro text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />读取分析结论…
        </div>
      )}
      {status === "failed" && stepRun?.error && (
        <p className="mt-2 text-micro text-destructive">该步骤未生成可用结论，请检查数据源后重试。</p>
      )}
      {status === "queued" && !opinion && (
        <p className="mt-2 text-micro text-muted-foreground">
          {stepId === "bull" || stepId === "bear"
            ? "等待三路分析完成"
            : stepId === "referee"
              ? "等待多空观点形成"
              : "等待调度"}
        </p>
      )}
    </article>
  );
}

export function StepTimeline({
  run,
  token,
  stepActivities: _stepActivities = {},
  report,
  variant = "compact",
  preparing = false,
}: {
  run: WorkflowRun | null;
  token: string;
  stepActivities?: Record<string, ToolProgressEvent[]>;
  report?: StockReportDocument | null;
  variant?: "compact" | "overview";
  preparing?: boolean;
}) {
  const overview = variant === "overview";
  const [opinions, setOpinions] = useState<Record<string, StructuredOpinion>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const reportRunId = typeof report?.workflow_run_id === "string" ? report.workflow_run_id : null;
  const researchKey = run?.id ?? reportRunId ?? report?.report_id ?? "empty";

  const artifactRefs = useMemo(() => {
    const refs: Record<string, ArtifactReadRef> = {};
    if (!run || !reportRunId || reportRunId === run.id) {
      for (const [stepId, uri] of Object.entries({
        ...recordOfStrings(report?.analyst_views),
        ...recordOfStrings(report?.debate),
      })) {
        refs[stepId] = { path: artifactPath(uri), scope: "shared" };
      }
    }
    if (run) {
      for (const stepId of STEP_IDS) {
        const artifact = run.steps[stepId]?.output?.artifacts?.find((value) =>
          isArtifactRef(value) ? value.relative_path.endsWith(".json") : value.endsWith(".json"),
        );
        if (!artifact) continue;
        refs[stepId] =
          isArtifactRef(artifact)
            ? {
                path: artifact.relative_path,
                scope: "room",
                room: run.roomId,
                artifactId: artifact.id,
              }
            : {
                path: artifactPath(artifact),
                scope: "shared",
              };
      }
    }
    return refs;
  }, [report, reportRunId, run]);
  useEffect(() => {
    setOpinions({});
    setLoading({});
  }, [researchKey]);

  useEffect(() => {
    const entries = Object.entries(artifactRefs).filter(([stepId]) => stepId !== "referee");
    if (entries.length === 0) return;
    let cancelled = false;
    setLoading(Object.fromEntries(entries.map(([stepId]) => [stepId, true])));
    for (const [stepId, ref] of entries) {
      void fetchFilePreviewBlob(
        token,
        ref.scope === "room"
          ? {
              scope: "room",
              path: ref.path,
              room: ref.room ?? run?.roomId ?? null,
              artifactId: ref.artifactId ?? null,
            }
          : { scope: "shared", path: ref.path },
      )
        .then(async ({ blob }) => JSON.parse(await blob.text()) as StructuredOpinion)
        .then((opinion) => {
          if (!cancelled) setOpinions((current) => ({ ...current, [stepId]: opinion }));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setLoading((current) => ({ ...current, [stepId]: false }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [artifactRefs, researchKey, token]);

  const refereeOpinion: StructuredOpinion | undefined = report?.summary
    ? {
        stance: report.research_stance ?? undefined,
        summary: report.summary,
        points: [
          ...(overview ? report.risks ?? [] : (report.risks ?? []).slice(0, 1)).map((claim) => reportClaimPoint("风险：", claim)),
          ...(overview ? report.catalysts ?? [] : (report.catalysts ?? []).slice(0, 1)).map((claim) => reportClaimPoint("催化：", claim)),
          ...(overview ? report.open_questions ?? [] : []).map((claim) => reportClaimPoint("待核验：", claim)),
        ].filter((point): point is { claim: string } => point !== null),
      }
    : opinions.referee;
  const statuses: WorkflowStepStatus[] = STEP_IDS.map((stepId) => {
    const status = run?.steps[stepId]?.status;
    if (status) return status;
    return (stepId === "referee" ? refereeOpinion : opinions[stepId])
      ? "succeeded"
      : "queued";
  });
  const settled = statuses.filter((status) =>
    status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled",
  ).length;
  const runningSteps = STEP_IDS.filter((stepId) => run?.steps[stepId]?.status === "running");
  const processActive = preparing || run?.status === "queued" || run?.status === "running" || run?.status === "waiting_approval";
  const processComplete = !processActive && Boolean(report || run);
  const processSections = (
    <div className="space-y-5" data-testid="research-process-sections">
      <section>
        <h3 className={cn("font-medium", overview ? "mb-2 text-ui" : "mb-1.5 text-caption")}>三路并行分析</h3>
        <div className={overview ? "grid gap-x-4 gap-y-2 md:grid-cols-3" : "space-y-1.5"}>
          {(["technical", "fundamental", "news"] as StepId[]).map((stepId) => (
            <StepCard key={stepId} stepId={stepId} stepRun={run?.steps[stepId]} opinion={opinions[stepId]} loading={loading[stepId]} overview={overview} />
          ))}
        </div>
      </section>

      <section>
        <h3 className={cn("font-medium", overview ? "mb-2 text-ui" : "mb-1.5 text-caption")}>多空对照</h3>
        <div className={overview ? "grid gap-x-4 gap-y-2 md:grid-cols-2" : "space-y-1.5"}>
          {(["bull", "bear"] as StepId[]).map((stepId) => (
            <StepCard key={stepId} stepId={stepId} stepRun={run?.steps[stepId]} opinion={opinions[stepId]} loading={loading[stepId]} overview={overview} />
          ))}
        </div>
      </section>

      <section>
        <h3 className={cn("font-medium", overview ? "mb-2 text-ui" : "mb-1.5 text-caption")}>最终研判</h3>
        <StepCard stepId="referee" stepRun={run?.steps.referee} opinion={refereeOpinion} loading={loading.referee} overview={overview} />
        {refereeOpinion?.stance && (
          <p className="mt-1.5 text-right text-micro text-muted-foreground">
            研究倾向：<span className="font-medium text-foreground">{visibleStanceLabel(refereeOpinion.stance)}</span>
          </p>
        )}
      </section>
    </div>
  );

  return (
    <div className={cn(overview ? "space-y-4 pb-2" : "space-y-3", !processActive && "text-muted-foreground")} data-testid="research-process">
      {!(processComplete && report?.schema_version === 4) && (
        <div data-testid="research-process-progress">
          <div className={cn("flex items-center justify-between text-muted-foreground", overview ? "text-caption" : "text-micro")}>
            <span>{preparing ? "正在准备研究资料并创建投研任务" : runningSteps.length > 1 ? "多项分析正在并行进行" : runningSteps.length === 1 ? `${STEP_LABELS[runningSteps[0]]}正在工作` : run?.status === "queued" || run?.status === "running" ? "投研任务已建立，等待分析开始" : report ? "本次投研已归档" : run ? "投研流程已结束" : "等待启动深度投研"}</span>
            <span>已完成 {settled}/6 个研究步骤</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full bg-info transition-[width]", preparing && "w-1/3 animate-pulse")} style={preparing ? undefined : { width: `${settled / 6 * 100}%` }} />
          </div>
        </div>
      )}

      {run?.status === "failed" && (
        <p className="border-l-2 border-destructive/50 bg-destructive/5 px-2.5 py-2 text-caption text-destructive">
          投研运行失败；已完成的分析仍保留，未完成步骤不生成结论。
        </p>
      )}
      {processComplete ? (
        <details data-testid="research-process-details">
          <summary className="cursor-pointer text-caption font-medium text-foreground">
            {report?.schema_version === 4 ? "查看各分析角色结论" : `查看研究过程（已完成 ${settled}/6 个研究步骤）`}
          </summary>
          <div className="mt-3">{processSections}</div>
        </details>
      ) : processSections}
    </div>
  );
}
