import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentComposer } from "./AgentComposer";

const attachmentMocks = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn(), clear: vi.fn() }));

vi.mock("@/hooks/useAttachedDocuments", () => ({
  useAttachedDocuments: () => ({
    documents: [{ name: "sample.xyz", path: "uploads/chat-1/sample.xyz", size: 3 }],
    uploading: false,
    error: null,
    add: attachmentMocks.add,
    remove: attachmentMocks.remove,
    clear: attachmentMocks.clear,
  }),
}));

describe("AgentComposer", () => {
  it("uses the terminal sidebar composer layout and keeps the native file input hidden", () => {
    const { container } = render(
      <AgentComposer value="" onChange={vi.fn()} onSend={vi.fn()} placeholder="输入问题..." />,
    );

    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toHaveAttribute("hidden");
    expect(fileInput).not.toHaveClass("flex");
    expect(screen.getByPlaceholderText("输入问题...").parentElement).toHaveClass("items-end");
    expect(screen.getByRole("button", { name: "添加文件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("accepts an arbitrary selected file and forwards uploaded document paths", () => {
    const onSend = vi.fn();
    attachmentMocks.add.mockClear();
    const { container } = render(
      <AgentComposer value="" onChange={vi.fn()} onSend={onSend} />,
    );
    const file = new File(["abc"], "sample.xyz", { type: "application/x-sample" });
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toHaveAttribute("accept");

    fireEvent.change(input!, { target: { files: [file] } });
    expect(attachmentMocks.add).toHaveBeenCalledWith([file]);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("", undefined, {
      docPaths: ["uploads/chat-1/sample.xyz"],
      documentNames: ["sample.xyz"],
    });
  });
});
