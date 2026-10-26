import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/tauri";

export interface CloudUpdate { work_keys: string[]; planning: boolean }

function validUpdate(value: unknown): value is CloudUpdate {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<CloudUpdate>;
  return typeof data.planning === "boolean" && Array.isArray(data.work_keys)
    && data.work_keys.length <= 100 && data.work_keys.every((key) =>
      typeof key === "string" && /^websocket:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(key));
}

/** Refresh existing views after a committed local import, without changing selection or starting work. */
export function useCloudUpdates(onUpdate: (value: CloudUpdate) => void): void {
  const callback = useRef(onUpdate);
  callback.current = onUpdate;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenOperations: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keys = new Set<string>();
    let planning = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisten = await listen<unknown>("mona-cloud-updated", ({ payload }) => {
        if (disposed || !validUpdate(payload)) return;
        for (const key of payload.work_keys) keys.add(key);
        planning ||= payload.planning;
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          if (disposed) return;
          const value = { work_keys: [...keys], planning };
          keys.clear(); planning = false;
          callback.current(value);
        }, 75);
      });
      if (disposed) { unlisten(); return; }
      unlistenOperations = await listen("operations-connections-changed", () => {
        if (disposed) return;
        void import("@/components/terminal/store/terminalStore")
          .then(({ useTerminalStore }) => useTerminalStore.getState().loadSavedConnections())
          .catch(() => { if (!disposed) console.warn("Saved host list could not be refreshed."); });
      });
      if (disposed) unlistenOperations();
    }).catch(() => {
      if (!disposed) console.warn("Cloud view updates unavailable; reopen the view to refresh.");
    });
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); unlisten?.(); unlistenOperations?.(); };
  }, []);
}
