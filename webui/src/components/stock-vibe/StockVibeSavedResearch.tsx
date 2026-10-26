import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { getStockVibeAttempt, type StockVibeAttempt } from "@/lib/stock-vibe-api";
import { StockVibeReport } from "./StockVibeReport";
import { StockVibeInfo } from "./StockVibeInfo";
import { StockVibeResearchEvidence } from "./StockVibeResearchEvidence";

export interface StockVibeNotificationTarget {
  symbol?: string;
  artifact_id?: string;
  session_id?: string;
  attempt_id?: string;
}

const ATTEMPT_STATUS: Record<StockVibeAttempt["status"], string> = {
  pending: "等待开始", running: "研究中", waiting_user: "等待补充信息", completed: "已完成",
  failed: "研究失败", cancelled: "已取消", interrupted: "研究已中断",
};

export function StockVibeSavedResearch({ sessionId, attemptId, onClose, onResume, title = "通知对应研究", closeLabel = "返回研究", embedded = false }: {
  sessionId: string; attemptId: string; onClose: () => void; title?: string; closeLabel?: string; embedded?: boolean;
  onResume?: (sessionId: string) => void;
}) {
  const [attempt, setAttempt] = useState<StockVibeAttempt | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setAttempt(null);
    setError(false);
    void getStockVibeAttempt(sessionId, attemptId).then(({ native }) => {
      if (native.session_id !== sessionId || native.attempt_id !== attemptId) throw new Error("identity mismatch");
      if (active) setAttempt(native);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [sessionId, attemptId]);
  const currentAttempt = attempt?.session_id === sessionId && attempt.attempt_id === attemptId ? attempt : null;

  return <section aria-label={title} className="space-y-3">
    {!embedded && <div className="flex items-center justify-between gap-3">
      <h2 className="text-ui font-semibold">{title}</h2>
      <Button variant="ghost" size="sm" onClick={onClose}>{closeLabel}</Button>
    </div>}
    {error ? <p role="alert">暂时无法读取这次研究的记录，请稍后重新打开。</p>
      : !currentAttempt ? <p role="status">正在读取已有研究…</p>
        : currentAttempt.status !== "completed" ? <p role="status">这次研究尚无已完成报告，当前状态：{ATTEMPT_STATUS[currentAttempt.status] || "状态待确认"}。</p>
          : !currentAttempt.summary ? <p>研究已结束，但没有可显示的报告。</p>
            : <>
              <p className="text-caption text-muted-foreground">{currentAttempt.grounding_validation?.valid === true
                ? "数值匹配检查已通过，分析结论仍需复核。" : "数值匹配尚未确认，请核查原始资料。"}</p>
              <StockVibeReport>{currentAttempt.summary}</StockVibeReport>
              <StockVibeInfo title="本次研究依据" label="查看研究依据"><StockVibeResearchEvidence sessionId={sessionId} attemptId={attemptId} /></StockVibeInfo>
            </>}
    {!error && currentAttempt && !["pending", "running"].includes(currentAttempt.status) && onResume && <Button variant="secondary" onClick={() => onResume(sessionId)}>继续原研究</Button>}
  </section>;
}
