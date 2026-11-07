import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageSettingsEntry } from "./ImageSettingsEntry";

const URL = "/api/work/admin/image";
const base = { enabled: false, price: null as { amount_per_image: string } | null };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});

function setup(options: { conflict?: boolean; changed?: boolean; status?: number; ready?: boolean } = {}) {
  let revision = "a".repeat(64), configuration = structuredClone(base), conflict = !!options.conflict;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    expect(String(input)).toBe(URL);
    if (options.status) return response({ error: "denied", detail: "DO_NOT_RENDER" }, options.status);
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string);
      if (conflict || body.expected_revision !== revision) {
        conflict = false; revision = "b".repeat(64);
        if (options.changed) configuration = { ...configuration, price: { amount_per_image: "9" } };
        return response({ error: "configuration_changed" }, 409);
      }
      configuration = body.configuration;
      revision = "c".repeat(64);
    }
    return response({ revision, configuration, synchronized: true,
      availability: { ready: options.ready ?? false, message: options.ready
        ? "配置已就绪，实际调用以上游结果为准。" : "请先开放一个 Codex 模型，生图暂不可用。" } });
  });
}

function puts() {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === URL && init?.method === "PUT");
}

async function open() {
  fireEvent.click(screen.getByRole("button", { name: "设置 GPT 生图" }));
  const dialog = await screen.findByRole("dialog", { name: "GPT 生图设置" });
  await within(dialog).findByLabelText("每张图片价格（元）");
  return dialog;
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); setup(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Codex image settings", () => {
  it("starts disabled with an empty price and exposes only necessary controls", async () => {
    render(<ImageSettingsEntry token="admin" onSaved={() => {}} />);
    expect(await screen.findByText("请先开放一个 Codex 模型，生图暂不可用。")).toBeInTheDocument();
    const dialog = await open();
    expect(within(dialog).getByRole("switch", { name: "启用生图" })).toHaveAttribute("aria-checked", "false");
    expect(within(dialog).getByLabelText("每张图片价格（元）")).toHaveValue("");
    expect(within(dialog).getByText("输入 0 表示免费。")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/模型 ID|API Key|Base URL|token|预留|计费方式/i);
  });

  it.each(["1.234567", "0"])("saves the exact explicitly entered price %s", async amount => {
    const onSaved = vi.fn();
    render(<ImageSettingsEntry token="admin" onSaved={onSaved} />);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("switch", { name: "启用生图" }));
    fireEvent.change(within(dialog).getByLabelText("每张图片价格（元）"), { target: { value: amount } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(JSON.parse(puts()[0][1]!.body as string).configuration)
      .toEqual({ enabled: true, price: { amount_per_image: amount } });
  });

  it("requires a valid price before enabling instead of treating blank as free", async () => {
    render(<ImageSettingsEntry token="admin" onSaved={() => {}} />);
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("switch", { name: "启用生图" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getByText("请填写有效价格，最多六位小数。")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("每张图片价格（元）"), { target: { value: "0.0000001" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(within(dialog).getByText("请填写有效价格，最多六位小数。")).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("preserves the draft across an unrelated configuration conflict", async () => {
    setup({ conflict: true });
    const onSaved = vi.fn();
    render(<ImageSettingsEntry token="admin" onSaved={onSaved} />);
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("每张图片价格（元）"), { target: { value: "2.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(await within(dialog).findByText("配置已变化，请刷新状态后核对草稿。")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "刷新状态" }));
    await within(dialog).findByText("状态已更新，可以继续保存草稿。");
    expect(within(dialog).getByLabelText("每张图片价格（元）")).toHaveValue("2.5");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(JSON.parse(puts()[1][1]!.body as string).expected_revision).toBe("b".repeat(64));
  });

  it("does not overwrite another administrator's changed image price", async () => {
    setup({ conflict: true, changed: true });
    render(<ImageSettingsEntry token="admin" onSaved={() => {}} />);
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("每张图片价格（元）"), { target: { value: "2.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await within(dialog).findByText("配置已变化，请刷新状态后核对草稿。");
    fireEvent.click(within(dialog).getByRole("button", { name: "刷新状态" }));
    expect(await within(dialog).findByText("生图配置已被修改，请加载最新配置后核对。")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("每张图片价格（元）")).toHaveValue("2.5");
    expect(within(dialog).getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "加载最新配置" }));
    expect(within(dialog).getByLabelText("每张图片价格（元）")).toHaveValue("9");
  });

  it("does not display arbitrary server errors and shows the reported ready status", async () => {
    setup({ status: 403 });
    render(<ImageSettingsEntry token="admin" onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "设置 GPT 生图" }));
    let dialog = await screen.findByRole("dialog", { name: "GPT 生图设置" });
    expect(await within(dialog).findByText("无法读取生图配置，请检查管理员登录后重试。")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("DO_NOT_RENDER");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    setup({ ready: true });
    dialog = await open();
    expect(within(dialog).getByText("配置已就绪，实际调用以上游结果为准。")).toBeInTheDocument();
  });
});
