import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { SEND_MESSAGE_SHORTCUT_EVENT } from "@/lib/tauri";
import type { RoomAgentInfo, SlashCommand } from "@/lib/types";

const COMMANDS: SlashCommand[] = [
  {
    command: "/stop",
    title: "Stop current task",
    description: "Cancel the active agent turn.",
    icon: "square",
  },
  {
    command: "/history",
    title: "Show conversation history",
    description: "Print the last N persisted messages.",
    icon: "history",
    argHint: "[n]",
  },
];
const MENTION_AGENTS: RoomAgentInfo[] = [
  { id: "com.mona.a-share-analyst", displayName: "A-share analyst" },
  { id: "com.mona.reviewer", displayName: "Reviewer" },
];
const ORIGINAL_INNER_HEIGHT = window.innerHeight;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerHeight", {
    value: ORIGINAL_INNER_HEIGHT,
    configurable: true,
  });
});

function rect(init: Partial<DOMRect>): DOMRect {
  const top = init.top ?? 0;
  const left = init.left ?? 0;
  const width = init.width ?? 0;
  const height = init.height ?? 0;
  return {
    x: init.x ?? left,
    y: init.y ?? top,
    top,
    left,
    width,
    height,
    right: init.right ?? left + width,
    bottom: init.bottom ?? top + height,
    toJSON: () => ({}),
  };
}

describe("ThreadComposer", () => {
  it("renders a readonly hero model composer when provided", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="claude-opus-4-5"
        placeholder="Ask anything..."
        variant="hero"
      />,
    );

    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reason" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deep research" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voice input" })).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("Ask anything...");
    expect(input).toBeInTheDocument();
    expect(input.className).toContain("min-h-[78px]");
    expect(input.parentElement?.className).toContain("max-w-[58rem]");
    expect(screen.getByTestId("hero-composer-prelude")).toHaveClass(
      "left-1/2",
      "max-w-[58rem]",
      "-translate-x-1/2",
      "flex-wrap",
    );
  });

  it("can hide global hero prompt chips for a dedicated agent", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="qwen3.7-plus"
        variant="hero"
        showHeroPromptChips={false}
      />,
    );

    expect(screen.queryByText("网页生成笔记")).not.toBeInTheDocument();
    expect(screen.queryByText("邮件整理今日待办")).not.toBeInTheDocument();
  });

  it("keeps the thread composer compact while matching the hero style", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="gpt-4o"
        placeholder="Type your message..."
      />,
    );

    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    const input = screen.getByPlaceholderText("Type your message...");
    expect(input.className).toContain("min-h-[50px]");
    expect(input.parentElement?.className).toContain("max-w-[49.5rem]");
    expect(input.parentElement?.className).toContain("rounded-2xl");
    expect(input.parentElement?.className).not.toContain("shadow-sm");
    expect(input.parentElement?.className).toContain("focus-within:ring-foreground/8");
    expect(screen.getByRole("button", { name: "Attach image" }).className).toContain("bg-card");
    expect(screen.getByRole("button", { name: "Send message" }).className).toContain("bg-action");
  });

  it("sends with Enter by default and keeps Shift+Enter for a newline", () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);
    const input = screen.getByLabelText("Message input");

    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("first", undefined, undefined);
  });

  it("sends a structured quote preview with the follow-up prompt", () => {
    const onSend = vi.fn();
    const onClearQuote = vi.fn();
    render(
      <ThreadComposer
        onSend={onSend}
        quote={{ author: "Mona", content: "先检查构建是否通过。" }}
        onClearQuote={onClearQuote}
      />,
    );

    expect(screen.getByTestId("composer-quote-preview")).toHaveTextContent("Replying to Mona");
    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "那接下来怎么做？" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith(
      "引用 Mona 的消息：\n先检查构建是否通过。\n\n那接下来怎么做？",
      undefined,
      {
        quote: { author: "Mona", content: "先检查构建是否通过。" },
        displayContent: "那接下来怎么做？",
      },
    );
    expect(onClearQuote).toHaveBeenCalledTimes(1);
  });

  it("switches live to Ctrl+Enter send while plain Enter keeps editing", () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);
    const input = screen.getByLabelText("Message input");
    fireEvent(
      window,
      new CustomEvent(SEND_MESSAGE_SHORTCUT_EVENT, { detail: "ctrl_enter" }),
    );
    fireEvent.change(input, { target: { value: "second" } });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith("second", undefined, undefined);
  });

  it("opens model details as a secondary menu and switches the selected model", async () => {
    const onModelSwitch = vi.fn();
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="qwen3.7-plus"
        modelOptions={[
          {
            provider: "aliyun-bailian-coding",
            providerLabel: "阿里云百炼 Coding Plan（包月）",
            model: "qwen3.7-plus",
            label: "Qwen 3.7 Plus",
            active: true,
          },
          {
            provider: "mona_managed",
            providerLabel: "Mona AI",
            model: "deepseek-v4-flash",
            label: "DeepSeek V4 Flash",
            active: false,
            isBuiltin: true,
            description: "编程主力，响应快，适合大多数代码任务",
            contextWindow: 1_000_000,
            recommended: true,
            tags: ["编程", "快速"],
            priceTier: "经济",
            reasoningEfforts: ["medium", "high", "max"],
            reasoningEffort: "high",
            inputAmountPerMillion: "1",
            cachedInputAmountPerMillion: "0.02",
            outputAmountPerMillion: "2",
            promotionLabel: "↓50%",
            promotionName: "新用户限时优惠",
            discountPercent: 50,
            originalInputAmountPerMillion: "2",
            originalCachedInputAmountPerMillion: "0.04",
            originalOutputAmountPerMillion: "4",
          },
        ]}
        onModelSwitch={onModelSwitch}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "qwen3.7-plus" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByPlaceholderText("搜索模型…")).toBeInTheDocument();
    expect(screen.getByText("阿里云百炼 Coding Plan（包月）")).toBeInTheDocument();
    expect(screen.getByText("Mona AI")).toBeInTheDocument();
    expect(screen.getByText("Qwen 3.7 Plus")).toBeInTheDocument();
    expect(screen.queryByText("免费")).not.toBeInTheDocument();
    const modelRow = screen.getByText("DeepSeek V4 Flash");
    fireEvent.pointerEnter(modelRow);
    expect(await screen.findByText("编程主力，响应快，适合大多数代码任务")).toBeInTheDocument();
    expect(screen.getByText("↓50%")).toBeInTheDocument();
    expect(screen.getByText("新用户限时优惠")).toBeInTheDocument();
    expect(screen.getByText("折扣中，较标准价省 50%")).toBeInTheDocument();
    expect(screen.getAllByText("¥2").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("¥4")).toBeInTheDocument();
    expect(screen.getByText("推理强度")).toBeInTheDocument();
    expect(screen.getByText("每百万 Token")).toBeInTheDocument();
    expect(screen.getByText("缓存读取")).toBeInTheDocument();
    expect(screen.getByText("1M 上下文")).toBeInTheDocument();
    fireEvent.click(modelRow);
    expect(onModelSwitch).toHaveBeenCalledWith("mona_managed", "deepseek-v4-flash", "high");
  });

  it("shows only the active model id in the composer trigger", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelOptions={[{
          provider: "mona_managed",
          providerLabel: "Mona AI",
          model: "ZHIPU/GLM-5.3",
          label: "GLM-5.3",
          active: true,
          isBuiltin: true,
          reasoningEffort: "medium",
        }]}
        onModelSwitch={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "ZHIPU/GLM-5.3" })).toBeInTheDocument();
    expect(screen.queryByText("Mona AI")).not.toBeInTheDocument();
    expect(screen.queryByText("默认")).not.toBeInTheDocument();
  });

  it("shows turn run timer when runStartedAt is set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((1_000 + 125) * 1000));

    render(
      <ThreadComposer
        onSend={vi.fn()}
        placeholder="Type your message..."
        runStartedAt={1000}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Running/);
    expect(status).toHaveTextContent(/2:05/);

    vi.useRealTimers();
  });

  it("labels the run strip while earlier context is being compacted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_125_000));

    render(
      <ThreadComposer
        onSend={vi.fn()}
        runStartedAt={1_000}
        isCompacting
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Compacting context");
    vi.useRealTimers();
  });

  it("shows a distinct waiting phase before the model starts responding", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((1_000 + 125) * 1000));

    render(
      <ThreadComposer
        onSend={vi.fn()}
        isStreaming
        isAwaitingModelResponse
        runStartedAt={1_000}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Waiting for model response · 2:05");
    expect(screen.getByPlaceholderText("Waiting for the model to respond…")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("opens an upward anchored goal panel with markdown content when expand is clicked", async () => {
    const longObjective =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789GoalTail";
    render(
      <ThreadComposer
        onSend={vi.fn()}
        placeholder="Type your message..."
        goalState={{
          active: true,
          objective: longObjective,
          ui_summary: "Short summary for strip",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show full goal" }));

    const dialog = await screen.findByRole("dialog", { name: "Goal" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Short summary for strip");
    expect(dialog).toHaveTextContent(longObjective);
  });

  it("opens a slash command palette and inserts the selected command", () => {
    const onSend = vi.fn();
    render(
      <ThreadComposer
        onSend={onSend}
        placeholder="Type your message..."
        slashCommands={COMMANDS}
      />,
    );

    const input = screen.getByLabelText("Message input");
    fireEvent.change(input, { target: { value: "/" } });

    const palette = screen.getByRole("listbox", { name: "Slash commands" });
    expect(palette).toBeInTheDocument();
    expect(palette).toHaveStyle({ maxHeight: "288px" });
    expect(screen.getByRole("option", { name: /\/stop/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /\/history/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("/history ");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
  });

  it("filters @ candidates by name or stable id and keeps keyboard selection usable", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        placeholder="Type your message..."
        mentionableAgents={MENTION_AGENTS}
      />,
    );
    const input = screen.getByLabelText("Message input");

    fireEvent.change(input, { target: { value: "@" } });
    expect(screen.getByRole("option", { name: /A-share analyst/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /Reviewer/ })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "@review" } });
    expect(screen.queryByRole("option", { name: /A-share analyst/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Reviewer/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.change(input, { target: { value: "@com.mona.a-share" } });
    expect(screen.getByRole("option", { name: /A-share analyst/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Reviewer/ })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("@A-share analyst ");
  });

  it("opens the slash command palette downward when there is more room below", async () => {
    vi.spyOn(HTMLFormElement.prototype, "getBoundingClientRect").mockReturnValue(
      rect({ top: 40, bottom: 160, width: 800, height: 120 }),
    );
    Object.defineProperty(window, "innerHeight", {
      value: 330,
      configurable: true,
    });
    render(
      <ThreadComposer
        onSend={vi.fn()}
        placeholder="Ask anything..."
        slashCommands={COMMANDS}
        variant="hero"
      />,
    );
    const input = screen.getByLabelText("Message input");

    fireEvent.change(input, { target: { value: "/" } });

    await waitFor(() => {
      const palette = screen.getByRole("listbox", { name: "Slash commands" });
      expect(palette.className).toContain("top-full");
      expect(palette).toHaveStyle({ maxHeight: "162px" });
    });
  });

  it("dismisses the slash command palette on outside click", () => {
    render(
      <div>
        <button type="button">outside</button>
        <ThreadComposer
          onSend={vi.fn()}
          placeholder="Type your message..."
          slashCommands={COMMANDS}
        />
      </div>,
    );

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "/" },
    });
    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }));

    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
  });

  it("shows a stop button while streaming", () => {
    const onStop = vi.fn();
    render(
      <ThreadComposer
        onSend={vi.fn()}
        onStop={onStop}
        isStreaming
        placeholder="Type your message..."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("shows a disabled stopping state while waiting for server confirmation", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        onStop={vi.fn()}
        isStreaming
        stopping
      />,
    );

    const button = screen.getByRole("button", { name: "Stopping" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  });

  it("renders context usage to the left of the model and reveals details on hover", async () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="hy4-preview"
        contextUsage={{ used: 59_600, total: 1_000_000 }}
      />,
    );

    const indicator = screen.getByRole("img", {
      name: "6.0% · 59.6K / 1.0M 上下文已使用",
    });
    const model = screen.getByText("hy4-preview");
    expect(indicator.className).toContain("h-7");
    expect(indicator.querySelector("svg")?.getAttribute("class")).toContain("h-5");
    expect(indicator.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(indicator);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "6.0% · 59.6K / 1.0M 上下文已使用",
    );
  });

  it("keeps context usage limited to user-facing values", async () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="qwen3.7-plus"
        contextUsage={{ used: 60_000, total: 1_000_000 }}
      />,
    );

    const indicator = screen.getByRole("img", {
      name: "6.0% · 60.0K / 1.0M 上下文已使用",
    });
    fireEvent.focus(indicator);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "6.0% · 60.0K / 1.0M 上下文已使用",
    );
    expect(screen.queryByText(/配置回退|模型目录|模型探测/)).not.toBeInTheDocument();
  });

  it("groups the context indicator with the trailing model selector and send button", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="hy4-preview"
        contextUsage={{ used: 170_000, total: 1_000_000 }}
      />,
    );

    const indicator = screen.getByRole("img", { name: "17.0% · 170.0K / 1.0M 上下文已使用" });
    const send = screen.getByRole("button", { name: "Send message" });
    expect(indicator.parentElement).toBe(send.parentElement);
  });

  it("keeps the context indicator visible when the context window is unknown", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="hy4-preview"
        contextUsage={{ used: 59_600, total: null }}
      />,
    );

    expect(screen.getByRole("img", { name: "已使用 59.6K，模型上下文窗口未知" })).toBeInTheDocument();
  });

  it("keeps the context indicator visible for legacy cumulative usage", () => {
    // Legacy turns stored cumulative usage; never render a nonsensical ratio.
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="qwen3.7-plus"
        contextUsage={{ used: 3_897_400, total: 65_536 }}
      />,
    );

    expect(screen.getByRole("img", { name: "已使用 3.9M，模型上下文窗口未知" })).toBeInTheDocument();
  });

  it("shows an empty context indicator without usage data", () => {
    render(<ThreadComposer onSend={vi.fn()} modelLabel="hy4-preview" />);

    expect(screen.getByRole("img", { name: "暂无上下文用量" })).toBeInTheDocument();
  });

  it("renders the model selector without a leading icon", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="Deepseek-V4"
        modelOptions={[{
          provider: "mona",
          providerLabel: "Mona",
          model: "Deepseek-V4",
          label: "Deepseek V4",
          active: true,
        }]}
        onModelSwitch={vi.fn()}
      />,
    );

    const trigger = screen.getByTitle("Deepseek-V4");
    expect(trigger.className).toContain("h-7");
    expect(trigger.className).toContain("text-caption");
    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("groups the model selector with the send button on the trailing side", () => {
    render(
      <ThreadComposer
        onSend={vi.fn()}
        modelLabel="hy4-preview"
        modelOptions={[{
          provider: "mona",
          providerLabel: "Mona",
          model: "hy4-preview",
          label: "Hy4 preview",
          active: true,
          contextWindow: 1_000_000,
        }]}
        onModelSwitch={vi.fn()}
      />,
    );

    const trigger = screen.getByTitle("hy4-preview");
    const send = screen.getByRole("button", { name: "Send message" });
    expect(trigger.parentElement).toBe(send.parentElement);
  });
});
