import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { DownloadBar } from "./DownloadBar";
import { useTheme } from "@/hooks/useTheme";
import { browserHideDownloads, browserShowDownloadsWindow } from "@/lib/browser-ipc";

export function DownloadsWindow() {
  useTheme();

  useEffect(() => {
    void browserShowDownloadsWindow();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    void window.onFocusChanged(({ payload: focused }) => {
      if (!focused) void browserHideDownloads();
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  return (
    <div className="h-full w-full overflow-hidden rounded-lg">
      <DownloadBar open onOpenChange={(open) => {
        if (!open) void browserHideDownloads();
      }} />
    </div>
  );
}
