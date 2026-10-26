import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createSession: vi.fn(), sendMessage: vi.fn(), cancelSession: vi.fn(), uploadFile: vi.fn(),
  getSession: vi.fn(), getMessages: vi.fn(), getRequest: vi.fn(), getAttempt: vi.fn(), getEventStream: vi.fn(),
}));
vi.mock("@/lib/stock-vibe-api", () => ({
  createStockVibeSession: api.createSession, sendStockVibeMessage: api.sendMessage,
  cancelStockVibeSession: api.cancelSession, uploadStockVibeFile: api.uploadFile,
  getStockVibeSession: api.getSession, getStockVibeMessages: api.getMessages,
  getStockVibeRequest: api.getRequest, getStockVibeAttempt: api.getAttempt,
  getStockVibeEventStreamUrl: api.getEventStream,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));
vi.mock("@/components/stock-vibe/StockVibeScenarios", () => ({ StockVibeScenarios: () => null }));
vi.mock("@/components/stock-vibe/StockVibeTeam", () => ({ StockVibeTeam: () => null }));
import { StockVibeResearchDialog } from "@/components/stock-vibe/StockVibeResearchDialog";

beforeEach(() => {
  localStorage.clear();
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getEventStream.mockRejectedValue(new Error("no stream"));
});

it("rereads the shared Session latest report when details reopen after a main-chat follow-up", async () => {
  let latest = "attempt-old";
  const messages = () => [
    { message_id: "question-old", role: "user", content: "盈利有现金流支持吗？", created_at: "2026-10-18T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "swing" } } },
    { message_id: "answer-old", role: "assistant", content: "旧报告", created_at: "2026-10-18T00:01:00Z", linked_attempt_id: "attempt-old" },
    ...(latest === "attempt-new" ? [
      { message_id: "question-new", role: "user", content: "主会话补充了最新年报，请更新", created_at: "2026-10-19T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "swing" } } },
      { message_id: "answer-new", role: "assistant", content: "更新年报后的最新报告", created_at: "2026-10-19T00:01:00Z", linked_attempt_id: "attempt-new" },
    ] : []),
  ];
  api.getSession.mockImplementation(async () => ({ native: { session_id: "shared", last_attempt_id: latest } }));
  api.getMessages.mockImplementation(async () => ({ native: messages() }));
  api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) => ({ native: {
    session_id: sessionId, attempt_id: attemptId, status: "completed", summary: attemptId === "attempt-new" ? "更新年报后的最新报告" : "旧报告",
    completed_at: "2026-10-19T00:01:00Z",
  } }));
  const common = { enabled: true, modelAvailable: true, onOpenChange: vi.fn(), onOpenModel: vi.fn(), onChanged: vi.fn() };
  const target = { symbol: null, mode: "swing" as const, resume: { sessionId: "shared" } };
  const view = render(<StockVibeResearchDialog {...common} target={target} open />);
  await screen.findByText("旧报告");
  fireEvent.change(screen.getByRole("textbox", { name: "追问" }), { target: { value: "保留尚未发出的追问" } });
  fireEvent.change(screen.getByLabelText("附件"), { target: { files: [new File(["report"], "补充资料.pdf")] } });
  view.rerender(<StockVibeResearchDialog {...common} target={target} open={false} />);
  latest = "attempt-new";
  view.rerender(<StockVibeResearchDialog {...common} target={{ ...target }} open />);
  await waitFor(() => expect(screen.getByRole("article", { name: "本次研究报告" })).toHaveTextContent("更新年报后的最新报告"));
  expect(screen.getByRole("textbox", { name: "追问" })).toHaveValue("保留尚未发出的追问");
  expect(screen.getByText("补充资料.pdf · 将随消息上传")).toBeInTheDocument();
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it("keeps an unconfirmed send pinned to its known attempt when reopening despite another native latest record", async () => {
  const requestId = "a".repeat(32);
  const storageKey = "mona.stock-vibe.research.v1:session:shared";
  const pending = [{ requestId, kind: "send", phase: "checking", sessionId: "shared" }];
  localStorage.setItem(storageKey, JSON.stringify({ sessionId: "shared", attemptId: "known-attempt", draft: "尚未确认的追问", attachments: [], pending }));
  let latest = "known-attempt";
  api.getRequest.mockResolvedValue({ request_id: requestId, status: "unknown" });
  api.getSession.mockImplementation(async () => ({ native: { session_id: "shared", last_attempt_id: latest } }));
  api.getMessages.mockResolvedValue({ native: [
    { message_id: "known-question", role: "user", content: "原问题", created_at: "2026-10-18T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "swing" } } },
    { message_id: "known-answer", role: "assistant", content: "已确认的报告", created_at: "2026-10-18T00:01:00Z", linked_attempt_id: "known-attempt" },
  ] });
  api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) => ({ native: { session_id: sessionId, attempt_id: attemptId, status: "completed", summary: "已确认的报告" } }));
  const common = { enabled: true, modelAvailable: true, onOpenChange: vi.fn(), onOpenModel: vi.fn(), onChanged: vi.fn() };
  const target = { symbol: null, mode: "swing" as const, resume: { sessionId: "shared" } };
  const view = render(<StockVibeResearchDialog {...common} target={target} open />);
  await screen.findByRole("article", { name: "本次研究报告" });
  view.rerender(<StockVibeResearchDialog {...common} target={target} open={false} />);
  latest = "external-latest";
  const reads = api.getSession.mock.calls.length;
  view.rerender(<StockVibeResearchDialog {...common} target={{ ...target }} open />);
  await waitFor(() => expect(api.getSession.mock.calls.length).toBeGreaterThan(reads));
  expect(await screen.findByRole("article", { name: "本次研究报告" })).toHaveTextContent("已确认的报告");
  expect(screen.getByRole("textbox", { name: "追问" })).toHaveValue("尚未确认的追问");
  expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  expect(screen.queryByText("已打开这项研究的最新记录，可继续追问。")).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ attemptId: "known-attempt", pending });
  expect(api.getAttempt).not.toHaveBeenCalledWith("shared", "external-latest");
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it("reopens an exact saved report without substituting a newer session report", async () => {
  api.getSession.mockResolvedValue({ native: { session_id: "shared", last_attempt_id: "new-attempt" } });
  api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) => ({ native: { session_id: sessionId, attempt_id: attemptId, status: "completed", summary: attemptId === "saved-attempt" ? "选择的旧报告" : "其他新报告" } }));
  const common = { enabled: true, modelAvailable: true, onOpenChange: vi.fn(), onOpenModel: vi.fn(), onChanged: vi.fn() };
  const target = { symbol: "002460.SZ", mode: "swing" as const, saved: { sessionId: "shared", attemptId: "saved-attempt" } };
  const view = render(<StockVibeResearchDialog {...common} target={target} open />);
  await screen.findByText("选择的旧报告");
  view.rerender(<StockVibeResearchDialog {...common} target={target} open={false} />);
  view.rerender(<StockVibeResearchDialog {...common} target={{ ...target }} open />);
  await screen.findByText("选择的旧报告");
  expect(screen.queryByText("其他新报告")).not.toBeInTheDocument();
  expect(api.getSession).not.toHaveBeenCalled();
  expect(api.getAttempt).not.toHaveBeenCalledWith("shared", "new-attempt");
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it("creates a strategy conversation without forcing a stock workbench context", async () => {
  api.createSession.mockRejectedValue(new Error("receipt lost"));
  const common = { enabled: true, modelAvailable: true, onOpenChange: vi.fn(), onOpenModel: vi.fn(), onChanged: vi.fn() };
  render(<StockVibeResearchDialog {...common} target={{ symbol: null, mode: "ultrashort", strategyCreation: true, strategyDraftId: "new-strategy-draft" }} open />);
  fireEvent.change(screen.getByRole("textbox", { name: "研究问题" }), { target: { value: "用动量和低波动组合生成一套日线策略" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());
  expect(api.createSession.mock.calls[0][1]).toEqual({ title: "创建策略", strategy_creation: true });
  expect(api.sendMessage).not.toHaveBeenCalled();
});

it("opens only a genuinely registered strategy artifact from the shared conversation", async () => {
  const artifact = { strategy_id: "sdm:new-strategy", version: "a".repeat(64), name: "动量与低波动" };
  api.getSession.mockResolvedValue({ native: { session_id: "strategy-session", last_attempt_id: "strategy-attempt" } });
  api.getMessages.mockResolvedValue({ native: [{ message_id: "answer", role: "assistant", content: "已保存生成结果", created_at: "2026-10-21T10:00:00Z", linked_attempt_id: "strategy-attempt", metadata: { strategy_artifacts: [artifact] } }] });
  api.getAttempt.mockResolvedValue({ native: { session_id: "strategy-session", attempt_id: "strategy-attempt", status: "completed", summary: "已保存生成结果" } });
  const onRegistered = vi.fn(), onOpen = vi.fn();
  render(<StockVibeResearchDialog enabled modelAvailable open onOpenChange={vi.fn()} onOpenModel={vi.fn()} onChanged={vi.fn()} onStrategyRegistered={onRegistered} onOpenStrategy={onOpen}
    target={{ symbol: null, mode: "swing", strategyCreation: true, resume: { sessionId: "strategy-session" } }} />);
  expect(await screen.findByText(artifact.name)).toBeInTheDocument();
  expect(onRegistered).toHaveBeenCalledWith(artifact.strategy_id);
  fireEvent.click(screen.getByRole("button", { name: "查看策略" })); expect(onOpen).toHaveBeenCalledWith(artifact.strategy_id);
  expect(api.createSession).not.toHaveBeenCalled(); expect(api.sendMessage).not.toHaveBeenCalled();
});
