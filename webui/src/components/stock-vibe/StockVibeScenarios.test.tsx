import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", () => ({
  listStockVibeScenarios: api.list,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));

import { StockVibeScenarios } from "./StockVibeScenarios";

function scenario(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: "a".repeat(32),
    run_id: "run-a",
    symbol: "600519.SH",
    exchange: "shanghai",
    as_of: "2026-10-15T00:00:00Z",
    mode: "swing",
    horizon: "10 个交易日",
    judgment: "watch",
    next_step: "等待新的来源数据再复核",
    conditions: [{
      field: "close",
      operator: "gte",
      threshold: 1234.5,
      evidence_ref: `sha256:${"c".repeat(64)}`,
      source: "tencent",
      observed_at: "2026-10-15T07:00:00Z",
      missing_data: null,
    }],
    invalidation: [{
      field: "volume",
      operator: "gt",
      threshold: null,
      evidence_ref: null,
      source: null,
      observed_at: null,
      missing_data: "成交量观测暂缺",
    }],
    review_at: null,
    supersedes: null,
    revision_reason: null,
    created_at: "2026-10-15T08:00:00Z",
    source: {
      snapshot_id: `sha256:${"d".repeat(64)}`,
      instance_id: "e".repeat(32),
      data_root_sha256: "f".repeat(64),
      patches: [{ path: "0015-hosted-research-scenarios.json", category: "host-integration", sha256: "a".repeat(64) }],
    },
    ...overrides,
  };
}

beforeEach(() => api.list.mockReset());

describe("StockVibeScenarios", () => {
  it("shows the newest matching artifact and opens evidence-backed history in dialogs", async () => {
    api.list.mockResolvedValue({
      native: { scenarios: [
        scenario({ artifact_id: "a".repeat(32), created_at: "2026-10-16T08:00:00Z", next_step: "最新下一步", invalidation: [] }),
        scenario({ artifact_id: "b".repeat(32), created_at: "2026-10-15T08:00:00Z", next_step: "历史下一步" }),
        scenario({ artifact_id: "d".repeat(32), symbol: "000001.SZ", next_step: "其他标的" }),
        scenario({ artifact_id: "e".repeat(32), mode: "medium", next_step: "其他周期" }),
      ] },
      source: null,
    });

    render(<StockVibeScenarios symbol="600519.SH" mode="swing" />);

    expect(await screen.findByText("最新下一步")).toBeInTheDocument();
    expect(screen.queryByText("历史下一步")).not.toBeInTheDocument();
    expect(screen.queryByText("其他标的")).not.toBeInTheDocument();
    expect(screen.queryByText("其他周期")).not.toBeInTheDocument();
    expect(screen.getAllByText(/来源：tencent · 观测时点：2026-10-15T07:00:00Z/)[0]).toBeVisible();
    expect(screen.getAllByText(`证据：sha256:${"c".repeat(64)}`)[0]).toBeVisible();
    expect(screen.getAllByText(`来源版本：sha256:${"d".repeat(64)} · 补丁数：1`)[0]).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "历史版本（1）" }));
    const history = await screen.findByRole("dialog", { name: "历史版本" });
    const oldVersionLabel = "2026-10-15T08:00:00Z · 观察 · 10 个交易日";
    fireEvent.click(within(history).getByRole("button", { name: oldVersionLabel }));
    const oldVersion = await screen.findByRole("dialog", { name: oldVersionLabel });
    expect(within(oldVersion).getByText("历史下一步")).toBeInTheDocument();
    expect(within(oldVersion).getByText(/缺项：成交量观测暂缺/)).toBeInTheDocument();
  });

  it("does not query before a symbol is selected and shows a real empty state", async () => {
    const { rerender } = render(<StockVibeScenarios symbol={null} mode="swing" />);
    expect(screen.getByText("先选择一个标的")).toBeInTheDocument();
    expect(api.list).not.toHaveBeenCalled();

    api.list.mockResolvedValue({ native: { scenarios: [] }, source: null });
    rerender(<StockVibeScenarios symbol="600519.SH" mode="swing" />);
    expect(await screen.findByText("暂无已保存的走势情景")).toBeInTheDocument();
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
  });

  it("opens the exact historical artifact cited by a notification", async () => {
    api.list.mockResolvedValue({ native: { scenarios: [
      scenario({ artifact_id: "a".repeat(32), created_at: "2026-10-16T08:00:00Z", next_step: "较新的情景" }),
      scenario({ artifact_id: "b".repeat(32), mode: "medium", next_step: "通知引用的原判断" }),
    ] }, source: null });
    render(<StockVibeScenarios symbol="600519.SH" mode="swing" focusArtifactId={"b".repeat(32)} />);
    expect(await screen.findByText("通知引用的原判断")).toBeInTheDocument();
    expect(screen.queryByText("较新的情景")).not.toBeInTheDocument();
  });
});
