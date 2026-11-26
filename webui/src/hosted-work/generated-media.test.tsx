import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageMedia } from "@/components/MessageBubble";
import { ConversationFileContext } from "@/components/deliver/ConversationFileContext";
import { configureHostedPlatform } from "@/lib/hosted-platform";
import type { UIMediaAttachment } from "@/lib/types";
import { fetchGeneratedMedia } from "./generated-media";

const BASE = "/api/work/desktop";
const first = `${location.origin}${BASE}/generated-media/${"a".repeat(43)}`;
const second = `${location.origin}${BASE}/generated-media/${"b".repeat(43)}`;
const SESSION = `websocket:${"1".repeat(32)}`;
const releases: Array<() => void> = [];

function configure(token = "account-A", onUnauthorized = vi.fn()) {
  releases.push(configureHostedPlatform({ apiBase: BASE, token, onUnauthorized }));
  return onUnauthorized;
}

function image() {
  return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
}

function renderMedia(media: UIMediaAttachment[], sessionKey = SESSION) {
  return render(<ConversationFileContext.Provider value={{ sessionKey, scope: "shared", download: vi.fn(), onError: vi.fn() }}>
    <MessageMedia align="left" media={media} />
  </ConversationFileContext.Provider>);
}

afterEach(() => {
  cleanup();
  while (releases.length) releases.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hosted generated images", () => {
  it("loads several images with the account bearer and revokes blobs on account change", async () => {
    configure();
    const fetcher = vi.fn().mockImplementation(async () => image());
    vi.stubGlobal("fetch", fetcher);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    renderMedia([
      { kind: "image", name: "one.png", url: first }, { kind: "image", name: "two.png", url: second },
    ]);
    expect(await screen.findByRole("img", { name: "one.png" })).toHaveAttribute("src", "blob:first");
    fireEvent.click(screen.getByRole("button", { name: "Show image 2: two.png" }));
    expect(await screen.findByRole("img", { name: "two.png" })).toHaveAttribute("src", "blob:second");
    expect(create).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).not.toContain("account-A");
      expect(new Headers(options.headers).get("Authorization")).toBe("Bearer account-A");
      expect(new Headers(options.headers).get("X-Mona-Session-Key")).toBe(SESSION);
      expect(options).toMatchObject({ credentials: "omit", cache: "no-store", redirect: "error" });
    }
    act(() => window.dispatchEvent(new Event("mona-account-changed")));
    expect(revoke).toHaveBeenCalledWith("blob:first");
    expect(revoke).toHaveBeenCalledWith("blob:second");
    expect(screen.queryByRole("img", { name: "two.png" })).not.toBeInTheDocument();
  });

  it("keeps an expired image unavailable without repeated requests or logging out the account", async () => {
    const unauthorized = configure();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const create = vi.spyOn(URL, "createObjectURL");
    const { container } = renderMedia([{ kind: "image", name: "one.png", url: first }]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(unauthorized).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("图片暂时无法查看，请刷新会话后重试。");
    expect(container.innerHTML).not.toContain("generated-media");
  });

  it("never exposes an old account's in-flight image after switching accounts", async () => {
    configure();
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      finish = () => { controller.enqueue(new Uint8Array([137, 80, 78, 71])); controller.close(); };
    } });
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetcher);
    const create = vi.spyOn(URL, "createObjectURL");
    renderMedia([{ kind: "image", name: "one.png", url: first }]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    configure("account-B");
    act(() => window.dispatchEvent(new Event("mona-account-changed")));
    await act(async () => { finish(); await Promise.resolve(); });
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("img", { name: "one.png" })).not.toBeInTheDocument();
  });

  it("revokes the local image URL when the conversation unmounts", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(image()));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const view = renderMedia([{ kind: "image", name: "one.png", url: first }]);
    await screen.findByRole("img", { name: "one.png" });
    view.unmount();
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:one");
  });

  it("revokes the previous conversation's blob before fetching for a new session", async () => {
    configure();
    const fetcher = vi.fn().mockResolvedValueOnce(image()).mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const media: UIMediaAttachment[] = [{ kind: "image", name: "one.png", url: first }];
    const view = renderMedia(media);
    await screen.findByRole("img", { name: "one.png" });
    const other = `websocket:${"2".repeat(32)}`;
    view.rerender(<ConversationFileContext.Provider value={{ sessionKey: other, scope: "shared", download: vi.fn(), onError: vi.fn() }}>
      <MessageMedia align="left" media={media} />
    </ConversationFileContext.Provider>);
    expect(revoke).toHaveBeenCalledWith("blob:one");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("X-Mona-Session-Key")).toBe(other);
    expect(screen.queryByRole("img", { name: "one.png" })).not.toBeInTheDocument();
  });

  it("bounds concurrent image reads and does not retry a failed request", async () => {
    configure();
    const pending: Array<(response: Response) => void> = [];
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const media = Array.from({ length: 5 }, (_, index) => ({ kind: "image" as const, name: `${index}.png`,
      url: `${location.origin}${BASE}/generated-media/${String(index).repeat(43)}` }));
    renderMedia(media);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    await act(async () => { pending[0](image()); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    await act(async () => { for (const resolve of pending.slice(1)) resolve(new Response(null, { status: 503 })); });
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("rejects foreign origins, unsupported content and oversized responses", async () => {
    configure();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(fetchGeneratedMedia(`https://other.invalid${BASE}/generated-media/${"c".repeat(43)}`,
      SESSION, new AbortController().signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response("not an image", { headers: { "Content-Type": "text/html" } }));
    await expect(fetchGeneratedMedia(first, SESSION, new AbortController().signal)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": "33554433" } }));
    await expect(fetchGeneratedMedia(first, SESSION, new AbortController().signal)).rejects.toThrow();
  });
});
