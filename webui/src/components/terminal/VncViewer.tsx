import { useCallback, useEffect, useRef } from "react";
import RFB from "@novnc/novnc";

interface VncViewerProps {
  wsUrl: string;
  wsToken: string;
  password?: string;
  onDisconnect?: () => void;
}

export function VncViewer({ wsUrl, wsToken, password, onDisconnect }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const disconnectReasonRef = useRef<string | null>(null);

  const connect = useCallback(() => {
    if (!containerRef.current) return;

    // Clean up previous connection
    if (rfbRef.current) {
      rfbRef.current.disconnect();
      rfbRef.current = null;
    }

    const url = `${wsUrl}/?token=${encodeURIComponent(wsToken)}`;

    try {
      const rfb = new RFB(containerRef.current, url, {
        credentials: password ? { password } : undefined,
      });

      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;

      rfb.addEventListener("connect", () => {
        console.log("[VNC] Connected");
      });

      rfb.addEventListener("disconnect", (e: CustomEvent<{ clean: boolean }>) => {
        const detail = e.detail;
        console.log("[VNC] Disconnected, clean:", detail.clean);
        rfbRef.current = null;
        if (!detail.clean && onDisconnect) {
          onDisconnect();
        }
      });

      rfb.addEventListener("credentialsrequired", () => {
        // If VNC server requires credentials and we don't have them,
        // we could show a dialog. For now, just log.
        console.log("[VNC] Credentials required by server");
      });

      rfb.addEventListener("desktopname", (e: CustomEvent<{ name: string }>) => {
        console.log("[VNC] Desktop name:", e.detail.name);
      });

      rfbRef.current = rfb;
    } catch (err) {
      console.error("[VNC] Failed to connect:", err);
      disconnectReasonRef.current = String(err);
    }
  }, [wsUrl, wsToken, password, onDisconnect]);

  useEffect(() => {
    connect();
    return () => {
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };
  }, [connect]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{
        background: "#1a1a2e",
      }}
    />
  );
}
