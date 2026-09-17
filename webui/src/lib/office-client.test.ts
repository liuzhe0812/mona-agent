import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  httpFetch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getServicesHttpBase: async () => "http://127.0.0.1:17174",
}));

vi.mock("@/lib/tauri", () => ({
  httpFetch: mocks.httpFetch,
}));

import {
  createOfficeSession,
  deleteOfficeSession,
  importOfficeSession,
  OfficeClientError,
  uploadOfficeCheckpoint,
} from "./office-client";

describe("office client", () => {
  beforeEach(() => mocks.httpFetch.mockReset());

  it("imports authorized file bytes with an encoded filename and owner", async () => {
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({ sessionId: "office_import" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const file = new Uint8Array([80, 75, 3, 4]).buffer;
    await importOfficeSession({
      filename: "收入 & 支出.xlsx",
      sourceIdentity: "D:/project/收入 & 支出.xlsx",
      ownerSessionKey: "websocket:project-1",
    }, file);
    const [url, init] = mocks.httpFetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/office/import");
    expect(new URL(url).searchParams.get("filename")).toBe("收入 & 支出.xlsx");
    expect(new Headers(init.headers).get("X-Mona-Session-Key")).toBe("websocket:project-1");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream");
    expect(init.body).toBe(file);
  });

  it("sends the owner binding without exposing the services token", async () => {
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({
      sessionId: "office_1",
      displayName: "input.xlsx",
      type: "sheets",
      version: { editorEpoch: "epoch_1", modelRevision: 0 },
      checkpointVersion: null,
      savedVersion: null,
      dirty: false,
      editorConnected: false,
      saveState: "clean",
      lastError: null,
    }), { status: 201, headers: { "Content-Type": "application/json" } }));

    await createOfficeSession({ ownerSessionKey: "chat:1", path: "input.xlsx" });

    const [, init] = mocks.httpFetch.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Mona-Session-Key")).toBe("chat:1");
    expect(headers.has("X-Mona-Token")).toBe(false);
  });

  it("uploads checkpoint bytes with an exact version and digest", async () => {
    mocks.httpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        uploadId: "upload_1",
        chunkBytes: 2,
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ received: 2 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ received: 4 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionId: "office_1",
        version: { editorEpoch: "epoch_1", modelRevision: 1 },
        size: 4,
        sha256: "a".repeat(64),
        workingFileName: "working.xlsx",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const file = new Uint8Array([1, 2, 3, 4]).buffer;

    await uploadOfficeCheckpoint(
      "office_1",
      "chat:1",
      { editorEpoch: "epoch_1", modelRevision: 1 },
      file,
    );

    expect(mocks.httpFetch).toHaveBeenCalledTimes(4);
    const [startUrl, startInit] = mocks.httpFetch.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toContain("/checkpoint-uploads");
    const startBody = JSON.parse(String(startInit.body));
    expect(startBody.version).toEqual({ editorEpoch: "epoch_1", modelRevision: 1 });
    expect(startBody.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [firstChunkUrl, firstChunkInit] = mocks.httpFetch.mock.calls[1] as [string, RequestInit];
    expect(firstChunkUrl).toContain("offset=0");
    expect((firstChunkInit.body as ArrayBuffer).byteLength).toBe(2);
    const [finishUrl] = mocks.httpFetch.mock.calls[3] as [string, RequestInit];
    expect(finishUrl).toContain("/finish");
  });

  it("deletes through the dedicated endpoint so the editor's close path is untouched", async () => {
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await deleteOfficeSession("office_1", "chat:1");

    const [url, init] = mocks.httpFetch.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/office/sessions/office_1/delete");
    expect(init.method).toBe("POST");
  });

  it("reports a missing endpoint as an outdated service instead of a bare 404", async () => {
    // An older services build answers unknown routes with a plain-text 404,
    // which used to surface as the opaque "文档编辑请求失败（404）".
    mocks.httpFetch.mockResolvedValue(new Response("404: Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));

    await expect(deleteOfficeSession("office_1", "chat:1")).rejects.toMatchObject({
      code: "EDITOR_UNAVAILABLE",
      message: expect.stringContaining("版本过旧"),
      retryable: true,
    });
  });

  it("keeps the structured session-not-found error from the service", async () => {
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({
      error: { code: "SESSION_NOT_FOUND", message: "Office 会话不存在。", retryable: false },
    }), { status: 404, headers: { "Content-Type": "application/json" } }));

    await expect(deleteOfficeSession("office_1", "chat:1")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
      message: "Office 会话不存在。",
      retryable: false,
    });
    expect(OfficeClientError).toBeDefined();
  });
});
