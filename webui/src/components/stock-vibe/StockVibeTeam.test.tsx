import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  createRun: vi.fn(),
  downloadArtifact: vi.fn(),
  getRequest: vi.fn(),
  getRun: vi.fn(),
  listArtifacts: vi.fn(),
  listPresets: vi.fn(),
  listRuns: vi.fn(),
  resumeRun: vi.fn(),
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  cancelStockVibeSwarm: api.cancelRun,
  createStockVibeSwarm: api.createRun,
  downloadStockVibeSwarmArtifact: api.downloadArtifact,
  getStockVibeRequest: api.getRequest,
  getStockVibeSwarmRun: api.getRun,
  listStockVibeSwarmArtifacts: api.listArtifacts,
  listStockVibeSwarmPresets: api.listPresets,
  listStockVibeSwarmRuns: api.listRuns,
  resumeStockVibeSwarm: api.resumeRun,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));

import { StockVibeTeam } from "./StockVibeTeam";

const STORAGE_KEY = "mona.stock-vibe.team.v1";

function completedRequest(requestId: string) {
  return {
    request_id: requestId,
    method: "POST",
    path: "/swarm/runs",
    payload_sha256: "a".repeat(64),
    status: "completed",
    error_category: null,
    source: null,
    source_sha256: null,
    receipt: { status_code: 201, body: { id: "team_run_1" } },
    receipt_sha256: "b".repeat(64),
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
}

function renderTeam(symbol: string | null) {
  return render(<StockVibeTeam symbol={symbol} mode="swing" enabled />);
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.listPresets.mockResolvedValue({ native: { presets: [{ name: "mona_ashare_research" }] }, source: null });
  api.listRuns.mockResolvedValue({ native: { runs: [] }, source: null });
  api.listArtifacts.mockResolvedValue({ native: { artifacts: [] }, source: null });
  api.getRun.mockImplementation(async (runId: string) => ({ native: { id: runId, status: "completed" }, source: null }));
  api.getRequest.mockResolvedValue({ status: "unknown" });
  api.createRun.mockImplementation(async (requestId: string) => completedRequest(requestId));
});

describe("StockVibeTeam symbol input", () => {
  it("shows the selected symbol as six digits and follows selection changes", async () => {
    const { rerender } = renderTeam("600519.SH");
    const input = screen.getByLabelText("证券代码");
    await screen.findByRole("heading", { name: "行情证据复核" });

    expect(input).toHaveValue("600519");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("maxlength", "6");

    rerender(<StockVibeTeam symbol="002460.SZ" mode="swing" enabled />);
    expect(input).toHaveValue("002460");
  });

  it("submits the inferred canonical symbol with the persisted stable request id", async () => {
    renderTeam("600519.SH");
    await screen.findByRole("heading", { name: "行情证据复核" });

    fireEvent.change(screen.getByLabelText("证券代码"), { target: { value: "002460" } });
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2026-10-18" } });
    fireEvent.change(screen.getByLabelText("想核对的问题（可选）"), { target: { value: "重点核对上涨时成交量有没有同步放大。" } });
    expect(screen.getByText("观察周期：波段")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "开始行情证据复核" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "开始行情证据复核" }));

    await waitFor(() => expect(api.createRun).toHaveBeenCalledOnce());
    const [requestId, input] = api.createRun.mock.calls[0];
    expect(requestId).toMatch(/^[a-f0-9]{32}$/);
    expect(input.user_vars.symbol).toBe("002460.SZ");
    expect(input.user_vars.start_date).toBe("2026-10-01");
    expect(input.user_vars.end_date).toBe("2026-10-18");
    expect(input.user_vars.question).toBe("观察期限：波段，3、5、10个交易日。\n\n重点核对上涨时成交量有没有同步放大。");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").writes[0].requestId).toBe(requestId);
  });

  it("blocks unknown code ranges without requesting an exchange suffix", async () => {
    renderTeam(null);
    await screen.findByRole("heading", { name: "行情证据复核" });
    fireEvent.change(screen.getByLabelText("证券代码"), { target: { value: "999999" } });

    expect(screen.getByRole("alert")).toHaveTextContent("暂无法识别该代码，请核对六位 A 股代码。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("后缀");
    expect(screen.getByRole("button", { name: "开始行情证据复核" })).toBeDisabled();
    expect(api.createRun).not.toHaveBeenCalled();
  });
});

it("labels research records for users and keeps stage details in a floating dialog", async () => {
  api.listRuns.mockResolvedValue({ native: { runs: [{ id: "team_run_1", status: "completed", created_at: "2026-10-18T00:00:00Z" }] }, source: null });
  api.getRun.mockResolvedValue({ native: {
    id: "team_run_1", status: "completed", final_report: "最终研究报告正文",
    user_vars: { symbol: "600519.SH", start_date: "2026-10-01", end_date: "2026-10-18" },
    grounding_metadata: { "600519.SH": { provenance: { source: "tencent" }, coverage: { start_date: "2026-10-01", end_date: "2026-10-18", row_count: 14 } } },
    tasks: [{ id: "data_review", agent_id: "researcher", status: "completed", summary: "仅在浮窗查看的阶段过程" }],
  }, source: null });
  api.listArtifacts.mockResolvedValue({ native: { artifacts: [{ artifact_id: "a".repeat(64), task_id: "data_review", filename: "行情复核报告.pdf", bytes: 1024 }] }, source: null });
  const { container } = renderTeam("600519.SH");

  const trigger = await screen.findByRole("button", { name: "查看研究进度（1/1）" });
  expect(screen.getByText("最终研究报告正文")).toBeInTheDocument();
  expect(screen.getByText("600519 · 2026-10-01 至 2026-10-18")).toBeInTheDocument();
  expect(screen.getByText("600519 · 腾讯行情 · 2026-10-01 至 2026-10-18 · 14 个交易日")).toBeInTheDocument();
  expect(screen.getByText("行情复核报告.pdf")).toBeInTheDocument();
  expect(screen.queryByText("仅在浮窗查看的阶段过程")).not.toBeInTheDocument();
  expect(screen.queryByText("team_run_1")).not.toBeInTheDocument();
  expect(screen.queryByText(/DAG|Agent|artifact|opaque|bytes|原生/i)).not.toBeInTheDocument();
  expect(container.querySelector("details")).toBeNull();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "研究阶段进度" });
  expect(within(dialog).getByText("行情研究")).toBeInTheDocument();
  expect(within(dialog).getByText("已完成")).toBeInTheDocument();
  expect(within(dialog).getByText("仅在浮窗查看的阶段过程")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭信息" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(api.createRun).not.toHaveBeenCalled();
});
