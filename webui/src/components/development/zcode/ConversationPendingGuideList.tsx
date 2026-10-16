import { Fragment, memo, useMemo } from "react";
import type { QueueItem, UserInputRow, ConversationRowRenderContext } from "./queueTypes";
import { useZCodeIntl } from "./primitives/intl";

interface ConversationPendingGuideListProps {
  context: ConversationRowRenderContext;
  items: readonly QueueItem[];
  turnId: string;
}

function pendingGuideRow(item: QueueItem, turnId: string): UserInputRow {
  return {
    rowId: -(item.order.admissionSeq + 1),
    turnId,
    productTurnId: turnId,
    entityId: item.queueItemId,
    kind: "userInput",
    text: item.text,
    origin: "realUser",
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    attachments: item.attachments,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  };
}

function ConversationPendingGuideListImpl({
  context,
  items,
  turnId,
}: ConversationPendingGuideListProps) {
  const { intl } = useZCodeIntl();
  const rows = useMemo(() => items.map((item) => pendingGuideRow(item, turnId)), [items, turnId]);
  const status = intl.formatMessage({ id: "chat.message.turnSteer.pending" });

  if (rows.length === 0) return null;
  return (
    <div data-v4-pending-guide-list="true" className="flex flex-col gap-5 pt-5">
      {rows.map((row) => (
        <Fragment key={row.sourceCommandId}>{context.renderUserInput(row, status)}</Fragment>
      ))}
    </div>
  );
}

export const ConversationPendingGuideList = memo(ConversationPendingGuideListImpl);
