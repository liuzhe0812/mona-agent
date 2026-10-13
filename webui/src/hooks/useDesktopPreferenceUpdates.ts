import { useEffect, useRef } from "react";
import { getDesktopSettings, isTauri, SEND_MESSAGE_SHORTCUT_EVENT, type DesktopAppSettings } from "@/lib/tauri";

/** Native storage is authoritative; the event never carries configuration or navigation commands. */
export function useDesktopPreferenceUpdates(onUpdate: (settings: DesktopAppSettings) => void): void {
  const callback = useRef(onUpdate);
  callback.current = onUpdate;
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let generation = 0;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      const current = ++generation;
      try {
        const settings = await getDesktopSettings();
        if (disposed || generation !== current) return;
        if (!settings || !Array.isArray(settings.sidebar_modules)
          || !["enter", "ctrl_enter"].includes(settings.send_message_shortcut)) return;
        window.dispatchEvent(new CustomEvent(SEND_MESSAGE_SHORTCUT_EVENT, { detail: settings.send_message_shortcut }));
        callback.current(settings);
      } catch {
        if (!disposed) console.warn("Desktop preferences refresh deferred; reopen settings to refresh.");
      }
    };
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      unlisten = await listen("desktop-preferences-changed", () => { if (!disposed) void refresh(); });
      if (disposed) unlisten();
    }).catch(() => {
      if (!disposed) console.warn("Desktop preference notifications unavailable; reopen settings to refresh.");
    });
    return () => { disposed = true; generation += 1; unlisten?.(); };
  }, []);
}
