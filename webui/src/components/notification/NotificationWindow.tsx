import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X } from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";

interface NotificationAction {
  label: string;
  action: string;
  primary?: boolean;
}

interface NotificationPayload {
  id: string;
  title: string;
  body: string;
  icon: string;
  actions: NotificationAction[];
  autoCloseMs: number;
  clickAction?: string;
  clickData?: unknown;
}

function decodePayload(): NotificationPayload | null {
  try {
    const hash = window.location.hash;
    const match = hash.match(/[?&]data=([^&]+)/);
    if (!match) return null;
    // Rust encodes with URL-safe base64 (no padding): uses - and _ instead of
    // + and /. Convert back to standard base64 for atob().
    const standard = match[1].replace(/-/g, "+").replace(/_/g, "/");
    // atob() returns a Latin-1 string; decode bytes as UTF-8 so Chinese
    // characters in title/body are preserved.
    const binary = atob(standard);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder("utf-8").decode(bytes);
    const parsed = JSON.parse(json) as NotificationPayload;
    return parsed;
  } catch {
    return null;
  }
}

export function NotificationWindow() {
  useTheme();
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [closing, setClosing] = useState(false);
  const hoverRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const remainingRef = useRef(0);

  const startCloseTimer = useCallback((durationMs: number) => {
    if (closeTimerRef.current !== null) {
      window.clearInterval(closeTimerRef.current);
    }
    remainingRef.current = durationMs;
    const tickMs = 100;
    closeTimerRef.current = window.setInterval(() => {
      if (hoverRef.current) return;
      remainingRef.current -= tickMs;
      if (remainingRef.current <= 0) {
        if (closeTimerRef.current !== null) {
          window.clearInterval(closeTimerRef.current);
          closeTimerRef.current = null;
        }
        setClosing(true);
      }
    }, tickMs);
  }, []);

  useEffect(() => {
    document.body.classList.add("notification-body");
    return () => document.body.classList.remove("notification-body");
  }, []);

  useEffect(() => {
    const data = decodePayload();
    if (!data) return;
    setPayload(data);
    if (data.autoCloseMs > 0) {
      startCloseTimer(data.autoCloseMs);
    }
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearInterval(closeTimerRef.current);
      }
    };
  }, [startCloseTimer]);

  // payload 设置后窗口内容已渲染，此时再显示窗口避免白屏闪烁
  useEffect(() => {
    if (!payload) return;
    const label = getCurrentWindow().label;
    void invoke("show_notification_window", { label }).catch(() => {});
  }, [payload]);

  // 出场动画结束后真正关闭窗口
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      const label = getCurrentWindow().label;
      void invoke("close_notification_window", { label }).catch(() => {
        void getCurrentWindow().close().catch(() => {});
      });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [closing]);

  const handleMouseEnter = useCallback(() => {
    hoverRef.current = true;
  }, []);
  const handleMouseLeave = useCallback(() => {
    hoverRef.current = false;
  }, []);

  const handleClose = useCallback(() => {
    if (closing) return;
    if (closeTimerRef.current !== null) {
      window.clearInterval(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(true);
  }, [closing]);

  const handleAction = useCallback(
    (action: string, data?: unknown) => {
      void invoke("emit_notification_action", { action, data }).catch(() => {});
      handleClose();
    },
    [handleClose],
  );

  const handleCardClick = useCallback(() => {
    if (payload?.clickAction) {
      handleAction(payload.clickAction, payload.clickData);
    }
  }, [payload, handleAction]);

  if (!payload) return null;

  const visibleActions = payload.actions.slice(0, 2);

  return (
    <div
      className={cn(
        "h-full w-full select-none overflow-hidden rounded-2xl",
        closing
          ? "animate-out fade-out-0 slide-out-to-right-full duration-300"
          : "animate-in fade-in-0 slide-in-from-right-full duration-300",
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={cn(
          "relative flex h-full w-full flex-col gap-1.5 overflow-hidden rounded-2xl border border-border/60 bg-popover/95 p-3.5 shadow-[0_18px_55px_rgba(15,23,42,0.18)] backdrop-blur-xl dark:border-white/10 dark:shadow-[0_22px_55px_rgba(0,0,0,0.45)]",
          payload.clickAction && "cursor-pointer hover:bg-popover",
        )}
        onClick={handleCardClick}
      >
        <div className="flex items-start gap-3">
          {/* 应用 logo */}
          <div className="shrink-0">
            <AgentLogo state="welcome" className="h-10 w-10" />
          </div>
          <div className="min-w-0 flex-1 pr-5">
            <p className="text-[13px] font-semibold leading-5 text-foreground">
              {payload.title}
            </p>
            <p className="mt-0.5 text-[12px] leading-4 text-muted-foreground line-clamp-2">
              {payload.body}
            </p>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleClose();
            }}
            aria-label="关闭"
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {visibleActions.length > 0 ? (
          <div className="mt-0.5 flex items-center justify-end gap-2">
            {visibleActions.map((act) => (
              <Button
                key={act.action}
                size="sm"
                variant={act.primary ? "default" : "ghost"}
                onClick={(e) => {
                  e.stopPropagation();
                  handleAction(act.action);
                }}
                className="h-6 rounded-full px-2.5 text-[11px]"
              >
                {act.label}
              </Button>
            ))}
          </div>
        ) : null}
        {/* 底部渐变装饰条 */}
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-gradient-to-r from-blue-500/0 via-blue-500/40 to-blue-500/0" />
      </div>
    </div>
  );
}
