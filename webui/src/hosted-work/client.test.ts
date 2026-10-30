import { afterEach, describe, expect, it, vi } from "vitest";
import { login, newRequestId, WorkClient, type PendingTurn } from "./client";

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const pending: PendingTurn = { session_id: "a".repeat(32), input: {
  request_id: "b".repeat(32), model_id: "official", text: "整理资料", attachment_ids: [],
} };

afterEach(() => vi.unstubAllGlobals());

describe("hosted Work transport", () => {
  it("creates strong request IDs on HTTP without randomUUID or subtle", () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = Array.from({ length: 100 }, newRequestId);
    expect(ids.every(id => /^[a-f0-9]{32}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("verifies downloaded content on HTTP without subtle crypto", async () => {
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("abc")));
    const file = { id: "d".repeat(32), name: "result.txt", size: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    const data = await new WorkClient("account-token").download("a".repeat(32), file);
    expect(data.size).toBe(3);
  });

  it("still rejects corrupted downloads without secure-context APIs", async () => {
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("abd")));
    await expect(new WorkClient("account-token").download("a".repeat(32), {
      id: "d".repeat(32), name: "result.txt", size: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    })).rejects.toMatchObject({ code: "file_changed" });
  });

  it("logs in through the standalone Work auth adapter", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ access_token: "synthetic-account-token" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await login("student", "synthetic-password")).toBe("synthetic-account-token");
    expect(fetcher.mock.calls[0][0]).toBe("/api/work/auth/login");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ account: "student", password: "synthetic-password" });
  });

  it("retries the same exact input identity only when explicitly called", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(response({ id: pending.input.request_id, status: "running" }));
    vi.stubGlobal("fetch", fetcher);
    const client = new WorkClient("account-token");
    await expect(client.submit(pending)).rejects.toMatchObject({ code: "result_unknown" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.submit(pending);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer account-token");
    expect(new Headers(fetcher.mock.calls[0][1].headers).has("X-Hosted-Work-Key")).toBe(false);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("api_key");
  });

  it("uses fixed same-origin endpoints and never follows credential redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ models: [], max_file_bytes: 1024 }));
    vi.stubGlobal("fetch", fetcher);
    await new WorkClient("account-token").models();
    expect(fetcher.mock.calls[0][0]).toBe("/api/work/models");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });

  it("preserves cancellation rather than sending a fallback request", async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError"));
    vi.stubGlobal("fetch", fetcher);
    await expect(new WorkClient("account-token").events("b".repeat(32), 0)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a false login success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ success: true })));
    await expect(login("someone", "synthetic-password")).rejects.toMatchObject({ code: "invalid_login" });
  });

  it("uses one upload identity and retains the original file bytes", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ id: "d".repeat(32) }, 201));
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["hello"], "课程资料.txt");
    await new WorkClient("account-token").upload("a".repeat(32), "d".repeat(32), file);
    expect(fetcher.mock.calls[0][0]).toContain(encodeURIComponent(file.name));
    expect(fetcher.mock.calls[0][1].body).toBe(file);
    expect(fetcher.mock.calls[0][1].method).toBe("PUT");
  });
});
