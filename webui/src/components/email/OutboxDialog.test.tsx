import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxEmail } from "./lib/types";

const mocks = vi.hoisted(() => ({
  outboxList: vi.fn(),
  outboxDelete: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("./lib/emailApi", () => ({
  outboxList: mocks.outboxList,
  outboxDelete: mocks.outboxDelete,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { OutboxDialog } from "./OutboxDialog";

const makeOutboxEmail = (id: string, status: string, overrides: Partial<OutboxEmail> = {}): OutboxEmail => ({
  id,
  accountId: "account-a",
  toAddresses: "recipient@example.invalid",
  subject: `Scheduled ${id}`,
  bodyText: "",
  scheduledAt: "2026-10-26T10:00:00.000Z",
  status,
  createdAt: "2026-10-25T10:00:00.000Z",
  ...overrides,
});

describe("OutboxDialog", () => {
  let onOutboxUpdated: (() => void) | undefined;

  beforeEach(() => {
    onOutboxUpdated = undefined;
    mocks.outboxList.mockReset();
    mocks.outboxDelete.mockReset().mockResolvedValue(undefined);
    mocks.listen.mockReset().mockImplementation(async (_event: string, handler: () => void) => {
      onOutboxUpdated = handler;
      return vi.fn();
    });
  });

  afterEach(() => cleanup());

  it("shows Chinese states and safe guidance without exposing raw errors", async () => {
    mocks.outboxList.mockResolvedValue([
      makeOutboxEmail("pending", "pending"),
      makeOutboxEmail("sent", "sent"),
      makeOutboxEmail("failed", "failed", { error: "internal provider details" }),
      makeOutboxEmail("unknown", "unknown", { error: "internal transport details" }),
    ]);

    render(<OutboxDialog open onOpenChange={vi.fn()} accountId="account-a" />);

    expect(await screen.findByText("Scheduled pending")).toBeVisible();
    expect(screen.getByText(/状态：\s*待发送/)).toBeVisible();
    expect(screen.getByText(/状态：\s*已发送/)).toBeVisible();
    expect(screen.getByText(/状态：\s*发送失败/)).toBeVisible();
    expect(screen.getByText(/状态：\s*结果待确认/)).toBeVisible();
    expect(screen.getAllByText(/计划发送：/)).toHaveLength(4);
    expect(screen.getByText(/请先在已发送文件夹核对，避免重复发送/)).toBeVisible();
    expect(screen.getByText("发送失败，请检查收件人和邮箱账号设置。")).toBeVisible();
    expect(screen.queryByText(/internal provider details|internal transport details/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "取消发送" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /重发|再次发送/ })).not.toBeInTheDocument();
  });

  it("cancels pending entries only", async () => {
    const pending = makeOutboxEmail("pending-1", "pending");
    const unknown = makeOutboxEmail("unknown-1", "unknown");
    mocks.outboxList.mockResolvedValue([pending, unknown]);

    render(<OutboxDialog open onOpenChange={vi.fn()} accountId="account-a" />);
    expect(await screen.findByText("Scheduled pending-1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消发送" }));

    await waitFor(() => expect(mocks.outboxDelete).toHaveBeenCalledWith("pending-1"));
    await waitFor(() => expect(screen.queryByText("Scheduled pending-1")).not.toBeInTheDocument());
    expect(screen.getByText("Scheduled unknown-1")).toBeVisible();
    expect(screen.queryByRole("button", { name: /取消发送/ })).not.toBeInTheDocument();
  });

  it("reloads the current account when the outbox update event arrives", async () => {
    mocks.outboxList
      .mockResolvedValueOnce([makeOutboxEmail("event-1", "pending")])
      .mockResolvedValueOnce([makeOutboxEmail("event-1", "sent")]);

    render(<OutboxDialog open onOpenChange={vi.fn()} accountId="account-a" />);
    expect(await screen.findByText(/状态：\s*待发送/)).toBeVisible();
    await waitFor(() => expect(mocks.listen).toHaveBeenCalledWith("email-outbox-updated", expect.any(Function)));

    await act(async () => {
      onOutboxUpdated?.();
    });

    await waitFor(() => expect(mocks.outboxList).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/状态：\s*已发送/)).toBeVisible();
  });
});
