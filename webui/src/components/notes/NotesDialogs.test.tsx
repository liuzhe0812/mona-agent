import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PromptDialog } from "./NotesDialogs";

describe("PromptDialog", () => {
  it("lets the owner close the dialog after an async action finishes", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PromptDialog
        open
        title="网页转笔记"
        defaultValue="https://example.com/article"
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    expect(onConfirm).toHaveBeenCalledWith("https://example.com/article");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
