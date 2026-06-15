import {
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  Monitor,
  Server,
} from "lucide-react";
import { useTerminalStore } from "./store/terminalStore";

interface Props {
  sessionId: string | null;
}

export function StatusBar({ sessionId }: Props) {
  const session = useTerminalStore((s) =>
    sessionId ? s.sessions.find((ss) => ss.id === sessionId) : null,
  );

  if (!session) {
    return (
      <div className="flex h-6 shrink-0 items-center gap-4 border-t bg-sidebar/50 px-3 text-[11px] text-muted-foreground">
        <WifiOff className="h-3 w-3" />
        <span>无活动会话</span>
      </div>
    );
  }

  const statusIcon =
    session.status === "connected" ? (
      <Wifi className="h-3 w-3 text-emerald-500" />
    ) : session.status === "connecting" ? (
      <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
    ) : session.status === "error" ? (
      <AlertTriangle className="h-3 w-3 text-destructive" />
    ) : (
      <WifiOff className="h-3 w-3" />
    );

  const statusText =
    session.status === "connected"
      ? "已连接"
      : session.status === "connecting"
        ? "连接中"
        : session.status === "error"
          ? "连接错误"
          : "未连接";

  const typeIcon =
    session.type === "local" ? (
      <Monitor className="h-3 w-3" />
    ) : (
      <Server className="h-3 w-3" />
    );

  const typeLabel =
    session.type === "ssh"
      ? "SSH"
      : session.type === "sftp"
        ? "SFTP"
        : session.type === "batch"
          ? "批量"
          : "本地";

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar/50 px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        {statusIcon}
        <span>{statusText}</span>
      </div>
      <div className="h-3 w-px bg-border" />
      <div className="flex items-center gap-1.5">
        {typeIcon}
        <span>{typeLabel}</span>
      </div>
      <div className="h-3 w-px bg-border" />
      <span>UTF-8</span>
      {session.title && (
        <>
          <div className="h-3 w-px bg-border" />
          <span className="truncate">{session.title}</span>
        </>
      )}
    </div>
  );
}
