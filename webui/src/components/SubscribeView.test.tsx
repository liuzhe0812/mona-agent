import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SubscribeView } from "./SubscribeView";

vi.mock("@/hooks/useLicense", () => ({
  useLicense: () => ({
    pricingConfig: {
      plans: [
        { id: "monthly", name: "月付", price: 5.9, durationMonths: 1 },
        { id: "quarterly", name: "季付", price: 14.9, durationMonths: 3 },
        {
          id: "yearly",
          name: "年付",
          price: 49.9,
          originalPrice: 69.9,
          durationMonths: 12,
          badge: "推荐",
        },
      ],
      contact: { email: "", wechat: "" },
      promotionalBanner: null,
      promoTrial: null,
    },
    pricingError: null,
    refreshLicense: vi.fn(),
    licenseActive: false,
    serverTrial: false,
    fetchPricing: vi.fn(),
  }),
}));

describe("SubscribeView", () => {
  it("sells devices and cloud workspace without locking local AI or gifting tokens", () => {
    render(<SubscribeView userEmail="user@example.com" onBackToLogin={vi.fn()} />);

    expect(screen.getByText("最多 3 台设备登录")).toBeTruthy();
    expect(screen.getByText("10GB 个人云空间")).toBeTruthy();
    expect(screen.getByText("Work 会话与关联文件同步")).toBeTruthy();
    expect(screen.queryByText("解锁笔记 AI、邮件 AI 与知识库 AI")).toBeNull();
    expect(screen.queryByText("解锁数据库 AI 与终端 AI")).toBeNull();
    expect(screen.getByText(/本地 AI 功能免费；Pro 不含模型额度/)).toBeTruthy();
    expect(screen.getByText("早期用户价")).toBeTruthy();
  });
});
