import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkApp } from "./WorkApp";
import type { TurnInput, WorkRun } from "./client";

const SID = "a".repeat(32);
const RID = "b".repeat(32);
const session = { id: SID, title: "资料整理", created: 1, updated: 1 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
let runs: WorkRun[];
let posts: TurnInput[];
let rejectFirst: boolean;
let fileReady: boolean;
const input: TurnInput = { request_id: RID, model_id: "official", text: "整理这份资料", attachment_ids: [] };

beforeEach(() => {
  sessionStorage.clear(); runs = []; posts = []; rejectFirst = false; fileReady = false;
  vi.stubGlobal("fetch", vi.fn(async (raw: string, init?: RequestInit) => {
    const path = String(raw);
    if (path === "/api/work/models") return response({ models: [{ id: "official", label: "平台模型", source: "mona" }], max_file_bytes: 1024 });
    if (path === "/api/work/sessions" && init?.method === "POST") return response(session, 201);
    if (path === "/api/work/sessions") return response({ sessions: [session] });
    if (path === `/api/work/sessions/${SID}`) return response({ ...session, runs,
      files: fileReady ? [{ id: "d".repeat(32), name: "结果.txt", size: 1, sha256: "e".repeat(64) }] : [] });
    if (path === `/api/work/sessions/${SID}/runs`) {
      const value = JSON.parse(String(init?.body)) as TurnInput; posts.push(value);
      if (rejectFirst && posts.length === 1) throw new TypeError("lost response");
      const run: WorkRun = { id: value.request_id, session_id: SID, status: "running", input: value, result: {} };
      runs = [run]; return response(run, 202);
    }
    if (path.includes("/events?")) {
      const run = { ...runs.at(-1)!, status: "completed", result: { content: "已完成整理", workspace_saved: true } };
      runs = [run]; fileReady = true;
      return response({ run, events: [{ seq: 1, kind: "delta", data: { text: "已完成整理" } }], has_more: false });
    }
    return response({ message: "unexpected fixture request" }, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

function loggedIn(pending?: { session_id: string; input: TurnInput }) {
  sessionStorage.setItem("mona-hosted-work-v1", JSON.stringify({ token: "account-token", selected: SID, pending }));
  return render(<WorkApp />);
}

describe("independent online Work surface", () => {
  it("adopts the website session without reusing another account's work selection", async () => {
    sessionStorage.setItem("mona-hosted-work-v1", JSON.stringify({ token: "old-account", selected: SID }));
    sessionStorage.setItem("mona-website-session-v1", JSON.stringify({ token: "website-account", user: { id: "1" } }));
    render(<WorkApp />);
    await screen.findByText("今天想完成什么？");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/work/sessions");
    expect(new Headers(call?.[1]?.headers).get("Authorization")).toBe("Bearer website-account");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === `/api/work/sessions/${SID}`)).toBe(false);
  });

  it("retains login after unconfirmed logout and clears it only after upstream success", async () => {
    const original = fetch;
    let reject = true;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url === "/api/work/auth/logout"
      ? Promise.resolve(response(reject ? { message: "退出未确认" } : { message: "logged out" }, reject ? 503 : 200)) : original(url, init)));
    loggedIn();
    await waitFor(() => expect(screen.getByLabelText("任务内容")).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("dialog");
    expect(sessionStorage.getItem("mona-hosted-work-v1")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    reject = false;
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await screen.findByRole("button", { name: "登录并开始" });
    expect(sessionStorage.getItem("mona-hosted-work-v1")).toBeNull();
  });

  it("offers account login but no API configuration or desktop modules", () => {
    render(<WorkApp />);
    expect(screen.getByLabelText("账号")).toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "运维" })).toBeNull();
    expect(screen.queryByRole("button", { name: "开发" })).toBeNull();
  });

  it("loads history without dispatching a model request", async () => {
    loggedIn();
    await waitFor(() => expect(screen.getByLabelText("任务内容")).not.toBeDisabled());
    expect(posts).toHaveLength(0);
    expect(screen.getByRole("combobox", { name: "平台模型" })).toBeInTheDocument();
  });

  it("keeps failed-send text and resubmits only the original request identity", async () => {
    rejectFirst = true; loggedIn();
    await waitFor(() => expect(screen.getByLabelText("任务内容")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "整理这份资料" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByRole("dialog");
    expect(posts).toHaveLength(1);
    expect(screen.getByLabelText("任务内容")).toHaveValue("整理这份资料");
    expect(JSON.parse(sessionStorage.getItem("mona-hosted-work-v1")!).pending.input.request_id).toBe(posts[0].request_id);
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    fireEvent.click(screen.getByRole("button", { name: "核对原请求" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual(posts[0]);
    await screen.findByRole("button", { name: "结果.txt" });
    expect(screen.getByLabelText("任务内容")).toHaveValue("");
  });

  it("observes an accepted pending request after refresh without posting again", async () => {
    runs = [{ id: RID, session_id: SID, status: "completed", input, result: { content: "已保存" } }];
    loggedIn({ session_id: SID, input });
    await screen.findByText("已保存");
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem("mona-hosted-work-v1")!).pending).toBeNull());
    expect(posts).toHaveLength(0);
  });

  it("retains unknown task state and disables starting another execution", async () => {
    runs = [{ id: RID, session_id: SID, status: "unknown", input, result: { message: "结果待核对" } }];
    loggedIn();
    await screen.findByText(/已暂停新的执行/);
    fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "继续" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  it("does not render a failed session query as an empty account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ message: "读取失败" }, 503)));
    loggedIn();
    await screen.findByRole("dialog");
    expect(screen.queryByText("还没有会话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(screen.getByRole("button", { name: "重新读取" })).toBeInTheDocument();
  });

  it("keeps execution disabled when no independent platform model is configured", async () => {
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url === "/api/work/models"
      ? Promise.resolve(response({ models: [], max_file_bytes: 1024 })) : original(url, init)));
    loggedIn();
    await screen.findByText(/在线模型尚未开放/);
    fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "开始任务" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(posts).toHaveLength(0);
  });

  it("cancels observation on unmount without cancelling the server task", async () => {
    const view = loggedIn();
    await waitFor(() => expect(screen.getByLabelText("任务内容")).not.toBeDisabled());
    await act(async () => view.unmount());
    expect(posts).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
  });
});
