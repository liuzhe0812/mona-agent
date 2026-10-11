import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeTerminalSession, TerminalSessionStatusEvent } from "@/components/terminal/ipc";

const native = vi.hoisted(() => ({ spawn: vi.fn(), kill: vi.fn(), list: vi.fn(),
  status: undefined as ((event: TerminalSessionStatusEvent) => void) | undefined, clear: vi.fn() }));
vi.mock("@/components/terminal/ipc", () => ({ shellSpawn: native.spawn, shellKill: native.kill,
  terminalListSessions: native.list,
  onTerminalSessionStatus: (callback: (event: TerminalSessionStatusEvent) => void) => {
    native.status = callback; return Promise.resolve(() => {});
  },
}));
vi.mock("@/components/terminal/store/terminalStore", () => ({
  useTerminalStore: { getState: () => ({ terminalRegistry: { clearBuffer: native.clear } }) },
}));
import { checkDevelopmentTerminal, startDevelopmentTerminal, stopDevelopmentTerminal } from "./terminal-lifecycle";
import { useDevelopmentStore } from "./store";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const running = (id: string): NativeTerminalSession => ({ id, session_type: "local", status: "connected" });
const state = () => useDevelopmentStore.getState();
beforeEach(() => {
  vi.clearAllMocks(); useDevelopmentStore.setState(useDevelopmentStore.getInitialState(), true);
  native.spawn.mockReset().mockResolvedValue("shell-a"); native.kill.mockReset().mockResolvedValue(undefined);
  native.list.mockReset().mockResolvedValue([running("shell-a"), running("shell-b")]);
});

describe("development terminal process ownership", () => {
  it("preserves an uncertain process without accepting input or starting a replacement", async () => {
    await startDevelopmentTerminal("dev-a", "D:/a");
    native.list.mockRejectedValueOnce(new Error("bridge disconnected"));
    await checkDevelopmentTerminal("dev-a");
    expect(state().terminals["dev-a"]).toMatchObject({ id: "shell-a", status: "error" });
    expect(state().terminals["dev-a"].error).toContain("终端状态尚未确认");
    expect(native.clear).not.toHaveBeenCalled(); expect(native.kill).not.toHaveBeenCalled();
    await startDevelopmentTerminal("dev-a", "D:/a");
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(state().terminals["dev-a"].status).toBe("ready");
  });
  it("does not treat connection events as a natural exit", async () => {
    await startDevelopmentTerminal("dev-a", "D:/a");
    native.status!({ sessionId: "shell-a", status: "connected" });
    expect(state().terminals["dev-a"].status).toBe("ready");
    expect(native.kill).not.toHaveBeenCalled();
  });
  it("creates once for repeated opens with the exact project directory", async () => {
    const first = startDevelopmentTerminal("dev-a", "D:/项目 A");
    expect(startDevelopmentTerminal("dev-a", "D:/项目 A")).toBe(first);
    await first;
    expect(native.spawn).toHaveBeenCalledTimes(1); expect(native.spawn).toHaveBeenCalledWith(80, 24, "D:/项目 A");
    expect(state().terminals["dev-a"]).toEqual({ id: "shell-a", status: "ready" });
    await startDevelopmentTerminal("dev-a", "D:/项目 A");
    expect(native.spawn).toHaveBeenCalledTimes(1);
  });
  it("ends the same late-created process when end is requested during creation", async () => {
    const spawn = deferred<string>(); native.spawn.mockReturnValue(spawn.promise);
    const first = startDevelopmentTerminal("dev-a", "D:/a");
    await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledTimes(1));
    const stop = stopDevelopmentTerminal("dev-a");
    expect(state().terminals["dev-a"].status).toBe("closing");
    expect(stopDevelopmentTerminal("dev-a")).toBe(stop);
    const repeatedOpen = startDevelopmentTerminal("dev-a", "D:/a");
    spawn.resolve("shell-a"); await Promise.all([first, stop, repeatedOpen]);
    expect(native.kill).toHaveBeenCalledTimes(1); expect(native.kill).toHaveBeenCalledWith("shell-a");
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(state().terminals["dev-a"]).toBeUndefined();
    expect(native.clear).toHaveBeenCalledTimes(1); expect(native.clear).toHaveBeenCalledWith("shell-a");
  });
  it("retains ownership and output until native end is confirmed", async () => {
    await startDevelopmentTerminal("dev-a", "D:/a");
    const closing = deferred<void>(); native.kill.mockReturnValueOnce(closing.promise);
    const stop = stopDevelopmentTerminal("dev-a");
    await vi.waitFor(() => expect(native.kill).toHaveBeenCalledTimes(1));
    expect(state().terminals["dev-a"]).toMatchObject({ id: "shell-a", status: "closing" });
    expect(native.clear).not.toHaveBeenCalled();
    expect(startDevelopmentTerminal("dev-a", "D:/a")).toBe(stop);
    closing.resolve(); await stop;
    expect(state().terminals["dev-a"]).toBeUndefined();
    expect(native.spawn).toHaveBeenCalledTimes(1);
  });
  it("does not replace a process or clear its output after an uncertain end", async () => {
    await startDevelopmentTerminal("dev-a", "D:/a");
    native.kill.mockRejectedValueOnce(new Error("connection lost"));
    await stopDevelopmentTerminal("dev-a");
    expect(state().terminals["dev-a"]).toMatchObject({ id: "shell-a", status: "error" });
    expect(state().terminals["dev-a"].error).toContain("未确认终端已结束");
    expect(native.clear).not.toHaveBeenCalled();
    await startDevelopmentTerminal("dev-a", "D:/a");
    expect(native.spawn).toHaveBeenCalledTimes(1);
    expect(state().terminals["dev-a"].status).toBe("ready");
  });
  it("keeps hidden session output and only ends the selected session", async () => {
    native.spawn.mockResolvedValueOnce("shell-a").mockResolvedValueOnce("shell-b");
    await startDevelopmentTerminal("dev-a", "D:/a"); await startDevelopmentTerminal("dev-b", "D:/b");
    state().setSide("dev-a", { tab: "terminal", terminalMode: "user" });
    state().closeSideTab("dev-a", "terminal"); state().openSession("project-b", "dev-b");
    expect(native.kill).not.toHaveBeenCalled(); expect(native.clear).not.toHaveBeenCalled();
    native.status!({ sessionId: "shell-a", status: "disconnected" });
    expect(state().terminals["dev-a"].status).toBe("exited");
    expect(state().terminals["dev-b"].status).toBe("ready");
    await stopDevelopmentTerminal("dev-a");
    expect(native.kill).toHaveBeenCalledTimes(1); expect(native.kill).toHaveBeenCalledWith("shell-a");
    expect(state().terminals["dev-b"].id).toBe("shell-b");
    expect(state().sides["dev-a"].terminalMode).toBe("user");
  });
  it("does not resurrect a process from a status read older than its exit event", async () => {
    await startDevelopmentTerminal("dev-a", "D:/a");
    const snapshot = deferred<NativeTerminalSession[]>(); native.list.mockReturnValueOnce(snapshot.promise);
    const check = checkDevelopmentTerminal("dev-a");
    await vi.waitFor(() => expect(native.list).toHaveBeenCalledTimes(2));
    native.status!({ sessionId: "shell-a", status: "disconnected" });
    snapshot.resolve([running("shell-a")]); await check;
    expect(state().terminals["dev-a"].status).toBe("exited");
  });
  it("reports a missing or nonlocal process as exited without creating one", async () => {
    state().setTerminal("dev-a", { id: "old-shell", status: "ready" });
    native.list.mockResolvedValueOnce([{ ...running("old-shell"), session_type: "ssh" }]);
    await checkDevelopmentTerminal("dev-a");
    expect(state().terminals["dev-a"].status).toBe("exited");
    expect(native.spawn).not.toHaveBeenCalled(); expect(native.kill).not.toHaveBeenCalled();
  });
});
