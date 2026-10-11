import { useEffect } from "react";
import { developmentApi, isRunActive } from "@/lib/development-api";
import { useDevelopmentStore } from "./store";

// One observer per product session. Closing a view only stops observing it.
const observers = new Map<string, { refs: number; refresh: () => void; stop: () => void }>();
export function refreshDevelopmentSession(id: string) { observers.get(id)?.refresh(); }

export function useDevelopmentSession(id: string | null, visible = true) {
  useEffect(() => {
    if (!id || !visible) return;
    let entry = observers.get(id);
    if (!entry) {
      let stopped = false, inFlight = false, timer: ReturnType<typeof setTimeout> | undefined;
      let urgent = false;
      let watch: string | undefined;
      const poll = async () => {
        if (stopped) return;
        if (inFlight) { urgent = true; return; }
        clearTimeout(timer); inFlight = true;
        let delay = 2500;
        try {
          const state = useDevelopmentStore.getState();
          const snapshot = await developmentApi.snapshot(id, state.snapshots[id]?.eventCursor ?? 0, undefined, watch);
          if (!stopped) {
            state.setSnapshot(id, snapshot);
            watch = snapshot.moreEvents ? undefined : snapshot.watchVersion;
            delay = snapshot.moreEvents || watch ? 0 : isRunActive(snapshot.runs[0]) ? 700 : 2500;
          }
        } catch (error) {
          if (!stopped) useDevelopmentStore.getState().setError(id, error instanceof Error ? error.message : "会话读取失败");
          delay = 5000;
        } finally {
          inFlight = false;
          if (!stopped) { timer = setTimeout(poll, urgent ? 0 : delay); urgent = false; }
        }
      };
      entry = { refs: 0, refresh: () => { watch = undefined; void poll(); }, stop: () => { stopped = true; clearTimeout(timer); } };
      observers.set(id, entry);
      void poll();
    }
    entry.refs += 1;
    return () => { if (entry && --entry.refs === 0) { entry.stop(); observers.delete(id); } };
  }, [id, visible]);
  return useDevelopmentStore((state) => id ? state.snapshots[id] : undefined);
}
