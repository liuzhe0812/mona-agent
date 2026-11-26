import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunMetricsPopover, type RunMetricsDisplay } from "./RunMetricsPopover";

describe("RunMetricsPopover", () => {
  const metrics: RunMetricsDisplay = {
    latestRate: 84.8,
    averageRate: 73.2,
    outputTokens: 1250,
    peakRate: 95.1,
    samples: [73.2, 84.8],
  };

  it("shows output and speed without a cache hit rate and distinguishes unreported reasoning usage", async () => {
    render(<RunMetricsPopover elapsedLabel="7s" metrics={metrics} />);
    const trigger = screen.getByRole("button", { name: /View run speed details/ });
    expect(trigger).toHaveTextContent("7s · Last 84.8 tok/s");
    expect(trigger).toHaveAccessibleName("View run speed details · 7s · Last 84.8 tok/s");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "View run speed details" });
    expect(within(dialog).queryByText("Cache hit rate")).not.toBeInTheDocument();
    expect(within(dialog).getByText("Reasoning share").parentElement).toHaveTextContent("Not reported");
    expect(within(dialog).getByText("Total output").parentElement).toHaveTextContent("1,250 tok");
    expect(within(dialog).getByText("Turn average").parentElement).toHaveTextContent("73.2 tok/s");
    expect(within(dialog).getByText("Peak").parentElement).toHaveTextContent("95.1 tok/s");
    expect(dialog.querySelector("polyline")).toBeInTheDocument();
  });

  it("shows a reported zero reasoning share and omits a one-point chart", async () => {
    render(<RunMetricsPopover metrics={{ ...metrics, reasoningRatio: 0, samples: [84.8] }} />);
    fireEvent.click(screen.getByRole("button", { name: /View run speed details/ }));

    const dialog = await screen.findByRole("dialog", { name: "View run speed details" });
    expect(within(dialog).getByText("Reasoning share").parentElement).toHaveTextContent("0%");
    expect(dialog.querySelector("polyline")).not.toBeInTheDocument();
  });

  it("labels live samples as estimates and uses the last request label during a pause", () => {
    const { rerender } = render(<RunMetricsPopover elapsedLabel="8s" liveRate={96} metrics={metrics} />);
    expect(screen.getByRole("button", { name: /View run speed details/ })).toHaveTextContent("8s · ~96.0 tok/s");
    rerender(<RunMetricsPopover elapsedLabel="9s" metrics={metrics} />);
    expect(screen.getByRole("button", { name: /View run speed details/ })).toHaveTextContent("9s · Last 84.8 tok/s");
  });

  it("shows reported-request coverage alongside a partially reported reasoning ratio", async () => {
    render(<RunMetricsPopover metrics={{
      ...metrics,
      reasoningRatio: 0.2,
      coverage: { total: 4, reasoning: 2 },
    }} />);
    fireEvent.click(screen.getByRole("button", { name: /View run speed details/ }));

    const dialog = await screen.findByRole("dialog", { name: "View run speed details" });
    const reasoning = within(dialog).getByText("Reasoning share").parentElement!;
    expect(reasoning).toHaveTextContent("20%");
    expect(reasoning).toHaveTextContent("2/4 requests reported");
    expect(within(dialog).getByText("Total output").parentElement).not.toHaveTextContent("requests reported");
  });
});
