import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserQuestionPanel } from "./UserQuestionPanel";
import type { UserQuestionRequest } from "@/lib/user-questions";
import i18n from "@/i18n";

const clientState = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/providers/ClientProvider", () => ({
  useClientContextOrNull: () => ({ client: clientState.client }),
}));

function request(requestId = "request-1"): UserQuestionRequest {
  return {
    request_id: requestId,
    agent_id: "agent-1",
    questions: [
      { id: "single", header: "模式", question: "选择一个模式", options: [{ label: "快速" }, { label: "仔细" }] },
      { id: "multi", question: "选择功能", multi_select: true, options: [{ label: "搜索" }, { label: "总结" }] },
      { id: "custom", question: "还有什么要求？" },
    ],
  };
}

function createClient(requestsByChat: Record<string, UserQuestionRequest[]>) {
  const handlers = new Map<string, (event: any) => void>();
  const client = {
    getUserQuestions: vi.fn((chatId: string) => requestsByChat[chatId] ?? []),
    answerUserQuestion: vi.fn(async () => {}),
    onChat: vi.fn((chatId: string, handler: (event: any) => void) => {
      handlers.set(chatId, handler);
      return () => { handlers.delete(chatId); };
    }),
  };
  return { client, handlers };
}

describe("UserQuestionPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    clientState.client = null;
    vi.restoreAllMocks();
  });

  it("submits single and multiple selections together with custom answers", async () => {
    const user = userEvent.setup();
    const { client } = createClient({ "chat-1": [request()] });
    clientState.client = client;
    render(<UserQuestionPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText("快速"));
    await user.click(screen.getByLabelText("搜索"));
    await user.click(screen.getByLabelText("总结"));
    await user.type(screen.getByLabelText("还有什么要求？：补充回答"), "请简洁");
    await user.type(screen.getByLabelText("模式：选择一个模式：补充回答"), "可补充");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(client.answerUserQuestion).toHaveBeenCalledWith("chat-1", "request-1", [
      { id: "single", selected: ["快速"], custom: "可补充" },
      { id: "multi", selected: ["搜索", "总结"] },
      { id: "custom", selected: [], custom: "请简洁" },
    ]));
  });

  it("shows per-question validation and does not choose a default option", async () => {
    const user = userEvent.setup();
    const { client } = createClient({ "chat-1": [request()] });
    clientState.client = client;
    render(<UserQuestionPanel chatId="chat-1" />);

    expect(screen.getByLabelText("快速")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(screen.getAllByRole("alert")).toHaveLength(3);
    expect(client.answerUserQuestion).not.toHaveBeenCalled();
  });

  it("clears a single choice so only the custom answer is submitted", async () => {
    const user = userEvent.setup();
    const { client } = createClient({ "chat-1": [request()] });
    clientState.client = client;
    render(<UserQuestionPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText("快速"));
    await user.click(screen.getByRole("button", { name: "清除选择" }));
    await user.type(screen.getByLabelText("模式：选择一个模式：补充回答"), "自定义模式");
    await user.click(screen.getByLabelText("搜索"));
    await user.type(screen.getByLabelText("还有什么要求？：补充回答"), "没有");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(client.answerUserQuestion).toHaveBeenCalledWith("chat-1", "request-1", [
      { id: "single", selected: [], custom: "自定义模式" },
      { id: "multi", selected: ["搜索"] },
      { id: "custom", selected: [], custom: "没有" },
    ]));
  });

  it("keeps the draft after a failed submission", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { client } = createClient({ "chat-1": [request()] });
    client.answerUserQuestion.mockRejectedValueOnce(new Error("offline"));
    clientState.client = client;
    render(<UserQuestionPanel chatId="chat-1" />);

    await user.click(screen.getByLabelText("仔细"));
    await user.click(screen.getByLabelText("搜索"));
    await user.type(screen.getByLabelText("还有什么要求？：补充回答"), "保留我");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith("回答提交失败，请重试"));
    expect(screen.getByLabelText("仔细")).toBeChecked();
    expect(screen.getByLabelText("搜索")).toBeChecked();
    expect(screen.getByLabelText("还有什么要求？：补充回答")).toHaveValue("保留我");
  });

  it("loads each chat snapshot separately and ignores another chat event", async () => {
    const chatA = request("a-request");
    const chatB = { ...request("b-request"), questions: [{ id: "b", question: "B 的问题" }] };
    const { client, handlers } = createClient({ "chat-a": [chatA], "chat-b": [chatB] });
    clientState.client = client;
    const view = render(<UserQuestionPanel chatId="chat-a" />);
    expect(await screen.findByText("选择一个模式")).toBeInTheDocument();

    handlers.get("chat-a")?.({ event: "user_questions", chat_id: "chat-b", requests: [chatB] });
    expect(screen.queryByText("B 的问题")).not.toBeInTheDocument();
    view.rerender(<UserQuestionPanel chatId="chat-b" />);

    expect(await screen.findByText("B 的问题")).toBeInTheDocument();
    expect(screen.queryByText("选择一个模式")).not.toBeInTheDocument();
  });

  it("cancels the request and leaves it visible if cancellation fails", async () => {
    const user = userEvent.setup();
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { client } = createClient({ "chat-1": [request()] });
    client.answerUserQuestion.mockRejectedValueOnce(new Error("offline"));
    clientState.client = client;
    render(<UserQuestionPanel chatId="chat-1" />);

    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(client.answerUserQuestion).toHaveBeenCalledWith("chat-1", "request-1", null));
    expect(await screen.findByText("选择一个模式")).toBeInTheDocument();
    expect(alert).toHaveBeenCalledWith("回答提交失败，请重试");
  });
});
