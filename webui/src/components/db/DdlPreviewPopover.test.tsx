import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/hooks/useTheme";
import { DdlPreviewPopover } from "./DdlPreviewPopover";

describe("DdlPreviewPopover", () => {
  it("renders SQL syntax highlighting in a non-modal floating layer", async () => {
    const { container } = render(
      <ThemeProvider theme="light">
        <DdlPreviewPopover open title="users · DDL" sql="CREATE TABLE users (id INT PRIMARY KEY);" onClose={vi.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByRole("dialog", { name: "DDL 预览" })).toHaveAttribute("aria-modal", "false");
    await waitFor(() => expect(container.querySelectorAll(".token").length).toBeGreaterThan(3));
    const tokens = Array.from(container.querySelectorAll<HTMLElement>(".token"));
    expect(tokens.map((token) => token.textContent).join(" ")).toContain("CREATE");
    expect(new Set(tokens.map((token) => token.style.color)).size).toBeGreaterThan(1);
  });

  it("copies the exact SQL and closes from Escape", async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    render(<DdlPreviewPopover open title="users · DDL" sql="CREATE TABLE users (id INT);" onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "复制 DDL" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("CREATE TABLE users (id INT);"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
