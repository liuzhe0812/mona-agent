import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import * as api from "@/lib/api";
import type { SessionUsageSummary } from "@/lib/types";
import { SessionUsagePopover } from "./SessionUsagePopover";

describe("SessionUsagePopover", () => {
  const usage: SessionUsageSummary = {
    promptTokens: 2000,
    completionTokens: 500,
    cacheReadTokens: 750,
    cacheWriteTokens: 125,
    cacheHitRate: 0.375,
    latencyMs: 120000,
    outputTokensPerSecond: 4.166,
    models: ["model-a", "model-b"],
  };

  it("shows context window usage on hover and opens the details on click", async () => {
    render(<SessionUsagePopover usage={usage} contextUsage={{ used: 56_700, total: 1_000_000 }} />);
    const name = i18n.t("thread.composer.contextUsage.panel");
    const button = screen.getByRole("button", { name });

    fireEvent.pointerMove(button, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Context window");
    expect(tooltip).toHaveTextContent("5.7% used (94.3% remaining)");
    expect(tooltip).toHaveTextContent("56.7k of 1M tokens used");

    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name })).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the reported task totals and supporting details", async () => {
    render(<SessionUsagePopover usage={usage} />);
    const name = i18n.t("thread.composer.contextUsage.panel");
    const button = screen.getByRole("button", { name });
    expect(button.querySelector("svg")).toBeInTheDocument();
    expect(button).toHaveTextContent("");
    fireEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name });
    expect(within(dialog).getByText("Token").parentElement).toHaveTextContent("2.5k (Input 2k · Output 500)");
    expect(within(dialog).getByText("Cache hit rate").nextElementSibling).toHaveTextContent(/^37\.5%$/);
    expect(within(dialog).getByText("Time").parentElement).toHaveTextContent("120 s");
    expect(within(dialog).getByText("Speed").parentElement).toHaveTextContent("4.2 tok/s");
    const modelList = within(dialog).getByRole("list");
    expect(within(modelList).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["model-a", "model-b"]);
  });

  it("distinguishes zero from unavailable values", async () => {
    render(<SessionUsagePopover usage={{
      ...usage,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
      cacheHitRate: null,
      latencyMs: null,
      outputTokensPerSecond: null,
      models: [],
    }} />);
    const name = i18n.t("thread.composer.contextUsage.panel");
    fireEvent.click(screen.getByRole("button", { name }));

    const dialog = await screen.findByRole("dialog", { name });
    expect(within(dialog).getByText("Cache hit rate").nextElementSibling).toHaveTextContent(/^Not reported$/);
    expect(within(dialog).getByText("Time").parentElement).toHaveTextContent("Not reported");
    expect(within(dialog).getByText("Speed").parentElement).toHaveTextContent("Not reported");
    expect(within(dialog).getByText("Models").parentElement).toHaveTextContent("Not reported");
  });

  it("keeps a saved session window when history arrives, edits in K/M, and resets to automatic", async () => {
    const load = vi.spyOn(api, "fetchSessionContext").mockResolvedValue({ windowTokens: 64_000, effectiveWindowTokens: 64_000, isBudget: true });
    const update = vi.spyOn(api, "updateSessionContext")
      .mockResolvedValueOnce({ windowTokens: 1_000_000, effectiveWindowTokens: 1_000_000, isBudget: true })
      .mockResolvedValueOnce({ windowTokens: null, effectiveWindowTokens: 1_000_000, isBudget: true });
    try {
      const session = { token: "token", key: "websocket:session-a" };
      const view = render(<SessionUsagePopover usage={usage} contextUsage={null} contextSession={session} />);
      await waitFor(() => expect(load).toHaveBeenCalledWith("token", "websocket:session-a"));
      view.rerender(<SessionUsagePopover usage={usage} contextUsage={{ used: 16_000, total: 1_000_000, isBudget: true }} contextSession={session} />);
      fireEvent.click(screen.getByRole("button", { name: "Context and task usage" }));
      expect(await screen.findByText("25% · 16k / 64k work budget used")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Session window settings" }));
      const input = screen.getByRole("spinbutton", { name: "Session context window" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
      expect(input).toHaveValue(64);
      fireEvent.change(input, { target: { value: "1" } });
      fireEvent.pointerDown(screen.getByRole("button", { name: "Window unit" }), { button: 0, ctrlKey: false });
      fireEvent.click(screen.getByRole("menuitem", { name: "M" }));
      expect(input).toHaveValue(1);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(update).toHaveBeenCalledWith("token", "websocket:session-a", { windowTokens: 1_000_000 }));
      expect(await screen.findByText("1.6% · 16k / 1M work budget used")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
      await waitFor(() => expect(update).toHaveBeenLastCalledWith("token", "websocket:session-a", { windowTokens: null }));
      expect(await screen.findByText("1.6% · 16k / 1M work budget used")).toBeInTheDocument();
      expect(screen.getByText("Cache hit rate").nextElementSibling).toHaveTextContent("37.5%");
    } finally {
      load.mockRestore();
      update.mockRestore();
    }
  });

  it("displays the effective limit when a saved preference exceeds the model cap", async () => {
    const load = vi.spyOn(api, "fetchSessionContext").mockResolvedValue({
      windowTokens: 1_000_000, effectiveWindowTokens: 64_000, isBudget: true,
    });
    try {
      render(<SessionUsagePopover usage={null} contextUsage={{ used: 16_000, total: 1_000_000 }}
        contextSession={{ token: "token", key: "websocket:session-a" }} />);
      await waitFor(() => expect(load).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Context and task usage" }));
      expect(await screen.findByText("25% · 16k / 64k work budget used")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Session window settings" }));
      expect(screen.getByRole("spinbutton", { name: "Session context window" })).toHaveValue(1000);
    } finally {
      load.mockRestore();
    }
  });

  it("holds compaction progress and hides stale usage until a new live measurement", async () => {
    let finish!: (value: api.SessionContextSettings) => void;
    const pending = new Promise<api.SessionContextSettings>((resolve) => { finish = resolve; });
    const load = vi.spyOn(api, "fetchSessionContext").mockResolvedValue({ windowTokens: null, effectiveWindowTokens: 1_000_000, isBudget: true });
    const update = vi.spyOn(api, "updateSessionContext").mockReturnValue(pending);
    try {
      const session = { token: "token", key: "websocket:session-a" };
      const old = { contextTokens: 49_700 };
      const view = render(<SessionUsagePopover usage={usage} contextUsage={{ used: 49_700, total: 1_000_000, isBudget: true }} contextSession={session} liveMeasurement={old} />);
      await waitFor(() => expect(load).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Context and task usage" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Compact context" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
      expect(screen.getByRole("button", { name: "Compacting…" })).toBeDisabled();
      await act(async () => { finish({ windowTokens: null, effectiveWindowTokens: 1_000_000, isBudget: true, compacted: true }); await pending; });
      expect(await screen.findByText("No context usage yet")).toBeInTheDocument();
      expect(screen.getByText("Context compacted.")).toBeInTheDocument();
      view.rerender(<SessionUsagePopover usage={usage} contextUsage={{ used: 49_700, total: 1_000_000, isBudget: true }} contextSession={session} liveMeasurement={old} />);
      expect(screen.getByText("No context usage yet")).toBeInTheDocument();
      const fresh = { contextTokens: 12_000 };
      view.rerender(<SessionUsagePopover usage={usage} contextUsage={{ used: 12_000, total: 1_000_000, isBudget: true }} contextSession={session} liveMeasurement={fresh} />);
      expect(await screen.findByText("1.2% · 12k / 1M work budget used")).toBeInTheDocument();
      expect(update).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledWith("token", "websocket:session-a", { compact: true });
    } finally {
      load.mockRestore();
      update.mockRestore();
    }
  });

  it("does not restore pre-compaction history when the saved estimate is unavailable", async () => {
    const load = vi.spyOn(api, "fetchSessionContext").mockResolvedValue({
      windowTokens: 64_000, effectiveWindowTokens: 64_000, isBudget: true, compacted: true,
    });
    try {
      const session = { token: "token", key: "websocket:session-a" };
      const view = render(<SessionUsagePopover usage={null} contextUsage={null} contextSession={session} />);
      await waitFor(() => expect(load).toHaveBeenCalled());
      view.rerender(<SessionUsagePopover usage={null} contextUsage={{ used: 49_700, total: 1_000_000 }} contextSession={session} />);
      fireEvent.click(screen.getByRole("button", { name: "Context and task usage" }));
      expect(await screen.findByText("No context usage yet")).toBeInTheDocument();
    } finally {
      load.mockRestore();
    }
  });

  it("validates the window and reports when there is nothing to compact", async () => {
    const load = vi.spyOn(api, "fetchSessionContext").mockResolvedValue({ windowTokens: null, effectiveWindowTokens: 1_000_000, isBudget: true });
    const update = vi.spyOn(api, "updateSessionContext").mockRejectedValueOnce(new api.ApiError(400, "目前没有可压缩的早期对话。"));
    try {
      render(<SessionUsagePopover usage={null} contextSession={{ token: "token", key: "websocket:session-a" }} />);
      await waitFor(() => expect(load).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Context and task usage" }));
      fireEvent.click(screen.getByRole("button", { name: "Session window settings" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
      fireEvent.change(screen.getByRole("spinbutton", { name: "Session context window" }), { target: { value: "4" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent("4,096 whole tokens");
      expect(update).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Compact context" }));
      const dialog = await screen.findByRole("alertdialog", { name: "Context operation failed" });
      expect(within(dialog).getByText("There is no earlier conversation to compact.")).toBeInTheDocument();
    } finally {
      load.mockRestore();
      update.mockRestore();
    }
  });

  it.each([
    ["zh-CN", "上下文和任务统计", "缓存命中率"],
    ["zh-TW", "上下文和任務統計", "快取命中率"],
  ])("shows localized task usage in %s", async (language, name, cacheLabel) => {
    await i18n.changeLanguage(language);
    render(<SessionUsagePopover usage={usage} />);
    fireEvent.click(screen.getByRole("button", { name }));

    const dialog = await screen.findByRole("dialog", { name });
    expect(within(dialog).getByText(cacheLabel).parentElement).toHaveTextContent("37.5%");
  });

  it("shows an empty state when usage is unavailable", async () => {
    render(<SessionUsagePopover usage={null} />);
    const name = i18n.t("thread.composer.contextUsage.panel");
    fireEvent.click(screen.getByRole("button", { name }));

    const dialog = await screen.findByRole("dialog", { name });
    expect(within(dialog).getByText(i18n.t("thread.composer.sessionUsage.empty"))).toBeInTheDocument();
    expect(dialog.querySelector("dl")).not.toBeInTheDocument();
  });
});
