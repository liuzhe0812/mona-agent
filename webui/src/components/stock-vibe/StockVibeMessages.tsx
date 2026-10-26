import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getStockVibeAttentionEvents, type StockVibeAttentionEvent } from "@/lib/stock-vibe-api";
import { stockTime } from "@/lib/stock-vibe-workbench";
import type { StockVibeNotificationTarget } from "./StockVibeSavedResearch";

export function StockVibeMessages({ onOpen, onError }: {
  onOpen: (target: StockVibeNotificationTarget) => void; onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0);
  const [events, setEvents] = useState<StockVibeAttentionEvent[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    void getStockVibeAttentionEvents().then(({ native }) => {
      if (!Array.isArray(native.events)) throw new Error("invalid event list");
      if (active) setEvents(native.events.filter((event) => event && typeof event.event_id === "string"
        && /^\d{6}\.(SH|SZ|BJ)$/.test(event.symbol) && ["research_completed", "condition_met"].includes(event.kind)));
    }).catch(() => {
      if (active) { setFailed(true); onError("暂时无法读取跟进消息，可以稍后重新打开。"); }
    });
    return () => { active = false; };
  }, [open, revision]);
  const validId = (id: string | null | undefined) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  return <>
    <Button size="icon" variant="ghost" aria-label="跟进消息" title="跟进消息" onClick={() => setOpen(true)}><Bell size={16} /></Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined} className="scrollbar-scope max-h-[80vh] max-w-2xl overflow-auto">
      <DialogHeader><DialogTitle>跟进消息</DialogTitle></DialogHeader>
      <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>刷新消息</Button>
      {failed ? <p className="text-caption">消息暂不可读，请稍后刷新。</p> : events === null ? <p role="status">正在读取消息…</p>
        : events.length === 0 ? <p className="text-caption text-muted-foreground">暂无跟进消息。已完成的研究和实际条件变化会列在这里。</p>
          : events.map((event) => <article key={event.event_id} className="space-y-2 border-b border-border py-3 text-caption">
            <p className="font-medium">{event.symbol.slice(0, 6)} · {event.kind === "research_completed" ? "跟进研究已完成" : "观察条件发生变化"}</p>
            <p className="text-muted-foreground">{stockTime(event.created_at)}</p>
            {(validId(event.session_id) && validId(event.attempt_id) || validId(event.artifact_id)) && <Button variant="ghost" size="sm" onClick={() => {
              setOpen(false); onOpen({ symbol: event.symbol, session_id: event.session_id ?? undefined,
                attempt_id: event.attempt_id ?? undefined, artifact_id: event.artifact_id ?? undefined });
            }}>{event.kind === "research_completed" ? "查看报告" : "查看对应记录"} →</Button>}
          </article>)}
    </DialogContent></Dialog>
  </>;
}
