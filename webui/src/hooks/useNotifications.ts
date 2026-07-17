import { useCallback, useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isTauri } from "@/lib/tauri";

export interface AppNotification {
  id: number;
  title: string;
  body: string;
  type: string;
  actionUrl?: string;
  imageUrl?: string;
  read: boolean;
  publishedAt?: string;
  expiresAt?: string;
}

interface RawNotification {
  id: number;
  title: string;
  body: string;
  type: string;
  action_url?: string;
  image_url?: string;
  read: boolean;
  published_at?: string;
  expires_at?: string;
}

interface ListNotificationsResponse {
  notifications: RawNotification[];
}

interface UnreadCountResponse {
  unread_count: number;
}

function toAppNotification(raw: RawNotification): AppNotification {
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    type: raw.type,
    actionUrl: raw.action_url,
    imageUrl: raw.image_url,
    read: raw.read,
    publishedAt: raw.published_at,
    expiresAt: raw.expires_at,
  };
}

export function useNotifications(): {
  notifications: AppNotification[];
  unreadCount: number;
  loading: boolean;
  fetchNotifications: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markAsRead: (id: number) => Promise<void>;
  markAllAsRead: () => Promise<void>;
} {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchNotifications = useCallback(async () => {
    if (!isTauri()) {
      setNotifications([]);
      return;
    }
    setLoading(true);
    try {
      const response = await invoke<ListNotificationsResponse>("list_notifications");
      setNotifications((response.notifications ?? []).map(toAppNotification));
    } catch {
      // 未登录或请求失败时静默处理，保持现有 state
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    if (!isTauri()) {
      setUnreadCount(0);
      return;
    }
    try {
      const res = await invoke<UnreadCountResponse>("get_unread_notification_count");
      setUnreadCount(res.unread_count ?? 0);
    } catch {
      // 静默
    }
  }, []);

  const markAsRead = useCallback(async (id: number) => {
    if (!isTauri()) return;
    try {
      await invoke("mark_notification_read", { notificationId: id });
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch {
      // 静默
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    const unread = notifications.filter((n) => !n.read);
    await Promise.all(unread.map((n) => markAsRead(n.id)));
  }, [notifications, markAsRead]);

  useEffect(() => {
    void fetchNotifications();
    void fetchUnreadCount();

    const intervalId = window.setInterval(() => {
      void fetchNotifications();
      void fetchUnreadCount();
    }, 5 * 60 * 1000);

    let unlisten: UnlistenFn | undefined;
    listen("auth-state-changed", (event) => {
      const payload = event.payload as { loggedIn: boolean };
      if (payload.loggedIn) {
        void fetchNotifications();
        void fetchUnreadCount();
      } else {
        setNotifications([]);
        setUnreadCount(0);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchNotifications();
        void fetchUnreadCount();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      if (unlisten) unlisten();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchNotifications, fetchUnreadCount]);

  return {
    notifications,
    unreadCount,
    loading,
    fetchNotifications,
    fetchUnreadCount,
    markAsRead,
    markAllAsRead,
  };
}
