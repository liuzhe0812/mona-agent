import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./switch";

describe("Switch", () => {
  it("exposes switch semantics and toggles the checked value", () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked onCheckedChange={onCheckedChange} aria-label="后台运行" />);

    const control = screen.getByRole("switch", { name: "后台运行" });
    expect(control).toHaveAttribute("aria-checked", "true");
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });
});
