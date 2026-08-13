import { useEffect, useRef, useState } from "react";
import { XtermTerminal } from "./XtermTerminal";
import { DesktopMode } from "./Desktop/DesktopMode";
import { useTerminalStore } from "./store/terminalStore";
import { shellSpawn, sshConnect, desktopConnect } from "./ipc";
import type { SessionType } from "./types/terminal";

export function StandaloneTerminalWindow() {
  const params = new URLSearchParams(window.location.search);
  const configId = params.get("configId") ?? "";
  const sessionType = (params.get("sessionType") ?? "local") as SessionType;
  const sessionTitle = params.get("sessionTitle") ?? "终端";

  const addSession = useTerminalStore((s) => s.addSession);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);

  const initializedRef = useRef(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    const init = async () => {
      try {
        if ((sessionType === "ssh" || sessionType === "sftp") && configId) {
          await useTerminalStore.getState().loadSavedConnections();
          const config = useTerminalStore.getState().savedConnections.find(
            (c) => c.id === configId,
          );
          if (!config) throw new Error("未找到连接配置");
          const newId = await sshConnect(config);
          addSession({
            id: newId,
            configId: config.id,
            type: sessionType,
            status: "connected",
            title: sessionTitle,
          });
          setActiveSession(newId);
          setSessionId(newId);
        } else if (sessionType === "desktop" && configId) {
          await useTerminalStore.getState().loadSavedConnections();
          const config = useTerminalStore.getState().savedConnections.find(
            (c) => c.id === configId,
          );
          if (!config) throw new Error("未找到连接配置");
          const newId = await desktopConnect(config);
          addSession({
            id: newId,
            configId: config.id,
            type: "desktop",
            status: "connected",
            title: sessionTitle,
          });
          setActiveSession(newId);
          setSessionId(newId);
        } else {
          const newId = await shellSpawn(80, 24);
          addSession({
            id: newId,
            configId: "",
            type: "local",
            status: "connected",
            title: sessionTitle || "本地终端",
          });
          setActiveSession(newId);
          setSessionId(newId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "连接失败");
      }
    };
    void init();
  }, [sessionType, configId, sessionTitle, addSession, setActiveSession]);

  const isDesktop = sessionType === "desktop";

  if (isDesktop && sessionId) {
    return (
      <div className="flex h-full flex-col bg-[#1b1440]">
        <DesktopMode sessionId={sessionId} />
      </div>
    );
  }

  return (
    <div className="h-full bg-[#1a1a1a] text-white">
      {error ? (
        <div className="flex h-full items-center justify-center text-body text-red-400">
          {error}
        </div>
      ) : !sessionId ? (
        <div className="flex h-full items-center justify-center text-body text-white/50">
          正在连接...
        </div>
      ) : (
        <XtermTerminal sessionId={sessionId} />
      )}
    </div>
  );
}
