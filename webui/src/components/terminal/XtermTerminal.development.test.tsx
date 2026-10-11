import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ input: undefined as ((text: string) => void) | undefined,
  instances: [] as { options: Record<string, unknown>; paste: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
  write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), dialog: vi.fn(),
  clipboard: vi.fn(), register: vi.fn(), unregister: vi.fn(), clear: vi.fn(),
  settings: { cursorStyle: "block", fontSize: 14, fontFamily: "monospace", scrollback: 1000 },
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: Record<string, unknown>; cols = 80; rows = 24;
  paste = vi.fn(); dispose = vi.fn();
  constructor(options: Record<string, unknown>) { this.options = options; controls.instances.push(this); }
  loadAddon() {} open() {} focus() {} refresh() {} write() {} clearSelection() {} getSelection() { return ""; }
  onData(callback: (text: string) => void) { controls.input = callback; return { dispose() {} }; }
  onTitleChange() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: controls.clipboard }));
vi.mock("./ipc", () => ({ shellWrite: controls.write, shellResize: controls.resize,
  sshWrite: vi.fn(), sshResize: vi.fn(), sshConnect: vi.fn(), sshReconnect: vi.fn() }));
vi.mock("./store/terminalStore", () => {
  const state = { settings: controls.settings, sessions: [], connections: [], activeSessionId: null,
    terminalRegistry: { register: controls.register, unregister: controls.unregister, clearBuffer: controls.clear },
    updateSessionTitle: vi.fn(), updateSessionStatus: vi.fn(), showSshPasswordDialog: controls.dialog };
  const useTerminalStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state });
  return { useTerminalStore };
});
import { XtermTerminal } from "./XtermTerminal";

beforeEach(() => { vi.clearAllMocks(); controls.instances.length = 0; });
afterEach(cleanup);

describe("Code reuse of the shared terminal", () => {
  it("sends ssh text to the native Code shell instead of invoking Work SSH management", () => {
    render(<XtermTerminal sessionId="code-shell" interceptSsh={false} />);
    for (const char of "ssh user@example.invalid") controls.input!(char);
    controls.input!("\r");
    expect(controls.write).toHaveBeenLastCalledWith("code-shell", "\r");
    expect(controls.dialog).not.toHaveBeenCalled();
    expect(controls.write).not.toHaveBeenCalledWith("code-shell", "\x03");
  });
  it("retains the existing Work SSH behavior by default", async () => {
    render(<XtermTerminal sessionId="work-shell" />);
    for (const char of "ssh user@example.invalid") controls.input!(char);
    controls.input!("\r");
    expect(controls.write).toHaveBeenLastCalledWith("work-shell", "\x03");
    await waitFor(() => expect(controls.dialog).toHaveBeenCalledWith(expect.objectContaining({ host: "example.invalid", username: "user" })));
  });
  it("keeps rendered output mounted but stops input when Code is closing or exited", () => {
    const view = render(<XtermTerminal sessionId="code-shell" interceptSsh={false} />);
    controls.input!("before"); controls.write.mockClear();
    view.rerender(<XtermTerminal sessionId="code-shell" interceptSsh={false} readOnly />);
    controls.input!("after");
    expect(controls.instances).toHaveLength(1);
    expect(controls.instances[0].options.disableStdin).toBe(true);
    expect(controls.write).not.toHaveBeenCalled();
    view.unmount();
    expect(controls.unregister).toHaveBeenCalledWith("code-shell");
    expect(controls.clear).not.toHaveBeenCalled();
  });
  it("does not read or paste clipboard content into a noninteractive terminal", async () => {
    const view = render(<XtermTerminal sessionId="code-shell" readOnly interceptSsh={false} />);
    await act(async () => { fireEvent.contextMenu(view.container.firstChild!); });
    expect(controls.clipboard).not.toHaveBeenCalled();
    expect(controls.instances[0].paste).not.toHaveBeenCalled();
  });
});
