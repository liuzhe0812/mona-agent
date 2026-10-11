import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import type { AttachedDocument } from "@/hooks/useAttachedDocuments";

const document = { name: "requirements.txt", path: "uploads/requirements.txt" };

function Composer({ send, chatId = "dev_one" }: { send: (...args: unknown[]) => Promise<boolean>; chatId?: string }) {
  const [documents, setDocuments] = useState<AttachedDocument[]>([document]);
  return <ThreadComposer chatId={chatId} onSend={send} value="检查文件" clearOnSend={false} awaitSendResult
    documentDraft={documents} onDocumentDraftChange={setDocuments} imageInputEnabled={false} />;
}

describe("attachment receipt", () => {
  it("retains file references after rejection and clears them only after acceptance", async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<Composer send={send} />);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0][2]).toEqual({ docPaths: [document.path], documentNames: [document.name] });
    expect(send.mock.calls[1][2]).toEqual(send.mock.calls[0][2]);
    await act(async () => {});
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2][2]).toBeUndefined();
  });

  it("does not let an old receipt clear the newly selected conversation", async () => {
    let resolve!: (accepted: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const { rerender } = render(<Composer send={send} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    rerender(<Composer send={send} chatId="dev_two" />);
    await act(async () => { resolve(true); });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2]).toEqual({ docPaths: [document.path], documentNames: [document.name] });
  });
});
