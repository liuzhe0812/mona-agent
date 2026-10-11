import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadComposer } from "@/components/thread/ThreadComposer";
import type { EncodeResponse } from "@/lib/imageEncode";
import type { MonaClient } from "@/lib/mona-client";
import { ClientProvider } from "@/providers/ClientProvider";

const encodeImage = vi.fn<(file: File) => Promise<EncodeResponse>>();

vi.mock("@/lib/imageEncode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/imageEncode")>();
  return {
    ...actual,
    encodeImage: (file: File) => encodeImage(file),
  };
});

function pngFile(name = "a.png", size = 10) {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

function resolveReady(file: File): EncodeResponse {
  return {
    id: "stub",
    ok: true,
    dataUrl: `data:image/png;base64,${btoa(file.name)}`,
    mime: "image/png",
    bytes: file.size,
    origBytes: file.size,
    normalized: false,
  };
}

function pasteFiles(element: HTMLElement, files: File[]) {
  fireEvent.paste(element, {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
}

function attachmentClient() {
  const handlers = new Set<Parameters<MonaClient["onDocUploadResult"]>[0]>();
  return {
    onDocUploadResult(handler: Parameters<MonaClient["onDocUploadResult"]>[0]) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    sendDocUpload: vi.fn(),
    complete(chatId: string, files: Array<{ name: string; path: string }>) {
      for (const handler of handlers) handler({ ok: true, chatId, files });
    },
  };
}

function withClient(client: ReturnType<typeof attachmentClient>, children: React.ReactNode) {
  return (
    <ClientProvider client={client as unknown as MonaClient} token="" runtimeStatus="ready">
      {children}
    </ClientProvider>
  );
}

beforeEach(() => {
  encodeImage.mockReset();
  let id = 0;
  // Tests never read the preview URL contents so a stable blob: stub is fine.
  if (!(globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL) {
    (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL =
      () => `blob:mock/${++id}`;
  }
  if (!(globalThis.URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL) {
    (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL =
      () => {};
  }
});

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe("ThreadComposer — attachments", () => {
  it("blocks file paste and drop when attachments are disabled but keeps the custom attach action", async () => {
    const client = attachmentClient();
    const onAttach = vi.fn();
    render(withClient(client, <ThreadComposer onSend={vi.fn()} attachmentsEnabled={false} onAttach={onAttach} attachLabel="引用项目文件" />));

    const textarea = screen.getByRole("textbox", { name: "Message input" });
    const form = textarea.closest("form")!;
    expect(screen.queryByRole("button", { name: "Attach files" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "引用项目文件" }));
    expect(onAttach).toHaveBeenCalledOnce();

    const textPaste = createEvent.paste(textarea, { clipboardData: { items: [] } });
    const preventDefault = vi.spyOn(textPaste, "preventDefault");
    fireEvent(textarea, textPaste);
    expect(preventDefault).not.toHaveBeenCalled();

    const file = new File(["document"], "notes.txt", { type: "text/plain" });
    pasteFiles(textarea, [file]);
    fireEvent.drop(form, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("当前模式不支持附件。");
    expect(client.sendDocUpload).not.toHaveBeenCalled();
    expect(encodeImage).not.toHaveBeenCalled();
  });

  it.each(["pick", "drop", "paste"])("accepts arbitrary file formats via %s before a chat exists", async (entry) => {
    const client = attachmentClient();
    const onSend = vi.fn();
    const files = [
      new File(["script"], "task.py", { type: "text/x-python" }),
      new File(["archive"], "data.zip", { type: "application/zip" }),
      new File(["vector"], "drawing.svg", { type: "image/svg+xml" }),
      new File(["photo"], "photo.heic", { type: "image/heic" }),
      new File(["photo"], "photo.avif", { type: "image/avif" }),
      new File(["unknown"], "custom", { type: "" }),
    ];
    render(withClient(client, <ThreadComposer onSend={onSend} />));
    const textarea = screen.getByLabelText(/message input/i);
    const form = textarea.closest("form")!;
    const input = form.querySelector('input[type="file"]')!;
    expect(input).not.toHaveAttribute("accept");
    if (entry === "pick") fireEvent.change(input, { target: { files } });
    else if (entry === "paste") pasteFiles(textarea, files);
    else fireEvent.drop(form, { dataTransfer: { files, types: ["Files"] } });

    await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledTimes(1));
    const [uploadId, payload] = client.sendDocUpload.mock.calls[0];
    expect(payload.map((file: { name: string }) => file.name)).toEqual(files.map((file) => file.name));
    expect(encodeImage).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const uploaded = files.map((file) => ({ name: file.name, path: `uploads/${uploadId}/${file.name}` }));
    act(() => client.complete(uploadId, uploaded));
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("", undefined, {
      docPaths: uploaded.map((file) => file.path),
      documentNames: files.map((file) => file.name),
    });
  });

  it("keeps a selected image as its original file when the model has no vision", async () => {
    const client = attachmentClient();
    const file = pngFile("reference.png");
    Object.defineProperty(file, "path", { value: "D:/pictures/reference.png" });
    render(withClient(client, <ThreadComposer onSend={vi.fn()} imageInputEnabled={false} />));
    expect(screen.getByLabelText("Attach files")).toBeEnabled();
    const input = screen.getByLabelText(/message input/i).closest("form")!.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledWith(
      expect.any(String), [{ name: file.name, local_path: "D:/pictures/reference.png" }],
    ));
    expect(encodeImage).not.toHaveBeenCalled();
  });

  it("ignores an old upload result after switching conversations", async () => {
    const client = attachmentClient();
    const onSend = vi.fn();
    const { rerender } = render(withClient(client, <ThreadComposer chatId="one" onSend={onSend} />));
    pasteFiles(screen.getByLabelText(/message input/i), [new File(["data"], "old.bin")]);
    await waitFor(() => expect(client.sendDocUpload).toHaveBeenCalledTimes(1));
    const uploadId = client.sendDocUpload.mock.calls[0][0];
    rerender(withClient(client, <ThreadComposer chatId="two" onSend={onSend} />));
    act(() => client.complete(uploadId, [{ name: "old.bin", path: "uploads/old.bin" }]));
    expect(screen.queryByText("old.bin")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/message input/i), { target: { value: "next" } });
    fireEvent.keyDown(screen.getByLabelText(/message input/i), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("next", undefined, undefined);
  });

  it("attaches a pasted image and includes its data url on send", async () => {
    const file = pngFile("a.png");
    encodeImage.mockResolvedValueOnce(resolveReady(file));
    const onSend = vi.fn();

    render(<ThreadComposer onSend={onSend} />);

    await act(async () => {
      pasteFiles(screen.getByLabelText(/message input/i), [file]);
    });

    await waitFor(() =>
      expect(screen.getByTestId("composer-chip")).toBeInTheDocument(),
    );

    const textarea = screen.getByLabelText(/message input/i);
    fireEvent.change(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
    const [content, images] = onSend.mock.calls[0];
    expect(content).toBe("hi");
    expect(images).toHaveLength(1);
    expect(images[0].media.data_url).toContain("data:image/png;base64,");
    expect(images[0].media.name).toBe("a.png");
  });

  it("blocks send while an image is still encoding", async () => {
    const file = pngFile("slow.png");
    let resolveEncode: (r: EncodeResponse) => void = () => {};
    encodeImage.mockReturnValueOnce(
      new Promise((r) => {
        resolveEncode = r;
      }),
    );
    const onSend = vi.fn();

    render(<ThreadComposer onSend={onSend} />);

    await act(async () => {
      pasteFiles(screen.getByLabelText(/message input/i), [file]);
    });

    const textarea = screen.getByLabelText(/message input/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      resolveEncode(resolveReady(file));
      await Promise.resolve();
    });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-image paste silently without adding a chip", async () => {
    const onSend = vi.fn();
    render(<ThreadComposer onSend={onSend} />);
    const textarea = screen.getByLabelText(/message input/i);

    fireEvent.paste(textarea, {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "string",
            type: "text/plain",
            getAsFile: () => null,
          },
        ],
        types: ["text/plain"],
        getData: () => "some pasted text",
      },
    });

    expect(screen.queryByTestId("composer-chip")).toBeNull();
    expect(encodeImage).not.toHaveBeenCalled();
  });

  it("surfaces an inline error when encoding fails", async () => {
    const file = pngFile("bad.png");
    encodeImage.mockResolvedValueOnce({
      id: "stub",
      ok: false,
      reason: "decode_failed",
    } as EncodeResponse);
    const onSend = vi.fn();

    render(<ThreadComposer onSend={onSend} />);
    await act(async () => {
      pasteFiles(screen.getByLabelText(/message input/i), [file]);
    });

    await waitFor(() => {
      const chip = screen.getByTestId("composer-chip");
      expect(chip.textContent ?? "").toMatch(/decode|image/i);
    });

    const textarea = screen.getByLabelText(/message input/i);
    fireEvent.change(textarea, { target: { value: "hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
