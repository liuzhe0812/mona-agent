import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageBubble } from "@/components/MessageBubble";
import type { UIMessage } from "@/lib/types";

const actions = vi.hoisted(() => ({
  copy: vi.fn(),
  export: vi.fn(),
}));

vi.mock("@/lib/copy-image", () => ({ copyImageToClipboard: actions.copy }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  downloadMediaUrl: actions.export,
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
});

afterEach(cleanup);

describe("generated image actions", () => {
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

  it("keeps actions off the image covered by the gallery expansion control", () => {
    const media = Array.from({ length: 6 }, (_, i) => ({
      kind: "image" as const, url: `/api/media/sig/image-${i}`, name: `generated-${i}.png`,
    }));
    render(<MessageBubble message={generated(media)} />);

    expect(screen.getAllByRole("button", { name: "Copy image" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Export image" })).toHaveLength(3);
    const expand = screen.getByRole("button", { name: "Show all (+2)" });
    expect(within(expand.parentElement!).queryByRole("button", { name: "Copy image" })).not.toBeInTheDocument();
    fireEvent.click(expand);
    expect(screen.getAllByRole("button", { name: "Copy image" })).toHaveLength(6);
    expect(screen.getAllByRole("button", { name: "Export image" })).toHaveLength(6);
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
