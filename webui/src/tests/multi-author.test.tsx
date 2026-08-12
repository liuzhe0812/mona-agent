import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ConversationAvatar,
  fallbackAgentName,
} from "@/components/room/AgentAvatar";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import type { ConversationMeta, UIMessage } from "@/lib/types";

describe("fallbackAgentName", () => {
  it("derives a display name from the last dotted id segment", () => {
    expect(fallbackAgentName("com.mona.a-share-analyst")).toBe("A-share-analyst");
  });

  it("keeps the Mona brand name", () => {
    expect(fallbackAgentName("mona")).toBe("Mona");
  });
});

describe("ConversationAvatar", () => {
  it("renders a stacked cluster with overflow count for rooms", () => {
    const conversation: ConversationMeta = {
      type: "room",
      title: "投研房间",
      agentIds: ["mona", "com.mona.a-share-analyst", "com.mona.fund-junior"],
    };
    const { container } = render(<ConversationAvatar conversation={conversation} />);
    expect(container.textContent).toContain("+1");
  });

  it("renders a single initial for partner direct chats", () => {
    const conversation: ConversationMeta = {
      type: "direct",
      title: "",
      agentIds: ["com.mona.a-share-analyst"],
      directAgentId: "com.mona.a-share-analyst",
    };
    const { container } = render(<ConversationAvatar conversation={conversation} />);
    expect(container.textContent).toContain("A");
    expect(container.textContent).not.toMatch(/\+\d/);
  });
});

describe("ThreadMessages multi-author projection", () => {
  const base: UIMessage = {
    id: "m1",
    role: "assistant",
    content: "结论：维持看多。",
    createdAt: Date.now(),
  };

  it("labels assistant messages authored by a partner agent", () => {
    render(
      <ThreadMessages
        messages={[
          {
            ...base,
            authorId: "com.mona.a-share-analyst",
            authorType: "agent",
          },
        ]}
        isStreaming={false}
      />,
    );
    // Registry unavailable in tests → derived fallback name from the id.
    expect(screen.getByText("A-share-analyst")).toBeTruthy();
  });

  it("omits the author header for Mona and legacy messages", () => {
    render(
      <ThreadMessages
        messages={[
          { ...base, id: "m1", authorId: "mona", authorType: "agent" },
          { ...base, id: "m2", content: "旧消息" },
        ]}
        isStreaming={false}
      />,
    );
    expect(screen.queryByText("Mona")).toBeNull();
  });
});
