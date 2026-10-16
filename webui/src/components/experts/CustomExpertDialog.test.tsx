import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

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
    expect(screen.queryByLabelText("Expertise")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Personality")).toHaveAttribute("maxLength", "20000");
    expect(screen.getByRole("button", { name: "Create and summon" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Partner name"), {
      target: { value: "  Contract reviewer  " },
    });
    fireEvent.change(screen.getByLabelText("Personality"), {
      target: { value: "  Highlight material risks.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create and summon" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        displayName: "Contract reviewer",
        instructions: "Highlight material risks.",
      });
    });
  });

  it("keeps the draft after a creation error and clears it after closing and reopening", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("Could not create"));
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
          <CustomExpertDialog open={open} onOpenChange={setOpen} onSubmit={onSubmit} />
        </>
      );
    }

    render(<Harness />);
    await user.type(screen.getByLabelText("Partner name"), "Writing partner");
    await user.type(screen.getByLabelText("Personality"), "Direct and concise");
    await user.click(screen.getByRole("button", { name: "Create and summon" }));

    expect(await screen.findByText("Could not create")).toBeInTheDocument();
    expect(screen.getByLabelText("Partner name")).toHaveValue("Writing partner");
    expect(screen.getByLabelText("Personality")).toHaveValue("Direct and concise");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(screen.getByLabelText("Partner name")).toHaveValue("");
    expect(screen.getByLabelText("Personality")).toHaveValue("");
    expect(screen.queryByText("Could not create")).not.toBeInTheDocument();
  });

  it("shows a pending state and disables dismissal until creation completes", async () => {
    const user = userEvent.setup();
    let finishSubmit!: () => void;
    const onOpenChange = vi.fn();
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finishSubmit = resolve; }));
    render(
      <CustomExpertDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} />,
    );

    await user.type(screen.getByLabelText("Partner name"), "Writing partner");
    await user.click(screen.getByRole("button", { name: "Create and summon" }));

    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledWith({ displayName: "Writing partner", instructions: "" });

    await act(async () => finishSubmit());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
