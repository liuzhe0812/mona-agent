import { describe, it, expect, vi, beforeEach } from "vitest";
import { useIdeStore } from "@/components/ide/useIdeStore";

vi.mock("@/components/terminal/ipc", () => ({
  ideOpenProject: vi.fn(),
  ideCheckFile: vi.fn(),
  ideReadFile: vi.fn(),
  ideWriteFile: vi.fn(),
  sftpList: vi.fn(),
}));

describe("useIdeStore", () => {
  beforeEach(() => {
    useIdeStore.setState({
      sessionId: null,
      rootPath: null,
      tree: [],
      expandedPaths: new Set(),
      tabs: [],
      activeTabId: null,
      ideVisible: false,
      showHiddenFiles: false,
      conflictState: null,
    });
  });

  it("opens a new tab when openFile is called", async () => {
    const { ideCheckFile, ideReadFile } = await import("@/components/terminal/ipc");
    vi.mocked(ideCheckFile).mockResolvedValue({ type: "editable", size: 100, mtime: 1 });
    vi.mocked(ideReadFile).mockResolvedValue({ content: "hello", mtime: 1, size: 100 });

    useIdeStore.setState({ sessionId: "s1" });
    await useIdeStore.getState().openFile("/home/user/test.txt");

    const state = useIdeStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].name).toBe("test.txt");
    expect(state.ideVisible).toBe(true);
  });

  it("activates an existing tab instead of creating a duplicate", async () => {
    const { ideCheckFile, ideReadFile } = await import("@/components/terminal/ipc");
    vi.mocked(ideCheckFile).mockResolvedValue({ type: "editable", size: 100, mtime: 1 });
    vi.mocked(ideReadFile).mockResolvedValue({ content: "hello", mtime: 1, size: 100 });

    useIdeStore.setState({ sessionId: "s1" });
    await useIdeStore.getState().openFile("/home/user/test.txt");
    const firstTab = useIdeStore.getState().tabs[0];
    await useIdeStore.getState().openFile("/home/user/test.txt");

    const state = useIdeStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(firstTab.id);
  });

  it("marks a tab dirty when content changes", async () => {
    const { ideCheckFile, ideReadFile } = await import("@/components/terminal/ipc");
    vi.mocked(ideCheckFile).mockResolvedValue({ type: "editable", size: 100, mtime: 1 });
    vi.mocked(ideReadFile).mockResolvedValue({ content: "hello", mtime: 1, size: 100 });

    useIdeStore.setState({ sessionId: "s1" });
    await useIdeStore.getState().openFile("/home/user/test.txt");
    const tabId = useIdeStore.getState().tabs[0].id;

    useIdeStore.getState().setTabContent(tabId, "world");
    const state = useIdeStore.getState();
    expect(state.tabs[0].isDirty).toBe(true);
  });

  it("hides IDE panel when the last tab is closed", async () => {
    const { ideCheckFile, ideReadFile } = await import("@/components/terminal/ipc");
    vi.mocked(ideCheckFile).mockResolvedValue({ type: "editable", size: 100, mtime: 1 });
    vi.mocked(ideReadFile).mockResolvedValue({ content: "hello", mtime: 1, size: 100 });

    useIdeStore.setState({ sessionId: "s1" });
    await useIdeStore.getState().openFile("/home/user/test.txt");
    const tabId = useIdeStore.getState().tabs[0].id;

    useIdeStore.getState().closeTab(tabId);
    const state = useIdeStore.getState();
    expect(state.tabs).toHaveLength(0);
    expect(state.ideVisible).toBe(false);
  });
});
