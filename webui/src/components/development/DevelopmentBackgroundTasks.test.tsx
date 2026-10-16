import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevBackgroundCommand, DevBackgroundCommandOutput, DevSession, DevSnapshot } from "@/lib/development-api";

const api = vi.hoisted(() => ({ commandOutput: vi.fn(), stopCommand: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("@/lib/development-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/development-api")>();
  return { ...actual, developmentApi: { ...actual.developmentApi, ...api } };
});
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: refresh }));

import { DevelopmentBackgroundTasks } from "./DevelopmentBackgroundTasks";
import { DevelopmentCommandOutput } from "./DevelopmentCommandOutput";
import { useDevelopmentStore } from "./store";

const makeCommand = (overrides: Partial<DevBackgroundCommand> = {}): DevBackgroundCommand => ({
  id: "command_one", command: "python -m http.server 8080", cwd: "D:/project", startedAt: new Date(Date.now() - 10_000).toISOString(),
  elapsedSeconds: 10, status: "running", exitCode: null, ...overrides,
});

const makeOutput = (overrides: Partial<DevBackgroundCommandOutput> = {}): DevBackgroundCommandOutput => ({
  ...makeCommand(), output: "server ready", truncated: false, ...overrides,
});

const makeSnapshot = (sessionId: string, command: DevBackgroundCommand): DevSnapshot => ({
  session: {
    id: sessionId, projectId: "project", title: "会话", executor: "mona", model: null,
    readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "",
  } satisfies DevSession,
  messages: [], messageCount: 0, before: null, runs: [], pendingInputs: [], events: [], eventCursor: 0, live: null,
  backgroundCommands: [command],
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  api.commandOutput.mockResolvedValue(makeOutput());
  api.stopCommand.mockResolvedValue(makeOutput({ status: "terminated", exitCode: null }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("development background commands", () => {
  it("shows only the count and rows for running commands", async () => {
    const running = makeCommand();
    const user = userEvent.setup();
    render(<DevelopmentBackgroundTasks sessionId="session_a" commands={[
      makeCommand({ id: "done", command: "completed command", status: "exited", exitCode: 0 }), running,
    ]} />);

    await user.click(screen.getByRole("button", { name: "运行中的终端命令：1" }));
    expect(await screen.findByText(running.command)).toBeInTheDocument();
    expect(screen.queryByText("completed command")).not.toBeInTheDocument();
    expect(screen.getByText(/运行 10秒/)).toBeInTheDocument();
  });

  it("opens the selected command in the right terminal for its session", async () => {
    const command = makeCommand({ id: "command_target" });
    const user = userEvent.setup();
    render(<DevelopmentBackgroundTasks sessionId="session_a" commands={[command]} />);
    await user.click(screen.getByRole("button", { name: "运行中的终端命令：1" }));
    await user.click(await screen.findByText(command.command, { selector: "span" }));

    expect(useDevelopmentStore.getState().sides.session_a).toMatchObject({
      tab: "terminal", terminalMode: "agent", backgroundCommandId: command.id, expanded: true,
    });
    expect(useDevelopmentStore.getState().sides.session_b).toBeUndefined();
  });

  it("stops the chosen command immediately and refreshes that session", async () => {
    const command = makeCommand({ id: "command_stop" });
    const user = userEvent.setup();
    useDevelopmentStore.getState().setSnapshot("session_a", makeSnapshot("session_a", command));
    api.stopCommand.mockResolvedValueOnce(makeOutput({ id: command.id, status: "terminated", exitCode: 143 }));
    render(<DevelopmentBackgroundTasks sessionId="session_a" commands={[command]} />);
    await user.click(screen.getByRole("button", { name: "运行中的终端命令：1" }));
    await user.click(await screen.findByRole("menuitem", { name: `停止命令：${command.command}` }));

    await waitFor(() => expect(api.stopCommand).toHaveBeenCalledWith("session_a", command.id));
    expect(refresh).toHaveBeenCalledWith("session_a");
    expect(useDevelopmentStore.getState().snapshots.session_a.backgroundCommands).toEqual([
      expect.objectContaining({ id: command.id, status: "terminated", exitCode: 143 }),
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports one stop failure without retrying it automatically", async () => {
    const command = makeCommand({ id: "command_failed" });
    const user = userEvent.setup();
    api.stopCommand.mockRejectedValueOnce(new Error("无法停止此命令"));
    const view = render(<DevelopmentBackgroundTasks sessionId="session_a" commands={[command]} />);
    await user.click(screen.getByRole("button", { name: "运行中的终端命令：1" }));
    await user.click(await screen.findByRole("menuitem", { name: `停止命令：${command.command}` }));

    expect(await screen.findByRole("dialog", { name: "停止命令失败" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("无法停止此命令");
    expect(api.stopCommand).toHaveBeenCalledTimes(1);
    view.rerender(<DevelopmentBackgroundTasks sessionId="session_a" commands={[]} />);
    expect(screen.getByRole("dialog", { name: "停止命令失败" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.stopCommand).toHaveBeenCalledTimes(1);
  });

  it("does not read while hidden, discard an old session response, and stop polling when hidden", async () => {
    vi.useFakeTimers();
    const pending = new Map<string, (value: DevBackgroundCommandOutput) => void>();
    api.commandOutput.mockImplementation((sessionId: string, commandId: string) => new Promise((resolve) => {
      pending.set(`${sessionId}/${commandId}`, resolve);
    }));
    const view = render(<DevelopmentCommandOutput sessionId="session_old" commandId="command_old" visible={false} onBack={vi.fn()} />);
    expect(api.commandOutput).not.toHaveBeenCalled();

    view.rerender(<DevelopmentCommandOutput sessionId="session_old" commandId="command_old" visible onBack={vi.fn()} />);
    view.rerender(<DevelopmentCommandOutput sessionId="session_new" commandId="command_new" visible onBack={vi.fn()} />);
    expect(api.commandOutput).toHaveBeenCalledTimes(2);

    await act(async () => {
      pending.get("session_old/command_old")?.(makeOutput({ command: "old command", output: "OLD_OUTPUT" }));
      pending.get("session_new/command_new")?.(makeOutput({ command: "new command", output: "NEW_OUTPUT", truncated: true }));
      await Promise.resolve();
    });
    expect(screen.getByText("NEW_OUTPUT")).toBeInTheDocument();
    expect(screen.queryByText("OLD_OUTPUT")).not.toBeInTheDocument();
    expect(screen.getByText("仅显示最近 50,000 个字符，较早内容已省略。")).toBeInTheDocument();

    view.rerender(<DevelopmentCommandOutput sessionId="session_new" commandId="command_new" visible={false} onBack={vi.fn()} />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(api.commandOutput).toHaveBeenCalledTimes(2);

    api.commandOutput.mockImplementationOnce(() => Promise.reject(new Error("读取请求失败")));
    view.rerender(<DevelopmentCommandOutput sessionId="session_new" commandId="command_new" visible onBack={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("dialog", { name: "读取命令输出失败" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("NEW_OUTPUT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试读取" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(api.commandOutput).toHaveBeenCalledTimes(4);
    expect(api.stopCommand).not.toHaveBeenCalled();
  });
});

