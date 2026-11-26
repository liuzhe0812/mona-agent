import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePendingQueue } from "@/hooks/usePendingQueue";
import { DocChatPanel, type DocChatRequest } from "./DocChatPanel";

const mocks = vi.hoisted(() => ({ send: vi.fn(), loading: false, streaming: false }));

vi.mock("@/providers/ClientProvider", () => ({ useClientContextOrNull: () => null }));
vi.mock("@/components/models/useWorkModelSelection", () => ({ useWorkModelSelection: () => ({}) }));
vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({ messages: [], loading: mocks.loading, error: null, hasPendingToolCalls: false, version: 0 }),
  reconcileHistoryMessages: (current: unknown) => current,
}));
vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [], isStreaming: mocks.streaming, isAwaitingModelResponse: false, stopping: false,
    send: mocks.send, setMessages: vi.fn(), messageRejection: null,
  }),
}));
vi.mock("@/components/thread/ThreadMessages", () => ({ ThreadMessages: () => null }));
vi.mock("@/components/thread/UserQuestionPanel", () => ({ UserQuestionPanel: () => null }));
vi.mock("@/components/thread/MessageRejectionDialog", () => ({ MessageRejectionDialog: () => null }));
vi.mock("@/components/thread/ThreadComposer", () => ({
  ThreadComposer: ({ pendingMessages }: { pendingMessages: Array<{ id: string; content: string; options?: { displayContent?: string } }> }) => (
    <div>{pendingMessages.map((message) => <span key={message.id}>{message.options?.displayContent ?? message.content}</span>)}</div>
  ),
}));

const request: DocChatRequest = {
  id: "edit-1",
  content: "修改第 8 页所选表格：润色",
  options: { displayContent: "润色", officeSessionId: "slides-session", officeDocumentType: "slides" },
};

describe("office editor requests", () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.loading = false;
    mocks.streaming = false;
  });

  it("waits for history and sends the selected instruction through the chat once", async () => {
    mocks.loading = true;
    let claimed = false;
    const onHandled = vi.fn(() => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    const props = { chatId: "office-chat", externalRequest: request, onExternalRequestHandled: onHandled };
    const view = render(<DocChatPanel {...props} />);
    expect(mocks.send).not.toHaveBeenCalled();

    mocks.loading = false;
    view.rerender(<DocChatPanel {...props} />);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
    expect(mocks.send).toHaveBeenCalledWith(request.content, undefined, expect.objectContaining(request.options!));
    view.rerender(<DocChatPanel {...props} />);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a request queued during a running task when the panel is closed and reopened", async () => {
    mocks.streaming = true;
    function Harness() {
      const queue = usePendingQueue("office-chat");
      const [pending, setPending] = useState<DocChatRequest | undefined>(request);
      const [open, setOpen] = useState(true);
      return <>
        <button onClick={() => setOpen((value) => !value)}>切换面板</button>
        {open && <DocChatPanel chatId="office-chat" pendingQueue={queue} externalRequest={pending} onExternalRequestHandled={() => { setPending(undefined); return true; }} />}
      </>;
    }
    render(<Harness />);
    expect(await screen.findByText("润色")).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "切换面板" }));
    fireEvent.click(screen.getByRole("button", { name: "切换面板" }));
    expect(screen.getByText("润色")).toBeInTheDocument();
  });

  it("holds the editor request when the pending queue is full", async () => {
    mocks.streaming = true;
    const onHandled = vi.fn(() => true);
    const queue = {
      messages: ["1", "2", "3"].map((id) => ({ id, content: id })),
      enqueue: vi.fn(), remove: vi.fn(), update: vi.fn(), clear: vi.fn(), clearScope: vi.fn(), setDeliveryState: vi.fn(),
    };
    const props = { chatId: "office-chat", pendingQueue: queue, externalRequest: request, onExternalRequestHandled: onHandled };
    const view = render(<DocChatPanel {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("等待发送：润色");
    expect(onHandled).not.toHaveBeenCalled();

    mocks.streaming = false;
    view.rerender(<DocChatPanel {...props} />);
    expect(screen.getByRole("status")).toHaveTextContent("等待发送：润色");
    expect(mocks.send).not.toHaveBeenCalled();

    mocks.streaming = true;
    const available = { ...queue, messages: queue.messages.slice(0, 2) };
    view.rerender(<DocChatPanel {...props} pendingQueue={available} />);
    await waitFor(() => expect(queue.enqueue).toHaveBeenCalledWith(request.content, undefined, expect.objectContaining(request.options!)));
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
