import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGatewayHttpBase: vi.fn(),
  httpFetch: vi.fn(),
  getCreditUsage: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getGatewayHttpBase: mocks.getGatewayHttpBase,
}));
vi.mock("@/lib/tauri", () => ({ httpFetch: mocks.httpFetch, getCreditUsage: mocks.getCreditUsage }));

import { formatTokens, UsageSettings } from "./UsageSettings";

describe("UsageSettings", () => {
  beforeEach(() => {
    mocks.getGatewayHttpBase.mockReset();
    mocks.httpFetch.mockReset();
    mocks.getCreditUsage.mockReset();
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
    expect(screen.queryByText("近 30 天费用")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "近 20 周活跃热力图" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "用量趋势" }).querySelectorAll("[title]")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "近 30 天 Token 柱状图" })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getAllByText("deepseek-chat").length).toBeGreaterThan(0);
    expect(screen.queryByText("deepseek-v4-flash")).not.toBeInTheDocument();
    expect(mocks.httpFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/usage\?tz_offset_minutes=/),
    );
  });

  it("does not display zero metrics when the local service is unavailable", async () => {
    mocks.getGatewayHttpBase.mockResolvedValue("");

    render(<UsageSettings />);

    await waitFor(() => expect(screen.getByText(/本机用量服务未启动/)).toBeInTheDocument());
    expect(screen.queryByText("今日 Token")).not.toBeInTheDocument();
  });

  it("shows Mona AI image and video usage by actual billing units", async () => {
    mocks.getCreditUsage.mockResolvedValue({
      period_spent_amount: "0.142619",
      pending_reserved_amount: "0",
      recent: [
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
    expect(screen.getByText("2 张 · qima_output_1k")).toBeInTheDocument();
    expect(screen.getByText("4.5 秒 · 720P")).toBeInTheDocument();
  });
});
