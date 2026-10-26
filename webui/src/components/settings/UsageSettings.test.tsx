import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGatewayHttpBase: vi.fn(),
  httpFetch: vi.fn(),
  getCreditUsage: vi.fn(),
  loggedIn: false,
  account: "account-a",
}));

vi.mock("@/lib/api", () => ({
  getGatewayHttpBase: mocks.getGatewayHttpBase,
}));
vi.mock("@/lib/tauri", () => ({ httpFetch: mocks.httpFetch, getCreditUsage: mocks.getCreditUsage }));
vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    loggedIn: mocks.loggedIn,
    licenseInfo: mocks.loggedIn
      ? { account: mocks.account, email: `${mocks.account}@example.com` }
      : null,
  }),
}));

import { formatTokens, UsageSettings } from "./UsageSettings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function managedUsage(requestId: string, amount: string) {
  return {
    period_spent_amount: amount,
    pending_reserved_amount: "0",
    recent: [{
      request_id: requestId,
      model: "deepseek-v4-flash",
      billing_type: "token" as const,
      status: "settled",
      spent_amount: amount,
      reserved_amount: "0",
      created_at: "2026-10-17T08:00:00Z",
      settled_at: "2026-10-17T08:01:00Z",
    }],
  };
}

describe("UsageSettings", () => {
  beforeEach(() => {
    mocks.getGatewayHttpBase.mockReset();
    mocks.httpFetch.mockReset();
    mocks.getCreditUsage.mockReset();
    mocks.loggedIn = false;
    mocks.account = "account-a";
    mocks.getCreditUsage.mockRejectedValue(new Error("Not logged in"));
    mocks.getGatewayHttpBase.mockResolvedValue("http://127.0.0.1:17173");
    mocks.httpFetch.mockResolvedValue(new Response(JSON.stringify({
      period_days: 30,
      today_tokens: 84_900,
      period_tokens: 120_000,
      request_count: 12,
      model_count: 2,
      provider_count: 2,
      daily: Array.from({ length: 30 }, (_, index) => ({
        date: `2026-08-${String(index + 1).padStart(2, "0")}`,
        prompt_tokens: index === 25 ? 80_000 : 0,
        completion_tokens: index === 25 ? 4_900 : 0,
        cached_tokens: index === 25 ? 20_000 : 0,
        total_tokens: index === 25 ? 84_900 : 0,
      })),
      by_model: [
        {
          provider: "DeepSeek",
          model: "deepseek-chat",
          prompt_tokens: 100_000,
          completion_tokens: 10_000,
          cached_tokens: 20_000,
          total_tokens: 110_000,
          request_count: 10,
        },
      ],
      recent: [
        {
          provider: "Mona AI",
          model: "deepseek-v4-flash",
          prompt_tokens: 80_000,
          completion_tokens: 4_900,
          cached_tokens: 20_000,
          total_tokens: 84_900,
          created_at: "2026-08-26T08:00:00Z",
        },
      ],
      updated_at: "2026-08-26T08:00:00Z",
    }), { status: 200 }));
  });

  it("formats Token values with 万 and 亿 automatically", () => {
    expect(formatTokens(9_999)).toBe("9,999");
    expect(formatTokens(10_000)).toBe("1万");
    expect(formatTokens(8_002_000)).toBe("800.2万");
    expect(formatTokens(100_000_000)).toBe("1亿");
    expect(formatTokens(123_456_789)).toBe("1.2亿");
  });

  it("shows all-provider local Token usage without mixing in billing", async () => {
    render(<UsageSettings />);

    expect(await screen.findByRole("heading", { name: "用量统计" })).toBeInTheDocument();
    expect(screen.getByText("今日 Token")).toBeInTheDocument();
    expect(screen.getByText("8.5万")).toBeInTheDocument();
    expect(screen.getByText("12万")).toBeInTheDocument();
    expect(screen.getByText("模型供应商")).toBeInTheDocument();
    expect(screen.getByText("调用记录")).toBeInTheDocument();
    expect(screen.getByText(/Code 中的原生模型调用暂未计入/)).toBeInTheDocument();
    expect(screen.queryByText("近 30 天费用")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "近 20 周活跃热力图" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "用量趋势" }).querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "近 30 天 Token 柱状图" })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getAllByText("deepseek-chat").length).toBeGreaterThan(0);
    expect(screen.queryByText("deepseek-v4-flash")).not.toBeInTheDocument();
    expect(mocks.getCreditUsage).not.toHaveBeenCalled();
    expect(mocks.httpFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/usage\?tz_offset_minutes=/),
    );
  });

  it("calculates cache hit rate from aggregate cached and input Tokens", async () => {
    const usage = {
      period_days: 30,
      today_tokens: 120_000,
      period_tokens: 120_000,
      request_count: 11,
      model_count: 2,
      provider_count: 2,
      daily: [{
        date: "2026-08-26",
        prompt_tokens: 110_000,
        completion_tokens: 10_000,
        cached_tokens: 20_000,
        total_tokens: 120_000,
      }],
      by_model: [
        {
          provider: "DeepSeek",
          model: "deepseek-chat",
          prompt_tokens: 100_000,
          completion_tokens: 10_000,
          cached_tokens: 20_000,
          total_tokens: 110_000,
          request_count: 10,
        },
        {
          provider: "DeepSeek",
          model: "zero-input-model",
          prompt_tokens: 0,
          completion_tokens: 10_000,
          cached_tokens: 0,
          total_tokens: 10_000,
          request_count: 1,
        },
        {
          provider: "DeepSeek",
          model: "legacy-overflow-model",
          prompt_tokens: 1_000,
          completion_tokens: 10_000,
          cached_tokens: 1_200,
          total_tokens: 11_000,
          request_count: 1,
        },
      ],
      recent: [],
      updated_at: "2026-08-26T08:00:00Z",
    };
    mocks.httpFetch.mockResolvedValueOnce(new Response(JSON.stringify(usage), { status: 200 }));

    render(<UsageSettings />);

    const modelTable = within(await screen.findByRole("region", { name: "按模型" })).getByRole("table");
    const cachedModel = within(modelTable).getByRole("row", { name: /deepseek-chat/ });
    const zeroInputModel = within(modelTable).getByRole("row", { name: /zero-input-model/ });
    const legacyModel = within(modelTable).getByRole("row", { name: /legacy-overflow-model/ });

    expect(within(cachedModel).getByRole("cell", { name: "20.0%" })).toBeInTheDocument();
    expect(within(zeroInputModel).getByRole("cell", { name: "—" })).toBeInTheDocument();
    expect(within(legacyModel).getByRole("cell", { name: "—" })).toBeInTheDocument();
    expect(within(modelTable).getByRole("columnheader", { name: "缓存命中率" })).toBeInTheDocument();
  });

  it.each([
    { model: "near-full-cache-model", prompt_tokens: 10_000, cached_tokens: 9_999, expected: "<100%" },
    { model: "tiny-cache-model", prompt_tokens: 100_000, cached_tokens: 49, expected: "<0.1%" },
  ])("keeps rounded cache hit rate accurate for $model", async ({ model, prompt_tokens, cached_tokens, expected }) => {
    const usage = {
      period_days: 30,
      today_tokens: prompt_tokens,
      period_tokens: prompt_tokens,
      request_count: 1,
      model_count: 1,
      provider_count: 1,
      daily: [{ date: "2026-08-26", prompt_tokens, completion_tokens: 0, cached_tokens, total_tokens: prompt_tokens }],
      by_model: [{
        provider: "DeepSeek",
        model,
        prompt_tokens,
        completion_tokens: 0,
        cached_tokens,
        total_tokens: prompt_tokens,
        request_count: 1,
      }],
      recent: [],
      updated_at: "2026-08-26T08:00:00Z",
    };
    mocks.httpFetch.mockResolvedValueOnce(new Response(JSON.stringify(usage), { status: 200 }));

    render(<UsageSettings />);

    const modelTable = within(await screen.findByRole("region", { name: "按模型" })).getByRole("table");
    const row = within(modelTable).getByRole("row", { name: new RegExp(model) });
    expect(within(row).getByRole("cell", { name: expected })).toBeInTheDocument();
  });

  it("does not display zero metrics when the local service is unavailable", async () => {
    mocks.getGatewayHttpBase.mockResolvedValue("");

    render(<UsageSettings />);

    await waitFor(() => expect(screen.getByText(/本机用量服务未启动/)).toBeInTheDocument());
    expect(screen.queryByText("今日 Token")).not.toBeInTheDocument();
  });

  it("shows Mona AI consumption and media usage without reserved balance or Token request records", async () => {
    mocks.loggedIn = true;
    mocks.getCreditUsage.mockResolvedValue({
      period_spent_amount: "0.142619",
      pending_reserved_amount: "0.58",
      recent: [
        {
          request_id: "token-request-uncertain-1234567890abcdef",
          model: "deepseek-v4-flash",
          billing_type: "token",
          status: "uncertain",
          spent_amount: null,
          reserved_amount: "0.58",
          usage: null,
          created_at: "2026-06-01T08:00:00Z",
          settled_at: "2026-06-01T08:01:00Z",
        },
        {
          request_id: "token-request-settled-1234567890abcdef",
          model: "qwen3.8-flash",
          billing_type: "token",
          status: "settled",
          spent_amount: "0.04",
          reserved_amount: "0",
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
          created_at: "2026-08-25T08:00:00Z",
          settled_at: "2026-08-25T08:01:00Z",
        },
        {
          request_id: "image-1",
          model: "qwen-image-3.0",
          billing_type: "image",
          status: "settled",
          spent_amount: "0.36",
          reserved_amount: "0",
          usage: { output_image_count: 2, output_image_type: "qima_output_1k" },
          created_at: "2026-08-26T08:00:00Z",
          settled_at: "2026-08-26T08:01:00Z",
        },
        {
          request_id: "video-1",
          model: "wan2.6-t2v",
          billing_type: "video",
          status: "settled",
          spent_amount: "2.7",
          reserved_amount: "0",
          usage: { duration: 4.5, SR: 720 },
          created_at: "2026-08-26T09:00:00Z",
          settled_at: "2026-08-26T09:05:00Z",
        },
      ],
    });

    render(<UsageSettings />);

    expect(await screen.findByRole("heading", { name: "图片与视频用量" })).toBeInTheDocument();
    expect(screen.getByText("Mona AI 近30天消费")).toBeInTheDocument();
    expect(screen.getByText("¥0.14")).toBeInTheDocument();
    expect(screen.queryByText("Mona AI 预留余额")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Mona AI Token 调用记录" })).not.toBeInTheDocument();
    expect(screen.queryByText("token-request-uncertain-1234567890abcdef")).not.toBeInTheDocument();
    expect(screen.queryByText("token-request-settled-1234567890abcdef")).not.toBeInTheDocument();
    expect(screen.getByText("2 张 · qima_output_1k")).toBeInTheDocument();
    expect(screen.getByText("4.5 秒 · 720P")).toBeInTheDocument();
  });

  it("shows an inline billing error for a logged-in user without hiding local usage", async () => {
    mocks.loggedIn = true;
    mocks.getCreditUsage.mockRejectedValue(new Error("network unavailable"));

    render(<UsageSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Mona AI 费用暂时无法查询，请刷新重试。");
    expect(screen.getByText("今日 Token")).toBeInTheDocument();
    expect(screen.getByText("12万")).toBeInTheDocument();
  });

  it("ignores a prior account's late billing response and clears billing data on logout", async () => {
    mocks.loggedIn = true;
    const accountARequest = deferred<ReturnType<typeof managedUsage>>();
    const accountBRequest = deferred<ReturnType<typeof managedUsage>>();
    mocks.getCreditUsage
      .mockReturnValueOnce(accountARequest.promise)
      .mockReturnValueOnce(accountBRequest.promise);

    const { rerender } = render(<UsageSettings />);
    await waitFor(() => expect(mocks.getCreditUsage).toHaveBeenCalledTimes(1));

    mocks.account = "account-b";
    rerender(<UsageSettings />);
    await waitFor(() => expect(mocks.getCreditUsage).toHaveBeenCalledTimes(2));

    await act(async () => accountBRequest.resolve(managedUsage("request-account-b", "2")));
    expect(await screen.findByText("¥2.00")).toBeInTheDocument();

    await act(async () => accountARequest.resolve(managedUsage("request-account-a", "1")));
    expect(screen.getByText("¥2.00")).toBeInTheDocument();
    expect(screen.queryByText("¥1.00")).not.toBeInTheDocument();

    mocks.loggedIn = false;
    mocks.account = "";
    rerender(<UsageSettings />);
    await waitFor(() => expect(screen.getByText("今日 Token")).toBeInTheDocument());
    expect(screen.queryByText("¥2.00")).not.toBeInTheDocument();
    expect(screen.queryByText("Mona AI 近30天消费")).not.toBeInTheDocument();
    expect(mocks.getCreditUsage).toHaveBeenCalledTimes(2);
  });
});
