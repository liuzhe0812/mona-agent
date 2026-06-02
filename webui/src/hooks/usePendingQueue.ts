import { useCallback, useState } from "react";

export interface PendingMessage {
  id: string;
  content: string;
}

const MAX_PENDING = 3;

export function usePendingQueue() {
  const [messages, setMessages] = useState<PendingMessage[]>([]);

  const enqueue = useCallback((content: string): boolean => {
    let accepted = false;
    setMessages((prev) => {
      if (prev.length >= MAX_PENDING) {
        return prev;
      }
      accepted = true;
      return [...prev, { id: crypto.randomUUID(), content }];
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
