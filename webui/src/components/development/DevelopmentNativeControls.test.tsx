import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevDecision, ExecutorSettings } from "@/lib/development-api";

const api = vi.hoisted(() => ({ executorSettings: vi.fn(), updateExecutorSettings: vi.fn(), probe: vi.fn(), login: vi.fn(), loginStatus: vi.fn(), cancelLogin: vi.fn(), decide: vi.fn() }));
const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
vi.mock("./useDevelopmentSession", () => ({ refreshDevelopmentSession: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => false, openExternalUrl }));

import { DevelopmentExecutors } from "./DevelopmentExecutors";
import { DevelopmentDecision } from "./DevelopmentDecisions";

const settings: ExecutorSettings = { revision: "revision-1", values: {
  codexPath: null, claudePath: null, codebuddyPath: null,
  claudeApiKeyEnv: "ANTHROPIC_API_KEY", codebuddyApiKeyEnv: "CODEBUDDY_API_KEY",
}, credentialPresent: { claude: false, codebuddy: false } };

beforeEach(() => {
  vi.clearAllMocks();
  api.executorSettings.mockResolvedValue(settings);
  api.updateExecutorSettings.mockImplementation(async (_old, values) => ({ ...settings, revision: "revision-2", values }));
  api.probe.mockResolvedValue({ state: "detected", reason: "待验证" });
  api.loginStatus.mockResolvedValue({ state: "idle", loginId: null, authUrl: "", reason: "" });
  api.login.mockImplementation(async () => {
    const value = { state: "waiting", authUrl: "https://codebuddy.cn/login", loginId: "managed", reason: "等待官方登录" };
    api.loginStatus.mockResolvedValue(value); return value;
  });
  api.decide.mockResolvedValue({ accepted: true });
});
afterEach(async () => { await act(async () => { cleanup(); }); });

function openSettings() {
  return render(<DevelopmentExecutors open onClose={vi.fn()} projectId="project-one" executors={[]} onChanged={vi.fn()} />);
}

describe("native executor controls", () => {
  it("requires saved configuration before a connection or login can use it", async () => {
    openSettings();
    const path = await screen.findByRole("textbox", { name: "Codex 程序路径" });
    fireEvent.change(path, { target: { value: "D:/tools/codex.exe" } });
    const probes = screen.getAllByRole("button", { name: "检查连接" });
    probes.forEach((button) => expect(button).toBeDisabled());
    screen.getAllByRole("button", { name: "获取官方登录链接" }).forEach((button) => expect(button).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(probes[0]).not.toBeDisabled());
    expect(api.updateExecutorSettings).toHaveBeenCalledWith(settings, expect.objectContaining({ codexPath: "D:/tools/codex.exe" }));
    expect(api.probe).not.toHaveBeenCalled();
  });

  it("exposes official CodeBuddy login without adding Claude subscription impersonation", async () => {
    openSettings();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "获取官方登录链接" })[1]).not.toBeDisabled());
    const buttons = screen.getAllByRole("button", { name: "获取官方登录链接" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(api.login).toHaveBeenCalledWith("project-one", "codebuddy"));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://codebuddy.cn/login"));
    expect(await screen.findByRole("button", { name: "重新打开授权页" })).toBeInTheDocument();
  });

  it("shows dependency failures with an actionable cause instead of claiming a connection", async () => {
    api.probe.mockResolvedValueOnce({ state: "unavailable", stage: "dependency", sdkVersion: null,
      errorCode: "sdk_not_installed", reason: "缺少配套 SDK", nextAction: "修复开发依赖", executable: "D:/tools/codebuddy.exe" });
    openSettings();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "检查连接" })[2]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "检查连接" })[2]);
    expect(await screen.findByText("修复开发依赖")).toBeInTheDocument();
    expect(screen.getByText("配套依赖")).toBeInTheDocument();
    expect(screen.queryByText(/连接就绪/)).not.toBeInTheDocument();
    expect(api.login).not.toHaveBeenCalled();
  });

  it("distinguishes native handshake, CLI version, SDK version and unverified authentication", async () => {
    api.probe.mockResolvedValueOnce({ state: "detected", stage: "authentication", protocolVerified: true,
      authentication: "unknown", version: "0.3.264", sdkVersion: "0.3.264", reason: "原生协议已响应" });
    openSettings();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "检查连接" })[2]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "检查连接" })[2]);
    expect(await screen.findByText(/CLI 0.3.264 · SDK 0.3.264/)).toBeInTheDocument();
    expect(screen.getByText(/这不代表模型认证/)).toBeInTheDocument();
    expect(screen.queryByText(/连接就绪/)).not.toBeInTheDocument();
  });

  it("ignores a late diagnostic response after changing the target project", async () => {
    let finish!: (value: unknown) => void;
    api.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const changed = vi.fn();
    const view = render(<DevelopmentExecutors open onClose={vi.fn()} projectId="project-one" executors={[]} onChanged={changed} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "检查连接" })[0]).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "检查连接" })[0]);
    view.rerender(<DevelopmentExecutors open onClose={vi.fn()} projectId="project-two" executors={[]} onChanged={changed} />);
    await act(async () => { finish({ state: "ready", reason: "OLD_PROJECT_RESULT" }); });
    expect(screen.queryByText("OLD_PROJECT_RESULT")).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it("binds question answers to the exact session and decision", async () => {
    const decision: DevDecision = { id: "decision-one", sessionId: "session-one", runId: "run-one", kind: "question",
      details: { questions: [{ id: "question-0", question: "选择环境", options: [{ label: "内网" }] }] } };
    render(<DevelopmentDecision decision={decision} />);
    fireEvent.click(screen.getByRole("button", { name: "内网", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith("session-one", "decision-one", { "question-0": ["内网"] }));
  });

  it("does not treat a permission click as a request to send another task", async () => {
    render(<DevelopmentDecision decision={{ id: "approve-one", sessionId: "session-two", runId: "run-two", kind: "permission", details: { command: "echo test" } }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "仅同意这一次" })); });
    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledWith("session-two", "approve-one", "accept");
  });
});