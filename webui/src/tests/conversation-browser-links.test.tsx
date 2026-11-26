import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MarkdownTextRenderer from "@/components/MarkdownTextRenderer";
import { MessageBubble } from "@/components/MessageBubble";
import { ConversationBrowserContext } from "@/components/deliver/ConversationBrowserContext";
import { OverviewPanel } from "@/components/deliver/OverviewPanel";
import type { UIMessage } from "@/lib/types";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  openExternalUrl: vi.fn(async (_url: string) => {}),
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  ...tauri,
}));

vi.mock("@/components/visualizer/InlineWidget", () => ({
  InlineWidget: ({ onOpenLink }: { onOpenLink: (url: string) => void }) => (
    <button onClick={() => onOpenLink("https://example.com/widget")}>widget link</button>
  ),
}));

beforeEach(() => {
  tauri.isTauri.mockReturnValue(true);
  tauri.openExternalUrl.mockClear();
});

afterEach(cleanup);

describe("conversation webpage links", () => {
  it("uses the current desktop conversation callback for Markdown links", () => {
    const open = vi.fn();
    const { rerender } = render(
      <ConversationBrowserContext.Provider value={open}>
        <MarkdownTextRenderer>{"[网页](https://example.com/page)"}</MarkdownTextRenderer>
      </ConversationBrowserContext.Provider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "网页" }));
    expect(open).toHaveBeenCalledWith("https://example.com/page");
    expect(tauri.openExternalUrl).not.toHaveBeenCalled();

    const nextOpen = vi.fn();
    rerender(
      <ConversationBrowserContext.Provider value={nextOpen}>
        <MarkdownTextRenderer>{"[网页](https://example.com/page)"}</MarkdownTextRenderer>
      </ConversationBrowserContext.Provider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "网页" }));
    expect(nextOpen).toHaveBeenCalledWith("https://example.com/page");
  });

  it("preserves external opening when there is no conversation callback", () => {
    render(<MarkdownTextRenderer>{"[网页](https://example.com/page)"}</MarkdownTextRenderer>);
    fireEvent.click(screen.getByRole("link", { name: "网页" }));
    expect(tauri.openExternalUrl).toHaveBeenCalledWith("https://example.com/page");
  });

  it("routes widget and reference links through the conversation callback", () => {
    const open = vi.fn();
    const widget: UIMessage = {
      id: "widget", role: "assistant", kind: "widget", createdAt: 1, content: "",
      widget: { id: "widget", title: "test", code: "", loadingMessages: [], status: "complete" },
    };
    const reference: UIMessage = {
      id: "reference", role: "assistant", createdAt: 2, content: "",
      toolEvents: [
        { name: "web_fetch", arguments: { url: "https://example.com/source" } },
        { name: "web_search", arguments: { q: "Mona" } },
      ],
    };
    render(
      <ConversationBrowserContext.Provider value={open}>
        <MessageBubble message={widget} />
        <OverviewPanel messages={[reference]} deliverables={null} processArtifacts={null} />
      </ConversationBrowserContext.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "widget link" }));
    fireEvent.click(screen.getByRole("button", { name: /example.com/ }));
    fireEvent.click(screen.getByRole("button", { name: /Mona/ }));
    expect(open.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/widget",
      "https://example.com/source",
      "https://www.bing.com/search?q=Mona",
    ]);
    expect(tauri.openExternalUrl).not.toHaveBeenCalled();
  });

  it("keeps hosted widget and reference links on the existing external path", () => {
    tauri.isTauri.mockReturnValue(false);
    const open = vi.fn();
    const widget: UIMessage = {
      id: "widget", role: "assistant", kind: "widget", createdAt: 1, content: "",
      widget: { id: "widget", title: "test", code: "", loadingMessages: [], status: "complete" },
    };
    const reference: UIMessage = {
      id: "reference", role: "assistant", createdAt: 2, content: "",
      toolEvents: [{ name: "web_fetch", arguments: { url: "https://example.com/source" } }],
    };
    render(
      <ConversationBrowserContext.Provider value={open}>
        <MessageBubble message={widget} />
        <OverviewPanel messages={[reference]} deliverables={null} processArtifacts={null} />
      </ConversationBrowserContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "widget link" }));
    fireEvent.click(screen.getByRole("button", { name: /example.com/ }));
    expect(open).not.toHaveBeenCalled();
    expect(tauri.openExternalUrl.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/widget",
      "https://example.com/source",
    ]);
  });
});
