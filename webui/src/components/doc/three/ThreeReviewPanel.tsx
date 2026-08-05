/**
 * 右栏评审面板：组件树、规格与候选状态。
 */

import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

import {
  applyCandidate,
  discardCandidate,
  fetchCandidateDiff,
  type ThreeCandidateDiff,
  type ThreeComponent,
} from "./threeState";

interface ThreeReviewPanelProps {
  projectName: string;
  components: ThreeComponent[];
  specPresent: boolean;
  candidatePresent: boolean;
  onCandidateResolved: () => void;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  } catch {
    return String(value);
  }
}

const KIND_LABELS: Record<string, string> = {
  added: "新增",
  removed: "删除",
  changed: "修改",
};

export function ThreeReviewPanel({
  projectName,
  components,
  specPresent,
  candidatePresent,
  onCandidateResolved,
}: ThreeReviewPanelProps) {
  const [diff, setDiff] = useState<ThreeCandidateDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDiff(null);
    setError("");
    if (!candidatePresent) return;
    let cancelled = false;
    fetchCandidateDiff(projectName)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        if (!cancelled) setDiff(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, candidatePresent]);

  const handleApply = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await applyCandidate(projectName);
      onCandidateResolved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "应用失败");
    } finally {
      setBusy(false);
    }
  }, [projectName, onCandidateResolved]);

  const handleDiscard = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await discardCandidate(projectName);
      onCandidateResolved();
    } catch {
      setError("放弃候选失败");
    } finally {
      setBusy(false);
    }
  }, [projectName, onCandidateResolved]);

  return (
    <div className="flex flex-col gap-2">
      <div className="px-2.5 text-[12px] font-medium text-muted-foreground">组件树</div>
      {components.length === 0 ? (
        <div className="px-2.5 text-[12px] text-muted-foreground">
          {specPresent ? "暂无组件" : "暂无组件：上传参考图后由 AI 生成"}
        </div>
      ) : (
        <div className="flex flex-col">
          {components.map((c) => (
            <div key={c.id} className="flex flex-col rounded-lg px-2.5 py-1.5 hover:bg-accent">
              <span className="text-[13px]">{c.name || c.id}</span>
              <span className="text-[11px] text-muted-foreground">
                {c.id} · {c.role} · {c.primitive}
              </span>
            </div>
          ))}
        </div>
      )}
      {candidatePresent && (
        <div className="mx-2.5 mt-1 flex flex-col gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2">
          <div className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
            待应用的候选规格
          </div>
          {diff?.stale ? (
            <div className="text-[12px] text-amber-600 dark:text-amber-400">
              候选已过期：正式规格在候选生成后发生了变化，不能直接应用。
            </div>
          ) : (
            diff && (
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto scrollbar-thin">
                {diff.changes.length === 0 ? (
                  <div className="text-[12px] text-muted-foreground">候选与正式规格一致</div>
                ) : (
                  diff.changes.map((c) => (
                    <div key={`${c.kind}:${c.path}`} className="text-[11px] leading-4">
                      <span className="mr-1 text-muted-foreground">{KIND_LABELS[c.kind] ?? c.kind}</span>
                      <span className="break-all">{c.path}</span>
                      {c.kind === "changed" && (
                        <span className="block break-all text-muted-foreground">
                          {formatValue(c.before)} → {formatValue(c.after)}
                        </span>
                      )}
                      {c.kind === "added" && (
                        <span className="block break-all text-muted-foreground">
                          {formatValue(c.after)}
                        </span>
                      )}
                      {c.kind === "removed" && (
                        <span className="block break-all text-muted-foreground">
                          {formatValue(c.before)}
                        </span>
                      )}
                    </div>
                  ))
                )}
                {diff.truncated && (
                  <div className="text-[11px] text-muted-foreground">差异过多，仅显示前 500 条</div>
                )}
              </div>
            )
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={busy || diff?.stale === true}
              onClick={handleApply}
            >
              应用
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={handleDiscard}>
              放弃
            </Button>
          </div>
          {error && <div className="text-[11px] text-destructive">{error}</div>}
        </div>
      )}
    </div>
  );
}
