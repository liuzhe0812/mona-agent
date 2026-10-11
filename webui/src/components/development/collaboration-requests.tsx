import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DevelopmentApiError, developmentApi, type DevCollaboration, type DevReviewSource, type ExecutorId } from "@/lib/development-api";
import { subagentApi } from "./workspace-api";
import { useDevelopmentStore } from "./store";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

export interface CollaborationPayload {
  executor: ExecutorId; goal: string; expectedOutput: string; readonly: boolean; presetId?: string;
  reviewSource?: DevReviewSource;
}
export interface PendingCollaboration { requestId: string; payload: CollaborationPayload }
export type CollaborationSurface = "review";
export const collaborationSlot = (session: string, surface: CollaborationSurface) => JSON.stringify([session, surface]);
const flights = new Map<string, { signature: string; promise: Promise<DevCollaboration> }>();

/** Preserve the original request across tab remounts; only explicit clicks retry it. */
export function dispatchCollaboration(session: string, surface: CollaborationSurface, payload: CollaborationPayload,
  beforeFirstDispatch?: () => Promise<void>): Promise<DevCollaboration> {
  const slot = collaborationSlot(session, surface);
  const existing = useDevelopmentStore.getState().collaborationRequests[slot];
  const canonical = (value: CollaborationPayload) => JSON.stringify([
    value.executor, value.goal, value.expectedOutput, value.readonly, value.presetId ?? "",
    value.reviewSource?.path ?? null, value.reviewSource?.version ?? null,
  ]);
  const signature = canonical(payload);
  const active = flights.get(slot);
  if ((existing && canonical(existing.payload) !== signature) || (active && active.signature !== signature)) {
    return Promise.reject(new Error("上次派发结果尚未确认，请先核对原派发；没有启动新的子任务。"));
  }
  if (active) return active.promise;
  const clear = (requestId: string) => {
    const state = useDevelopmentStore.getState();
    if (state.collaborationRequests[slot]?.requestId === requestId) state.setCollaborationRequest(slot, null);
  };
  const task = Promise.resolve().then(async () => {
    if (existing) {
      const record = await developmentApi.collaborationRequest(session, existing.requestId);
      if (record) { clear(existing.requestId); refreshDevelopmentSession(session); return record; }
    } else {
      await beforeFirstDispatch?.();
    }
    if (!payload.presetId?.trim()) throw new Error("请选择已保存的子智能体配置，临时协作任务已移除。");
    const pending = existing ?? { requestId: `collab_${crypto.randomUUID().replaceAll("-", "")}`, payload: { ...payload, ...(payload.reviewSource ? { reviewSource: { ...payload.reviewSource } } : {}) } };
    // A storage failure aborts before dispatch; an uncertain response retains the exact body.
    useDevelopmentStore.getState().setCollaborationRequest(slot, pending);
    try {
      const body = pending.payload;
      const record = await subagentApi.run(session, body.presetId!, pending.requestId, body.goal, body.expectedOutput, body.readonly, body.reviewSource);
      clear(pending.requestId); refreshDevelopmentSession(session);
      return record;
    } catch (error) {
      if (error instanceof DevelopmentApiError && [400, 401, 403, 404, 422].includes(error.status)) clear(pending.requestId);
      throw error;
    }
  }).finally(() => { flights.delete(slot); });
  flights.set(slot, { signature, promise: task });
  return task;
}

export function PendingCollaborationNotice({ sessionId, surface, onResolved }: {
  sessionId: string; surface: CollaborationSurface; onResolved: (record: DevCollaboration) => void;
}) {
  const pending = useDevelopmentStore((s) => s.collaborationRequests[collaborationSlot(sessionId, surface)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missingRequest, setMissingRequest] = useState<string | null>(null);
  if (!pending) return null;
  const inspect = async (retry = false) => {
    const slot = collaborationSlot(sessionId, surface);
    if (busy || useDevelopmentStore.getState().collaborationRequests[slot]?.requestId !== pending.requestId) return;
    setBusy(true); setError(""); setMissingRequest(null);
    try {
      const record = retry
        ? await dispatchCollaboration(sessionId, surface, pending.payload)
        : await developmentApi.collaborationRequest(sessionId, pending.requestId);
      if (!record) { setMissingRequest(pending.requestId); return; }
      if (record.parentSessionId !== sessionId || record.requestId !== pending.requestId) throw new Error("返回记录不属于原派发请求，未替换当前任务。");
      const state = useDevelopmentStore.getState();
      if (state.collaborationRequests[slot]?.requestId === pending.requestId) state.setCollaborationRequest(slot, null);
      refreshDevelopmentSession(sessionId); onResolved(record);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "派发状态尚未确认，原请求仍保留。"); }
    finally { setBusy(false); }
  };
  return <div role="status" className="space-y-2 rounded-md border border-border/60 p-3 text-caption">
    <p className="text-muted-foreground">上次子任务派发等待确认。关闭标签或切换会话不会重新派发。</p>
    <p className="line-clamp-2 break-words" title={pending.payload.goal}>{pending.payload.goal}</p>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void inspect()}>{busy ? "正在核对…" : "核对原派发"}</Button>
    {missingRequest === pending.requestId && <div className="space-y-2">
      {pending.payload.presetId ? <>
        <p className="text-muted-foreground">服务端暂未找到原请求，没有重新派发。重试仍使用原任务内容和请求标识。</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void inspect(true)}>按原请求重试</Button>
      </> : <>
        <p className="text-muted-foreground">未找到原任务。临时协作已移除，请改用已保存的子智能体配置。</p>
        <Button variant="outline" size="sm" onClick={() => useDevelopmentStore.getState().setCollaborationRequest(collaborationSlot(sessionId, surface), null)}>清除此待确认记录</Button>
      </>}
    </div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
