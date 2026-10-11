import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi, executorLabels, runLabels, type DevCollaboration, type DevReviewSourceState, type DevSession } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";
import { refreshDevelopmentSession } from "./useDevelopmentSession";
import { ReviewVersionNotice } from "./DevelopmentReviewVersion";

export function DevelopmentResultFollowUp({ record, session, available, onUpdated }: {
  record: DevCollaboration; session: DevSession; available: boolean; onUpdated: (record: DevCollaboration) => void;
}) {
  const snapshot = useDevelopmentStore((s) => s.snapshots[session.id]);
  const pendingSend = useDevelopmentStore((s) => s.sends[session.id]);
  const current = snapshot?.session ?? session;
  const [target, setTarget] = useState<DevSession | null>(null);
  const [sourceCheck, setSourceCheck] = useState<DevReviewSourceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => () => { epoch.current += 1; }, [session.id, record.id]);
  const blocked = !available || current.archived || current.readonly
    || ["unknown", "recovering", "interrupting"].includes(snapshot?.runs[0]?.status ?? "")
    || !!pendingSend;
  const canPrepare = useRef(false);
  canPrepare.current = !blocked;
  const inspectionOnly = () => setNotice("暂未查到处理请求。当前仅核对状态，不会重新发送。");
  const apply = (value: DevCollaboration) => {
    if (value.id !== record.id || value.parentSessionId !== session.id) throw new Error("返回结果不属于当前任务。");
    onUpdated(value); refreshDevelopmentSession(session.id);
  };
  const inspect = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    const generation = epoch.current;
    try {
      const value = await developmentApi.inspectCollaborationResult(session.id, record.id);
      if (generation !== epoch.current) return;
      apply(value);
      if (!value.followUp) {
        if (!canPrepare.current) { inspectionOnly(); return; }
        const source = value.reviewSource ? await developmentApi.reviewSource(session.id, record.id) : null;
        if (generation !== epoch.current) return;
        if (source && (source.collaborationId !== record.id || source.parentSessionId !== session.id)) throw new Error("版本资料不属于当前审查。");
        if (!canPrepare.current) { inspectionOnly(); return; }
        setSourceCheck(source);
        setTarget(useDevelopmentStore.getState().snapshots[session.id]?.session ?? session);
      }
    } catch (cause) { if (generation === epoch.current) setError(cause instanceof Error ? cause.message : "状态核对失败，没有发送请求。"); }
    finally { inFlight.current = false; if (generation === epoch.current) setBusy(false); }
  };
  const submit = async () => {
    if (!target || inFlight.current || blocked) return;
    inFlight.current = true; setBusy(true); setError("");
    const generation = epoch.current;
    try {
      const value = await developmentApi.continueCollaborationResult(target, record.id);
      if (generation === epoch.current) { apply(value); setTarget(null); }
    } catch (cause) {
      if (generation === epoch.current) { setTarget(null); setError(cause instanceof Error ? cause.message : "发送结果待核对，没有自动重试。"); }
    } finally { inFlight.current = false; if (generation === epoch.current) setBusy(false); }
  };
  const follow = record.followUp;
  const inputLabels: Record<string, string> = {
    pending: "已排队，等待当前任务成功结束", reserved: "正在派发", accepted: "已接收", consumed: "已派发，请查看主会话",
    cancelled: "已撤回，未重新执行", rejected: "未接收，请查看主会话", unknown: "派发状态待核对，未重新执行",
  };
  if (!record.returnMessageId) return null;
  return <div className="space-y-2" aria-label="子任务结果处理">
    {follow ? <p role="status" className="text-caption text-muted-foreground">主会话处理 · {follow.run
      ? follow.run.status === "succeeded" ? "本轮已结束，请查看处理结论" : runLabels[follow.run.status]
      : inputLabels[follow.input?.state ?? ""] ?? "状态待核对"}</p>
      : <Button variant="outline" size="sm" className="h-7 text-caption" disabled={busy} onClick={() => void inspect()}>
        {busy ? "正在核对…" : blocked || error ? "核对处理状态" : "交给主会话处理"}
      </Button>}
    {notice && blocked && !follow && <p role="status" className="text-caption text-muted-foreground">{notice}</p>}
    {error && !follow && <p role="alert" className="text-caption text-destructive">{error}</p>}
    <Dialog open={!!target} onOpenChange={(open) => { if (!open && !busy) setTarget(null); }}><DialogContent>
      <DialogHeader><DialogTitle>处理子任务结果</DialogTitle><DialogDescription>在原主会话中继续，不重新运行子智能体，不覆盖输入框中的草稿。主任务运行时会排队等待。</DialogDescription></DialogHeader>
      {target && <p className="text-ui">{executorLabels[target.executor]} · {target.model ?? "当前默认模型"}</p>}
      {sourceCheck && <ReviewVersionNotice value={sourceCheck} />}
      <p className="line-clamp-3 break-words text-caption text-muted-foreground">{record.goal}</p>
      <p className="text-caption text-muted-foreground">主负责人将核对当前代码，判断并处理建议；子任务结束不代表建议已采纳或验证通过。</p>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setTarget(null)}>取消</Button><Button disabled={busy || blocked} onClick={() => void submit()}>{busy ? "正在发送…" : "确认交给主会话"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
