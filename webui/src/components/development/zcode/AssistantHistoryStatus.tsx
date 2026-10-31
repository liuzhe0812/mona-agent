// Modified for local integration. See the accompanying NOTICE for license information.
import type { ReactNode } from "react";
import { ChevronRightIcon } from "zcode-lucide-react";
import { cn } from "@/components/development/zcode/utils";
import { useZCodeIntl } from "./primitives/intl";
import { CollapsibleTrigger } from "./primitives/collapsible";
import { formatConversationWorkDuration } from "./conversationWorkDuration";
import type { ConversationTurnWorkSegment } from "./conversationTurnWorkSegments";
export function AssistantHistoryStatus({
  segment,
  open,
  label,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  label?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const durationLabel = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const historyLabel =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({ id: "chat.history.stopped" })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })
        : durationLabel
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel })
          : intl.formatMessage({ id: "chat.history.worked" });

  return (
    <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={`chat-assistant-history-trigger:${segment.key}`}
          aria-label="工作过程"
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span className="truncate">{label ?? historyLabel}</span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
    </div>
  );
}

