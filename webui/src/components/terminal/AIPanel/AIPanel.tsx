import { useCallback, useState } from "react";
import { AIChat } from "./AIChat";
import { QuickActions } from "./QuickActions";
import { terminalGetOutput } from "../ipc";

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

  const handleGetOutput = useCallback(async () => {
    if (!sessionId) return;
    try {
      const output = await terminalGetOutput(sessionId);
      setInitialMessage(
        output.trim()
          ? `[终端输出]\n\`\`\`\n${output.slice(-4000)}\n\`\`\`\n\n请分析以上终端输出`
          : "终端暂无输出内容",
      );
      setMessageKey((prev) => prev + 1);
    } catch {}
  }, [sessionId]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <QuickActions onAction={handleQuickAction} onGetOutput={handleGetOutput} />
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
