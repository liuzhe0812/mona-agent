import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  StockVibeAttentionSettings,
  type StockVibeAttentionSettingsValue,
} from "./StockVibeAttentionSettings";

const value: StockVibeAttentionSettingsValue = {
  proactive_mode: "important_changes",
  watched_symbols: [],
  notification_start: "09:30",
  notification_end: "15:00",
  attention_interval_sec: 300,
  data_sources: ["tencent", "baostock", "tushare"],
};

function renderSettings(overrides: Partial<StockVibeAttentionSettingsValue> = {}) {
  const onSave = vi.fn();
  render(
    <StockVibeAttentionSettings
      open
      onOpenChange={vi.fn()}
      value={{ ...value, ...overrides }}
      saving={false}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe("StockVibeAttentionSettings", () => {
  it("shows connected source choices, explains unavailable sources, and saves an empty scope only on click", () => {
    const onSave = renderSettings();

    expect(screen.getByRole("button", { name: "腾讯" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "东方财富" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText(/Baostock、AkShare、Tushare、Gildata.*尚未接入/)).toBeInTheDocument();
    expect(screen.getByText(/空范围不会扫描全市场/)).toBeInTheDocument();
    expect(screen.getByText(/应用完全退出后不会运行/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存关注设置" }));

    expect(onSave).toHaveBeenCalledWith({
      ...value,
      watched_symbols: [],
      data_sources: ["tencent"],
    });
  });

  it("renders saved symbols without suffixes", () => {
    renderSettings({ watched_symbols: ["600000.SH", "000001.SZ"] });

    expect(screen.getByLabelText("关注范围")).toHaveValue("600000\n000001");
    expect(screen.getByLabelText("关注范围")).toHaveAttribute("placeholder", "600000\n000001");
    expect(screen.getByText(/仅输入六位 A 股代码/)).toBeInTheDocument();
  });

  it("infers exchanges and de-duplicates bare codes split by lines or commas", () => {
    const onSave = renderSettings();
    fireEvent.change(screen.getByLabelText("关注范围"), {
      target: { value: "600000, 000001\n600000" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存关注设置" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      watched_symbols: ["600000.SH", "000001.SZ"],
    }));
  });

  it("saves connected sources and the minute interval in seconds", () => {
    const onSave = renderSettings({ data_sources: ["tencent"] });
    fireEvent.click(screen.getByRole("button", { name: "东方财富" }));
    fireEvent.change(screen.getByLabelText("检查间隔（分钟）"), { target: { value: "7.5" } });

    fireEvent.click(screen.getByRole("button", { name: "保存关注设置" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      proactive_mode: "important_changes",
      data_sources: ["tencent", "eastmoney"],
      attention_interval_sec: 450,
    }));
  });

  it("rejects malformed symbols and more than 50 unique symbols", () => {
    const onSave = renderSettings();
    const symbols = screen.getByLabelText("关注范围");
    const save = screen.getByRole("button", { name: "保存关注设置" });

    fireEvent.change(symbols, { target: { value: "6000" } });
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent("代码需为六位数字。");
    expect(onSave).not.toHaveBeenCalled();

    const tooMany = Array.from({ length: 51 }, (_, index) => String(600000 + index)).join("\n");
    fireEvent.change(symbols, { target: { value: tooMany } });
    fireEvent.click(save);
    expect(screen.getByRole("alert")).toHaveTextContent("最多可关注 50 个");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("asks users to check an unknown bare code", () => {
    const onSave = renderSettings();
    fireEvent.change(screen.getByLabelText("关注范围"), { target: { value: "999999" } });

    fireEvent.click(screen.getByRole("button", { name: "保存关注设置" }));

    expect(screen.getByRole("alert")).toHaveTextContent("暂无法识别代码，请核对六位 A 股代码。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("后缀");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("requires valid times and a check interval of at least five minutes", () => {
    const onSave = renderSettings();
    fireEvent.change(screen.getByLabelText("开始"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关注设置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("有效的开始和结束时间");

    fireEvent.change(screen.getByLabelText("开始"), { target: { value: "09:30" } });
    fireEvent.change(screen.getByLabelText("检查间隔（分钟）"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关注设置" }));
    expect(screen.getByRole("alert")).toHaveTextContent("至少为 5 分钟");
    expect(onSave).not.toHaveBeenCalled();
  });
});
