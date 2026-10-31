import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { developmentApi, type DevInput } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";
import { refreshDevelopmentSession } from "./useDevelopmentSession";

export function DevelopmentUnknownInputs({ sessionId, inputs }: { sessionId: string; inputs: DevInput[] }) {
  const [selected, setSelected] = useState<DevInput | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const close = async () => {
    if (!selected || !checked || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      await developmentApi.closeUnknownInput(sessionId, selected.id, selected.revision);
      const state = useDevelopmentStore.getState();
      const snapshot = state.snapshots[sessionId];
      if (snapshot) state.setSnapshot(sessionId, { ...snapshot,
        pendingInputs: snapshot.pendingInputs.filter((item) => item.id !== selected.id) });
      if (state.sends[sessionId]?.id === selected.id) state.setSend(sessionId, null);
      refreshDevelopmentSession(sessionId);
      setSelected(null);
    } catch {
      setError("暂时无法结束等待，原消息仍保留。请检查任务状态后重试。");
    } finally { pending.current = false; setBusy(false); }
  };
  if (!inputs.length) return null;
  return <div role="status" aria-label="补充消息待核对" className="space-y-2">
    <p className="font-medium text-warning">补充消息的生效情况尚未确认</p>
    {inputs.map((item) => <div key={item.id} className="space-y-1">
      <p className="line-clamp-2 whitespace-pre-wrap">{item.source?.content || item.source?.documentNames?.join("、") || "补充消息"}</p>
      <Button variant="outline" size="sm" disabled={!item.canCloseUnknown || busy} onClick={() => {
        setSelected(item); setChecked(false); setError("");
      }}>结束这条消息的等待</Button>
      {!item.canCloseUnknown && <p className="text-muted-foreground">请先结束原任务，再核对这条消息。</p>}
    </div>)}
    <Dialog open={!!selected} onOpenChange={(open) => { if (!open && !busy) setSelected(null); }}>
      <DialogContent><DialogHeader><DialogTitle>结束这条消息的等待？</DialogTitle>
        <DialogDescription>请先核对任务和文件改动。结束等待不会重新发送消息，也不代表消息已生效。</DialogDescription></DialogHeader>
        <label className="flex items-center gap-2 text-ui"><Checkbox checked={checked} disabled={busy}
          onCheckedChange={(value) => setChecked(value === true)} />已核对任务和文件改动</label>
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setSelected(null)}>取消</Button>
          <Button disabled={!checked || busy} onClick={() => void close()}>{busy ? "正在处理…" : "确认结束等待"}</Button>
        </DialogFooter></DialogContent>
    </Dialog>
  </div>;
}
