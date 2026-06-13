import { useCallback, useEffect, useState } from "react";

import { invoke } from "@tauri-apps/api/core";

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
      setNotifications(response.notifications.map(toAppNotification));
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
      const count = await invoke<number>("get_unread_notification_count");
      setUnreadCount(count);
    } catch {
      setUnreadCount(0);
    }
  }, []);

  const markAsRead = useCallback(async (id: number) => {
    if (!isTauri()) return;
    await invoke("mark_notification_read", { notification_id: id });
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const markAllAsRead = useCallback(async () => {
    const unread = notifications.filter((n) => !n.read);
    await Promise.all(unread.map((n) => markAsRead(n.id)));
  }, [notifications, markAsRead]);

  useEffect(() => {
    void fetchNotifications();
    void fetchUnreadCount();
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
