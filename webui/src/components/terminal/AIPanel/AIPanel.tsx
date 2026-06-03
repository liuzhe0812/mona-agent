import { Bot } from "lucide-react";
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

  const handleQuickAction = useCallback((result: ActionConfirmResult) => {
    setInitialAction(result);
    setMessageKey((prev) => prev + 1);
  }, []);

  const handleInitialMessageSent = useCallback(() => {
    setInitialAction(undefined);
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-5 w-5 place-items-center rounded-md border border-border/70 bg-background">
            <Bot className="h-3 w-3 text-muted-foreground" />
          </span>
          <h2 className="truncate text-[12px] font-semibold text-foreground">AI 助手</h2>
        </div>
      </div>
      <div className="border-b p-3">
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
