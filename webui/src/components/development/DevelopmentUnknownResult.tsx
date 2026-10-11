import { useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi, type DevNativeBinding, type DevRun } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

export function DevelopmentUnknownResult({ run, binding, onStop, stopping = false }: {
  run: DevRun; binding?: DevNativeBinding | null; onStop?: () => void | Promise<void>; stopping?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const canClose = !!binding && ["claude", "codebuddy"].includes(run.executor);
  const canStop = !!onStop && ["codex", "mona"].includes(run.executor);
  const resolve = async () => {
    if (pending.current || !binding || !checked) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await developmentApi.closeUnknown(run.sessionId, run.id, run.revision, binding.id);
      const state = useDevelopmentStore.getState();
      const snapshot = state.snapshots[run.sessionId];
      if (snapshot && result.id === run.id && result.sessionId === run.sessionId) {
        state.setSnapshot(run.sessionId, { ...snapshot,
          runs: snapshot.runs.map((item) => item.id === result.id ? result : item),
          ...(result.status === "closed_unknown" ? { nativeBinding: null } : {}),
        });
        if (result.status === "closed_unknown" && state.sends[run.sessionId]?.id === result.requestId) state.setSend(run.sessionId, null);
      }
      refreshDevelopmentSession(run.sessionId);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "暂时无法处理，请重试。原任务没有重新执行。");
      setOpen(true);
    } finally { pending.current = false; setBusy(false); }
  };
  return <div role="status" aria-label="任务结果暂未收到" className="space-y-2">
    <p className="flex items-center gap-2 font-medium text-warning"><TriangleAlert className="h-4 w-4 shrink-0" />未收到任务完成结果</p>
    <p className="text-muted-foreground">任务可能仍在执行，或已修改项目文件。请勿重复发送相同任务。</p>
    {canStop && <Button variant="outline" size="sm" disabled={busy || stopping} onClick={() => void onStop()}>{stopping ? "正在中断…" : "停止任务"}</Button>}
    {canClose && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setChecked(false); setError(""); setOpen(true); }}>结束等待并继续</Button>}
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}><DialogContent>
      <DialogHeader><DialogTitle>结束等待</DialogTitle><DialogDescription>请先检查文件改动，并确认相关操作已结束。之后可发送新任务，原任务不会重做。</DialogDescription></DialogHeader>
      {canClose && <label className="flex items-start gap-2 text-ui"><Checkbox checked={checked} disabled={busy} onCheckedChange={(value) => setChecked(value === true)} />已检查文件改动，确认相关操作已结束</label>}
      {error && <><p role="alert" className="text-caption text-destructive">暂时无法结束等待，请稍后再试。</p>
        <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">诊断详情</summary><p className="mt-2 break-words">{error}</p></details></>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
        {canClose && <Button disabled={busy || !checked} onClick={() => void resolve()}>{busy ? "正在处理…" : "确认并继续"}</Button>}
      </DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
