import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MermaidDiagram } from "./mermaid-diagram";
import { downloadMermaidDiagram } from "./mermaid-export";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg viewBox="0 0 200 100"><g class="node" data-id="a"><rect width="80" height="40"/></g></svg>',
    }),
  },
}));

vi.mock("./mermaid-export", async (loadOriginal) => {
  const original = await loadOriginal<typeof import("./mermaid-export")>();
  return { ...original, downloadMermaidDiagram: vi.fn().mockResolvedValue(undefined) };
});

class ImmediateIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
  root = null;
  rootMargin = "0px";
  thresholds = [0];
}

describe("Mermaid diagram exports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IntersectionObserver", ImmediateIntersectionObserver);
  });

  it("groups PNG, SVG, and Draw.io downloads in one export menu", async () => {
    render(<MermaidDiagram code="flowchart TD\n  A --> B" />);
    const enlarge = await screen.findByTitle("Enlarge diagram");
    fireEvent.click(enlarge);

    const exportButton = screen.getByRole("button", { name: "Export" });
    fireEvent.pointerDown(exportButton, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export PNG image" }));
    fireEvent.pointerDown(exportButton, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export SVG image" }));
    fireEvent.pointerDown(exportButton, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Export editable Draw.io diagram" }));

    await waitFor(() => expect(downloadMermaidDiagram).toHaveBeenCalledTimes(3));
    expect(vi.mocked(downloadMermaidDiagram).mock.calls.map((call) => call[2]))
      .toEqual(["png", "svg", "drawio"]);
  });
});
