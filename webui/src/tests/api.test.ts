import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSession,
  fetchProviderModels,
  fetchSidebarState,
  fetchWebuiThread,
  listSessions,
  listSlashCommands,
  updateSidebarState,
  updateImageGenerationSettings,
  updateProviderSettings,
  updateSettings,
  updateStockSettings,
  updateVideoGenerationSettings,
  updateWebSearchSettings,
} from "@/lib/api";

describe("webui API helpers", () => {
  // ``request()`` in api.ts inspects the content-type header on ok
  // responses, so every stubbed response needs a ``headers.get`` shim.
  const jsonHeaders = { get: () => "application/json" };
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: jsonHeaders,
        json: async () => ({ deleted: true, key: "websocket:chat-1", messages: [] }),
      }),
    );
  });

  it("percent-encodes websocket keys when fetching webui-thread snapshot", async () => {
    await fetchWebuiThread("tok", "websocket:chat-1");

    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/websocket%3Achat-1/webui-thread",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("percent-encodes websocket keys when deleting a session", async () => {
    await deleteSession("tok", "websocket:chat-1");

    expect(fetch).toHaveBeenCalledWith(
      "/api/sessions/websocket%3Achat-1/delete",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("serializes settings updates as a narrow query string", async () => {
    await updateSettings("tok", {
      modelPreset: "default",
      model: "openrouter/test",
      provider: "openrouter",
      timezone: "Asia/Shanghai",
      botName: "mona",
      botIcon: "nb",
      toolHintMaxLength: 120,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/update?model_preset=default&model=openrouter%2Ftest&provider=openrouter&timezone=Asia%2FShanghai&bot_name=mona&bot_icon=nb&tool_hint_max_length=120",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("sends provider keys in a header instead of the URL", async () => {
    await updateProviderSettings("tok", {
      provider: "openrouter",
      apiKey: "sk-or-test",
      apiBase: "https://openrouter.ai/api/v1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/provider/update?provider=openrouter&api_base=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer tok",
          "X-Mona-Provider-Key": "sk-or-test",
        },
      }),
    );

    await fetchProviderModels("tok", {
      provider: "deepseek",
      apiKey: "sk-deepseek",
      apiBase: "https://api.deepseek.com",
    });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/settings/provider/models?provider=deepseek&api_base=https%3A%2F%2Fapi.deepseek.com",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer tok",
          "X-Mona-Provider-Key": "sk-deepseek",
        },
      }),
    );
  });

  it("serializes a custom provider name separately from its secret", async () => {
    await updateProviderSettings("tok", {
      provider: "custom",
      customName: "本地 Relay",
      apiBase: "https://relay.example/v1",
      apiKey: "custom-secret",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/provider/update?provider=custom&custom_name=%E6%9C%AC%E5%9C%B0+Relay&api_base=https%3A%2F%2Frelay.example%2Fv1",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer tok",
          "X-Mona-Provider-Key": "custom-secret",
        },
      }),
    );
  });

  it("serializes web search settings updates", async () => {
    await updateWebSearchSettings("tok", {
      provider: "searxng",
      baseUrl: "https://search.example.com",
      maxResults: 8,
      timeout: 45,
      useJinaReader: false,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/web-search/update?provider=searxng&base_url=https%3A%2F%2Fsearch.example.com&max_results=8&timeout=45&use_jina_reader=false",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("serializes image generation settings updates", async () => {
    await updateImageGenerationSettings("tok", {
      enabled: true,
      provider: "openrouter",
      model: "openai/gpt-5.4-image-2",
      defaultAspectRatio: "16:9",
      defaultImageSize: "2K",
      maxImagesPerTurn: 3,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/image-generation/update?enabled=true&provider=openrouter&model=openai%2Fgpt-5.4-image-2&default_aspect_ratio=16%3A9&default_image_size=2K&max_images_per_turn=3",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("serializes video generation settings updates", async () => {
    await updateVideoGenerationSettings("tok", {
      enabled: true,
      provider: "agnes",
      model: "agnes-video-v2.0",
      defaultAspectRatio: "16:9",
      defaultDuration: 5,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/video-generation/update?enabled=true&provider=agnes&model=agnes-video-v2.0&default_aspect_ratio=16%3A9&default_duration=5",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("reads and writes persisted sidebar state", async () => {
    const lastReadAtByKey = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `websocket:chat-${index}`,
        "2026-08-18T08:30:00Z",
      ]),
    );
    const state = {
      schema_version: 5,
      pinned_keys: ["websocket:chat-1"],
      archived_keys: ["websocket:old"],
      title_overrides: { "websocket:chat-1": "Release" },
      last_read_at_by_key: lastReadAtByKey,
      tags_by_key: {},
      collapsed_groups: {},
      view: {
        density: "compact" as const,
        show_previews: false,
        show_timestamps: false,
        show_archived: true,
        sort: "updated_desc" as const,
      },
      updated_at: null,
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: jsonHeaders,
      json: async () => state,
    } as unknown as Response);

    await expect(fetchSidebarState("tok")).resolves.toEqual(state);
    expect(fetch).toHaveBeenCalledWith(
      "/api/webui/sidebar-state",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );

    await updateSidebarState("tok", state);
    const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(String(url)).toBe("/api/webui/sidebar-state/update");
    expect(init).toEqual(expect.objectContaining({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
    }));
    expect(String(init?.body).length).toBeGreaterThan(8_192);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      pinned_keys: ["websocket:chat-1"],
      title_overrides: { "websocket:chat-1": "Release" },
      last_read_at_by_key: lastReadAtByKey,
    });
  });

  it("maps generated session titles from the sessions list", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: jsonHeaders,
      json: async () => ({
        sessions: [
          {
            key: "websocket:chat-1",
            created_at: "2026-05-01T10:00:00",
            updated_at: "2026-05-01T10:01:00",
            title: "优化 WebUI 标题",
            run_started_at: 1_700_000_000,
          },
        ],
      }),
    } as Response);

    await expect(listSessions("tok")).resolves.toMatchObject([
      {
        key: "websocket:chat-1",
        title: "优化 WebUI 标题",
        preview: "",
        runStartedAt: 1_700_000_000,
      },
    ]);
  });

  it("maps IM session summary and attention fields from the sessions list", async () => {
    // IM plan 12.1/12.3: snake_case wire fields map onto the camelCase
    // ChatSummary contract the list UI derives unread/attention state from.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: jsonHeaders,
      json: async () => ({
        sessions: [
          {
            key: "websocket:chat-1",
            created_at: "2026-08-14T10:00:00+08:00",
            updated_at: "2026-08-14T10:05:00+08:00",
            title: "每日市场简报",
            preview: "分析已完成，等待你确认后发布",
            preview_at: "2026-08-14T10:05:00+08:00",
            preview_author_type: "agent",
            preview_author_id: "com.mona.a-share-analyst",
            preview_message_type: "approval",
            workflow_run_status: "waiting_approval",
            waiting_approval: true,
            scheduled: true,
          },
          {
            key: "websocket:chat-2",
            created_at: "2026-08-14T09:00:00+08:00",
            updated_at: "2026-08-14T09:01:00+08:00",
            preview: "hello",
          },
        ],
      }),
    } as Response);

    const rows = await listSessions("tok");
    expect(rows[0]).toMatchObject({
      key: "websocket:chat-1",
      preview: "分析已完成，等待你确认后发布",
      previewAt: "2026-08-14T10:05:00+08:00",
      previewAuthorType: "agent",
      previewAuthorId: "com.mona.a-share-analyst",
      previewMessageType: "approval",
      workflowRunStatus: "waiting_approval",
      waitingApproval: true,
      scheduled: true,
    });
    // Legacy rows without the new fields map to safe defaults.
    expect(rows[1]).toMatchObject({
      previewAt: null,
      previewAuthorType: null,
      previewAuthorId: null,
      previewMessageType: null,
      workflowRunStatus: null,
      waitingApproval: false,
      scheduled: false,
    });
  });

  it("serializes stock settings updates", async () => {
    await updateStockSettings("tok", {
      enabled: true,
      autoReviewEnabled: false,
      reviewTime: "16:00",
      pushNotification: false,
      pushEmail: true,
      quoteRefreshSec: 60,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/stock/update?enabled=true&autoReviewEnabled=false&reviewTime=16%3A00&pushNotification=false&pushEmail=true&quoteRefreshSec=60",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("serializes partial stock settings updates", async () => {
    await updateStockSettings("tok", { reviewTime: "09:30" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/settings/stock/update?reviewTime=09%3A30",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });

  it("maps slash command metadata from the commands endpoint", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      headers: jsonHeaders,
      json: async () => ({
        commands: [
          {
            command: "/stop",
            title: "Stop current task",
            description: "Cancel the active task.",
            icon: "square",
          },
          {
            command: "/restart",
            title: "Restart mona",
            description: "Restart the bot process.",
            icon: "rotate-cw",
          },
          {
            command: "/history",
            title: "Show conversation history",
            description: "Print the last N messages.",
            icon: "history",
            arg_hint: "[n]",
          },
        ],
      }),
    } as Response);

    await expect(listSlashCommands("tok")).resolves.toEqual([
      {
        command: "/history",
        title: "Show conversation history",
        description: "Print the last N messages.",
        icon: "history",
        argHint: "[n]",
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/commands",
      expect.objectContaining({
        headers: { Authorization: "Bearer tok" },
      }),
    );
  });
});
