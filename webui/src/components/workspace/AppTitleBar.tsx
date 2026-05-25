import type { ReactNode } from "react";
import { Maximize2, Minus, Moon, Sun, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

export type WorkspaceTabId = "ssh" | "rdp" | "note" | "kb" | "windows";

export interface OpenTab {
  id: WorkspaceTabId;
  label: string;
  icon: ReactNode;
}

interface AppTitleBarProps {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  openTabs: OpenTab[];
  activeTabId: WorkspaceTabId | null;
  onSelectTab: (id: WorkspaceTabId) => void;
  onCloseTab: (id: WorkspaceTabId) => void;
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

export function AppTitleBar({
  theme,
  onToggleTheme,
  openTabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}: AppTitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center border-b border-border/70 bg-sidebar/95 text-sidebar-foreground"
    >
      {openTabs.length > 0 ? (
        <div
          className="flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden scrollbar-thin"
          onPointerDownCapture={undefined}
        >
          {openTabs.map((tab) => (
            <TitleBarTab
              key={tab.id}
              label={tab.label}
              icon={tab.icon}
              active={tab.id === activeTabId}
              onSelect={() => onSelectTab(tab.id)}
              onClose={() => onCloseTab(tab.id)}
            />
          ))}
        </div>
      ) : null}
      <div data-tauri-drag-region className="min-w-0 flex-1" />
      <div className="flex h-full items-center">
        <TitleBarButton
          label={theme === "dark" ? "切换到浅色" : "切换到深色"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? (
            <Sun className="h-3.5 w-3.5" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          )}
        </TitleBarButton>
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

function TitleBarTab({
  label,
  icon,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-9 min-w-0 shrink-0 items-center border-r border-border/70 text-[12.5px] font-medium transition-colors",
        active
          ? "bg-background text-foreground"
          : "bg-sidebar/80 text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex h-full min-w-0 items-center gap-1.5 px-3 text-left"
      >
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 max-w-[120px] truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={`关闭 ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="mr-1.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground/55 opacity-0 transition-colors hover:bg-foreground/8 hover:text-foreground group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
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
