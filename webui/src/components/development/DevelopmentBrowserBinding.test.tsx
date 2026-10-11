import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevBrowserBinding, DevSession, DevSnapshot } from "@/lib/development-api";

const api = vi.hoisted(() => ({ bindBrowser: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/development-api", () => ({ developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: refresh }));
import { DevelopmentBrowserBinding } from "./DevelopmentBrowserBinding";
import { useDevelopmentStore } from "./store";

const session: DevSession = { id: "dev_a", projectId: "project_a", title: "Preview", executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
const reportError = vi.fn();
const binding: DevBrowserBinding = { id: "preview_a", tabId: "tab-a", origin: "http://127.0.0.1:3000" };
const snapshot: DevSnapshot = { session, messages: [], before: null, messageCount: 0, runs: [], events: [], eventCursor: 0, pendingInputs: [], live: null };
beforeEach(() => { vi.clearAllMocks(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true); useDevelopmentStore.getState().setSnapshot(session.id, snapshot); });
afterEach(cleanup);

describe("session-owned browser preview", () => {
  it("opening the panel never binds or starts work; linking is explicit and versioned", async () => {
    api.bindBrowser.mockResolvedValue({ binding });
    render(<DevelopmentBrowserBinding onError={reportError} session={session} tabId="tab-a" url="http://127.0.0.1:3000" />);
    expect(api.bindBrowser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "关联此页" }));
    await waitFor(() => expect(api.bindBrowser).toHaveBeenCalledWith(session.id, "tab-a", null));
    await waitFor(() => expect(useDevelopmentStore.getState().snapshots[session.id].browserBinding).toEqual(binding));
  });
  it("unlinking leaves the page open and clears only this conversation's binding", async () => {
    api.bindBrowser.mockResolvedValue({ binding: null });
    render(<DevelopmentBrowserBinding onError={reportError} session={session} tabId="tab-a" url="http://127.0.0.1:3000" binding={binding} />);
    fireEvent.click(screen.getByRole("button", { name: "解除关联" }));
    await waitFor(() => expect(api.bindBrowser).toHaveBeenCalledWith(session.id, null, binding.id));
  });
  it.each([{ ...session, readonly: true }, { ...session, executor: "codex" as const }])("does not expose linking to unsupported sessions", (value) => {
    render(<DevelopmentBrowserBinding onError={reportError} session={value} tabId="tab-a" url="https://test.invalid" />);
    expect(screen.queryByRole("button", { name: "关联此页" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("开发预览关联")).not.toBeInTheDocument();
  });
  it("does not link a blank page or retry an uncertain result", async () => {
    const view = render(<DevelopmentBrowserBinding onError={reportError} session={session} tabId="tab-a" url="about:blank" />);
    expect(screen.queryByRole("button", { name: "关联此页" })).not.toBeInTheDocument();
    api.bindBrowser.mockRejectedValue(new Error("关联结果待核对"));
    view.rerender(<DevelopmentBrowserBinding onError={reportError} session={session} tabId="tab-a" url="http://127.0.0.1:3000" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "关联此页" })); });
    expect(reportError).toHaveBeenLastCalledWith("关联结果待核对");
    expect(api.bindBrowser).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(session.id);
  });
});
