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
  it("shows Pro benefits before early-user pricing", () => {
    render(<SubscribeView userEmail="user@example.com" onBackToLogin={vi.fn()} />);

    expect(screen.getByText("让 Mona 理解你的工作上下文")).toBeTruthy();
    expect(screen.getByText("在终端、数据库中直接获得 AI 协作")).toBeTruthy();
    expect(screen.getByText("使用知识库、AI 文档与跨模块知识沉淀")).toBeTruthy();
    expect(screen.getByText("早期用户价")).toBeTruthy();
  });
});
