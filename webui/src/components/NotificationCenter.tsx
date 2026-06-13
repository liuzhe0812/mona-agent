import { Bell } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useNotifications } from "@/hooks/useNotifications";

export interface NotificationCenterProps {
  onOpenSubscribe?: () => void;
}

export function NotificationCenter({ onOpenSubscribe }: NotificationCenterProps) {
  const [open, setOpen] = useState(false);
  const { notifications, unreadCount, loading, markAsRead, markAllAsRead } =
    useNotifications();

  const badgeText = unreadCount > 99 ? "99+" : String(unreadCount);

  const handleAction = (actionUrl?: string) => {
    if (actionUrl === "subscribe") {
      setOpen(false);
      onOpenSubscribe?.();
      return;
    }
    if (actionUrl) {
      window.open(actionUrl, "_blank");
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <div className="relative inline-flex">
          <Button variant="ghost" size="icon" aria-label="消息中心">
            <Bell className="h-5 w-5" />
          </Button>
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {badgeText}
            </span>
          )}
        </div>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full max-w-sm flex-col p-0">
        <SheetHeader className="flex-row items-center justify-between space-y-0 border-b p-4">
          <SheetTitle className="text-base">消息中心</SheetTitle>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" onClick={markAllAsRead}>
              全部已读
            </Button>
          )}
        </SheetHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            加载中...
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            暂无消息
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="divide-y">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className="flex gap-3 p-4 transition-colors hover:bg-muted/50"
                >
                  {!n.read && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-sm font-medium text-foreground">
                      {n.title}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {n.body}
                    </p>
                    <div className="mt-1 flex items-center justify-end gap-2">
                      {n.actionUrl && (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-0 py-0 text-xs"
                          onClick={() => handleAction(n.actionUrl)}
                        >
                          查看详情
                        </Button>
                      )}
                      {!n.read && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto px-2 py-1 text-xs"
                          onClick={() => markAsRead(n.id)}
                        >
                          已读
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
