import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocChatPanel } from "./DocChatPanel";

const mocks = vi.hoisted(() => ({
  onStreamingChange: vi.fn(),
  setMessages: vi.fn(),
  send: vi.fn(),
  inject: vi.fn(),
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({
    messages: [],
    loading: false,
    error: null,
    hasPendingToolCalls: false,
    version: 0,
  }),
}));

vi.mock("@/hooks/useMonaStream", () => ({
  useMonaStream: () => ({
    messages: [],
    isStreaming: false,
    isAwaitingModelResponse: false,
    stopping: false,
    stop: vi.fn(),
    send: mocks.send,
    inject: mocks.inject,
    setMessages: mocks.setMessages,
    streamError: null,
    dismissStreamError: vi.fn(),
  }),
}));

vi.mock("@/components/thread/ThreadMessages", () => ({
  ThreadMessages: () => null,
}));

vi.mock("@/components/thread/ThreadComposer", () => ({
  ThreadComposer: ({ onSend }: { onSend: (content: string) => void }) => (
    <button type="button" onClick={() => onSend("修改标题")}>发送文档请求</button>
  ),
}));

describe("DocChatPanel", () => {
  beforeEach(() => {
    mocks.onStreamingChange.mockReset();
    mocks.setMessages.mockReset();
    mocks.send.mockReset();
    mocks.inject.mockReset();
  });

  it("does not repeat the streaming notification when the parent callback identity changes", async () => {
    function Harness() {
      const [, setStreamingByTab] = useState<Record<string, boolean>>({});
      return (
        <DocChatPanel
          chatId="ppt-chat"
          getSendOptions={() => undefined}
          onStreamingChange={(streaming) => {
            mocks.onStreamingChange(streaming);
            setStreamingByTab((current) => ({ ...current, ppt: streaming }));
          }}
        />
      );
    }

    render(<Harness />);

    await waitFor(() => expect(mocks.onStreamingChange).toHaveBeenCalledTimes(1));
    expect(mocks.onStreamingChange).toHaveBeenCalledWith(false);
  });

  it("passes document context through the shared composer send path", () => {
    render(
      <DocChatPanel
        chatId="office-chat"
        getSendOptions={() => ({
          officeSessionId: "office-session",
          officeDocumentType: "slides",
          officeDisplayName: "季度汇报.pptx",
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "发送文档请求" }));

    expect(mocks.send).toHaveBeenCalledWith(
      "修改标题",
      undefined,
      expect.objectContaining({
        displayContent: "修改标题",
        officeSessionId: "office-session",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      }),
    );
  });
});
