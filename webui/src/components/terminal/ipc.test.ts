import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { onTerminalOutput, shellSpawn } from "./ipc";

describe("local shell startup", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    mocks.invoke.mockReset().mockResolvedValue("session-1");
    mocks.listen.mockReset();
  });

  it("waits for the output listener before spawning the shell", async () => {
    let finishListening!: () => void;
    mocks.listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        finishListening = () => resolve(() => {});
      }),
    );

    const listening = onTerminalOutput(() => {});
    const spawning = shellSpawn(80, 24);

    await Promise.resolve();
    expect(mocks.invoke).not.toHaveBeenCalled();

    finishListening();
    await listening;

    await expect(spawning).resolves.toBe("session-1");
    expect(mocks.invoke).toHaveBeenCalledWith("shell_spawn", {
      cols: 80,
      rows: 24,
    });
  });
});
