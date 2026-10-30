import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TextEditorApp } from "./TextEditorApp";

const ipc = vi.hoisted(() => ({
  desktopGetFileContent: vi.fn(),
  desktopSaveFileContent: vi.fn(),
}));

vi.mock("../../ipc", () => ipc);

describe("desktop text editor", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps the draft after a failed save and clears dirty only after a successful retry", async () => {
    ipc.desktopGetFileContent.mockResolvedValue("original");
    ipc.desktopSaveFileContent.mockRejectedValueOnce("private remote stderr").mockResolvedValueOnce(undefined);
    render(<TextEditorApp sessionId="desktop" filePath="/tmp/file.txt" />);

    const editor = await screen.findByRole("textbox");
    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.change(editor, { target: { value: "my draft" } });
    fireEvent.click(save);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("保存失败");
    expect(dialog).not.toHaveTextContent("private remote stderr");
    expect(editor).toHaveValue("my draft");
    expect(ipc.desktopSaveFileContent).toHaveBeenCalledWith("desktop", "/tmp/file.txt", "my draft");

    fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeDisabled());
    expect(editor).toHaveValue("my draft");
    expect(ipc.desktopSaveFileContent).toHaveBeenCalledTimes(2);
  });

  it("keeps later edits dirty when an earlier save finishes", async () => {
    ipc.desktopGetFileContent.mockResolvedValue("original");
    let finishSave: () => void = () => {};
    ipc.desktopSaveFileContent.mockReturnValue(new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<TextEditorApp sessionId="desktop" filePath="/tmp/file.txt" />);

    const editor = await screen.findByRole("textbox");
    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.change(editor, { target: { value: "first draft" } });
    fireEvent.click(save);
    fireEvent.change(editor, { target: { value: "later draft" } });
    await act(async () => finishSave());

    expect(editor).toHaveValue("later draft");
    expect(save).toBeEnabled();
    expect(ipc.desktopSaveFileContent).toHaveBeenCalledWith("desktop", "/tmp/file.txt", "first draft");
  });

  it("shows a load error instead of treating a failed read as content", async () => {
    ipc.desktopGetFileContent.mockRejectedValue("private remote stderr");
    render(<TextEditorApp sessionId="desktop" filePath="/tmp/file.txt" />);

    expect(await screen.findByText(/读取文件失败/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("private remote stderr")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    expect(ipc.desktopSaveFileContent).not.toHaveBeenCalled();
  });
});
