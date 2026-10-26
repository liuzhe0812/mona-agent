import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailAccount } from "./types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { deleteFolder, renameFolder } from "./emailApi";

const account: EmailAccount = {
  id: "account-a",
  displayName: "Test account",
  imapHost: "imap.example.test",
  imapPort: 993,
  imapUsername: "user@example.test",
  imapPassword: "",
  smtpHost: "smtp.example.test",
  smtpPort: 465,
  smtpUsername: "user@example.test",
  smtpPassword: "",
  fromAddress: "user@example.test",
  imapUseSsl: true,
  smtpUseSsl: true,
};

describe.each(["rename", "delete"] as const)("%s folder request", (action) => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue("");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts once at its deadline and reports an unconfirmed result", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let startFetch!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { startFetch = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      startFetch();
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const operation = action === "rename"
      ? renameFolder("http://127.0.0.1:17173", account, "Archive", "Projects")
      : deleteFolder("http://127.0.0.1:17173", account, "Archive");
    const rejection = expect(operation).rejects.toMatchObject({ name: "EmailFolderMutationTimeoutError" });
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
  });
});
