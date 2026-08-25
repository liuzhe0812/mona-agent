import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/components/MessageBubble";
import { resources } from "@/i18n";
import type { UIMessage } from "@/lib/types";

describe("MessageBubble", () => {
  it("uses group-chat wording in the visible room labels", () => {
    expect(resources.en.common.chat.newRoom).toBe("New group chat");
    expect(resources.en.common.room.panel.title).toBe("Group chat");
    expect(resources["zh-CN"].common.chat.newRoom).toBe("新建协作群");
    expect(resources["zh-CN"].common.room.panel.title).toBe("协作群");
  });

  it("renders user messages as right-aligned pills", () => {
    const message: UIMessage = {
      id: "u1",
      role: "user",
      content: "hello",
      createdAt: Date.now(),
    };

    const { container } = render(<MessageBubble message={message} />);
    const row = container.firstElementChild;
    const pill = screen.getByText("hello");

    expect(row).toHaveClass("ml-auto", "flex");
    expect(pill).toHaveClass("ml-auto", "max-w-full", "rounded-2xl");
    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
  });

  it("copies completed assistant replies from the action row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const message: UIMessage = {
      id: "a-copy",
      role: "assistant",
      content: "I can help with the next step.",
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));

    expect(writeText).toHaveBeenCalledWith("I can help with the next step.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied reply" })).toBeInTheDocument(),
    );
  });

  it("does not show copy actions for streaming placeholders", () => {
    const message: UIMessage = {
      id: "a-streaming",
      role: "assistant",
      content: "",
      isStreaming: true,
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} />);

    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
  });

  it("does not show copy when showAssistantCopyAction is false", () => {
    const message: UIMessage = {
      id: "a-mid",
      role: "assistant",
      content: "Mid-turn snippet.",
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} showAssistantCopyAction={false} />);

    expect(screen.queryByRole("button", { name: "Copy reply" })).not.toBeInTheDocument();
  });

  it("renders group assistant replies as left bubbles", () => {
    const message: UIMessage = {
      id: "a-group",
      role: "assistant",
      content: "来自分析师的结论。",
      createdAt: Date.now(),
    };

    const { container } = render(
      <MessageBubble message={message} isGroupChat />,
    );

    expect(container.firstElementChild).toHaveClass("w-fit", "max-w-[min(85%,48rem)]");
    expect(container.querySelector(".self-start")).toBeInTheDocument();
    const groupBubble = container.querySelector(".rounded-tl-md");
    expect(groupBubble).toBeInTheDocument();
    expect(groupBubble).toHaveClass("border", "bg-card/80");
    expect(groupBubble).not.toHaveClass("shadow-sm");
    expect(screen.getByTestId("group-bubble-tail")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("collapses long completed replies without truncating their content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const message: UIMessage = {
      id: "a-long",
      role: "assistant",
      content,
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} isGroupChat />);

    const toggle = await screen.findByRole("button", { name: "Show all" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).toContain("line 29");
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(content));

    fireEvent.click(toggle);
    const collapse = await screen.findByRole("button", { name: "Collapse" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(await screen.findByRole("button", { name: "Show all" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps long direct replies unchanged", () => {
    const content = Array.from({ length: 30 }, (_, index) => `direct line ${index}`).join("\n");
    const message: UIMessage = {
      id: "a-direct-long",
      role: "assistant",
      content,
      createdAt: Date.now(),
    };

    const { container } = render(<MessageBubble message={message} />);

    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
    expect(container.querySelector(".max-h-96")).not.toBeInTheDocument();
  });

  it("keeps group attachments outside the collapsed reply body", async () => {
    const content = Array.from({ length: 30 }, (_, index) => `attachment line ${index}`).join("\n");
    const message: UIMessage = {
      id: "a-long-attachments",
      role: "assistant",
      content,
      createdAt: Date.now(),
      deliveredFiles: [
        {
          path: "report.md",
          absolute_path: "/tmp/report.md",
          name: "report.md",
          size: 1024,
          size_human: "1 KB",
          mime: "text/markdown",
        },
      ],
      media: [
        {
          kind: "video",
          url: "/api/media/sig/clip",
          name: "clip.mp4",
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} isGroupChat />);

    await screen.findByRole("button", { name: "Show all" });
    const collapsedBody = container.querySelector(".max-h-96");
    expect(collapsedBody).toBeInTheDocument();
    expect(collapsedBody).not.toContainElement(screen.getByText("report.md"));
    expect(collapsedBody).not.toContainElement(screen.getByLabelText(/video attachment/i));
    expect(screen.getByText("report.md")).toBeInTheDocument();
    expect(screen.getByLabelText(/video attachment/i)).toBeInTheDocument();
  });

  it("keeps actionable stock confirmation cards expanded", () => {
    const content = [
      "[[stock-deep-research XSHG:600519 贵州茅台]]",
      ...Array.from({ length: 30 }, (_, index) => `research line ${index}`),
    ].join("\n");
    const message: UIMessage = {
      id: "a-stock-confirm",
      role: "assistant",
      content,
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} isGroupChat />);

    expect(screen.getByRole("button", { name: "启动深度投研" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  });

  it("keeps long streaming replies expanded and still copies the full source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const content = Array.from({ length: 30 }, (_, index) => `stream line ${index}`).join("\n");
    const message: UIMessage = {
      id: "a-long-streaming",
      role: "assistant",
      content,
      isStreaming: true,
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} isGroupChat />);

    expect(screen.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
    expect(document.body.textContent).toContain("stream line 29");
    // Streaming replies intentionally have no action row; the complete source
    // is still present in the rendered DOM while the response is in flight.
    expect(writeText).not.toHaveBeenCalled();
  });

  it("renders trace messages as collapsible tool groups", () => {
    const message: UIMessage = {
      id: "t1",
      role: "tool",
      kind: "trace",
      content: 'search "hk weather"',
      traces: ['weather("get")', 'search "hk weather"'],
      createdAt: Date.now(),
    };

    render(<MessageBubble message={message} />);
    const toggle = screen.getByRole("button", { name: /used 2 tools/i });

    expect(screen.queryByText('weather("get")')).not.toBeInTheDocument();
    expect(screen.queryByText('search "hk weather"')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText('weather("get")')).toBeInTheDocument();
    expect(screen.getByText('search "hk weather"')).toBeInTheDocument();
  });

  it("renders video media as an inline player", () => {
    const message: UIMessage = {
      id: "a1",
      role: "assistant",
      content: "here is the clip",
      createdAt: Date.now(),
      media: [
        {
          kind: "video",
          url: "/api/media/sig/payload",
          name: "demo.mp4",
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} />);

    expect(screen.getByText("here is the clip")).toBeInTheDocument();
    const video = screen.getByLabelText(/video attachment/i);
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("src", "/api/media/sig/payload");
    expect(container.querySelector("video[controls]")).toBeInTheDocument();
  });

  it("auto-expands the reasoning trace while streaming with a shimmer header", () => {
    const message: UIMessage = {
      id: "a-reasoning-streaming",
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      reasoning: "Step 1: parse intent. Step 2: compute.",
      reasoningStreaming: true,
    };

    const { container } = render(<MessageBubble message={message} />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText(/Step 1: parse intent\./)).toBeInTheDocument();
    expect(container.querySelector(".reasoning-sheen-stripe")).not.toBeInTheDocument();
    expect(screen.getByText("Thinking…")).toHaveClass("streaming-text-sheen");
    expect(screen.getByText("Thinking…")).toHaveAttribute("data-sheen-text", "Thinking…");
    expect(screen.getByRole("button", { name: /thinking/i }).parentElement).not.toHaveClass("mb-2");
  });

  it("collapses the reasoning section by default once streaming ends", () => {
    const message: UIMessage = {
      id: "a-reasoning-done",
      role: "assistant",
      content: "The answer is 42.",
      createdAt: Date.now(),
      reasoning: "hidden until expanded",
      reasoningStreaming: false,
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByText("The answer is 42.")).toBeInTheDocument();
    expect(screen.queryByText("hidden until expanded")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /thinking/i }).parentElement).toHaveClass("mb-2");

    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));
    expect(screen.getByText("hidden until expanded")).toBeInTheDocument();
  });

  it("renders reasoning body as markdown so headings are not left as raw ###", async () => {
    await import("@/components/MarkdownTextRenderer");
    const message: UIMessage = {
      id: "a-reasoning-md",
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      reasoning: "### Section title\n\nBody line.",
      reasoningStreaming: false,
    };

    const { container } = render(<MessageBubble message={message} />);
    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));

    await waitFor(() => {
      expect(container.querySelector("h3")?.textContent).toBe("Section title");
    });
    expect(container.textContent).not.toContain("###");
    expect(screen.getByText("Body line.")).toBeInTheDocument();
  });

  it("renders inline file paths as compact file references", async () => {
    await import("@/components/MarkdownTextRenderer");
    const message: UIMessage = {
      id: "a-file-path",
      role: "assistant",
      content:
        "改动在 `webui/src/components/MarkdownTextRenderer.tsx` 和 `/Users/renxubin/.mona/workspace/minecraft-fps/index.html`。",
      createdAt: Date.now(),
    };

    try {
      render(<MessageBubble message={message} />);

      const references = await screen.findAllByTestId("inline-file-path");
      expect(references).toHaveLength(2);
      expect(references[0].parentElement).not.toHaveClass("translate-y-[0.08em]");
      expect(references[0].parentElement).toHaveClass("align-baseline");
      expect(references[0].parentElement).toHaveClass("leading-[inherit]");
      expect(references[0]).toHaveTextContent("MarkdownTextRenderer.tsx");
      expect(references[0]).not.toHaveTextContent("webui/src/components");
      expect(screen.getByText("index.html")).toBeInTheDocument();
      expect(references[1]).not.toHaveTextContent("/Users/renxubin");
      expect(references[1]).not.toHaveAttribute("title");
      expect(references[1]).toHaveAttribute(
        "aria-label",
        "/Users/renxubin/.mona/workspace/minecraft-fps/index.html",
      );

      vi.useFakeTimers();
      fireEvent.pointerMove(references[1].parentElement!);
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).toHaveTextContent(
        "/Users/renxubin/.mona/workspace/minecraft-fps/index.html",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders assistant image media as a larger generated result", () => {
    const message: UIMessage = {
      id: "a-image",
      role: "assistant",
      content: "done",
      createdAt: Date.now(),
      media: [
        {
          kind: "image",
          url: "/api/media/sig/image",
          name: "generated.png",
        },
      ],
    };

    const { container } = render(<MessageBubble message={message} />);

    const imageButton = screen.getByRole("button", { name: /view image/i });
    expect(imageButton).toHaveClass("w-[min(100%,34rem)]", "rounded-2xl");
    expect(imageButton).not.toHaveAttribute("title");
    expect(container.querySelector("img")).toHaveClass("h-auto", "w-full", "object-contain");
  });
});
