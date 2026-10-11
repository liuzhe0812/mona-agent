import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi, runLabels, type DevCollaboration } from "@/lib/development-api";
export { SubagentAvatar } from "./SubagentAvatar";

export function useSubagentTasks(sessionId: string, visible: boolean) {
  const [state, setState] = useState<{ sessionId: string; records: DevCollaboration[] | null; error: string }>({ sessionId, records: null, error: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const records = await developmentApi.collaborations(sessionId);
        if (records.some((record) => record.parentSessionId !== sessionId)) throw new Error("子任务记录不属于当前任务，请重新读取。");
        if (active) setState({ sessionId, records, error: "" });
      } catch {
        if (active) setState((old) => ({ sessionId, records: old.sessionId === sessionId ? old.records : null, error: "无法读取子任务，请重试。" }));
      } finally {
        if (active) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [sessionId, visible, revision]);
  return { ...(state.sessionId === sessionId ? state : { records: null, error: "" }), retry: () => setRevision((value) => value + 1) };
}

export function taskGroup(record: DevCollaboration): "active" | "completed" | "ended" {
  if (record.latestRun?.status === "succeeded") return "completed";
  if (record.latestRun?.status === "failed" || record.latestRun?.status === "interrupted" || record.latestRun?.status === "closed_unknown" || !record.latestRun && record.state === "failed") return "ended";
  return "active";
}

export function taskTime(record: DevCollaboration) { return record.latestRun?.finishedAt || record.latestRun?.createdAt || record.createdAt || ""; }
export function recentTasks(records: DevCollaboration[]) {
  return [...records].sort((a, b) => (Date.parse(taskTime(b)) || 0) - (Date.parse(taskTime(a)) || 0));
}
export function taskLabel(record: DevCollaboration) { return record.title || record.goal; }
export function taskStatus(record: DevCollaboration) {
  return record.latestRun ? runLabels[record.latestRun.status] : record.state === "failed" ? "未启动成功" : record.state === "unknown" ? "待确认" : "准备中";
}
export function taskProgress(record: DevCollaboration) {
  return record.latestRun?.status === "running" ? record.progress?.trim() || "处理中" : taskStatus(record);
}
export function taskElapsed(record: DevCollaboration, currentTime: number) {
  const start = Date.parse(record.latestRun?.startedAt || record.latestRun?.createdAt || record.createdAt || "");
  if (!Number.isFinite(start)) return "";
  const seconds = record.latestRun?.status === "queued" ? 0 : Math.max(0, Math.floor((currentTime - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}
export function taskAge(record: DevCollaboration) {
  const timestamp = Date.parse(taskTime(record));
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (!minutes) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  const days = Math.floor(minutes / 1440);
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

export function SubagentLoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(!!error); }, [error]);
  return <Dialog open={open && !!error} onOpenChange={setOpen}><DialogContent>
    <DialogHeader><DialogTitle>子任务读取失败</DialogTitle><DialogDescription>{error}</DialogDescription></DialogHeader>
    <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>关闭</Button><Button onClick={onRetry}>重新读取</Button></DialogFooter>
  </DialogContent></Dialog>;
}
