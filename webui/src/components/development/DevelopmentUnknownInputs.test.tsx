import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DevInput, DevSnapshot } from "@/lib/development-api";
import { DevelopmentUnknownInputs } from "./DevelopmentUnknownInputs";
import { useDevelopmentStore } from "./store";

const api = vi.hoisted(() => ({ closeUnknownInput: vi.fn(), send: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/development-api", () => ({ developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: api.refresh }));
const input: DevInput = { id: "unknown_guide", messageId: "message_guide", runId: "run_original",
  state: "unknown", intent: "steering", revision: 3, canCloseUnknown: true, source: { content: "保留这条补充说明" } };
beforeEach(() => {
  vi.clearAllMocks(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  useDevelopmentStore.getState().setSnapshot("dev_original", { session: { id: "dev_original", revision: 0 },
    messages: [], runs: [], events: [], pendingInputs: [input], eventCursor: 0, messageCount: 0, before: null } as unknown as DevSnapshot);
  useDevelopmentStore.getState().setDraft("dev_original", "新草稿");
  api.closeUnknownInput.mockResolvedValue({ ...input, state: "closed_unknown", revision: 4 });
});
afterEach(cleanup);

it("requires explicit verification and closes only the original guide without sending or clearing the draft", async () => {
  render(<DevelopmentUnknownInputs sessionId="dev_original" inputs={[input]} />);
  fireEvent.click(screen.getByRole("button", { name: "结束这条消息的等待" }));
  expect(screen.getByRole("button", { name: "确认结束等待" })).toBeDisabled();
  expect(api.closeUnknownInput).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认结束等待" }));
  await waitFor(() => expect(api.closeUnknownInput).toHaveBeenCalledWith("dev_original", input.id, input.revision));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(useDevelopmentStore.getState().snapshots.dev_original.pendingInputs).toEqual([]);
  expect(useDevelopmentStore.getState().drafts.dev_original).toBe("新草稿");
  expect(api.send).not.toHaveBeenCalled();
});

it("retains the unknown input after failure and permits retrying the same identity", async () => {
  api.closeUnknownInput.mockRejectedValueOnce(new Error("fixture failure"));
  render(<DevelopmentUnknownInputs sessionId="dev_original" inputs={[input]} />);
  fireEvent.click(screen.getByRole("button", { name: "结束这条消息的等待" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认结束等待" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("原消息仍保留");
  expect(useDevelopmentStore.getState().snapshots.dev_original.pendingInputs).toEqual([input]);
  fireEvent.click(screen.getByRole("button", { name: "确认结束等待" }));
  await waitFor(() => expect(api.closeUnknownInput).toHaveBeenCalledTimes(2));
  expect(api.closeUnknownInput.mock.calls[1]).toEqual(api.closeUnknownInput.mock.calls[0]);
});

it("keeps tracking visible while the original task has not finished and cancel does not resolve it", () => {
  const view = render(<DevelopmentUnknownInputs sessionId="dev_original" inputs={[{ ...input, canCloseUnknown: false }]} />);
  expect(screen.getByRole("button", { name: "结束这条消息的等待" })).toBeDisabled();
  view.rerender(<DevelopmentUnknownInputs sessionId="dev_original" inputs={[input]} />);
  fireEvent.click(screen.getByRole("button", { name: "结束这条消息的等待" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.closeUnknownInput).not.toHaveBeenCalled();
});
