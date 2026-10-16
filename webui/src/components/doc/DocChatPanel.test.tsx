import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DocChatPanel } from "./DocChatPanel";
import type { SendImage, SendOptions } from "@/hooks/useMonaStream";
import type { MessageQuote, UIMessage } from "@/lib/types";
import { videoFocusQuote } from "./video/VideoWorkbenchHeader";

const mocks = vi.hoisted(() => ({
  historyError: null as string | null,
  historyLoading: false,
  onStreamingChange: vi.fn(),
  setMessages: vi.fn(),
  send: vi.fn(),
  inject: vi.fn(),
}));

vi.mock("@/hooks/useSessions", () => ({
  useSessionHistory: () => ({
    messages: [],
    loading: mocks.historyLoading,
    error: mocks.historyError,
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
  ThreadMessages: ({ onQuote }: { onQuote: (message: UIMessage, author: string) => void }) => (
    <button
      type="button"
      onClick={() => onQuote({ role: "assistant", content: "手动选中的消息" } as UIMessage, "Mona")}
    >
      引用一条消息
    </button>
  ),
}));

vi.mock("@/components/thread/ThreadComposer", () => ({
  ThreadComposer: ({ chatId, onSend, quote }: {
    chatId?: string | null;
    onSend: (content: string, images?: SendImage[], options?: SendOptions) => void;
    quote?: MessageQuote | null;
  }) => (
    <>
      <div data-testid="composer-chat-id">{chatId}</div>
      <div data-testid="composer-quote">{quote?.content ?? ""}</div>
      <button
        type="button"
        onClick={() => onSend("修改标题", undefined, {
          docPaths: ["uploads/office/appendix.bin"],
          documentNames: ["appendix.bin"],
        })}
      >
        发送文档请求
      </button>
      <button type="button" onClick={() => onSend("请修改当前画面")}>
        发送普通消息
      </button>
      <button
        type="button"
        onClick={() => onSend(
          "请修改当前画面",
          undefined,
          quote ? { quote, displayContent: "请修改当前画面" } : undefined,
        )}
      >
        发送带引用的消息
      </button>
    </>
  ),
}));

describe("DocChatPanel", () => {
  beforeEach(() => {
    mocks.historyError = null;
    mocks.historyLoading = false;
    mocks.onStreamingChange.mockReset();
    mocks.setMessages.mockReset();
    mocks.send.mockReset();
    mocks.inject.mockReset();
  });

  it("reports ready only after history loads and clears readiness during loading or errors", async () => {
    mocks.historyLoading = true;
    const onReadyChange = vi.fn();
    const view = render(<DocChatPanel chatId="video-chat" onReadyChange={onReadyChange} />);

    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(null));
    mocks.historyLoading = false;
    view.rerender(<DocChatPanel chatId="video-chat" onReadyChange={onReadyChange} />);
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith("video-chat"));

    mocks.historyError = "history failed";
    view.rerender(<DocChatPanel chatId="video-chat" onReadyChange={onReadyChange} />);
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(null));
    mocks.historyError = null;
    view.rerender(<DocChatPanel chatId="video-chat" onReadyChange={onReadyChange} />);
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith("video-chat"));

    view.unmount();
    expect(onReadyChange).toHaveBeenLastCalledWith(null);
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

    expect(screen.getByTestId("composer-chat-id")).toHaveTextContent("office-chat");
    expect(mocks.send).toHaveBeenCalledWith(
      "修改标题",
      undefined,
      expect.objectContaining({
        docPaths: ["uploads/office/appendix.bin"],
        documentNames: ["appendix.bin"],
        displayContent: "修改标题",
        officeSessionId: "office-session",
        officeDocumentType: "slides",
        officeDisplayName: "季度汇报.pptx",
      }),
    );
  });

  it("adds the current video focus to an ordinary message sent to Mona", () => {
    const quote = videoFocusQuote({
      projectName: "产品介绍",
      sceneIndex: 2,
      sceneTitle: "转化对比",
      seconds: 3.5,
    })!;
    render(
      <DocChatPanel
        chatId="video-chat"
        getSendOptions={() => ({ agentKind: "video", quote })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "发送普通消息" }));

    expect(mocks.send).toHaveBeenCalledWith(
      "请修改当前画面",
      undefined,
      expect.objectContaining({
        agentKind: "video",
        displayContent: "请修改当前画面",
        quote,
      }),
    );
  });

  it("keeps a manually selected message quote ahead of the automatic video focus", () => {
    const focusQuote = videoFocusQuote({
      projectName: "产品介绍",
      sceneIndex: 2,
      sceneTitle: "转化对比",
      seconds: 3.5,
    })!;
    const manualQuote = { author: "Mona", content: "手动选中的消息" };
    render(
      <DocChatPanel
        chatId="video-chat"
        getSendOptions={() => ({ agentKind: "video", quote: focusQuote })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "引用一条消息" }));
    expect(screen.getByTestId("composer-quote")).toHaveTextContent(manualQuote.content);
    fireEvent.click(screen.getByRole("button", { name: "发送带引用的消息" }));

    expect(mocks.send).toHaveBeenCalledWith(
      "请修改当前画面",
      undefined,
      expect.objectContaining({
        agentKind: "video",
        displayContent: "请修改当前画面",
        quote: manualQuote,
      }),
    );
    expect(mocks.send.mock.calls[0][2]).not.toMatchObject({ quote: focusQuote });
  });
  it("adds the active style sample context while preserving the user's visible message", () => {
    render(<DocChatPanel chatId="style-chat" prepareContent={(text) => `样片项目 style-sample。${text}`} getSendOptions={() => ({ agentKind: "video" })} />);
    fireEvent.click(screen.getByRole("button", { name: "发送普通消息" }));
    expect(mocks.send).toHaveBeenCalledWith("样片项目 style-sample。请修改当前画面", undefined,
      expect.objectContaining({ agentKind: "video", displayContent: "请修改当前画面" }));
  });

});
