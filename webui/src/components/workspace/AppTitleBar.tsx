import type { ReactNode } from "react";
import { Maximize2, Minus, Plus, Settings, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/ConnectionBadge";
import { BrowserTabItem } from "@/components/browser/BrowserTab";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { Tab } from "@/hooks/useBrowserTabs";

interface AppTitleBarProps {
  tabs: Tab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
  onOpenSettings?: (section?: string) => void;
  /** When true, renders a pulsing badge on the settings button (e.g. update available). */
  settingsBadge?: boolean;
  // 标签管理增强
  onPinToggle?: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onCloseOthers?: (id: string) => void;
  onCloseRight?: (id: string) => void;
  onReorder?: (fromId: string, toId: string) => void;
  onToggleMute?: (id: string) => void;
  // md-reader 标签专用
  onSaveMdAsNote?: (id: string) => void;
  onRevealMdInExplorer?: (id: string) => void;
}

async function withCurrentWindow(
  action: (win: ReturnType<typeof getCurrentWindow>) => Promise<void>,
) {
  if (!isTauri()) return;
  try {
    await action(getCurrentWindow());
  } catch (e) {
    console.error("[AppTitleBar] window action failed:", e);
  }
}

export function AppTitleBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
  onOpenSettings,
  settingsBadge,
  onPinToggle,
  onDuplicate,
  onCloseOthers,
  onCloseRight,
  onReorder,
  onToggleMute,
  onSaveMdAsNote,
  onRevealMdInExplorer,
}: AppTitleBarProps) {
  return (
    <header
      data-tauri-drag-region="deep"
      className="flex h-9 shrink-0 items-center border-b border-border/70 bg-sidebar/95 text-sidebar-foreground"
    >
      {/* 标签栏 */}
      <div className="flex items-center gap-0.5 overflow-x-auto px-2 scrollbar-none">
        {tabs.map((tab) => (
          <BrowserTabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onClick={() => onTabClick(tab.id)}
            onClose={tab.type !== "mona" ? () => onTabClose(tab.id) : undefined}
            onPinToggle={tab.type !== "mona" && onPinToggle ? () => onPinToggle(tab.id) : undefined}
            onDuplicate={tab.type === "browser" && onDuplicate ? () => onDuplicate(tab.id) : undefined}
            onCloseOthers={tab.type !== "mona" && onCloseOthers ? () => onCloseOthers(tab.id) : undefined}
            onCloseRight={tab.type !== "mona" && onCloseRight ? () => onCloseRight(tab.id) : undefined}
            onReorder={onReorder}
            onToggleMute={tab.type === "browser" && onToggleMute ? () => onToggleMute(tab.id) : undefined}
            onSaveAsNote={tab.type === "md-reader" && onSaveMdAsNote ? () => onSaveMdAsNote(tab.id) : undefined}
            onRevealInExplorer={tab.type === "md-reader" && onRevealMdInExplorer ? () => onRevealMdInExplorer(tab.id) : undefined}
          />
        ))}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onNewTab}
          className="h-6 w-6 rounded-md text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>

      {/* 右侧控制按钮 */}
      <div className="ml-auto flex h-full items-center">
        <ConnectionBadge />
        {onOpenSettings && (
          <TitleBarButton label="设置" onClick={() => onOpenSettings()} badge={settingsBadge}>
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
  badge = false,
  onClick,
}: {
  label: string;
  children: ReactNode;
  danger?: boolean;
  badge?: boolean;
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
        "relative h-9 w-11 rounded-none text-muted-foreground hover:bg-sidebar-accent/80 hover:text-foreground",
        danger && "hover:bg-red-500 hover:text-white",
      )}
    >
      {children}
      {badge ? (
        <span className="absolute right-2.5 top-2 flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500/70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" />
        </span>
      ) : null}
    </Button>
  );
}
