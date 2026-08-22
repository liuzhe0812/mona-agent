import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NewTabPage } from "./NewTabPage";

describe("NewTabPage", () => {
  it("searches from the central field without creating a WebView first", () => {
    const onNavigate = vi.fn();

    render(<NewTabPage onNavigate={onNavigate} />);
    const input = screen.getByRole("textbox", { name: "Search or enter address" });

    fireEvent.change(input, { target: { value: "Mona desktop" } });
    fireEvent.submit(input);

    expect(onNavigate).toHaveBeenCalledWith(
      "https://www.google.com/search?q=Mona%20desktop",
    );
  });

  it("opens history and downloads from the start page", () => {
    const onOpenHistory = vi.fn();
    const onOpenDownloads = vi.fn();

    render(
      <NewTabPage
        onNavigate={vi.fn()}
        onOpenHistory={onOpenHistory}
        onOpenDownloads={onOpenDownloads}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Downloads" }));

    expect(onOpenHistory).toHaveBeenCalledOnce();
    expect(onOpenDownloads).toHaveBeenCalledOnce();
  });
});
