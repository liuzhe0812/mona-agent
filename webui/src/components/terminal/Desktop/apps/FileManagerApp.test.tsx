import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FileManagerApp } from "./FileManagerApp";
import { RecycleBinApp } from "./RecycleBinApp";
import { shellPath, shellQuote } from "./shellQuote";

const ipc = vi.hoisted(() => ({
  desktopExec: vi.fn(),
  desktopListFiles: vi.fn(),
  desktopGetDisks: vi.fn(),
}));

vi.mock("../../ipc", () => ipc);

describe("desktop file commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.desktopExec.mockResolvedValue("root");
    ipc.desktopGetDisks.mockResolvedValue([]);
  });

  it("quotes both paths when renaming a remotely listed file", async () => {
    const name = "a'; printf injected; #";
    const path = `/tmp/${name}`;
    ipc.desktopListFiles.mockResolvedValue({ path: "/tmp", files: [
      { name, path, type: "file", size: "0 B", mode: "rw", modified: "" },
    ] });
    render(<FileManagerApp sessionId="desktop" initialPath="/tmp" />);

    fireEvent.contextMenu(await screen.findByText(name));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByDisplayValue(name), { target: { value: "-b'; echo injected; #" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => expect(ipc.desktopExec).toHaveBeenCalledWith(
      "desktop", `mv -- ${shellQuote(path)} ${shellQuote("/tmp/-b'; echo injected; #")}`,
    ));
  });

  it("quotes remote trash entries and restore paths", async () => {
    const name = "a'; printf injected; #";
    const original = "/tmp/b'; printf injected; #";
    ipc.desktopExec.mockImplementation(async (_session: string, command: string) => {
      if (command.startsWith("ls -1")) return name;
      if (command.startsWith("cat --")) return `Path=${original}\nDeletionDate=2026-01-01`;
      if (command.startsWith("test -d")) return "file";
      if (command.startsWith("stat ")) return "0";
      return "";
    });
    render(<RecycleBinApp sessionId="desktop" />);

    fireEvent.contextMenu(await screen.findByText("b'; printf injected; #"));
    fireEvent.click(screen.getByRole("button", { name: "还原" }));

    const source = `~/.local/share/Trash/files/${name}`;
    await waitFor(() => expect(ipc.desktopExec).toHaveBeenCalledWith(
      "desktop", expect.stringContaining(`mv -- ${shellPath(source)} ${shellPath(original)}`),
    ));
  });
});
