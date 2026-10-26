import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StockEntry } from "./StockEntry";

vi.mock("@/components/stock-vibe/StockVibeView", () => ({
  StockVibeView: () => <div data-testid="vibe-stock-view">Vibe stock view</div>,
}));

describe("StockEntry", () => {
  it("mounts the Vibe view directly", async () => {
    render(<StockEntry />);

    expect(await screen.findByTestId("vibe-stock-view")).toBeInTheDocument();
    expect(screen.queryByText(/旧版/)).not.toBeInTheDocument();
  });
});
