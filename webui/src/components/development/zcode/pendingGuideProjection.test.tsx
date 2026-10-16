import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { QueueItem, QueueState, UserInputRow } from "./queueTypes";
import { projectPendingGuideQueue } from "./pendingGuideProjection";
import { ConversationPendingGuideList } from "./ConversationPendingGuideList";

vi.mock("./primitives/intl", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: () => "等待引导当前任务…" },
  }),
}));

afterEach(cleanup);

function queueItem(
  queueItemId: string,
  admitted: "guide" | "queue",
  admissionSeq: number,
): QueueItem {
  return {
    id: `input-${queueItemId}`,
    messageId: `message-${queueItemId}`,
    runId: "run-1",
    state: "pending",
    revision: 0,
    queueItemId,
    text: `text-${queueItemId}`,
    sourceCommandId: `command-${queueItemId}`,
    clientId: `client-${queueItemId}`,
    attachments: [{ kind: "file", url: `file://${queueItemId}`, name: `${queueItemId}.txt` }],
    admittedAt: `2026-10-15T08:00:0${admissionSeq}Z`,
    order: { admissionSeq },
    delivery: { admitted },
  };
}

it("splits guides by admitted delivery while preserving input object identity and order", () => {
  const firstQueue = queueItem("queue-1", "queue", 0);
  const firstGuide = queueItem("guide-1", "guide", 1);
  const secondGuide = queueItem("guide-2", "guide", 2);
  const secondQueue = queueItem("queue-2", "queue", 3);
  const queue: QueueState = { items: [firstQueue, firstGuide, secondGuide, secondQueue] };

  const projection = projectPendingGuideQueue(queue);

  expect(projection.pendingGuides).toEqual([firstGuide, secondGuide]);
  expect(projection.pendingGuides[0]).toBe(firstGuide);
  expect(projection.pendingGuides[1]).toBe(secondGuide);
  expect(projection.visibleQueue.items).toEqual([firstQueue, secondQueue]);
  expect(projection.visibleQueue.items[0]).toBe(firstQueue);
  expect(projection.visibleQueue.items[1]).toBe(secondQueue);
});

it("passes the pending input identity and guide status to the host row renderer", () => {
  const item = queueItem("guide-1", "guide", 4);
  const renderUserInput = vi.fn((row: UserInputRow, status: string) => (
    <div data-testid="pending-guide">{row.text}: {status}</div>
  ));

  render(
    <ConversationPendingGuideList
      context={{ renderUserInput }}
      items={[item]}
      turnId="turn-1"
    />,
  );

  expect(screen.getByTestId("pending-guide")).toHaveTextContent("text-guide-1: 等待引导当前任务…");
  expect(renderUserInput).toHaveBeenCalledOnce();
  const [row, status] = renderUserInput.mock.calls[0];
  expect(row).toMatchObject({
    rowId: -5,
    turnId: "turn-1",
    productTurnId: "turn-1",
    entityId: item.queueItemId,
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    text: item.text,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  });
  expect(row.attachments).toBe(item.attachments);
  expect(status).toBe("等待引导当前任务…");
});
