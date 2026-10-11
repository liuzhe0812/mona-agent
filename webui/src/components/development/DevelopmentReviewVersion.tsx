import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { developmentApi, type DevCollaboration, type DevReviewSourceState } from "@/lib/development-api";

export function ReviewVersionNotice({ value }: { value: DevReviewSourceState }) {
  const labels = { unchanged: "核对时版本未变", changed: "代码已变化，原审查需要重新确认", unavailable: "当前版本无法核对" };
  return <div className="space-y-1 text-caption text-muted-foreground" aria-label="审查版本核对结果">
    <p>{labels[value.state]}</p>
    {value.path !== null && <p className="break-all">范围：{value.path || "项目已跟踪文件差异"}</p>}
    {value.reason && <p>{value.reason}</p>}
    <p>核对时间：{new Date(value.checkedAt).toLocaleTimeString()} · 版本一致不代表审查通过。</p>
  </div>;
}

export function DevelopmentReviewVersion({ sessionId, record }: { sessionId: string; record: DevCollaboration }) {
  const [value, setValue] = useState<DevReviewSourceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    setValue(null); setError(""); setBusy(false); running.current = false;
    return () => { epoch.current += 1; };
  }, [sessionId, record.id, record.reviewSource?.version]);
  if (!record.readonly) return null;
  const check = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); setValue(null);
    const generation = epoch.current;
    try {
      const result = await developmentApi.reviewSource(sessionId, record.id);
      if (generation !== epoch.current) return;
      if (result.parentSessionId !== sessionId || result.collaborationId !== record.id) throw new Error("返回资料不属于当前审查。");
      setValue(result);
    } catch (cause) { if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "版本核对失败，未启动任务。"); }
    finally { if (generation === epoch.current) { running.current = false; setBusy(false); } }
  };
  return <div className="space-y-1 pt-1">
    {value ? <ReviewVersionNotice value={value} /> : <p className="text-micro text-muted-foreground">{record.reviewSource ? "审查版本尚未核对当前代码。" : "此任务未记录可核对版本。"}</p>}
    <Button variant="ghost" size="sm" className="h-7 text-caption" disabled={busy || !record.reviewSource} onClick={() => void check()}>{busy ? "正在核对版本…" : "核对代码版本"}</Button>
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
  </div>;
}
