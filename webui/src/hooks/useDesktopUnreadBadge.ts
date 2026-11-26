import { Image } from "@tauri-apps/api/image";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

import { isTauri } from "@/lib/tauri";

async function createUnreadOverlay(label: string): Promise<Image> {
  const canvas = document.createElement("canvas");
  const size = 32;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unable to draw the unread badge");

  const brandRed = getComputedStyle(document.documentElement).getPropertyValue("--brand-red").trim();
  ctx.fillStyle = `hsl(${brandRed})`;
  ctx.beginPath();
  ctx.roundRect(1, 1, 30, 30, label.length === 1 ? 15 : 10);
  ctx.fill();
  ctx.fillStyle = "white";
  ctx.font = `bold ${label.length === 1 ? 24 : label.length === 2 ? 20 : 15}px Segoe UI, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, size / 2, size / 2, 26);

  return Image.new(new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer), size, size);
}

export function useDesktopUnreadBadge(count: number): void {
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    if (!isTauri()) return;
    const windows = /Windows/.test(navigator.userAgent);
    if (!windows && !/Macintosh/.test(navigator.userAgent)) return;
    const desktopWindow = getCurrentWindow();
    if (desktopWindow.label !== "main") return;

    const label = count > 99 ? "99+" : count > 0 ? String(count) : undefined;
    let active = true;
    const sync = () => {
      queue.current = queue.current.then(async () => {
        if (!active) return;
        if (!windows) {
          await desktopWindow.setBadgeLabel(label);
          return;
        }

        const icon = label ? await createUnreadOverlay(label) : undefined;
        try {
          if (active) await desktopWindow.setOverlayIcon(icon);
        } finally {
          await icon?.close();
        }
      }).catch(() => console.warn("Could not update the desktop unread badge"));
    };

    sync();
    window.addEventListener("focus", sync);
    return () => {
      active = false;
      window.removeEventListener("focus", sync);
    };
  }, [count]);
}
