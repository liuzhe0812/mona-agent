import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatChart } from "@/components/ChatChart";
import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";

describe("ChatChart", () => {
  it("renders a true scatter plot without connecting paths", () => {
    const source = JSON.stringify({
      type: "scatter",
      title: "Samples",
      x_label: "Index",
      y_label: "Value",
      data: [
        { label: "A1", x: 1, y: 7 },
        { label: "A2", x: 2, y: 15 },
        { label: "A3", x: 4, y: 9 },
      ],
    });

    const { container } = render(<ChatChart source={source} />);

    const plot = screen.getByRole("img", { name: "Samples" });
    expect(plot).toBeInTheDocument();
    expect(container.querySelectorAll("svg circle")).toHaveLength(3);
    expect(plot.querySelector("path")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
  });

  it("renders chart fences inline instead of as code", () => {
    render(
      <MarkdownTextRenderer>
        {'```chart\n{"type":"bar","title":"Revenue","data":[{"label":"Q1","value":12},{"label":"Q2","value":18}]}\n```'}
      </MarkdownTextRenderer>,
    );

    expect(screen.getByRole("img", { name: "Revenue" })).toBeInTheDocument();
    expect(screen.queryByText("chart", { selector: "span" })).not.toBeInTheDocument();
  });

  it("waits for a streaming chart block to finish before rendering it", () => {
    render(
      <MarkdownTextRenderer highlightCode={false}>
        {'```chart\n{"type":"scatter","data":['}
      </MarkdownTextRenderer>,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/"type":"scatter"/)).toBeInTheDocument();
  });

  it("offers PNG, SVG, and CSV export actions", () => {
    const createObjectUrl = vi.fn(() => "blob:chart-export");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    let downloadedFilename = "";
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function recordDownload(this: HTMLAnchorElement) {
        downloadedFilename = this.download;
      });
    render(
      <ChatChart
        source={'{"type":"line","title":"Trend","data":[["Jan",1],["Feb",2]]}'}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: /export/i }), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByText("Export PNG image")).toBeInTheDocument();
    expect(screen.getByText("Export SVG image")).toBeInTheDocument();
    expect(screen.getByText("Export CSV data")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Export CSV data"));
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(downloadedFilename).toBe("Trend.csv");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:chart-export");
    anchorClick.mockRestore();
  });

  it("shows a readable error for invalid chart JSON", () => {
    render(<ChatChart source="not-json" />);

    expect(screen.getByRole("alert")).toHaveTextContent("not valid JSON");
  });
});
