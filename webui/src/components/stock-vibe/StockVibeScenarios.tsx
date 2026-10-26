import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { StockVibeInfo } from "./StockVibeInfo";
import { EmptyState } from "@/components/ui/empty-state";
import { listStockVibeScenarios, StockVibeApiError, type StockVibeScenarioArtifact, type StockVibeScenarioCondition, type StockVibeScenarioMode } from "@/lib/stock-vibe-api";

export interface StockVibeScenariosProps {
  symbol: string | null;
  mode: StockVibeScenarioMode;
  focusArtifactId?: string;
}

const JUDGMENTS: Record<StockVibeScenarioArtifact["judgment"], string> = {
  bullish: "偏多",
  bearish: "偏空",
  neutral: "中性",
  watch: "观察",
  insufficient_data: "证据不足",
};

const OPERATORS: Record<StockVibeScenarioCondition["operator"], string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  equal: "=",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCondition(value: unknown): value is StockVibeScenarioCondition {
  if (!isRecord(value)) return false;
  return typeof value.field === "string"
    && ["gt", "gte", "lt", "lte", "equal"].includes(String(value.operator))
    && (value.threshold === null || (typeof value.threshold === "number" && Number.isFinite(value.threshold)))
    && (typeof value.evidence_ref === "string" || value.evidence_ref === null)
    && (typeof value.source === "string" || value.source === null)
    && (typeof value.observed_at === "string" || value.observed_at === null)
    && (typeof value.missing_data === "string" || value.missing_data === null);
}

function isSource(value: unknown): boolean {
  return isRecord(value)
    && typeof value.snapshot_id === "string" && /^sha256:[a-f0-9]{64}$/.test(value.snapshot_id)
    && typeof value.instance_id === "string" && /^[a-f0-9]{32}$/.test(value.instance_id)
    && typeof value.data_root_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.data_root_sha256)
    && Array.isArray(value.patches) && value.patches.every((patch) => isRecord(patch)
      && typeof patch.path === "string" && typeof patch.category === "string"
      && typeof patch.sha256 === "string" && /^[a-f0-9]{64}$/.test(patch.sha256));
}

function isScenario(value: unknown): value is StockVibeScenarioArtifact {
  if (!isRecord(value)) return false;
  const modes = ["ultrashort", "swing", "medium"];
  const judgments = ["bullish", "bearish", "neutral", "watch", "insufficient_data"];
  return typeof value.artifact_id === "string"
    && typeof value.run_id === "string"
    && typeof value.symbol === "string"
    && modes.includes(String(value.mode))
    && typeof value.created_at === "string"
    && typeof value.as_of === "string"
    && typeof value.horizon === "string"
    && judgments.includes(String(value.judgment))
    && typeof value.next_step === "string"
    && Array.isArray(value.conditions) && value.conditions.every(isCondition)
    && Array.isArray(value.invalidation) && value.invalidation.every(isCondition)
    && (typeof value.review_at === "string" || value.review_at === null)
    && (typeof value.supersedes === "string" || value.supersedes === null)
    && (typeof value.revision_reason === "string" || value.revision_reason === null)
    && isSource(value.source);
}

function apiErrorMessage(error: unknown): string {
  return error instanceof StockVibeApiError
    ? error.message
    : "暂时无法读取已保存的情景，请稍后重试。";
}

function conditionLine(condition: StockVibeScenarioCondition): string {
  if (condition.threshold === null || condition.missing_data) {
    return `${condition.field} · 缺项：${condition.missing_data || "未提供缺项说明"}`;
  }
  return `${condition.field} ${OPERATORS[condition.operator]} ${condition.threshold}`;
}

function ScenarioFacts({ artifact }: { artifact: StockVibeScenarioArtifact }) {
  return (
    <div className="mt-3 space-y-3 text-caption">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">判断</dt><dd>{JUDGMENTS[artifact.judgment] ?? artifact.judgment}</dd>
        <dt className="text-muted-foreground">时点</dt><dd>{artifact.as_of}</dd>
        <dt className="text-muted-foreground">期限</dt><dd>{artifact.horizon}</dd>
        <dt className="text-muted-foreground">复核</dt><dd>{artifact.review_at ?? "未设置"}</dd>
      </dl>
      <section aria-label="有来源条件">
        <h4 className="mb-1 font-medium">条件</h4>
        {artifact.conditions.length ? (
          <ul className="space-y-2">
            {artifact.conditions.map((condition, index) => (
              <li key={`${condition.field}-${index}`} className="rounded-md bg-muted/40 p-2">
                <p>{conditionLine(condition)}</p>
                {condition.threshold !== null && (
                  <p className="mt-1 text-muted-foreground">
                    来源：{condition.source ?? "未提供"} · 观测时点：{condition.observed_at ?? "未提供"}
                  </p>
                )}
                {condition.evidence_ref && (
                  <p className="mt-1 break-all text-muted-foreground">证据：{condition.evidence_ref}</p>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">未记录条件。</p>}
      </section>
      <section aria-label="失效条件">
        <h4 className="mb-1 font-medium">失效条件</h4>
        {artifact.invalidation.length ? (
          <ul className="space-y-2">
            {artifact.invalidation.map((condition, index) => (
              <li key={`${condition.field}-${index}`} className="rounded-md bg-muted/40 p-2">
                <p>{conditionLine(condition)}</p>
                {condition.threshold !== null && (
                  <p className="mt-1 text-muted-foreground">
                    来源：{condition.source ?? "未提供"} · 观测时点：{condition.observed_at ?? "未提供"}
                  </p>
                )}
                {condition.evidence_ref && (
                  <p className="mt-1 break-all text-muted-foreground">证据：{condition.evidence_ref}</p>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-muted-foreground">未记录失效条件。</p>}
      </section>
      <p><span className="font-medium">下一步：</span>{artifact.next_step}</p>
      {artifact.revision_reason && <p><span className="font-medium">修订原因：</span>{artifact.revision_reason}</p>}
      <p className="break-all text-muted-foreground">情景编号：{artifact.artifact_id} · 研究记录：{artifact.run_id}</p>
      <p className="break-all text-muted-foreground">来源版本：{artifact.source.snapshot_id} · 补丁数：{artifact.source.patches.length}</p>
    </div>
  );
}

function sortNewest(left: StockVibeScenarioArtifact, right: StockVibeScenarioArtifact): number {
  return right.created_at.localeCompare(left.created_at) || right.artifact_id.localeCompare(left.artifact_id);
}

export function StockVibeScenarios({ symbol, mode, focusArtifactId }: StockVibeScenariosProps) {
  const [scenarios, setScenarios] = useState<StockVibeScenarioArtifact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!symbol) {
      setScenarios([]);
      setLoading(false);
      setError(null);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void listStockVibeScenarios().then((response) => {
      if (!active) return;
      if (!isRecord(response.native) || !Array.isArray(response.native.scenarios)) {
        throw new Error("invalid scenario response");
      }
      const valid = response.native.scenarios.filter(isScenario);
      if (valid.length !== response.native.scenarios.length) throw new Error("invalid scenario artifact");
      setScenarios(valid);
    }).catch((reason: unknown) => {
      if (active) {
        setScenarios([]);
        setError(apiErrorMessage(reason));
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [symbol, revision]);

  if (!symbol) {
    return <EmptyState title="先选择一个标的" description="选择标的后可查看已保存的走势情景。" />;
  }
  if (loading) return <p className="text-caption text-muted-foreground" role="status">正在读取已保存的情景…</p>;
  if (error) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-caption text-destructive">{error}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>
          重试
        </Button>
      </div>
    );
  }

  const matching = scenarios
    .filter((scenario) => focusArtifactId ? scenario.artifact_id === focusArtifactId
      : scenario.symbol.toUpperCase() === symbol.toUpperCase() && scenario.mode === mode)
    .sort(sortNewest);
  const [latest, ...history] = matching;
  if (!latest) {
    return <EmptyState title={focusArtifactId ? "未找到通知引用的情景" : "暂无已保存的走势情景"} description={`${symbol} · ${mode}`} />;
  }

  return (
    <section className="mb-5 space-y-3 rounded-lg border border-border p-4" aria-label="已保存走势情景">
      <div>
        <p className="text-caption text-muted-foreground">{latest.symbol} · {focusArtifactId ? "通知引用情景" : "最新已保存情景"}</p>
        <h3 className="text-ui font-semibold">{JUDGMENTS[latest.judgment] ?? latest.judgment} · {latest.horizon}</h3>
        <p className="text-caption text-muted-foreground">
          保存于 {latest.created_at}{latest.supersedes ? ` · 修订自 ${latest.supersedes}` : ""}
        </p>
      </div>
      <ScenarioFacts artifact={latest} />
      {history.length > 0 && (
        <StockVibeInfo title="历史版本" label={`历史版本（${history.length}）`}>
          <div className="space-y-2">
            {history.map((artifact) => {
              const label = `${artifact.created_at} · ${JUDGMENTS[artifact.judgment] ?? artifact.judgment} · ${artifact.horizon}`;
              return <StockVibeInfo key={artifact.artifact_id} title={label} label={label}>
                <ScenarioFacts artifact={artifact} />
              </StockVibeInfo>;
            })}
          </div>
        </StockVibeInfo>
      )}
    </section>
  );
}
