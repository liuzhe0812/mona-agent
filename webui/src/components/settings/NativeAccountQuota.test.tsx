import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NativeAccountQuota, formatNativePlan } from "./NativeAccountQuota";
import type { NativeAccountUsage } from "@/lib/development-api";

const NOW = Date.UTC(2026, 6, 1, 10, 0);

function makeUsage(overrides: Partial<NativeAccountUsage> = {}): NativeAccountUsage {
  return {
    revision: 1,
    connected: true,
    email: null,
    planType: "pro",
    limits: [],
    credits: null,
    availableResets: null,
    fetchedAt: NOW,
    error: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe("NativeAccountQuota", () => {
  it("formats known plans and preserves unknown native plan names", () => {
    expect(formatNativePlan("pro")).toBe("ChatGPT Pro");
    expect(formatNativePlan(null)).toBe("ChatGPT订阅");
    expect(formatNativePlan("unknown-plan")).toBe("ChatGPT Unknown Plan");
  });

  it("renders every bucket window with remaining percentage and severity", () => {
    const { container } = render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({
          email: "private@example.com",
          limits: [
            {
              limitId: "codex",
              primary: { usedPercent: 72, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 },
              secondary: { usedPercent: 90, windowDurationMins: 10_080, resetsAt: NOW / 1000 + 86400 },
            },
            {
              limitId: "codex_spark",
              limitName: "GPT-5.3-Codex-Spark",
              primary: { usedPercent: 15, windowDurationMins: 10_080, resetsAt: NOW / 1000 + 172800 },
            },
          ],
        })}
      />,
    );

    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    expect(screen.getByText("5 小时")).toBeInTheDocument();
    expect(screen.getByText("周限")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.3-Codex-Spark 周限")).toBeInTheDocument();
    expect(screen.getByText("剩余 28%")).toBeInTheDocument();
    expect(screen.getByText("剩余 10%")).toBeInTheDocument();
    expect(screen.getByText("剩余 85%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /5 小时.*用量偏高/ }))
      .toHaveAttribute("data-severity", "warn");
    expect(screen.getByRole("progressbar", { name: /5 小时.*用量偏高/ }))
      .toHaveAttribute("aria-valuenow", "28");
    expect(screen.getByRole("progressbar", { name: /周限.*用量较高/ }))
      .toHaveAttribute("data-severity", "crit");
    expect(container.textContent).not.toContain("private@example.com");
    expect(screen.queryByText("ChatGPT Pro")).not.toBeInTheDocument();
  });

  it.each([
    [70, "normal"],
    [70.1, "warn"],
    [90, "crit"],
  ])("uses the Cindy severity boundary at %s%% used", (used, severity) => {
    render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({ limits: [{ primary: { usedPercent: used, windowDurationMins: 300 } }] })}
      />,
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute("data-severity", severity);
  });

  it("keeps quota windows compact without a usage-details action", () => {
    const resetsAt = NOW / 1000 + (10_080 * 60 * 0.75);
    render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({
          limits: [
            { primary: { usedPercent: 31, windowDurationMins: 10_080, resetsAt } },
            { limitName: "GPT-5.3-Codex-Spark", primary: { usedPercent: 31, windowDurationMins: 10_080, resetsAt } },
          ],
        })}
      />,
    );

    expect(screen.queryByTestId("quota-pace")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "额度用量明细" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getAllByText("剩余 69%")).toHaveLength(2);
  });

  it("keeps expired windows visible, marks reset as pending, and omits stale pace", () => {
    render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({
          fetchedAt: NOW - 24 * 60 * 60_000,
          limits: [{ primary: { usedPercent: 30, windowDurationMins: 10_080, resetsAt: NOW / 1000 - 3600 } }],
        })}
      />,
    );

    const countdown = screen.getByText("等待重置数据更新");
    const resetTitle = countdown.getAttribute("title");
    expect(resetTitle).toContain("重置");
    expect(screen.getByText("数据更新于 1440 分钟前")).toBeInTheDocument();
    expect(screen.queryByText(resetTitle!)).not.toBeInTheDocument();
    expect(screen.queryByTestId("quota-pace")).not.toBeInTheDocument();
  });

  it("shows known credits and reset count but does not turn missing values into zero", () => {
    const { rerender } = render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({
          credits: { balance: "1,234.5", hasCredits: true, unlimited: false },
          availableResets: 0,
        })}
      />,
    );
    expect(screen.getByText("剩余 1,234.50 credits")).toBeInTheDocument();
    expect(screen.getByText("可用重置：0 次")).toBeInTheDocument();

    rerender(<NativeAccountQuota nowMs={NOW} usage={makeUsage({ credits: null, availableResets: null })} />);
    expect(screen.getByText("暂无配额窗口数据")).toBeInTheDocument();
    expect(screen.queryByText(/credits/)).not.toBeInTheDocument();
    expect(screen.queryByText(/可用重置/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "额度用量明细" })).not.toBeInTheDocument();
  });

  it("shows only supported credit status without inventing a balance", () => {
    render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({ credits: { balance: null, hasCredits: true, unlimited: false } })}
      />,
    );
    expect(screen.getByText("余额可用")).toBeInTheDocument();
    expect(screen.queryByText(/剩余 0/)).not.toBeInTheDocument();
  });

  it("shows the earliest reset credit expiry independently from the available count", () => {
    const { rerender } = render(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({ resetCreditsExpireAt: NOW / 1000 + 3600 })}
      />,
    );
    expect(screen.getByText(/^最早过期：/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "额度用量明细" })).not.toBeInTheDocument();

    rerender(
      <NativeAccountQuota
        nowMs={NOW}
        usage={makeUsage({ availableResets: 0, resetCreditsExpireAt: null })}
      />,
    );
    expect(screen.getByText("可用重置：0 次")).toBeInTheDocument();
    expect(screen.queryByText(/^最早过期：/)).not.toBeInTheDocument();
  });

  it("does not render an empty quota section for a disconnected account", () => {
    const { container } = render(<NativeAccountQuota nowMs={NOW} usage={makeUsage({ connected: false })} />);
    expect(container.firstChild).toBeNull();
  });
});
