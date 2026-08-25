import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThreadHeader } from "./ThreadHeader";
import type { UIMessage } from "@/lib/types";

const messages: UIMessage[] = [
  { id: "u1", role: "user", content: "请搜索小红书运营方案", createdAt: 1_700_000_000_000 },
  { id: "a1", role: "assistant", content: "小红书运营方案已经整理完成", createdAt: 1_700_000_060_000 },
];

describe("ThreadHeader conversation tools", () => {
  it("searches the current conversation and jumps to a result", () => {
    const onJumpToMessage = vi.fn();
    render(<ThreadHeader title="会话" onToggleSidebar={() => {}} messages={messages} onJumpToMessage={onJumpToMessage} />);

    fireEvent.click(screen.getByRole("button", { name: "搜索会话" }));
    fireEvent.change(screen.getByPlaceholderText("搜索当前会话内容"), { target: { value: "整理完成" } });
    fireEvent.click(screen.getByText("小红书运营方案已经整理完成"));

    expect(onJumpToMessage).toHaveBeenCalledWith("a1");
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
