import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage, EmailSearchRequest, EmailSearchResult } from "./lib/types";

const mocks = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  fetchEmailBody: vi.fn(),
}));

vi.mock("./lib/emailApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/emailApi")>()),
  searchMessages: mocks.searchMessages,
  fetchEmailBody: mocks.fetchEmailBody,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * estimateSize(),
      })),
    measureElement: () => undefined,
  }),
}));

import { MailListView } from "./MailListView";
import { useEmailStore } from "./store/emailStore";

const makeMessage = (uid: string, overrides: Partial<EmailMessage> = {}): EmailMessage => ({
  uid,
  accountId: "account-a",
  folder: "INBOX",
  subject: `Inbox ${uid}`,
  fromAddress: "sender@example.invalid",
  toAddresses: "",
  date: "2026-10-01T00:00:00Z",
  bodyText: "",
  hasAttachments: false,
  isRead: false,
  isStarred: false,
  rawSize: 10,
  ...overrides,
});

const makeSearchResult = (
  uid: string,
  overrides: Partial<EmailSearchResult> = {},
): EmailSearchResult => ({
  uid,
  accountId: "account-a",
  folder: "INBOX",
  subject: `Search ${uid}`,
  fromAddress: "sender@example.invalid",
  toAddresses: "",
  date: "2026-10-01T00:00:00Z",
  hasAttachments: false,
  isRead: false,
  isStarred: false,
  rawSize: 10,
  ...overrides,
});

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
}

function primeScroller() {
  const scroller = document.querySelector(".scrollbar-hover") as HTMLDivElement;
  setScrollMetrics(scroller, 2800, 500);
  fireEvent.scroll(scroller);
  return scroller;
}

describe("MailListView search", () => {
  beforeEach(() => {
    mocks.searchMessages.mockReset();
    mocks.fetchEmailBody.mockReset().mockResolvedValue({
      bodyText: "Loaded from the local email cache",
      bodyHtml: null,
      attachments: [],
    });
    useEmailStore.setState({
      accounts: [],
      messages: [makeMessage("local-1")],
      selectedMessage: null,
      selectedAccountId: "account-a",
      selectedFolder: "INBOX",
      isUnifiedInbox: false,
      selectedUids: new Set(),
      lastMailboxUpdate: null,
      hasMore: false,
      loading: false,
      loadingMore: false,
      error: null,
      folders: [],
      gatewayUrl: "http://127.0.0.1:17174",
      bodyCache: {},
      bodyLoadingStage: {},
    });
  });

  afterEach(() => cleanup());

  it("pages past the first 50 matches and opens a body-only search hit", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      makeSearchResult(String(index + 1), { subject: `First page ${index + 1}`, folder: "Archive" }),
    );
    const bodyHit = makeSearchResult("51", {
      folder: "Archive",
      subject: "Body-only result",
    });
    mocks.searchMessages.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([bodyHit]);
    useEmailStore.setState({
      selectedFolder: "Archive",
      messages: [makeMessage("local-1", { folder: "Archive" })],
    });

    render(<MailListView />);
    const scroller = primeScroller();
    fireEvent.change(screen.getByPlaceholderText("搜索邮件..."), {
      target: { value: "needle only in cached body" },
    });

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(1));
    fireEvent.scroll(scroller);
    expect(await screen.findByText("First page 1")).toBeVisible();
    expect(mocks.searchMessages).toHaveBeenNthCalledWith(1, {
      keyword: "needle only in cached body",
      accountId: "account-a",
      folder: "Archive",
      limit: 50,
      offset: 0,
    });

    scroller.scrollTop = 2300;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(2));
    expect(mocks.searchMessages).toHaveBeenNthCalledWith(2, {
      keyword: "needle only in cached body",
      accountId: "account-a",
      folder: "Archive",
      limit: 50,
      offset: 50,
    });

    scroller.scrollTop = 2600;
    fireEvent.scroll(scroller);
    const hit = await screen.findByText("Body-only result");
    fireEvent.click(hit);

    await waitFor(() => {
      expect(useEmailStore.getState().selectedMessage?.bodyText).toBe(
        "Loaded from the local email cache",
      );
    });
    expect(mocks.fetchEmailBody).toHaveBeenCalledWith(
      "account-a",
      "51",
      "Archive",
      "http://127.0.0.1:17174",
    );
  });

  it("searches every INBOX in unified mode and sends the active filters", async () => {
    useEmailStore.setState({ selectedAccountId: null, isUnifiedInbox: true, messages: [] });
    mocks.searchMessages.mockResolvedValue([
      makeSearchResult("77", { accountId: "account-b", subject: "Unified result" }),
    ]);

    render(<MailListView />);
    const scroller = primeScroller();
    fireEvent.click(screen.getByRole("button", { name: "未读" }));
    fireEvent.change(screen.getByPlaceholderText("搜索邮件..."), {
      target: { value: "unified body needle" },
    });

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(1));
    fireEvent.scroll(scroller);
    expect(await screen.findByText("Unified result")).toBeVisible();
    expect(mocks.searchMessages).toHaveBeenCalledWith({
      keyword: "unified body needle",
      folder: "INBOX",
      isRead: false,
      limit: 50,
      offset: 0,
    });
  });

  it("restores the original list when the search is cleared", async () => {
    mocks.searchMessages.mockResolvedValue([
      makeSearchResult("88", { subject: "Search-only result" }),
    ]);
    render(<MailListView />);
    const scroller = primeScroller();
    const input = screen.getByPlaceholderText("搜索邮件...");
    fireEvent.change(input, { target: { value: "search needle" } });

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(1));
    fireEvent.scroll(scroller);
    expect(await screen.findByText("Search-only result")).toBeVisible();
    fireEvent.change(input, { target: { value: "" } });

    expect(await screen.findByText("Inbox local-1")).toBeVisible();
    expect(screen.queryByText("Search-only result")).not.toBeInTheDocument();
    expect(mocks.searchMessages).toHaveBeenCalledTimes(1);
  });

  it("ignores an older search response after the query changes", async () => {
    let resolveOld!: (results: EmailSearchResult[]) => void;
    const oldRequest = new Promise<EmailSearchResult[]>((resolve) => {
      resolveOld = resolve;
    });
    mocks.searchMessages.mockImplementation((request: EmailSearchRequest) =>
      request.keyword === "old needle"
        ? oldRequest
        : Promise.resolve([
            makeSearchResult("new", { subject: "New query result" }),
          ]),
    );
    render(<MailListView />);
    const scroller = primeScroller();
    const input = screen.getByPlaceholderText("搜索邮件...");
    fireEvent.change(input, { target: { value: "old needle" } });
    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "new needle" } });

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(2));
    fireEvent.scroll(scroller);
    expect(await screen.findByText("New query result")).toBeVisible();
    await act(async () => {
      resolveOld([makeSearchResult("old", { subject: "Old query result" })]);
      await oldRequest;
    });
    expect(screen.queryByText("Old query result")).not.toBeInTheDocument();
    expect(screen.getByText("New query result")).toBeVisible();
  });

  it("refreshes an active search when its mailbox is updated", async () => {
    mocks.searchMessages.mockResolvedValue([
      makeSearchResult("refresh", { subject: "Updated mailbox result" }),
    ]);
    render(<MailListView />);
    const scroller = primeScroller();
    fireEvent.change(screen.getByPlaceholderText("搜索邮件..."), {
      target: { value: "mailbox body query" },
    });

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(1));
    fireEvent.scroll(scroller);
    expect(await screen.findByText("Updated mailbox result")).toBeVisible();

    act(() => {
      useEmailStore.setState({
        lastMailboxUpdate: { accountId: "account-a", folder: "INBOX", version: 1 },
      });
    });

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalledTimes(2));
    expect(mocks.searchMessages).toHaveBeenLastCalledWith({
      keyword: "mailbox body query",
      accountId: "account-a",
      folder: "INBOX",
      limit: 50,
      offset: 0,
    });
  });
});
