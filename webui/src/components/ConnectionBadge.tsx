import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { useClientOptional, type RuntimeStatus } from "@/providers/ClientProvider";
import type { ConnectionStatus } from "@/lib/types";

const COPY: Record<ConnectionStatus, { color: string }> = {
  idle: { color: "text-muted-foreground" },
  connecting: {
    color: "text-amber-700 dark:text-amber-300",
  },
  open: {
    color: "text-emerald-700 dark:text-emerald-400",
  },
  reconnecting: {
    color: "text-amber-700 dark:text-amber-300",
  },
  closed: {
    color: "text-muted-foreground",
  },
  error: {
    color: "text-destructive",
  },
};

function runtimeStatusToConnectionStatus(
  status: RuntimeStatus,
): ConnectionStatus | null {
  if (status === "ready") return null; // ready 时由 client.status 决定
  if (status === "connecting") return "connecting";
  if (status === "error") return "error";
  if (status === "auth") return "idle"; // auth 时不显示连接异常
  return null;
}

export function ConnectionBadge() {
  const { t } = useTranslation();
  const { client, runtimeStatus } = useClientOptional();
  const [clientStatus, setClientStatus] = useState<ConnectionStatus>(
    client ? client.status : "idle",
  );

  useEffect(() => {
    if (!client) return;
    return client.onStatus(setClientStatus);
  }, [client]);

  // runtime 未就绪时，用 runtimeStatus 推导显示状态
  const status: ConnectionStatus | null = client
    ? clientStatus
    : runtimeStatusToConnectionStatus(runtimeStatus);

  if (!status || status === "open" || status === "idle") return null;

  const meta = COPY[status];
  const pulsing =
    status === "connecting" ||
    status === "reconnecting" ||
    status === "error";
  const label = t(`connection.${status}`);
  return (
    <span
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors",
        "text-muted-foreground/70 hover:bg-sidebar-accent/65",
        meta.color,
      )}
      aria-live="polite"
      role="status"
      title={label}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {pulsing && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
        )}
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
