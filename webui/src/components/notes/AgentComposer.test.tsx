import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentComposer } from "./AgentComposer";

describe("AgentComposer", () => {
  it("uses the terminal sidebar composer layout and keeps the native file input hidden", () => {
    const { container } = render(
      <AgentComposer value="" onChange={vi.fn()} onSend={vi.fn()} placeholder="输入问题..." />,
    );

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toHaveAttribute("hidden");
    expect(fileInput).not.toHaveClass("flex");
    expect(screen.getByPlaceholderText("输入问题...").parentElement).toHaveClass("items-end");
    expect(screen.getByRole("button", { name: "添加图片" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });
});
