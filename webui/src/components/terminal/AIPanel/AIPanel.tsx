import { Bot, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { AIChat } from "./AIChat";
import { QuickActions } from "./QuickActions";
import type { ActionConfirmResult } from "./ActionConfig";

interface Props {
  sessionId: string | null;
}

export function AIPanel({ sessionId }: Props) {
  const [initialAction, setInitialAction] = useState<ActionConfirmResult | undefined>(undefined);
  const [messageKey, setMessageKey] = useState(0);

  const handleResetChat = useCallback(() => {
    setInitialAction(undefined);
    setMessageKey((prev) => prev + 1);
  }, []);

  const handleQuickAction = useCallback((result: ActionConfirmResult) => {
    setInitialAction(result);
    setMessageKey((prev) => prev + 1);
  }, []);

  const handleInitialMessageSent = useCallback(() => {
    setInitialAction(undefined);
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-md border border-border/70 bg-background">
            <Bot className="h-3 w-3 text-muted-foreground" />
          </span>
          <h2 className="truncate text-[12px] font-semibold text-foreground">AI 助手</h2>
        </div>
        <button
          type="button"
          aria-label="重置会话"
          title="重置会话"
          onClick={handleResetChat}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="shrink-0 border-b border-border/65 px-2.5 py-2.5">
        <QuickActions onAction={handleQuickAction} />
      </div>
      <div className="flex-1 overflow-auto">
        <AIChat
          key={messageKey}
          sessionId={sessionId}
          initialAction={initialAction}
          onInitialMessageSent={handleInitialMessageSent}
        />
      </div>
    </div>
  );
}
