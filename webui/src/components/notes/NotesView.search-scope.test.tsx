import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listWikiPages: vi.fn(),
  notesVaultPath: "/notes-vault" as string | null,
  notebooks: [] as { id: string; name: string }[],
  initialState: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));
vi.mock("@/lib/materials-api", () => ({ listWikiPages: mocks.listWikiPages }));

import { NotesView } from "./NotesView";
import { ClientProvider } from "@/providers/ClientProvider";
import { createBlankNote } from "./notes-storage";

describe("NotesView sidebar actions", () => {
  beforeEach(() => {
    mocks.listWikiPages.mockReset().mockResolvedValue([]);
    mocks.notesVaultPath = "/notes-vault";
    mocks.notebooks = [];
    mocks.initialState = {};
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: mocks.invoke.mockReset().mockImplementation((command: string, args?: { state?: { notes: { id: string }[] } }) => {
          if (command === "notes_vault_get_path") return Promise.resolve(mocks.notesVaultPath);
          if (command === "notes_vault_pick_directory") return Promise.resolve(null);
          if (command === "notes_load_state") {
            return Promise.resolve({
              vaultToken: "a".repeat(64),
              notebooks: mocks.notebooks,
              notes: [],
              activeNotebookId: "",
              activeNoteId: null,
              transformations: [],
              workspace: null,
              rightSidebarOpen: false,
              rightSidebarWidth: 306,
              rightActiveTab: "ai",
              ...mocks.initialState,
            });
          }
          if (command === "get_agent_search_scope") {
            return Promise.resolve({
              notes: { mode: "all", allowedNotebookIds: [] },
              email: { mode: "all", allowedFolders: [] },
            });
          }
          if (command === "notes_save_state") {
            return Promise.resolve(Object.fromEntries((args?.state?.notes ?? []).map((note) => [note.id, "b".repeat(64)])));
          }
          return Promise.reject(new Error(`unexpected command: ${command}`));
        }),
      },
    });
  });

  it("focuses the new note in the active split pane", async () => {
    const leftNote = createBlankNote("");
    const rightNote = createBlankNote("");
    mocks.initialState = {
      notes: [leftNote, rightNote],
      activeNoteId: leftNote.id,
      workspace: {
        activeLeafId: "left",
        root: {
          id: "split",
          type: "split",
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            { id: "left", type: "leaf", tabIds: [leftNote.id], activeTabId: leftNote.id, graphOpen: false },
            { id: "right", type: "leaf", tabIds: [rightNote.id], activeTabId: rightNote.id, graphOpen: false },
          ],
        },
      },
    };
    const user = userEvent.setup();
    render(
      <ClientProvider client={null} token="" runtimeStatus="ready">
        <NotesView />
      </ClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "新建" }));
    await user.click(await screen.findByRole("menuitem", { name: "新建笔记" }));
    const editors = await waitFor(() => {
      const elements = document.querySelectorAll<HTMLElement>('.ProseMirror[contenteditable="true"]');
      expect(elements).toHaveLength(2);
      expect(elements[0]).toHaveFocus();
      return elements;
    });
    await user.click(editors[1]);
    expect(editors[1]).toHaveFocus();
  });

  it("focuses a note created from a folder's context menu", async () => {
    mocks.notebooks = [{ id: "demo", name: "demo" }];
    const user = userEvent.setup();
    render(
      <ClientProvider client={null} token="" runtimeStatus="ready">
        <NotesView />
      </ClientProvider>,
    );

    await user.click(await screen.findByPlaceholderText("搜索笔记"));
    fireEvent.contextMenu(screen.getByText("demo"));
    await user.click(await screen.findByRole("menuitem", { name: "新建笔记" }));
    await waitFor(() => expect(document.querySelector('.ProseMirror[contenteditable="true"]')).toHaveFocus());
    await user.keyboard("B");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "notes_save_state",
      expect.objectContaining({ state: expect.objectContaining({
        notes: expect.arrayContaining([expect.objectContaining({ notebookId: "demo", contentMarkdown: "B" })]),
      }) }),
      undefined,
    ));
  });

  it("opens the create menu and creates a note in the vault root", async () => {
    const user = userEvent.setup();
    render(
      <ClientProvider client={null} token="" runtimeStatus="ready">
        <NotesView />
      </ClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "新建" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual([
      "新建笔记",
      "新建文件夹",
    ]);
    expect(screen.getByText("仓库为空，右键新建文件夹或笔记")).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "新建笔记" }));
    expect((await screen.findAllByText("未命名笔记")).length).toBeGreaterThan(0);
    const editor = await waitFor(() => {
      const element = document.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
      expect(element).toHaveFocus();
      return element!;
    });
    await user.keyboard("A");
    await waitFor(() => expect(editor).toHaveTextContent("A"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "notes_save_state",
      expect.objectContaining({ state: expect.objectContaining({
        notes: expect.arrayContaining([expect.objectContaining({ notebookId: "", contentMarkdown: "A" })]),
      }) }),
      undefined,
    ));
  });

  it("creates a folder from the create menu", async () => {
    const user = userEvent.setup();
    render(
      <ClientProvider client={null} token="" runtimeStatus="ready">
        <NotesView />
      </ClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "新建" }));
    await user.click(await screen.findByRole("menuitem", { name: "新建文件夹" }));
    const dialog = await screen.findByRole("dialog", { name: "笔记本名称" });
    const input = within(dialog).getByPlaceholderText("输入笔记本名称");
    await user.clear(input);
    await user.type(input, "项目资料");
    await user.click(within(dialog).getByRole("button", { name: "确定" }));

    expect(await screen.findByText("项目资料")).toBeInTheDocument();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
      "notes_save_state",
      expect.objectContaining({ state: expect.objectContaining({
        notebooks: expect.arrayContaining([expect.objectContaining({ id: "项目资料", name: "项目资料" })]),
        notes: [],
      }) }),
      undefined,
    ));
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
