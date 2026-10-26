import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  cancelSession: vi.fn(),
  uploadFile: vi.fn(),
  getSession: vi.fn(),
  getMessages: vi.fn(),
  getRequest: vi.fn(),
  getAttempt: vi.fn(),
  getEventStream: vi.fn(),
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  createStockVibeSession: api.createSession,
  sendStockVibeMessage: api.sendMessage,
  cancelStockVibeSession: api.cancelSession,
  uploadStockVibeFile: api.uploadFile,
  getStockVibeSession: api.getSession,
  getStockVibeMessages: api.getMessages,
  getStockVibeRequest: api.getRequest,
  getStockVibeAttempt: api.getAttempt,
  getStockVibeEventStreamUrl: api.getEventStream,
  StockVibeApiError: class StockVibeApiError extends Error {
    constructor(readonly status: number, readonly code: string) {
      super(code);
    }
  },
}));

import { StockVibeResearch } from "./StockVibeResearch";
import { StockVibeApiError, type StockVibeWorkbenchContext } from "@/lib/stock-vibe-api";

const STORAGE_KEY = "mona.stock-vibe.research.v1:600000.SH";
const RECEIPT_HASH = "a".repeat(64);

function requestRecord(requestId: string, body: unknown, statusCode = 200) {
  return {
    request_id: requestId.replace(/-/g, "").toLowerCase(),
    method: "POST",
    path: "/sessions",
    payload_sha256: RECEIPT_HASH,
    status: "completed",
    error_category: null,
    source: null,
    source_sha256: null,
    receipt: { status_code: statusCode, body },
    receipt_sha256: RECEIPT_HASH,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
  };
}

function notDispatched(requestId: string) {
  return {
    ...requestRecord(requestId, null),
    status: "rejected",
    error_category: "not_dispatched",
    source: null,
    source_sha256: null,
    receipt: null,
    receipt_sha256: null,
  };
}

function attempt(sessionId: string, attemptId: string, status: "waiting_user" | "completed", valid?: boolean) {
  return {
    native: {
      session_id: sessionId,
      attempt_id: attemptId,
      status,
      summary: status === "completed" ? "原生完成报告" : null,
      error: null,
      created_at: "2026-10-16T00:00:00Z",
      completed_at: status === "completed" ? "2026-10-16T00:01:00Z" : null,
      grounding_validation: valid === undefined ? null : { valid },
    },
    source: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.getSession.mockImplementation(async (sessionId: string) => ({
    native: { session_id: sessionId, last_attempt_id: null },
    source: null,
  }));
  api.getMessages.mockResolvedValue({ native: [], source: null });
  api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) =>
    attempt(sessionId, attemptId, "completed", false));
  api.getRequest.mockImplementation(async (requestId: string) => ({
    request_id: requestId.replace(/-/g, "").toLowerCase(),
    status: "unknown",
    error_category: "receipt_unconfirmed",
    source: null,
    receipt: null,
    receipt_sha256: null,
  }));
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("StockVibeResearch request recovery", () => {
  it("binds a candidate follow-up to its exact native source without reusing unrelated stock research", async () => {
    const context: StockVibeWorkbenchContext = { symbol: "600000.SH", task: "comprehensive", mode: "swing" };
    const origin = { swarm_id: "swarm-source", task_id: "task-screener", symbol: "600000.SH" };
    localStorage.setItem(`${STORAGE_KEY}:task:comprehensive`, JSON.stringify({ sessionId: "unrelated-session", attemptId: null, pending: [], attachments: [] }));
    api.createSession.mockImplementation(async (requestId: string) => requestRecord(requestId, { session_id: "native-followup" }, 201));
    api.sendMessage.mockImplementation(async (_session: string, requestId: string) => ({ ...requestRecord(requestId, { message_id: "question", attempt_id: "attempt-a" }), path: "/sessions/native-followup/messages" }));
    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled context={context} nativeResearch={origin} initialQuestion="核对这次入选依据" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.createSession.mock.calls[0][1]).toEqual({ title: "600000.SH · 综合分析 · 波段", workbench: context, native_research: origin });
    expect(api.sendMessage.mock.calls[0][0]).toBe("native-followup");
    expect(api.getSession).not.toHaveBeenCalledWith("unrelated-session");
    expect(JSON.parse(localStorage.getItem(`${STORAGE_KEY}:task:comprehensive`) ?? "{}").sessionId).toBe("unrelated-session");
  });

  it("binds review questions to one native operation without adding a trading horizon", async () => {
    const journalId = "b".repeat(32);
    api.getSession.mockResolvedValue({ native: { session_id: "review-session", journal_operation_id: journalId, last_attempt_id: null }, source: null });
    api.createSession.mockImplementation(async (requestId: string) => requestRecord(requestId, { session_id: "review-session" }, 201));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => requestRecord(requestId, { message_id: "review-message", attempt_id: "review-attempt" }));
    render(<StockVibeResearch symbol={null} mode="swing" journalOperationId={journalId} enabled title="成交复盘" initialQuestion="为什么有些交易没配对？" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.createSession.mock.calls[0][1]).toEqual({ title: "成交复盘", journal_operation_id: journalId });
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "为什么有些交易没配对？" });
    expect(localStorage.getItem(`mona.stock-vibe.research.v1:journal:${journalId}`)).toBeTruthy();
  });

  it("blocks follow-up when a restored session belongs to another trade review", async () => {
    api.getSession.mockResolvedValue({ native: { session_id: "other-review", journal_operation_id: "c".repeat(32), last_attempt_id: null }, source: null });
    render(<StockVibeResearch symbol={null} mode="swing" journalOperationId={"b".repeat(32)} enabled resumeSession={{ sessionId: "other-review" }} />);
    await screen.findByText(/读取的研究记录与原会话不一致/);
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("uploads a selected document before sending the original question with its attachment", async () => {
    const filePath = `uploads/${"d".repeat(32)}.pdf`;
    api.uploadFile.mockImplementation(async (requestId: string) => requestRecord(requestId, { file_path: filePath }, 201));
    api.createSession.mockImplementation(async (requestId: string) => requestRecord(requestId, { session_id: "with-file" }, 201));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => requestRecord(requestId, { message_id: "message-file", attempt_id: "attempt-file" }));
    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled initialQuestion="请解释这份财报的现金流" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("附件"), { target: { files: [new File(["financial report"], "财报.pdf", { type: "application/pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.uploadFile).toHaveBeenCalledOnce();
    expect(api.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(api.sendMessage.mock.invocationCallOrder[0]);
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "请解释这份财报的现金流", research: { symbol: "600000.SH", mode: "swing" }, attachments: [{ file_path: filePath, filename: "财报.pdf" }] });
  });

  it("does not send the question when attachment upload is unconfirmed", async () => {
    api.uploadFile.mockRejectedValue(new StockVibeApiError(0, "network_error"));
    render(<StockVibeResearch symbol={null} mode="swing" enabled initialQuestion="分析附件" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("附件"), { target: { files: [new File(["text"], "资料.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("alertdialog");
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("textbox", { name: "研究问题" })).toHaveValue("分析附件");
  });

  it("continues using the original document on follow-up without uploading it again", async () => {
    const file = { file_path: `uploads/${"e".repeat(32)}.txt`, filename: "原始资料.txt" };
    api.getSession.mockResolvedValue({ native: { session_id: "documents", last_attempt_id: "previous" }, source: null });
    api.getMessages.mockResolvedValue({ native: [{ message_id: "previous-question", role: "user", content: "解释附件", created_at: "2026-10-16T00:00:00Z", metadata: { research: { symbol: null, mode: "swing" }, attachments: [file] } }], source: null });
    api.sendMessage.mockImplementation(async (_session: string, requestId: string) => requestRecord(requestId, { message_id: "next", attempt_id: "next" }));
    render(<StockVibeResearch symbol={null} mode="swing" enabled resumeSession={{ sessionId: "documents" }} />);
    await screen.findByText("原始资料.txt · 本次追问沿用");
    const question = screen.getByRole("textbox", { name: "追问" });
    await waitFor(() => expect(question).toBeEnabled());
    fireEvent.change(question, { target: { value: "请重新核对原资料" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage.mock.calls[0][2].attachments).toEqual([file]);
    expect(api.uploadFile).not.toHaveBeenCalled();
  });

  it("opens the workbench task with a fixed stock and period instead of a duplicate research home", async () => {
    api.createSession.mockImplementation(async (requestId: string) => requestRecord(requestId, { session_id: "chosen-stock" }, 201));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => requestRecord(requestId, { message_id: "message", attempt_id: "chosen-attempt" }));
    render(<StockVibeResearch symbol="002460.SZ" mode="swing" enabled context={{ symbol: "002460.SZ", task: "fundamental", mode: "swing" }} initialQuestion="盈利有现金流支持吗？" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(screen.queryByRole("textbox", { name: "研究对象" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "综合分析" })).not.toBeInTheDocument();
    expect(screen.getByText("002460 · 波段")).toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.createSession.mock.calls[0][1].workbench).toEqual({ symbol: "002460.SZ", task: "fundamental", mode: "swing" });
    expect(api.sendMessage.mock.calls[0][2].research.symbol).toBe("002460.SZ");
  });

  it("restores a report's own stock and period when continuing another stock's history", async () => {
    api.getSession.mockResolvedValue({ native: { session_id: "historic", last_attempt_id: "historic-attempt", config: { mona_workbench: { symbol: "002460.SZ", mode: "medium", task: "risk" } } }, source: null });
    api.getMessages.mockResolvedValue({ native: [{ message_id: "historic-message", role: "user", content: "核对风险", created_at: "2026-10-16T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "medium" } } }], source: null });
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => requestRecord(requestId, { message_id: "next", attempt_id: "next-attempt" }));
    render(<StockVibeResearch symbol="600000.SH" mode="ultrashort" enabled resumeSession={{ sessionId: "historic" }} />);
    const question = await screen.findByRole("textbox", { name: "追问" });
    await waitFor(() => expect(question).toBeEnabled());
    await screen.findByText("002460 · 中短线");
    fireEvent.change(question, { target: { value: "请核实公告" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage.mock.calls[0][0]).toBe("historic");
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "请核实公告", research: { symbol: "002460.SZ", mode: "medium" } });
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("shows a completed report once and keeps legacy runtime instructions out of the user's question", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: "old", attemptId: "old-attempt", attachments: [], pending: [] }));
    api.getSession.mockResolvedValue({ native: { session_id: "old", last_attempt_id: "old-attempt" }, source: null });
    api.getMessages.mockResolvedValue({ native: [
      { message_id: "question", role: "user", content: "标的：600000.SH\n\n账户资料不足时请说明限制，不要生成个性化仓位数字。\n\n用户问题：利润增长来自哪里？", created_at: "2026-10-16T00:00:00Z" },
      { message_id: "answer", role: "assistant", content: "原生完成报告", linked_attempt_id: "old-attempt", created_at: "2026-10-16T00:01:00Z" },
    ], source: null });
    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled />);
    await screen.findByRole("article", { name: "本次研究报告" });
    expect(screen.getAllByText("原生完成报告")).toHaveLength(1);
    expect(screen.getByText("利润增长来自哪里？")).toBeInTheDocument();
    expect(screen.queryByText(/账户资料不足/)).not.toBeInTheDocument();
  });

  it("uses actual tool events for progress and ignores another attempt's events", async () => {
    const listeners = new Map<string, (event: { data: string }) => void>();
    const close = vi.fn();
    vi.stubGlobal("EventSource", class {
      addEventListener(type: string, listener: (event: { data: string }) => void) { listeners.set(type, listener); }
      close = close;
    });
    api.getEventStream.mockResolvedValue("http://127.0.0.1:17174/api/stock-vibe/events/test-ticket");
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: "live", attemptId: "live-attempt", attachments: [], pending: [] }));
    api.getSession.mockResolvedValue({ native: { session_id: "live", last_attempt_id: "live-attempt" }, source: null });
    api.getAttempt.mockResolvedValue({ native: { ...attempt("live", "live-attempt", "completed").native, status: "running" }, source: null });
    const view = render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled />);
    await waitFor(() => expect(listeners.has("tool_call")).toBe(true));
    act(() => listeners.get("tool_call")!({ data: JSON.stringify({ attempt_id: "other", tool: "get_market_data" }) }));
    expect(screen.queryByText("正在读取行情")).not.toBeInTheDocument();
    act(() => listeners.get("tool_call")!({ data: JSON.stringify({ attempt_id: "live-attempt", tool: "get_market_data" }) }));
    expect(screen.getByText("正在读取行情")).toBeInTheDocument();
    act(() => listeners.get("tool_result")!({ data: JSON.stringify({ attempt_id: "live-attempt", tool: "get_market_data", status: "ok" }) }));
    expect(screen.getByText("读取行情已完成，继续分析中")).toBeInTheDocument();
    view.unmount();
    expect(close).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["comprehensive", "综合分析"],
    ["fundamental", "财报与估值"],
    ["technical", "走势分析"],
    ["risk", "风险检查"],
  ] as const)("keeps %s research isolated and creates its workbench metadata", async (task, label) => {
    const context: StockVibeWorkbenchContext = { symbol: "600000.SH", task, mode: "swing" };
    const previous = { sessionId: "other-session", attemptId: null, pending: [], attachments: [] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(previous));
    for (const other of ["comprehensive", "fundamental", "technical", "risk"]) {
      if (other !== task) localStorage.setItem(`${STORAGE_KEY}:task:${other}`, JSON.stringify(previous));
    }
    api.createSession.mockImplementation(async (requestId: string) =>
      requestRecord(requestId, { session_id: `session-${task}` }, 201));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) =>
      requestRecord(requestId, { message_id: "message-a", attempt_id: "attempt-a" }));

    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled context={context} initialQuestion="核对研究依据" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(api.getSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.createSession.mock.calls[0][1]).toEqual({ title: `600000.SH · ${label} · 波段`, workbench: context });
    expect(api.sendMessage.mock.calls[0][0]).toBe(`session-${task}`);
    expect(JSON.parse(localStorage.getItem(`${STORAGE_KEY}:task:${task}`) ?? "{}").sessionId).toBe(`session-${task}`);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").sessionId).toBe("other-session");
  });

  it("keeps the selected historical attempt instead of substituting the session latest report", async () => {
    const resumeKey = "mona.stock-vibe.research.v1:session:session-original";
    localStorage.setItem(resumeKey, JSON.stringify({
      sessionId: "session-original", attemptId: "attempt-old", pending: [], attachments: [],
    }));
    api.getSession.mockResolvedValue({
      native: { session_id: "session-original", last_attempt_id: "attempt-latest" }, source: null,
    });
    api.getMessages.mockResolvedValue({ native: [
      { message_id: "original-message", role: "user", content: "原会话问题", created_at: "2026-10-16T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "medium" } }, linked_attempt_id: null },
      { message_id: "old-answer", role: "assistant", content: "原先报告", created_at: "2026-10-16T00:01:00Z", linked_attempt_id: "attempt-old" },
      { message_id: "later-message", role: "user", content: "另一次研究", created_at: "2026-10-17T00:00:00Z", metadata: { research: { symbol: "600519.SH", mode: "ultrashort" } }, linked_attempt_id: null },
      { message_id: "later-answer", role: "assistant", content: "之后报告", created_at: "2026-10-17T00:01:00Z", linked_attempt_id: "attempt-latest" },
    ], source: null });
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) =>
      requestRecord(requestId, { message_id: "followup-message", attempt_id: "attempt-followup" }));

    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled
      resumeSession={{ sessionId: "session-original", attemptId: "attempt-old" }} />);
    await screen.findByText("原会话问题");
    await waitFor(() => expect(api.getAttempt).toHaveBeenCalledWith("session-original", "attempt-old"));
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(await screen.findByText("002460 · 中短线")).toBeInTheDocument();
    const question = screen.getByRole("textbox", { name: "追问" });
    await waitFor(() => expect(question).toBeEnabled());
    fireEvent.change(question, { target: { value: "请解释报告里的依据" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage.mock.calls[0][0]).toBe("session-original");
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "请解释报告里的依据", research: { symbol: "002460.SZ", mode: "medium" } });
    expect(api.createSession).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(resumeKey) ?? "{}").attemptId).toBe("attempt-followup");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("continues the same research from its latest attempt and actual latest scope without replaying", async () => {
    localStorage.setItem("mona.stock-vibe.research.v1:session:shared", JSON.stringify({ sessionId: "shared", attemptId: "old-attempt", pending: [], attachments: [], scope: { symbol: "002460.SZ", mode: "medium" } }));
    api.getSession.mockResolvedValue({ native: { session_id: "shared", last_attempt_id: "latest-attempt" }, source: null });
    api.getMessages.mockResolvedValue({ native: [
      { message_id: "old-question", role: "user", content: "旧问题", created_at: "2026-10-16T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "medium" } }, linked_attempt_id: null },
      { message_id: "old-answer", role: "assistant", content: "旧报告", created_at: "2026-10-16T00:01:00Z", linked_attempt_id: "old-attempt" },
      { message_id: "latest-question", role: "user", content: "后来补充的问题", created_at: "2026-10-17T00:00:00Z", metadata: { research: { symbol: "600519.SH", mode: "ultrashort" } }, linked_attempt_id: null },
      { message_id: "latest-answer", role: "assistant", content: "最新报告", created_at: "2026-10-17T00:01:00Z", linked_attempt_id: "latest-attempt" },
    ], source: null });
    api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) => ({ native: { ...attempt(sessionId, attemptId, "completed").native, summary: attemptId === "latest-attempt" ? "最新报告" : "旧报告" }, source: null }));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => requestRecord(requestId, { message_id: "followup", attempt_id: "followup-attempt" }));
    render(<StockVibeResearch symbol="000001.SZ" mode="swing" enabled resumeSession={{ sessionId: "shared" }} />);
    await screen.findByText("已打开这项研究的最新记录，可继续追问。");
    await waitFor(() => expect(api.getAttempt).toHaveBeenCalledWith("shared", "latest-attempt"));
    expect(api.getAttempt).not.toHaveBeenCalledWith("shared", "old-attempt");
    expect(await screen.findByText("600519 · 超短线")).toBeInTheDocument();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "追问" }), { target: { value: "继续解释最新依据" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage.mock.calls[0][0]).toBe("shared");
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "继续解释最新依据", research: { symbol: "600519.SH", mode: "ultrashort" } });
  });

  it("does not invent the current stock or period for a legacy report without recorded context", async () => {
    api.getSession.mockResolvedValue({ native: { session_id: "legacy", last_attempt_id: "legacy-attempt" }, source: null });
    api.getMessages.mockResolvedValue({ native: [
      { message_id: "earlier-question", role: "user", content: "更早的另一项问题", created_at: "2026-10-15T00:00:00Z", metadata: { research: { symbol: "002460.SZ", mode: "medium" } }, linked_attempt_id: null },
      { message_id: "earlier-answer", role: "assistant", content: "更早的报告", created_at: "2026-10-15T00:01:00Z", linked_attempt_id: "earlier-attempt" },
      { message_id: "legacy-question", role: "user", content: "旧研究", created_at: "2026-10-16T00:00:00Z", linked_attempt_id: null },
      { message_id: "legacy-answer", role: "assistant", content: "旧结论", created_at: "2026-10-16T00:01:00Z", linked_attempt_id: "legacy-attempt" },
    ], source: null });
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => requestRecord(requestId, { message_id: "followup", attempt_id: "followup-attempt" }));
    render(<StockVibeResearch symbol="600519.SH" mode="ultrashort" enabled resumeSession={{ sessionId: "legacy", attemptId: "legacy-attempt" }} />);
    await screen.findByText("原研究范围 · 原记录未保存研究周期");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "追问" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "追问" }), { target: { value: "解释原报告" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "解释原报告" });
  });

  it("blocks writes when a resumed session response has another identity", async () => {
    api.getSession.mockResolvedValue({
      native: { session_id: "session-other", last_attempt_id: "attempt-other" }, source: null,
    });
    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled initialQuestion="请继续"
      resumeSession={{ sessionId: "session-original", attemptId: "attempt-original" }} />);

    await screen.findByText("读取的研究记录与原会话不一致，已停止追问。请从研究记录重新进入。");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(api.getAttempt).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("validates resume identifiers before reading or dispatching", async () => {
    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled
      resumeSession={{ sessionId: "../invalid", attemptId: "attempt-original" }} />);
    await screen.findByText("研究记录标识无效，无法打开原会话。请从研究记录重新进入。");
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(api.getSession).not.toHaveBeenCalled();
    expect(api.getAttempt).not.toHaveBeenCalled();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("creates a session and sends the same user intent after a normalized receipt", async () => {
    api.createSession.mockImplementation(async (requestId: string) =>
      requestRecord(requestId, { session_id: "session-a" }, 201));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string, input: { content: string }) =>
      requestRecord(requestId, { message_id: "message-a", attempt_id: "attempt-a", content: input.content }));
    api.getAttempt.mockResolvedValue(attempt("session-a", "attempt-a", "completed", false));

    render(<StockVibeResearch symbol={null} mode="swing" enabled initialQuestion="核对公开证据" />);
    const question = await screen.findByRole("textbox", { name: "研究问题" });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    await screen.findByText("原生完成报告");
    const createId = api.createSession.mock.calls[0][0] as string;
    const sendId = api.sendMessage.mock.calls[0][1] as string;
    expect(createId).toMatch(/^[a-f0-9]{32}$/);
    expect(sendId).toMatch(/^[a-f0-9]{32}$/);
    expect(sendId).not.toBe(createId);
    expect(localStorage.getItem("mona.stock-vibe.research.v1:universe")).toContain("session-a");
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ content: "核对公开证据", research: { symbol: null, mode: "swing" } });
    expect(screen.getByText("数字与证据核对未通过。")).toBeInTheDocument();
    expect(question).toHaveValue("");
  });

  it("only queries an unknown create request and does not auto-send its old question", async () => {
    const dashedId = "00112233-4455-6677-8899-aabbccddeeff";
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: null,
      attemptId: null,
      attachments: [],
      pending: [{ requestId: dashedId, kind: "create", phase: "checking" }],
    }));
    api.getRequest
      .mockResolvedValueOnce({
        request_id: dashedId.replace(/-/g, ""),
        status: "unknown",
        error_category: "receipt_unconfirmed",
        source: null,
        receipt: null,
        receipt_sha256: null,
      })
      .mockResolvedValueOnce(requestRecord(dashedId, { session_id: "session-recovered" }, 201));

    vi.useFakeTimers();
    render(<StockVibeResearch symbol="600000.SH" mode="ultrashort" enabled initialQuestion="旧问题" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getRequest).toHaveBeenCalledOnce();
    expect(api.sendMessage).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getRequest).toHaveBeenCalledTimes(2);
    expect(api.getRequest).toHaveBeenCalledWith(dashedId);
    expect(screen.getByText("会话已就绪。问题尚未提交，请再次点击发送继续。")).toBeInTheDocument();
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("unlocks only a user-initiated retry after not_dispatched while waiting_user accepts a follow-up", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: "session-waiting",
      attemptId: "attempt-waiting",
      attachments: [],
      pending: [],
    }));
    api.getSession.mockResolvedValue({
      native: { session_id: "session-waiting", last_attempt_id: "attempt-waiting" },
      source: null,
    });
    api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) =>
      attempt(sessionId, attemptId, attemptId === "attempt-waiting" ? "waiting_user" : "completed"));
    api.sendMessage
      .mockImplementationOnce(async (_sessionId: string, requestId: string) => notDispatched(requestId))
      .mockImplementationOnce(async (_sessionId: string, requestId: string) =>
        requestRecord(requestId, { message_id: "message-next", attempt_id: "attempt-next" }));

    render(<StockVibeResearch symbol="600000.SH" mode="medium" enabled />);
    const question = await screen.findByRole("textbox", { name: "追问" });
    await waitFor(() => expect(question).toBeEnabled());
    fireEvent.change(question, { target: { value: "补充核对" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("这次请求已确认未发出。检查内容后，可由你手动重新提交。");
    expect(api.sendMessage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    const ids = api.sendMessage.mock.calls.map((call) => call[1] as string);
    expect(ids[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[1]).toMatch(/^[a-f0-9]{32}$/);
    expect(ids[1]).not.toBe(ids[0]);
    expect(api.sendMessage.mock.calls[1][2]).toEqual({ content: "补充核对", research: { symbol: "600000.SH", mode: "medium" } });
  });

  it("keeps an unknown send receipt locked across closing and reopening details without dispatching twice", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: "waiting", attemptId: "waiting-attempt", attachments: [], pending: [] }));
    api.getSession.mockResolvedValue({ native: { session_id: "waiting", last_attempt_id: "waiting-attempt" }, source: null });
    api.getAttempt.mockResolvedValue(attempt("waiting", "waiting-attempt", "waiting_user"));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) => ({ request_id: requestId, status: "unknown" }));
    const { rerender } = render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "追问" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "追问" }), { target: { value: "继续核对" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.getRequest).toHaveBeenCalledOnce());
    const pending = JSON.parse(localStorage.getItem(STORAGE_KEY)!).pending;
    rerender(<StockVibeResearch symbol="600000.SH" mode="swing" enabled open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<StockVibeResearch symbol="600000.SH" mode="swing" enabled open />);
    expect(screen.getByRole("textbox", { name: "追问" })).toHaveValue("继续核对");
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).pending).toEqual(pending);
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.createSession).not.toHaveBeenCalled();
  });

  it("checks a send receipt after a transport failure without repeating the write", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: "session-waiting",
      attemptId: "attempt-waiting",
      attachments: [],
      pending: [],
    }));
    api.getSession.mockResolvedValue({
      native: { session_id: "session-waiting", last_attempt_id: "attempt-waiting" },
      source: null,
    });
    api.getAttempt.mockImplementation(async (sessionId: string, attemptId: string) =>
      attempt(sessionId, attemptId, attemptId === "attempt-waiting" ? "waiting_user" : "completed"));
    api.sendMessage.mockRejectedValueOnce(new StockVibeApiError(0, "network_error"));

    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled />);
    const question = await screen.findByRole("textbox", { name: "追问" });
    await waitFor(() => expect(question).toBeEnabled());
    fireEvent.change(question, { target: { value: "补充核对" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText("network_error");
    await waitFor(() => expect(api.getRequest).toHaveBeenCalledOnce());
    const requestId = api.sendMessage.mock.calls[0][1] as string;
    expect(api.getRequest).toHaveBeenCalledWith(requestId);
    expect(question).toHaveValue("补充核对");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").pending).toMatchObject([
      { requestId, kind: "send", phase: "checking" },
    ]);
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("StockVibeResearch 追问直达", () => {
  it("追问带入的问题直接派发，不需要在弹窗里再点一次发送", async () => {
    api.createSession.mockImplementation(async (requestId: string) =>
      requestRecord(requestId, { session_id: "s".repeat(24) }));
    api.sendMessage.mockImplementation(async (_sessionId: string, requestId: string) =>
      requestRecord(requestId, { attempt_id: "c".repeat(24) }));

    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled initialQuestion="这波放量能撑住吗？" autoSend />);

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage).toHaveBeenCalledWith(expect.any(String), expect.any(String),
      expect.objectContaining({ content: "这波放量能撑住吗？" }));
    // 问题已被受理，草稿随之清空：用户不必在弹窗里重打一遍再点发送。
    await waitFor(() => expect(screen.getByRole("textbox", { name: "追问" })).toHaveValue(""));
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("已存在会话时追问仍保留本次问题，不被空草稿覆盖", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: "session-existing", attemptId: null, attachments: [], pending: [], draft: "",
    }));
    api.getSession.mockResolvedValue({
      native: { session_id: "session-existing", last_attempt_id: null }, source: null,
    });
    api.sendMessage.mockRejectedValueOnce(new StockVibeApiError(0, "network_error"));

    render(<StockVibeResearch symbol="600000.SH" mode="swing" enabled initialQuestion="毛利率为什么回落？" autoSend />);

    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledOnce());
    expect(api.sendMessage.mock.calls[0][2]).toMatchObject({ content: "毛利率为什么回落？" });
    expect(api.sendMessage.mock.calls[0][0]).toBe("session-existing");
  });
});
