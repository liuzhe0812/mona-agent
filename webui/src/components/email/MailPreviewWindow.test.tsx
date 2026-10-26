import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getServicesStatus: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/lib/tauri", () => ({
  getServicesStatus: mocks.getServicesStatus,
  openPathWithSystemApp: vi.fn(),
  isTauri: () => true,
}));
vi.mock("./MailView", () => ({ SafeHtmlFrame: () => <iframe title="邮件正文" /> }));

import { formatPreviewDate, MailPreviewWindow } from "./MailPreviewWindow";

const body = {
  bodyText: "本地已缓存的正文",
  bodyHtml: null,
  header: { subject: "测试邮件", fromAddress: "sender@example.com", date: "2026-10-16" },
};

describe("MailPreviewWindow loading", () => {
  beforeEach(() => {
    window.location.hash = "#/mail-preview?accountId=work&uid=42&folder=INBOX";
    mocks.invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "email_fetch_body") return body;
      if (command === "email_list_accounts") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    mocks.getServicesStatus.mockReset().mockResolvedValue({ running: true, port: 17174 });
    mocks.unlisten.mockReset();
    mocks.listen.mockReset().mockResolvedValue(mocks.unlisten);
  });

  afterEach(() => {
    cleanup();
    window.location.hash = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the cached body while service status and accounts are still pending", async () => {
    mocks.getServicesStatus.mockReturnValue(new Promise(() => {}));
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "email_fetch_body") return Promise.resolve(body);
      return new Promise(() => {});
    });

    render(<MailPreviewWindow />);

    expect(await screen.findByText(body.bodyText)).toBeVisible();
    expect(screen.getByRole("heading", { name: body.header.subject })).toBeVisible();
    expect(mocks.invoke).toHaveBeenCalledWith("email_fetch_body", {
      accountId: "work", uid: "42", mailbox: "INBOX", gatewayUrl: "",
    });
    expect(document.title).toBe(body.header.subject);
  });

  it("accepts an empty body without a second request", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(async (command: string) => command === "email_fetch_body"
      ? { ...body, bodyText: "" } : []);

    await act(async () => { render(<MailPreviewWindow />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(screen.getByText("此邮件无可显示正文")).toBeVisible();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "email_fetch_body")).toHaveLength(1);
  });

  it("keeps inline CID metadata out of the reader attachment list", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "email_fetch_body") {
        return {
          ...body,
          attachments: [
            { filename: "logo.png", contentType: "image/png", size: 3, partId: "", contentId: "logo", isInline: true },
            { filename: "report.pdf", contentType: "application/pdf", size: 10, partId: "", isInline: false },
          ],
        };
      }
      return [];
    });

    render(<MailPreviewWindow />);

    expect(await screen.findByText("report.pdf")).toBeVisible();
    expect(screen.queryByText("logo.png")).not.toBeInTheDocument();
  });

  it("shows a safe error and lets the user retry a failed body request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let failed = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "email_fetch_body") return [];
      if (!failed) {
        failed = true;
        throw new Error("internal transport failure");
      }
      return body;
    });

    render(<MailPreviewWindow />);
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));

    expect(await screen.findByText(body.bodyText)).toBeVisible();
    expect(screen.queryByText(/internal transport failure/)).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "email_fetch_body")).toHaveLength(2);
  });

  it("only shows network progress for this message and keeps one event listener", async () => {
    mocks.invoke.mockImplementation((command: string) => command === "email_fetch_body"
      ? new Promise(() => {}) : Promise.resolve([]));
    const view = render(<MailPreviewWindow />);
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledOnce());
    const listener = mocks.listen.mock.calls[0][1];

    act(() => listener({ payload: { accountId: "other", uid: "42", mailbox: "INBOX", stage: "network" } }));
    expect(await screen.findByRole("status")).toHaveTextContent("正在加载正文...");
    act(() => listener({ payload: { accountId: "work", uid: "42", mailbox: "INBOX", stage: "network" } }));
    expect(screen.getByRole("status")).toHaveTextContent("正在请求邮件...");
    expect(mocks.listen).toHaveBeenCalledOnce();

    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});

describe("formatPreviewDate", () => {
  it("shows only a numeric local date without the email timezone", () => {
    expect(formatPreviewDate("Sat, 12 Sep 2026 12:00:00 +0000")).toBe("2026-9-12");
  });

  it("returns an empty value for a missing or invalid date", () => {
    expect(formatPreviewDate("")).toBe("");
    expect(formatPreviewDate("not a date")).toBe("");
  });
});
