import { afterEach, describe, expect, it, vi } from "vitest";

import { configureHostedPlatform, downloadHostedFile, getHostedPlatform } from "./hosted-platform";

const TOKEN_A = "synthetic-account-A";
const TOKEN_B = "synthetic-account-B";
const CONTENT = new TextEncoder().encode("abc");
const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const FILE = { path: "reports/本地文档.txt", name: "本地文档.txt", sha256: SHA256_ABC };
const SESSION = `websocket:${"1".repeat(32)}`;
const releases: Array<() => void> = [];

function configure(token: string) {
  releases.push(configureHostedPlatform({ apiBase: "/api/work/desktop", token }));
}

function fileResponse(): Response {
  return new Response(CONTENT, { status: 200, headers: { "Content-Type": "text/plain" } });
}

function watchDownload() {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-download");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  const links: Array<{ href: string; name: string; connected: boolean }> = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    links.push({ href: this.href, name: this.download, connected: this.isConnected });
  });
  return { create, revoke, click, links };
}

afterEach(() => {
  while (releases.length) releases.pop()?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hosted file download", () => {
  it("authenticates the file request without putting credentials in the URL or following redirects", async () => {
    vi.useFakeTimers();
    configure(TOKEN_A);
    const fetcher = vi.fn().mockResolvedValue(fileResponse());
    vi.stubGlobal("fetch", fetcher);
    const download = watchDownload();

    await downloadHostedFile(FILE, "shared", SESSION);

    expect(fetcher).toHaveBeenCalledOnce();
    const [address, options] = fetcher.mock.calls[0];
    const url = new URL(address);
    expect(url.origin).toBe(location.origin);
    expect(url.pathname).toBe("/api/work/desktop/api/file-preview");
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: FILE.path, scope: "shared", session_key: SESSION });
    expect(address).not.toContain(TOKEN_A);
    expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${TOKEN_A}`);
    expect(options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(download.create).toHaveBeenCalledOnce();
    expect(download.create.mock.calls[0][0]).toMatchObject({ size: CONTENT.length, type: "text/plain" });
    expect(download.links).toEqual([{ href: "blob:local-download", name: FILE.name, connected: true }]);
    vi.advanceTimersByTime(1000);
    expect(download.revoke).toHaveBeenCalledWith("blob:local-download");
  });

  it("does not start a download when the returned file has the wrong SHA-256", async () => {
    configure(TOKEN_A);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fileResponse()));
    const download = watchDownload();

    await expect(downloadHostedFile({ ...FILE, sha256: "0".repeat(64) }, "shared", SESSION))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("文件已变化") });
    expect(download.create).not.toHaveBeenCalled();
    expect(download.click).not.toHaveBeenCalled();
  });

  it("does not start a download if the server returns a redirect", async () => {
    configure(TOKEN_A);
    const fetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 302, headers: { Location: "https://other.example/redirected" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const download = watchDownload();

    await expect(downloadHostedFile(FILE, "shared", SESSION)).rejects.toMatchObject({ status: 302 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    expect(download.create).not.toHaveBeenCalled();
    expect(download.click).not.toHaveBeenCalled();
  });

  it("discards the old account's file if the account changes while reading the response body", async () => {
    configure(TOKEN_A);
    const response = fileResponse();
    let finish!: (bytes: ArrayBuffer) => void;
    const readBody = vi.spyOn(response, "arrayBuffer").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const download = watchDownload();
    const pending = downloadHostedFile(FILE, "shared", SESSION);
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());

    configure(TOKEN_B);
    finish(CONTENT.slice().buffer);

    await expect(pending).rejects.toThrow("账号已变化");
    expect(getHostedPlatform()?.token).toBe(TOKEN_B);
    expect(download.create).not.toHaveBeenCalled();
    expect(download.click).not.toHaveBeenCalled();
  });
});
