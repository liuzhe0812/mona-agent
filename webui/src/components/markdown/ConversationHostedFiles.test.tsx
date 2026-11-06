import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { ConversationFileContext } from "@/components/deliver/ConversationFileContext";
import { DeliveredFileCard } from "@/components/deliver/DeliveredFileCard";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";

afterEach(() => { cleanup(); useFilePreviewStore.getState().close(); vi.restoreAllMocks(); });

describe("hosted conversation files", () => {
  it("routes bare and workspace PPT links through the active conversation and keeps web links external", async () => {
    const download = vi.fn().mockResolvedValue(undefined);
    const access = { sessionKey: "websocket:current", scope: "shared" as const, download, onError: vi.fn() };
    render(<ConversationFileContext.Provider value={access}><MarkdownTextRenderer>
      {"[下载演示](deck.pptx) [工作区](./slides/deck.pptx) [外部](https://example.com/deck.pptx)"}
    </MarkdownTextRenderer></ConversationFileContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "下载演示" }));
    fireEvent.click(screen.getByRole("button", { name: "工作区" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(download).toHaveBeenNthCalledWith(1, "deck.pptx");
    expect(download).toHaveBeenNthCalledWith(2, "./slides/deck.pptx");
    expect(screen.getByRole("link", { name: "外部" })).toHaveAttribute("href", "https://example.com/deck.pptx");
  });

  it("leaves the desktop renderer unchanged without a hosted conversation context", () => {
    render(<MarkdownTextRenderer>{"[演示](deck.pptx)"}</MarkdownTextRenderer>);
    expect(screen.getByRole("link", { name: "演示" })).toHaveAttribute("href", "deck.pptx");
  });

  it("uses the current session for a message delivery card", () => {
    const file = { path: "deck.pptx", absolute_path: "/workspace/deck.pptx", name: "deck.pptx",
      size: 4, size_human: "4 B", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
    const access = { sessionKey: "websocket:current", scope: "shared" as const,
      download: vi.fn(), onError: vi.fn() };
    render(<ConversationFileContext.Provider value={access}><DeliveredFileCard file={file} /></ConversationFileContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /deck\.pptx/ }));
    expect(useFilePreviewStore.getState()).toMatchObject({ file, scope: "shared", sessionKey: "websocket:current" });
  });

  it("reports failed downloads through the existing error handler", async () => {
    const failure = new Error("download failed");
    const access = { sessionKey: "websocket:current", scope: "shared" as const,
      download: vi.fn().mockRejectedValue(failure), onError: vi.fn() };
    render(<ConversationFileContext.Provider value={access}><MarkdownTextRenderer>{"[演示](deck.pptx)"}</MarkdownTextRenderer></ConversationFileContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "演示" }));
    await waitFor(() => expect(access.onError).toHaveBeenCalledWith(failure));
  });
});
