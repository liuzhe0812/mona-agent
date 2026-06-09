import type { ReactNode } from "react";
import { Maximize2, Minus, Settings, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface AppTitleBarProps {
  onOpenSettings?: () => void;
}

async function withCurrentWindow(
  action: (win: Awaited<
    ReturnType<typeof import("@tauri-apps/api/window").getCurrentWindow>
  >) => Promise<void>,
) {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await action(getCurrentWindow());
  } catch (e) {
    console.error("[AppTitleBar] window action failed:", e);
  }
}

export function AppTitleBar({ onOpenSettings }: AppTitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center border-b border-border/70 bg-sidebar/95 text-sidebar-foreground"
    >
      <div data-tauri-drag-region className="min-w-0 flex-1" />
      <div className="flex h-full items-center">
        <ConnectionBadge />
        {onOpenSettings && (
          <TitleBarButton
            label="设置"
            onClick={onOpenSettings}
          >
            <Settings className="h-3.5 w-3.5" />
          </TitleBarButton>
        )}
        <TitleBarButton
          label="最小化"
          onClick={() => {
            void withCurrentWindow((win) => win.minimize());
          }}
        >
          <Minus className="h-3.5 w-3.5" />
        </TitleBarButton>
        <TitleBarButton
          label="最大化"
          onClick={() => {
            void withCurrentWindow((win) => win.toggleMaximize());
          }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </TitleBarButton>
        <TitleBarButton
          label="关闭"
          danger
          onClick={() => {
            void withCurrentWindow((win) => win.close());
          }}
        >
          <X className="h-3.5 w-3.5" />
        </TitleBarButton>
      </div>
    </header>
  );
}

function TitleBarButton({
  label,
  children,
  danger = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "h-9 w-11 rounded-none text-muted-foreground hover:bg-sidebar-accent/80 hover:text-foreground",
        danger && "hover:bg-red-500 hover:text-white",
      )}
    >
      {children}
    </Button>
  );
}
