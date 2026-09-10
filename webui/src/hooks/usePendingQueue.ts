import { useCallback, useState } from "react";

import type { SendImage, SendOptions } from "@/hooks/useMonaStream";

export interface PendingMessage {
  id: string;
  content: string;
  images?: SendImage[];
  options?: SendOptions;
}

const MAX_PENDING = 3;

export function usePendingQueue() {
  const [messages, setMessages] = useState<PendingMessage[]>([]);

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
  }, []);

  const remove = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const update = useCallback((id: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content } : m)),
    );
  }, []);

  const clear = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, enqueue, remove, update, clear };
}
