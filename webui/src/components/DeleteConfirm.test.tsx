import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DeleteConfirm } from "./DeleteConfirm";

describe("DeleteConfirm", () => {
  it("uses the standard destructive-dialog hierarchy and confirms the deletion", () => {
    const onConfirm = vi.fn();
    render(
      <DeleteConfirm
        open
        title="Project notes"
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveClass("rounded-xl", "bg-popover", "shadow-overlay");
    const title = screen.getByText("Delete this chat?");
    expect(title).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("rounded-md");
    expect(title.parentElement?.parentElement).toHaveClass("flex", "items-start", "gap-3");

    fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
