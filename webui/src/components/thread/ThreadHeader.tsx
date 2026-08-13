import { Menu, Moon, Sun, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConversationMeta } from "@/lib/types";

interface ThreadHeaderProps {
  title: string;
  onToggleSidebar: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  hideSidebarToggleOnDesktop?: boolean;
  minimal?: boolean;
  /** Multi-agent phase 2d: conversation shape of the active session. Rooms
   *  surface a member-count badge that toggles the room context panel. */
  conversation?: ConversationMeta | null;
  onToggleRoomPanel?: () => void;
}

export function ThreadHeader({
  title,
  onToggleSidebar,
  theme,
  onToggleTheme,
  hideSidebarToggleOnDesktop = false,
  minimal = false,
  conversation = null,
  onToggleRoomPanel,
}: ThreadHeaderProps) {
  const { t } = useTranslation();
  if (minimal) {
    return (
      <div className="relative z-10 flex h-11 items-center justify-between gap-3 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("thread.header.toggleSidebar")}
          onClick={onToggleSidebar}
          className={cn(
            "h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
            hideSidebarToggleOnDesktop && "lg:hidden",
          )}
        >
          <Menu className="h-3.5 w-3.5" />
        </Button>
        <ThemeButton
          theme={theme}
          onToggleTheme={onToggleTheme}
          label={t("thread.header.toggleTheme")}
          className="ml-auto"
        />
      </div>
    );
  }

  const isRoom = conversation?.type === "room";
  const memberCount = isRoom ? (conversation?.agentIds.length ?? 0) : 0;

  return (
    <div className="relative z-10 flex items-center justify-between gap-3 px-3 py-2">
      <div className="relative flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("thread.header.toggleSidebar")}
          onClick={onToggleSidebar}
          className={cn(
            "h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
            hideSidebarToggleOnDesktop && "lg:hidden",
          )}
        >
          <Menu className="h-3.5 w-3.5" />
        </Button>
        <div className="flex min-w-0 items-center rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground">
          <span className="max-w-[min(60vw,32rem)] truncate">{title}</span>
        </div>
        {isRoom && onToggleRoomPanel ? (
          <button
            type="button"
            onClick={onToggleRoomPanel}
            aria-label={t("room.header.members", { count: memberCount })}
            title={t("room.header.members", { count: memberCount })}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">{memberCount}</span>
          </button>
        ) : null}
      </div>

      <ThemeButton
        theme={theme}
        onToggleTheme={onToggleTheme}
        label={t("thread.header.toggleTheme")}
        className="ml-auto shrink-0"
      />

      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-4" />
    </div>
  );
}

function ThemeButton({
  theme,
  onToggleTheme,
  label,
  className,
}: {
  theme: "light" | "dark";
  onToggleTheme: () => void;
  label: string;
  className?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      onClick={onToggleTheme}
      className={cn(
        "h-8 w-8 rounded-full text-muted-foreground/85 hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}
