import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: {
    newChat: vi.fn(),
    sendMessage: vi.fn(),
  },
  listSlashCommands: vi.fn(),
  quickAskOpenNote: vi.fn(),
  quickAskOpenSsh: vi.fn(),
  quickAskFocusChat: vi.fn(),
  quickAskHide: vi.fn(),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ client: mocks.client, modelName: "model", token: "tok" }),
}));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => ({}) }));
vi.mock("@/lib/api", () => ({ listSlashCommands: mocks.listSlashCommands }));
vi.mock("@/lib/tauri", () => ({
  quickAskFocusChat: mocks.quickAskFocusChat,
  quickAskHide: mocks.quickAskHide,
  quickAskOpenNote: mocks.quickAskOpenNote,
  quickAskOpenSsh: mocks.quickAskOpenSsh,
}));
vi.mock("@/components/thread/ThreadComposer", () => ({
  ThreadComposer: ({ leadingActions, onSend }: { leadingActions?: ReactNode; onSend: (text: string) => void }) => (
    <div>
      <div data-testid="quick-actions">{leadingActions}</div>
      <button type="button" onClick={() => onSend("测试")}>触发发送</button>
    </div>
  ),
}));

import { QuickAskWindow } from "./QuickAskWindow";

describe("QuickAskWindow brand surface", () => {
  beforeEach(() => {
    mocks.listSlashCommands.mockResolvedValue([]);
    mocks.quickAskFocusChat.mockResolvedValue(undefined);
    mocks.quickAskHide.mockResolvedValue(undefined);
    mocks.client.newChat.mockReset();
    mocks.client.sendMessage.mockReset();
  });

  it("keeps shortcut pills neutral and removes hardcoded note color", async () => {
    render(<QuickAskWindow />);

    const note = await screen.findByRole("button", { name: "新建笔记" });
    const ssh = screen.getByRole("button", { name: "新建 SSH 会话" });
    expect(note).toHaveClass("rounded-full", "hover:bg-foreground/[0.06]");
    expect(ssh).toHaveClass("rounded-full", "hover:bg-foreground/[0.06]");
    expect(note.querySelector("svg")).toHaveClass("text-muted-foreground");
  });

  it("keeps error feedback dangerous but unraised", async () => {
    mocks.client.newChat.mockRejectedValueOnce(new Error("发送失败"));
    render(<QuickAskWindow />);

    fireEvent.click(await screen.findByRole("button", { name: "触发发送" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("border-destructive/30", "text-destructive");
    expect(alert).not.toHaveClass("shadow-sm");
  });
});
