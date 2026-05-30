import { useEffect } from "react";

import { isTauri } from "@/lib/tauri";

import { useMdReaderStore } from "./mdReaderStore";

export function useFileOpen() {
  const openFile = useMdReaderStore((s) => s.openFile);

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("md-file-open", (event) => {
          const filePath = event.payload;
          if (filePath) {
            openFile(filePath);
          }
        });

        if (cancelled) {
          unlisten();
          return;
        }
      } catch (err) {
        console.error("Failed to listen for md-file-open event:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openFile]);
}
