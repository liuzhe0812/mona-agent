import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({}),
}));

vi.mock("@/lib/api", () => ({
  listSlashCommands: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: {
      newChat: vi.fn(),
      sendMessage: vi.fn(),
    },
    modelName: "qwen3.7-plus",
    token: "token",
  }),
}));

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
});
