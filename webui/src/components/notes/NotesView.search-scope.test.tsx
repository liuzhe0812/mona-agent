import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listWikiPages: vi.fn(),
  notesVaultPath: "/notes-vault" as string | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@/lib/materials-api", () => ({ listWikiPages: mocks.listWikiPages }));

import { NotesView } from "./NotesView";
import { ClientProvider } from "@/providers/ClientProvider";

describe("NotesView search scope settings", () => {
  beforeEach(() => {
    mocks.listWikiPages.mockReset().mockResolvedValue([]);
    mocks.notesVaultPath = "/notes-vault";
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: mocks.invoke.mockReset().mockImplementation((command: string) => {
          if (command === "notes_vault_get_path") return Promise.resolve(mocks.notesVaultPath);
          if (command === "notes_vault_pick_directory") return Promise.resolve(null);
          if (command === "notes_load_state") {
            return Promise.resolve({
              vaultToken: "a".repeat(64),
              notebooks: [],
              notes: [],
              activeNotebookId: "",
              activeNoteId: null,
              transformations: [],
              workspace: null,
              rightSidebarOpen: false,
              rightSidebarWidth: 306,
              rightActiveTab: "ai",
            });
          }
          if (command === "get_agent_search_scope") {
            return Promise.resolve({
              notes: { mode: "all", allowedNotebookIds: [] },
              email: { mode: "all", allowedFolders: [] },
            });
          }
          if (command === "notes_save_state") return Promise.resolve({});
          return Promise.reject(new Error(`unexpected command: ${command}`));
        }),
      },
    });
  });

  it("opens notebook search settings from the Notes more menu", async () => {
    const user = userEvent.setup();
    render(
      <ClientProvider client={null} token="" runtimeStatus="ready">
        <NotesView />
      </ClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "更多" }));
    await user.click(await screen.findByRole("menuitem", { name: "设置" }));

    const dialog = await screen.findByRole("dialog", { name: "笔记设置" });
    expect(await within(dialog).findByRole("button", { name: "笔记搜索范围" })).toBeInTheDocument();
    expect(mocks.invoke).toHaveBeenCalledWith("get_agent_search_scope", {}, undefined);
  });

  it("opens settings without a vault and keeps the existing vault chooser available", async () => {
    mocks.notesVaultPath = null;
    const user = userEvent.setup();
    render(
      <ClientProvider client={null} token="" runtimeStatus="ready">
        <NotesView />
      </ClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "设置" }));
    const dialog = await screen.findByRole("dialog", { name: "笔记设置" });
    expect(await within(dialog).findByText("未配置笔记仓库")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "选择仓库目录" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "notes_vault_pick_directory")).toHaveLength(1));
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: "选择仓库目录" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "notes_vault_pick_directory")).toHaveLength(2));
  });
});
