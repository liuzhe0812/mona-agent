import {
  BookOpen,
  FileText,
  Home,
  Menu,
  Monitor,
  Plus,
  Server,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type WorkspaceTabId = "home" | "ssh" | "rdp" | "note" | "kb" | "windows";

interface WorkspaceTab {
  id: WorkspaceTabId;
  label: string;
  icon: LucideIcon;
  fixed?: boolean;
}

const TABS: WorkspaceTab[] = [
  { id: "home", label: "首页", icon: Home, fixed: true },
  { id: "ssh", label: "SSH prod-01", icon: Server },
  { id: "rdp", label: "RDP win-dev", icon: Monitor },
  { id: "note", label: "运维笔记.md", icon: FileText },
  { id: "kb", label: "知识库", icon: BookOpen },
  { id: "windows", label: "Windows 维护", icon: Wrench },
];

interface WorkspaceTabsProps {
  activeTab: WorkspaceTabId;
  onSelect: (tab: WorkspaceTabId) => void;
  onToggleSidebar: () => void;
}

export function WorkspaceTabs({
  activeTab,
  onSelect,
  onToggleSidebar,
}: WorkspaceTabsProps) {
  return (
    <div className="flex h-10 shrink-0 items-stretch border-b border-border/75 bg-sidebar/95">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="打开侧边栏"
        onClick={onToggleSidebar}
        className="h-10 w-10 shrink-0 rounded-none border-r border-border/70 text-muted-foreground hover:bg-sidebar-accent/75 hover:text-foreground lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </Button>
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden scrollbar-thin">
        {TABS.map((tab) => (
          <WorkspaceTabButton
            key={tab.id}
            tab={tab}
            active={activeTab === tab.id}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onSelect("home")}
          />
        ))}
        <button
          type="button"
          aria-label="新建标签页"
          className="flex h-10 w-10 shrink-0 items-center justify-center border-r border-border/70 text-muted-foreground transition-colors hover:bg-sidebar-accent/75 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function WorkspaceTabButton({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: WorkspaceTab;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const Icon = tab.icon;
  return (
    <div
      className={cn(
        "group flex h-10 min-w-0 shrink-0 items-center border-r border-border/70 text-[12.5px] font-medium transition-colors",
        tab.fixed ? "w-[72px]" : "w-[132px]",
        active
          ? "bg-background text-foreground shadow-[inset_0_1px_0_hsl(var(--background))]"
          : "bg-sidebar/80 text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left",
          tab.fixed && "justify-center px-2",
        )}
      >
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active && tab.id === "home" && "text-[#f25b8f]",
            active && tab.id === "ssh" && "text-[#4f9de8]",
            active && tab.id === "rdp" && "text-[#53c59d]",
            active && tab.id === "note" && "text-[#eba45d]",
            active && tab.id === "kb" && "text-[#a877e7]",
            active && tab.id === "windows" && "text-[#53c59d]",
          )}
        />
        <span className="min-w-0 truncate">{tab.label}</span>
      </button>
      {!tab.fixed ? (
        <button
          type="button"
          aria-label={`关闭 ${tab.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="mr-2 grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground/55 opacity-70 transition-colors hover:bg-foreground/8 hover:text-foreground group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}
