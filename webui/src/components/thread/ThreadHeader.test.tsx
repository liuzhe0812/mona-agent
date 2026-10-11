import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThreadHeader } from "./ThreadHeader";
import type { UIMessage } from "@/lib/types";

const messages: UIMessage[] = [
  { id: "u1", role: "user", content: "请搜索小红书运营方案", createdAt: 1_700_000_000_000 },
  { id: "a1", role: "assistant", content: "小红书运营方案已经整理完成", createdAt: 1_700_000_060_000 },
];

describe("ThreadHeader conversation tools", () => {
  it("toggles the session list with the left-sidebar icon", () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = render(
      <ThreadHeader title="会话" onToggleSidebar={onToggleSidebar} sidebarOpen />,
    );

    const collapse = screen.getByRole("button", { name: "收起会话列表" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse.querySelector("svg rect")).toBeInTheDocument();
    fireEvent.click(collapse);
    expect(onToggleSidebar).toHaveBeenCalledOnce();

    rerender(<ThreadHeader title="会话" onToggleSidebar={onToggleSidebar} sidebarOpen={false} />);
    expect(screen.getByRole("button", { name: "展开会话列表" })).toHaveAttribute("aria-expanded", "false");
  });

  it("searches the current conversation and jumps to a result", () => {
    const onJumpToMessage = vi.fn();
    render(<ThreadHeader title="会话" onToggleSidebar={() => {}} messages={messages} onJumpToMessage={onJumpToMessage} />);

    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    fireEvent.change(screen.getByPlaceholderText("搜索当前会话内容"), { target: { value: "整理完成" } });
    fireEvent.click(screen.getByText("小红书运营方案已经整理完成"));

    expect(onJumpToMessage).toHaveBeenCalledWith("a1");
  });

  it("loads full history only when search opens so older messages remain searchable", () => {
    const older: UIMessage = {
      id: "u-old",
      role: "user",
      content: "earlier project requirement",
      createdAt: 1_699_999_000_000,
    };
    const onEnsureFullHistory = vi.fn(async () => [older, ...messages]);
    const onJumpToMessage = vi.fn();
    const props = {
      title: "会话",
      onToggleSidebar: () => {},
      onJumpToMessage,
      onEnsureFullHistory,
    };
    const view = render(<ThreadHeader {...props} messages={messages} />);

    expect(onEnsureFullHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    expect(onEnsureFullHistory).toHaveBeenCalledOnce();
    view.rerender(<ThreadHeader {...props} messages={[older, ...messages]} />);
    fireEvent.change(screen.getByPlaceholderText("搜索当前会话内容"), { target: { value: "earlier project" } });
    fireEvent.click(screen.getByText("earlier project requirement"));

    expect(onJumpToMessage).toHaveBeenCalledWith("u-old");
  });

  it("reloads full history if a revision changes while the search dialog is open", () => {
    const onEnsureFullHistory = vi.fn(async () => messages);
    const props = {
      title: "会话",
      onToggleSidebar: () => {},
      messages,
      onJumpToMessage: () => {},
      onEnsureFullHistory,
    };
    const view = render(<ThreadHeader {...props} hasMoreHistory={false} />);

    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    expect(onEnsureFullHistory).toHaveBeenCalledTimes(1);
    view.rerender(<ThreadHeader {...props} hasMoreHistory fullHistoryLoading={false} />);

    expect(onEnsureFullHistory).toHaveBeenCalledTimes(2);
  });

  it("lists user inputs newest first and jumps to the selected input", () => {
    const onJumpToMessage = vi.fn();
    render(<ThreadHeader title="会话" onToggleSidebar={() => {}} messages={messages} onJumpToMessage={onJumpToMessage} />);

    fireEvent.click(screen.getByRole("button", { name: "用户输入历史" }));
    fireEvent.click(screen.getByText("请搜索小红书运营方案"));

    expect(onJumpToMessage).toHaveBeenCalledWith("u1");
  });

  it("leaves collapse control to the open artifact panel", () => {
    render(<ThreadHeader title="会话" onToggleSidebar={() => {}} workspaceOpen workspaceHasContent onToggleWorkspace={() => {}} />);

    expect(screen.queryByRole("button", { name: "收起工作区" })).not.toBeInTheDocument();
  });
});
