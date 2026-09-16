import { useState } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DocChatPanel } from "./DocChatPanel";

const mocks = vi.hoisted(() => ({
  onStreamingChange: vi.fn(),
  setMessages: vi.fn(),
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
    stop: vi.fn(),
    setMessages: mocks.setMessages,
    streamError: null,
    dismissStreamError: vi.fn(),
  }),
}));

vi.mock("@/components/thread/ThreadMessages", () => ({
  ThreadMessages: () => null,
}));

describe("DocChatPanel", () => {
  it("does not repeat the streaming notification when the parent callback identity changes", async () => {
    function Harness() {
      const [, setStreamingByTab] = useState<Record<string, boolean>>({});
      return (
        <DocChatPanel
          chatId="ppt-chat"
          onSend={() => undefined}
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
});
