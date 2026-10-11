import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingQueueStrip } from "@/components/thread/PendingQueueStrip";
import type { PendingMessage } from "@/hooks/usePendingQueue";

afterEach(cleanup);

describe("PendingQueueStrip", () => {
  it("does not show append when no append callback is provided", () => {
    const message: PendingMessage = { id: "pending-a", content: "Next task" };
    render(<PendingQueueStrip messages={[message]} onRemove={vi.fn()} onEdit={vi.fn()} isFull={false} />);
    expect(screen.queryByRole("button", { name: "Append to current task" })).not.toBeInTheDocument();
  });

  it("shows the guide action when append is supported", () => {
    const message: PendingMessage = { id: "pending-a", content: "Next task" };
    const onAppend = vi.fn();
    render(<PendingQueueStrip messages={[message]} onAppend={onAppend} onRemove={vi.fn()} onEdit={vi.fn()} isFull={false} />);
    const append = screen.getByRole("button", { name: "Append to current task" });

    expect(append).toHaveTextContent("Append");
    fireEvent.click(append);
    expect(onAppend).toHaveBeenCalledWith("pending-a");
  });

  it("keeps editing and queue removal in the more menu", async () => {
    const message: PendingMessage = { id: "pending-a", content: "Next task" };
    const onEdit = vi.fn(), onRemove = vi.fn();
    render(<PendingQueueStrip messages={[message]} onRemove={onRemove} onEdit={onEdit} isFull={false} />);
    const openMore = () => {
      const trigger = screen.getByRole("button", { name: "More actions" });
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
    };

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit message" }));
    expect(onEdit).toHaveBeenCalledWith("pending-a");

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from queue" }));
    expect(onRemove).toHaveBeenCalledWith("pending-a");
  });

  it("disables append, edit and delete for locked pending messages", () => {
    const message: PendingMessage = { id: "pending-a", content: "Cancelling request", locked: true };
    const onAppend = vi.fn(), onEdit = vi.fn(), onRemove = vi.fn();
    render(<PendingQueueStrip messages={[message]} onAppend={onAppend} onRemove={onRemove} onEdit={onEdit} isFull={false} />);
    const append = screen.getByRole("button", { name: "Append to current task" });
    const remove = screen.getByRole("button", { name: "Delete message" });
    expect(append).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(screen.getByRole("button", { name: "More actions" })).toBeDisabled();

    fireEvent.click(append); fireEvent.click(remove);
    expect(onAppend).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
