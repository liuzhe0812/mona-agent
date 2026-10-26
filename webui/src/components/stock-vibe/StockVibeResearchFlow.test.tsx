import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createSession: vi.fn(), sendMessage: vi.fn(), cancelSession: vi.fn(), uploadFile: vi.fn(),
  getSession: vi.fn(), getMessages: vi.fn(), getRequest: vi.fn(), getAttempt: vi.fn(), getEventStream: vi.fn(),
  getStatus: vi.fn(), getAttention: vi.fn(), getMarket: vi.fn(), getWorkbenchMarket: vi.fn(), updateAttention: vi.fn(), createRequestId: vi.fn(),
}));
vi.mock("@/lib/stock-vibe-api", () => ({
  createStockVibeSession: api.createSession, sendStockVibeMessage: api.sendMessage,
  cancelStockVibeSession: api.cancelSession, uploadStockVibeFile: api.uploadFile,
  getStockVibeSession: api.getSession, getStockVibeMessages: api.getMessages,
  getStockVibeRequest: api.getRequest, getStockVibeAttempt: api.getAttempt,
  getStockVibeEventStreamUrl: api.getEventStream,
  getStockVibeStatus: api.getStatus, getStockVibeAttention: api.getAttention, getStockVibeMarketData: api.getMarket,
  getStockVibeWorkbenchMarket: api.getWorkbenchMarket, updateStockVibeAttention: api.updateAttention, createStockVibeRequestId: api.createRequestId,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));
vi.mock("@/components/stock-vibe/StockVibeAttentionSettings", () => ({ StockVibeAttentionSettings: () => null }));
vi.mock("@/components/stock-vibe/StockVibeModelSettings", () => ({ StockVibeModelSettings: () => null }));
vi.mock("@/components/stock-vibe/StockVibeOperations", () => ({ StockVibeOperations: () => null }));
vi.mock("@/components/stock-vibe/StockVibeOpportunity", () => ({ StockVibeOpportunity: () => null }));
vi.mock("@/components/stock-vibe/StockVibeScenarios", () => ({ StockVibeScenarios: () => null }));
vi.mock("@/components/stock-vibe/StockVibeTeam", () => ({ StockVibeTeam: () => <p>复核表单</p> }));
vi.mock("@/components/stock-vibe/StockVibeWorkbench", () => ({ StockVibeWorkbench: (props: { onResearch: (symbol: string, task: string) => void }) => <button onClick={() => props.onResearch("600519.SH", "fundamental")}>财报与估值</button> }));
vi.mock("@/components/stock-vibe/StockVibeMessages", () => ({ StockVibeMessages: () => null }));
import { StockVibeResearch } from "@/components/stock-vibe/StockVibeResearch";
import { StockVibeView } from "@/components/stock-vibe/StockVibeView";

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getSession.mockResolvedValue({ native: { session_id: "research", last_attempt_id: "attempt", config: { mona_workbench: { symbol: "002460.SZ", mode: "swing", task: "fundamental" } } } });
  api.getMessages.mockResolvedValue({ native: [] });
  api.getEventStream.mockRejectedValue(new Error("not available"));
  api.getStatus.mockResolvedValue({ execution_allowed: true, model_preset: "default", running: true, diagnostic: null });
  api.getWorkbenchMarket.mockResolvedValue({ native: {}, source: null });
  api.createRequestId.mockReturnValue("b".repeat(32));
});
afterEach(() => { vi.useRealTimers(); });

it("keeps the unsent question and attachment when closing details and switching tabs", async () => {
  localStorage.setItem("mona.stock-vibe.display.v1", JSON.stringify({ symbols: ["600519.SH"], selected: "600519.SH", interval: "intraday", mode: "swing" }));
  render(<StockVibeView />);
  fireEvent.click(screen.getByRole("button", { name: "财报与估值" }));
  const question = await screen.findByRole("textbox", { name: "研究问题" });
  await waitFor(() => expect(question).toBeEnabled());
  fireEvent.change(question, { target: { value: "盈利增长有现金流支持吗？" } });
  fireEvent.change(screen.getByLabelText("附件"), { target: { files: [new File(["report"], "年报.pdf")] } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "机会选股" }));
  fireEvent.click(screen.getByRole("button", { name: "投资工作台" }));
  fireEvent.click(screen.getByRole("button", { name: "财报与估值" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("盈利增长有现金流支持吗？"));
  expect(screen.getByText("600519 · 波段")).toBeInTheDocument();
  expect(screen.getByText("年报.pdf · 将随消息上传")).toBeInTheDocument();
  const stored = JSON.parse(localStorage.getItem("mona.stock-vibe.research.v1:600519.SH:task:fundamental") ?? "{}");
  expect(stored.task).toBe("fundamental");
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.sendMessage).not.toHaveBeenCalled();
  expect(api.uploadFile).not.toHaveBeenCalled();
});

it("shows the assistant's actual clarification when a running attempt begins waiting for the user", async () => {
  localStorage.setItem("mona.stock-vibe.research.v1:002460.SZ", JSON.stringify({ sessionId: "research", attemptId: "attempt", attachments: [], pending: [] }));
  api.getAttempt.mockResolvedValueOnce({ native: { session_id: "research", attempt_id: "attempt", status: "running" } })
    .mockResolvedValue({ native: { session_id: "research", attempt_id: "attempt", status: "waiting_user" } });
  render(<StockVibeResearch symbol="002460.SZ" mode="swing" enabled />);
  await waitFor(() => expect(api.getAttempt).toHaveBeenCalledOnce());
  api.getMessages.mockResolvedValue({ native: [{
    message_id: "clarification", role: "assistant", content: "你想看2025年报，还是2026年中报？", created_at: "2026-10-19T10:00:00Z", linked_attempt_id: "attempt",
  }] });
  await screen.findByText("需要你补充信息，可在下方继续回答。", {}, { timeout: 7500 });
  expect(await screen.findByText("你想看2025年报，还是2026年中报？")).toBeInTheDocument();
}, 10000);
