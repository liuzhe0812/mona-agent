import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ getAttempt: vi.fn(), getMessages: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", () => ({ getStockVibeAttempt: api.getAttempt, getStockVibeMessages: api.getMessages }));
import { StockVibeSavedResearch } from "./StockVibeSavedResearch";

beforeEach(() => { api.getAttempt.mockReset(); api.getMessages.mockReset().mockResolvedValue({ native: [] }); });

it("reads the notification's existing attempt without creating a new research task", async () => {
  api.getAttempt.mockResolvedValue({ native: { session_id: "session-a", attempt_id: "attempt-a",
    status: "completed", summary: "原有研究报告", grounding_validation: { valid: true } } });
  render(<StockVibeSavedResearch sessionId="session-a" attemptId="attempt-a" onClose={vi.fn()} />);
  expect(await screen.findByText("原有研究报告")).toBeInTheDocument();
  expect(api.getAttempt).toHaveBeenCalledOnce();
  expect(api.getAttempt).toHaveBeenCalledWith("session-a", "attempt-a");
});

it("does not present a mismatched record as the requested report", async () => {
  const resume = vi.fn();
  api.getAttempt.mockResolvedValue({ native: { session_id: "other", attempt_id: "attempt-a", status: "completed", summary: "别的报告" } });
  render(<StockVibeSavedResearch sessionId="session-a" attemptId="attempt-a" onClose={vi.fn()} onResume={resume} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
  expect(screen.queryByText("别的报告")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续原研究" })).not.toBeInTheDocument();
  expect(resume).not.toHaveBeenCalled();
});

it("keeps a nonterminal record out of the completed report", async () => {
  api.getAttempt.mockResolvedValue({ native: { session_id: "session-a", attempt_id: "attempt-a", status: "running", summary: "未完成内容" } });
  render(<StockVibeSavedResearch sessionId="session-a" attemptId="attempt-a" onClose={vi.fn()} />);
  expect(await screen.findByText(/当前状态：研究中/)).toBeInTheDocument();
  expect(screen.queryByText("未完成内容")).not.toBeInTheDocument();
});

it("continues the original session while leaving latest-attempt lookup to research details", async () => {
  api.getAttempt.mockResolvedValue({ native: { session_id: "session-a", attempt_id: "attempt-a", status: "completed", summary: "原有研究报告" } });
  const resume = vi.fn();
  const user = userEvent.setup();
  render(<StockVibeSavedResearch sessionId="session-a" attemptId="attempt-a" onClose={vi.fn()} onResume={resume} />);
  await user.click(await screen.findByRole("button", { name: "继续原研究" }));
  expect(resume).toHaveBeenCalledOnce();
  expect(resume).toHaveBeenCalledWith("session-a");
  expect(api.getAttempt).toHaveBeenCalledOnce();
});

it("labels a failed attempt in Chinese without treating its partial summary as a report", async () => {
  api.getAttempt.mockResolvedValue({ native: { session_id: "session-a", attempt_id: "attempt-a", status: "failed", summary: "失败前的内容" } });
  render(<StockVibeSavedResearch sessionId="session-a" attemptId="attempt-a" onClose={vi.fn()} />);
  expect(await screen.findByText(/当前状态：研究失败/)).toBeInTheDocument();
  expect(screen.queryByText("失败前的内容")).not.toBeInTheDocument();
});

it("loads only the selected attempt's recorded evidence on demand", async () => {
  api.getAttempt.mockResolvedValue({ native: { session_id: "session-a", attempt_id: "attempt-a", status: "completed", summary: "原有研究报告" } });
  api.getMessages.mockResolvedValue({ native: [
    { role: "assistant", linked_attempt_id: "attempt-other", tool_trail: [{ tool: "get_market_data", status: "ok", arguments: { symbol: "600519.SH" } }] },
    { role: "assistant", linked_attempt_id: "attempt-a", tool_trail: [{ tool: "get_market_data", status: "ok", arguments: { symbol: "002460.SZ", source: "tencent" } }] },
  ] });
  const user = userEvent.setup();
  render(<StockVibeSavedResearch sessionId="session-a" attemptId="attempt-a" onClose={vi.fn()} />);
  await screen.findByText("原有研究报告");
  expect(api.getMessages).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "查看研究依据" }));
  expect(await screen.findByText("标的：002460.SZ")).toBeInTheDocument();
  expect(screen.queryByText("标的：600519.SH")).not.toBeInTheDocument();
  expect(api.getMessages).toHaveBeenCalledWith("session-a");
});
