import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { developmentApi, type DevExecutor } from "@/lib/development-api";
import { OpenAiSubscriptionAction } from "./OpenAiSubscriptionAction";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("allows ChatGPT login when Codex is disabled but its program is available", async () => {
  const executor = { id: "codex", name: "Codex", available: false, enabled: false, programAvailable: true, reason: "", models: [] } as DevExecutor;
  const waiting = { loginId: "login-1", state: "waiting", authUrl: "https://auth.openai.com/authorize", reason: "等待授权" } as const;
  vi.spyOn(developmentApi, "loginStatus")
    .mockResolvedValueOnce({ loginId: null, state: "idle", authUrl: "", reason: "" })
    .mockResolvedValue(waiting);
  vi.spyOn(developmentApi, "login").mockResolvedValue(waiting);
  const cancel = vi.spyOn(developmentApi, "cancelLogin").mockResolvedValue({ loginId: "login-1", state: "cancelled", authUrl: "", reason: "已取消" });
  vi.spyOn(window, "open").mockImplementation(() => null);
  render(<OpenAiSubscriptionAction executor={executor} onChanged={vi.fn()} />);

  fireEvent.click(await screen.findByRole("button", { name: "使用本机 Codex 账号" }));
  await waitFor(() => expect(developmentApi.login).toHaveBeenCalledWith(undefined, "codex"));
  expect(window.open).toHaveBeenCalledWith(waiting.authUrl, "_blank", "noopener,noreferrer");
  fireEvent.click(await screen.findByRole("button", { name: "取消连接" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(undefined, "codex", "login-1"));
});

it("confirms before disconnecting an authenticated ChatGPT account", async () => {
  const executor = { id: "codex", name: "Codex", available: true, reason: "", models: [],
    probe: { state: "ready", reason: "", authentication: "ready", authMode: "chatgpt" } } as DevExecutor;
  vi.spyOn(developmentApi, "loginStatus").mockResolvedValue({ loginId: null, state: "idle", authUrl: "", reason: "" });
  const logout = vi.spyOn(developmentApi, "logout").mockResolvedValue({ ok: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onChanged = vi.fn();
  render(<OpenAiSubscriptionAction executor={executor} onChanged={onChanged} />);

  const button = screen.getByRole("button", { name: "断开连接" });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() => expect(logout).toHaveBeenCalledWith("codex"));
  expect(onChanged).toHaveBeenCalledOnce();
});
