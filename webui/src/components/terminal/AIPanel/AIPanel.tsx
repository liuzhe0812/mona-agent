import { useCallback, useState } from "react";
import { AIChat } from "./AIChat";
import { QuickActions } from "./QuickActions";

interface Props {
  sessionId: string | null;
}

export function AIPanel({ sessionId }: Props) {
  const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined);
  const [messageKey, setMessageKey] = useState(0);

  const handleQuickAction = useCallback((prompt: string) => {
    setInitialMessage(prompt);
    setMessageKey((prev) => prev + 1);
  }, []);

  const handleInitialMessageSent = useCallback(() => {
    setInitialMessage(undefined);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <QuickActions onAction={handleQuickAction} />
      </div>
      <div className="flex-1 overflow-auto">
        <AIChat
          key={messageKey}
          sessionId={sessionId}
          initialMessage={initialMessage}
          onInitialMessageSent={handleInitialMessageSent}
        />
      </div>
    </div>
  );
}
