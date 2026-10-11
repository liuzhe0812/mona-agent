import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const quickAskMocks = vi.hoisted(() => ({
  newChat: vi.fn(),
  sendMessage: vi.fn(),
  focusChat: vi.fn(),
  hide: vi.fn(),
}));

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({}),
}));

vi.mock("@/lib/api", () => ({
  listSlashCommands: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: {
      newChat: quickAskMocks.newChat,
      sendMessage: quickAskMocks.sendMessage,
    },
    modelName: "qwen3.7-plus",
    token: "token",
  }),
}));

vi.mock("@/hooks/useAttachedDocuments", () => ({
  useAttachedDocuments: () => ({
    documents: [{ name: "artifact.xyz", path: "uploads/quick/artifact.xyz" }],
    uploading: false,
    error: null,
    add: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    quickAskFocusChat: quickAskMocks.focusChat,
    quickAskHide: quickAskMocks.hide,
  };
});

import { QuickAskWindow } from "./QuickAskWindow";

describe("QuickAskWindow", () => {
  it("renders a compact ask surface without notes or SSH actions", () => {
    render(<QuickAskWindow />);

    expect(screen.getByText("Mona 快捷提问")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("向 Mona 提问…")).toBeInTheDocument();
    expect(screen.getByText("qwen3.7-plus")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 SSH 会话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建笔记" })).not.toBeInTheDocument();
    expect(screen.queryByText("网页生成笔记")).not.toBeInTheDocument();
  });

  it("sends uploaded document paths with the new chat message", async () => {
    quickAskMocks.newChat.mockResolvedValue("quick-chat");
    quickAskMocks.sendMessage.mockClear();

    render(<QuickAskWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(quickAskMocks.sendMessage).toHaveBeenCalledWith(
        "quick-chat",
        "",
        undefined,
        expect.objectContaining({ docPaths: ["uploads/quick/artifact.xyz"] }),
      ),
    );
  });
});
