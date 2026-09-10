import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CustomExpertDialog } from "./CustomExpertDialog";

describe("CustomExpertDialog", () => {
  it("creates a local expert from the user fields", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CustomExpertDialog
        open
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.queryByText(/uploaded|server/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Expert name"), {
      target: { value: "Contract reviewer" },
    });
    fireEvent.change(screen.getByLabelText("Expertise"), {
      target: { value: "Review contracts" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "Highlight material risks." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create and summon" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        displayName: "Contract reviewer",
        description: "Review contracts",
        instructions: "Highlight material risks.",
      });
    });
  });
});
