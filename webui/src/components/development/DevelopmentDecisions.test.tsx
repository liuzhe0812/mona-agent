import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DevDecision } from "@/lib/development-api";

const mocks = vi.hoisted(() => ({ decide: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentApi: { decide: mocks.decide } }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: mocks.refresh }));
import { DevelopmentDecision } from "./DevelopmentDecisions";

beforeEach(() => { vi.clearAllMocks(); mocks.decide.mockResolvedValue({ ok: true }); });

it("handles a named child permission from the parent without changing its owner", async () => {
  const decision = { id: "decision_test", sessionId: "dev_child", parentSessionId: "dev_parent", taskTitle: "检查修改",
    runId: "run_child", kind: "permission", details: { command: "npm test" } } as DevDecision;
  render(<DevelopmentDecision decision={decision} />);
  expect(screen.getByText("检查修改")).toBeInTheDocument();
  const allow = screen.getByRole("button", { name: "允许一次", exact: true });
  fireEvent.click(allow);
  fireEvent.click(allow);
  await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("dev_child", "decision_test", "accept"));
  expect(mocks.refresh).toHaveBeenCalledWith("dev_parent");
  expect(mocks.refresh).toHaveBeenCalledWith("dev_child");
  expect(mocks.decide).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("button", { name: "已提交" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
});

it("keeps the child question answer after a failed submission", async () => {
  mocks.decide.mockRejectedValueOnce(new Error("暂时无法提交"));
  render(<DevelopmentDecision decision={{ id: "decision_question", sessionId: "dev_child", runId: "run_child",
    kind: "question", details: { questions: [{ id: "q1", question: "如何处理？", options: [] }] } }} />);
  const answer = screen.getByRole("textbox", { name: "如何处理？" });
  fireEvent.change(answer, { target: { value: "保留当前实现" } });
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  await screen.findByText("暂时无法提交");
  expect(answer).toHaveValue("保留当前实现");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
  await waitFor(() => expect(mocks.decide).toHaveBeenLastCalledWith("dev_child", "decision_question", { q1: ["保留当前实现"] }));
});

it("only offers similar commands for a native prefix and guards repeated keyboard approval", async () => {
  const decision: DevDecision = { id: "permission", sessionId: "dev_parent", runId: "run", kind: "permission",
    details: { command: "cargo build", similarCommandPrefix: ["cargo", "build"] } };
  const view = render(<DevelopmentDecision decision={decision} autoFocus />);
  const card = screen.getByLabelText("当前任务确认");
  expect(card).toHaveFocus();
  fireEvent.keyDown(card, { key: "Enter", repeat: true });
  expect(mocks.decide).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: "更多授权选项" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: /允许类似命令/ }));
  await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("dev_parent", "permission", "accept_similar"));
  expect(mocks.decide).toHaveBeenCalledOnce();
  view.unmount();
  render(<DevelopmentDecision decision={{ ...decision, id: "single", details: { command: "cargo build" } }} />);
  fireEvent.pointerDown(screen.getByRole("button", { name: "更多授权选项" }), { button: 0, ctrlKey: false });
  await screen.findByRole("menuitem", { name: "允许一次" });
  expect(screen.queryByRole("menuitem", { name: /允许类似命令/ })).toBeNull();
});
