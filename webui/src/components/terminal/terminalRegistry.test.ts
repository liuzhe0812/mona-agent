import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import { TerminalRegistry } from "./terminalRegistry";

describe("TerminalRegistry", () => {
  it("replays the complete output when a terminal remounts", () => {
    const registry = new TerminalRegistry();
    const first = { write: vi.fn() } as unknown as Terminal;
    const second = { write: vi.fn() } as unknown as Terminal;

    registry.write("local-1", "li");
    registry.register("local-1", first);
    registry.unregister("local-1");
    registry.write("local-1", "uzhe>");
    registry.register("local-1", second);

    expect(second.write).toHaveBeenCalledWith("liuzhe>");
  });
});
