import {
  Wifi,
  WifiOff,
  Loader2,
  AlertTriangle,
  Monitor,
  Server,
} from "lucide-react";
import { useTerminalStore } from "./store/terminalStore";
import { useBatchStore } from "./store/batchStore";

interface Props {
  sessionId: string | null;
}

export function StatusBar({ sessionId }: Props) {
  const session = useTerminalStore((s) =>
    sessionId ? s.sessions.find((ss) => ss.id === sessionId) : null,
  );
  const batchSessions = useBatchStore((s) => session?.type === "batch" ? s.sessions : null);
  const batchIsConnecting = useBatchStore((s) => session?.type === "batch" && s.isConnecting);

  if (!session) {
    return (
      <div className="flex h-6 shrink-0 items-center gap-4 border-t bg-sidebar/50 px-3 text-micro text-muted-foreground">
        <WifiOff className="h-3 w-3" />
        <span>无活动会话</span>
      </div>
    );
  }

  const connectedCount = batchSessions?.filter((s) => s.status === "connected").length ?? 0;
  const status = session.type === "batch"
    ? batchIsConnecting || batchSessions?.some((s) => s.status === "connecting")
      ? "connecting"
      : connectedCount > 0 ? "connected" : "disconnected"
    : session.status;

  const statusIcon =
    status === "connected" ? (
      <Wifi className="h-3 w-3 text-success-indicator" />
    ) : status === "connecting" ? (
      <Loader2 className="h-3 w-3 animate-spin text-warning" />
    ) : status === "error" ? (
      <AlertTriangle className="h-3 w-3 text-destructive" />
    ) : (
      <WifiOff className="h-3 w-3" />
    );

  const statusText =
    status === "connected"
      ? session.type === "batch" ? `已连接 ${connectedCount}/${batchSessions?.length ?? 0}` : "已连接"
      : status === "connecting"
        ? session.type === "batch" ? `正在连接 ${connectedCount}/${batchSessions?.length ?? 0}` : "连接中"
        : status === "error"
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
    <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-sidebar/50 px-3 text-micro text-muted-foreground">
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
