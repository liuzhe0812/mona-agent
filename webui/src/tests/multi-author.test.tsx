import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentAvatar,
  ConversationAvatar,
  fallbackAgentName,
} from "@/components/room/AgentAvatar";
import { AgentLogo } from "@/components/AgentLogo";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import type { ConversationMeta, UIMessage } from "@/lib/types";

describe("fallbackAgentName", () => {
  it("derives a display name from the last dotted id segment", () => {
    expect(fallbackAgentName("com.example.custom-agent")).toBe("Custom-agent");
  });

  it("keeps the Mona brand name", () => {
    expect(fallbackAgentName("mona")).toBe("Mona");
  });
});

describe("AgentLogo", () => {
  it("uses the raster Mona mark and keeps state on the outer wrapper", () => {
    const { container } = render(<AgentLogo state="working" />);
    const logo = container.querySelector(".mona-agent-logo");

    expect(logo?.className).toContain("mona-agent-logo--working");
    expect(logo?.querySelector('img[src="/brand/mona_app_icon.png"]')).toBeTruthy();
    expect(logo?.querySelector("svg")).toBeNull();
    expect(logo?.querySelector("style")?.textContent).toContain("prefers-reduced-motion");
  });

  it("keeps the compact avatar variant on the same raster identity", () => {
    const { container } = render(<AgentLogo state="idle" variant="avatar" />);

    expect(container.querySelector('img[src="/brand/mona_avatar_white.png"]')).toBeTruthy();
    expect(container.querySelector("style")?.textContent).not.toContain(
      "mona-agent-logo--welcome",
    );
  });
});

describe("ConversationAvatar", () => {
  it("uses the current human portrait as Mona's default Agent avatar", () => {
    const { container } = render(<AgentAvatar agentId="mona" />);
    expect(container.querySelector('img[src="/brand/mona_avatar_human.png"]')).toBeTruthy();
    expect(container.querySelector('img[src="/brand/mona_avatar_white.png"]')).toBeNull();
  });

  it("pairs the task initial with a small Mona identity badge", () => {
    const { container } = render(<ConversationAvatar taskTitle="制作新能源报告" />);
    expect(container.textContent).toBe("制");
    const badge = container.querySelector('img[src="/brand/mona_avatar_human.png"]');
    expect(badge).toBeTruthy();
  });

  it("keeps the user's Mona avatar on task badges", () => {
    const customAvatar = "data:image/png;base64,dXNlci1hdmF0YXI=";
    const agents = new Map([
      ["mona", { id: "mona", displayName: "Mona", avatarUrl: customAvatar, enabled: true }],
    ]);
    const { container } = render(
      <ConversationAvatar taskTitle="制作新能源报告" agentsById={agents} />,
    );

    expect(container.querySelector(`img[src="${customAvatar}"]`)).toBeTruthy();
    expect(container.querySelector('img[src="/brand/mona_avatar_human.png"]')).toBeNull();
  });

  it("renders a stacked cluster with overflow count for rooms", () => {
    const conversation: ConversationMeta = {
      type: "room",
      title: "投研房间",
      agentIds: ["mona", "com.mona.a-share-analyst", "com.mona.fund-junior"],
    };
    const { container } = render(<ConversationAvatar conversation={conversation} />);
    expect(container.textContent).toContain("+1");
  });

  it("renders the built-in avatar for partner direct chats", () => {
    const conversation: ConversationMeta = {
      type: "direct",
      title: "",
      agentIds: ["com.mona.a-share-analyst"],
      directAgentId: "com.mona.a-share-analyst",
    };
    const { container } = render(<ConversationAvatar conversation={conversation} />);
    expect(container.querySelector('img[src="/brand/agents/a-share-analyst.png"]')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\+\d/);
  });

  it.each([
    ["com.mona.xhs-operator", "/brand/agents/xhs-operator.png"],
    ["com.mona.academic-researcher", "/brand/agents/academic-researcher.png"],
    ["com.mona.a-share-analyst", "/brand/agents/a-share-analyst.png"],
    ["com.mona.musician", "/brand/agents/musician.webp"],
  ])("uses a distinct bundled portrait for %s", (agentId, avatarUrl) => {
    const { container } = render(<AgentAvatar agentId={agentId} />);
    expect(container.querySelector(`img[src="${avatarUrl}"]`)).toBeTruthy();
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
    expect(screen.getByText("股神")).toBeTruthy();
  });

  it("shows Mona and partner identities in a group chat", () => {
    const { container } = render(
      <ThreadMessages
        messages={[
          { ...base, id: "mona-1", content: "Mona 的汇总。", authorId: "mona", authorType: "agent" },
          {
            ...base,
            id: "analyst-1",
            content: "分析师的补充。",
            authorId: "com.mona.a-share-analyst",
            authorType: "agent",
          },
        ]}
        isStreaming={false}
        isGroupChat
      />,
    );

    expect(screen.getByText("Mona")).toBeInTheDocument();
    expect(screen.getByText("股神")).toBeInTheDocument();
    expect(screen.getByText("Mona 的汇总。")).toBeInTheDocument();
    expect(screen.getByText("分析师的补充。")).toBeInTheDocument();
    expect(container.querySelector('img[src="/brand/mona_avatar_human.png"]')).toBeTruthy();
  });

  it("uses a left avatar column and weak time divider for spaced group replies", () => {
    const { container } = render(
      <ThreadMessages
        messages={[
          { ...base, id: "first", createdAt: 0, authorId: "mona", authorType: "agent" },
          {
            ...base,
            id: "second",
            createdAt: 6 * 60 * 1000,
            authorId: "com.mona.a-share-analyst",
            authorType: "agent",
          },
        ]}
        isStreaming={false}
        isGroupChat
      />,
    );

    expect(container.querySelector(".h-9.w-9")).toBeInTheDocument();
    expect(container.querySelector(".rounded-tl-md")).toBeInTheDocument();
    const divider = container.querySelector('div[aria-label]');
    expect(divider).toBeInTheDocument();
    expect(divider?.textContent).toBeTruthy();
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
