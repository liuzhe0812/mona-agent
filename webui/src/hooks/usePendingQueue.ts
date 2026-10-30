import { useCallback, useState } from "react";

import type { SendImage, SendOptions } from "@/hooks/useMonaStream";

export interface PendingMessage {
  id: string;
  content: string;
  images?: SendImage[];
  options?: SendOptions;
  locked?: boolean;
  deliveryState?: "pending" | "unknown";
}

const MAX_PENDING = 3;

export function usePendingQueue(chatId: string | null = null) {
  const [queues, setQueues] = useState<Record<string, PendingMessage[]>>({});
  const scope = chatId ?? "";
  const messages = queues[scope] ?? [];
  const setMessages = useCallback((update: (previous: PendingMessage[]) => PendingMessage[]) => {
    setQueues((previous) => ({ ...previous, [scope]: update(previous[scope] ?? []) }));
  }, [scope]);

  const enqueue = useCallback((content: string, images?: SendImage[], options?: SendOptions): boolean => {
    let accepted = false;
    setMessages((prev) => {
      if (prev.length >= MAX_PENDING) {
        return prev;
      }
      accepted = true;
      return [
        ...prev,
        {
          id: crypto.randomUUID(),
          content,
          ...(images?.length ? { images } : {}),
          ...(options ? { options } : {}),
        },
      ];
    });
    return accepted;
  }, [setMessages]);

  const remove = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, [setMessages]);

  const update = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m)),
    );
  }, [setMessages]);

  const clear = useCallback(() => {
    setMessages(() => []);
  }, [setMessages]);

  const setDeliveryState = useCallback((id: string, deliveryState?: PendingMessage["deliveryState"]) => {
    setMessages((previous) => previous.map((message) => message.id === id
      ? { ...message, deliveryState, locked: deliveryState !== undefined }
      : message));
  }, [setMessages]);

  return { messages, enqueue, remove, update, clear, setDeliveryState };
}
