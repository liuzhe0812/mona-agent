import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/components/MessageBubble";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import type { UIMessage } from "@/lib/types";

const actions = vi.hoisted(() => ({
  copy: vi.fn(),
  export: vi.fn(),
  isTauri: vi.fn(),
  createNote: vi.fn(),
}));

vi.mock("@/lib/copy-image", () => ({ copyImageToClipboard: actions.copy }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  downloadMediaUrl: actions.export,
  isTauri: actions.isTauri,
  createNoteFromChat: actions.createNote,
}));

const generated = (media: UIMessage["media"]): UIMessage => ({
  id: "assistant-image",
  role: "assistant",
  content: "Here is the generated image.",
  createdAt: 1,
  media,
});

beforeEach(() => {
  actions.copy.mockReset().mockResolvedValue(undefined);
  actions.export.mockReset().mockResolvedValue(null);
  actions.isTauri.mockReset().mockReturnValue(false);
  actions.createNote.mockReset().mockResolvedValue("note-1");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("generated image actions", () => {
  it("saves an image-only reply from the More actions menu with its image bytes", async () => {
    const image = { kind: "image" as const, url: "/api/media/sig/image", name: "generated.png" };
    actions.isTauri.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "Content-Type": "image/png" },
    })));
    render(<MessageBubble message={{ ...generated([image]), content: "" }} onQuote={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), { button: 0, ctrlKey: false });
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Reply" })).toBeInTheDocument();
    expect(menu.queryByRole("menuitem", { name: "Export image" })).not.toBeInTheDocument();
    fireEvent.click(menu.getByRole("menuitem", { name: "Save as note" }));
    await waitFor(() => expect(actions.createNote).toHaveBeenCalledWith(
      "generated", "", undefined, { data: "data:image/png;base64,iVBORw==", extension: "png" },
    ));
  });

  it.each([undefined, "Preparing the image"])("shows the footer for a completed image-only reply (reasoning: %s)", async (reasoning) => {
    const image = { kind: "image" as const, url: "/api/media/sig/image", name: "generated.png" };
    const messages: UIMessage[] = [
      { id: "request", role: "user", content: "Generate an image", createdAt: 1 },
      {
        ...generated([image]), content: "", reasoning,
        createdAt: new Date(2026, 10, 24, 17, 22).getTime(),
        tokenUsage: { promptTokens: 1_000, completionTokens: 200, cachedTokens: 0, totalTokens: 1_200 },
      },
    ];
    const { rerender } = render(<ThreadMessages messages={messages} isStreaming />);
    expect(screen.queryByTestId("direct-message-actions")).not.toBeInTheDocument();

    rerender(<ThreadMessages messages={messages} />);
    const reply = within(screen.getByTestId("message-bubble-assistant-image"));
    expect(reply.getByRole("img", { name: image.name })).toBeInTheDocument();
    const footer = within(reply.getByTestId("direct-message-actions"));
    expect(footer.getByText("11-24 17:22")).toBeInTheDocument();
    expect(footer.getByText("1.2k tokens")).toBeInTheDocument();
    expect(footer.getByRole("button", { name: "Share as image" })).toBeInTheDocument();

    fireEvent.click(footer.getByRole("button", { name: "Copy image" }));
    expect(await footer.findByRole("button", { name: "Image copied" })).toBeInTheDocument();
    expect(actions.copy).toHaveBeenCalledWith(image.url);
    fireEvent.click(screen.getByRole("button", { name: "Export image" }));
    await waitFor(() => expect(actions.export).toHaveBeenCalledWith(image.url, image.name));
  });

  it("copies and exports the image without opening its preview", async () => {
    const image = { kind: "image" as const, url: "/api/media/sig/image", name: "generated.png" };
    render(<MessageBubble message={generated([image])} />);

    const preview = screen.getByRole("button", { name: "View image: generated.png" });
    const copy = screen.getByRole("button", { name: "Copy image" });
    const save = screen.getByRole("button", { name: "Export image" });
    expect(preview.contains(copy)).toBe(false);
    expect(preview.contains(save)).toBe(false);

    copy.focus();
    expect(copy).toHaveFocus();
    fireEvent.click(copy);
    await waitFor(() => expect(actions.copy).toHaveBeenCalledWith(image.url));
    expect(await screen.findByRole("button", { name: "Image copied" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(save);
    await waitFor(() => expect(actions.export).toHaveBeenCalledWith(image.url, image.name));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not add actions to user uploads or unavailable image placeholders", () => {
    const upload: UIMessage = {
      id: "user-image", role: "user", content: "", createdAt: 1,
      images: [{ url: "data:image/png;base64,AA==", name: "upload.png" }],
    };
    const { rerender } = render(<MessageBubble message={upload} />);
    expect(screen.queryByRole("button", { name: "Copy image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export image" })).not.toBeInTheDocument();

    rerender(<MessageBubble message={generated([{ kind: "image", name: "missing.png" }])} />);
    expect(screen.queryByRole("button", { name: "Copy image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export image" })).not.toBeInTheDocument();
  });

  it("copies and exports the visible image after switching thumbnails", async () => {
    const media = Array.from({ length: 6 }, (_, i) => ({
      kind: "image" as const, url: `/api/media/sig/image-${i}`, name: `generated-${i}.png`,
    }));
    render(<MessageBubble message={{ ...generated(media), content: "" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await screen.findByRole("button", { name: "Image copied" });

    const selected = media[5];
    fireEvent.click(screen.getByRole("button", { name: `Show image 6: ${selected.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    await waitFor(() => expect(actions.copy).toHaveBeenLastCalledWith(selected.url));
    fireEvent.click(screen.getByRole("button", { name: "Export image" }));
    await waitFor(() => expect(actions.export).toHaveBeenCalledWith(selected.url, selected.name));
  });

  it.each([
    ["copy", "Copy image", "Copy image failed"],
    ["export", "Export image", "Export image failed"],
  ] as const)("shows an actionable dialog when %s fails", async (action, label, title) => {
    actions[action].mockRejectedValue(new Error("raw internal detail"));
    render(<MessageBubble message={generated([{ kind: "image", url: "/api/media/sig/image", name: "generated.png" }])} />);

    fireEvent.click(screen.getByRole("button", { name: label }));
    const dialog = await screen.findByRole("alertdialog", { name: title });
    expect(dialog).toHaveTextContent("Please try again");
    expect(dialog).not.toHaveTextContent("raw internal detail");
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });
});
