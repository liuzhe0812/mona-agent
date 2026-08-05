import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PptProject } from "@/lib/types";
import { PptHistory } from "./PptHistory";

// --- API mocks ---
const fetchPptProjects = vi.fn();
const deletePptProject = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchPptProjects: (...args: unknown[]) => fetchPptProjects(...args),
    deletePptProject: (...args: unknown[]) => deletePptProject(...args),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: () => false,
    openPathWithSystemApp: vi.fn(),
  };
});

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ token: "tok" }),
}));

// Radix ContextMenu 的轻量测试替身：菜单项直接内联渲染，
// 删除确认行为（AlertDialog、API 门控、错误重试）与被测组件自身逻辑保持不变。
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => null,
}));

const PROJECT_A: PptProject = {
  name: "proj-a",
  createdAt: Date.now() - 60_000,
  format: "ppt169",
  slideCount: 8,
  hasExport: true,
  hasSvgOutput: true,
  hasPptxOutput: true,
  hasSpecLock: true,
  status: "done",
  chatId: "chat-a",
};

const PROJECT_B: PptProject = {
  ...PROJECT_A,
  name: "proj-b",
  chatId: null,
  status: "generating",
  hasExport: false,
  slideCount: 3,
};

function setupLoaded(projects: PptProject[] = [PROJECT_A, PROJECT_B]) {
  fetchPptProjects.mockResolvedValue({ projects });
}

async function renderHistory(props: Partial<Parameters<typeof PptHistory>[0]> = {}) {
  const onSelect = props.onSelect ?? vi.fn();
  const onDownload = props.onDownload ?? vi.fn();
  const onDelete = props.onDelete ?? vi.fn();
  render(
    <PptHistory
      currentProjectName={props.currentProjectName}
      onSelect={onSelect}
      onDownload={onDownload}
      onDelete={onDelete}
    />,
  );
  await screen.findByText("proj-a");
  return { onSelect, onDownload, onDelete };
}

/** 项目按数组顺序渲染，取第 index 个「删除项目」菜单项 */
function deleteMenuItem(index = 0) {
  return screen.getAllByRole("button", { name: /删除项目/ })[index];
}

describe("PptHistory 删除确认与错误恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupLoaded();
  });

  it("点击删除只打开确认框，不立即调用删除 API；取消不调用", async () => {
    await renderHistory();

    fireEvent.click(deleteMenuItem(0));

    // 确认框出现，API 未被调用
    await screen.findByText("删除这个项目？");
    expect(screen.getByText(/将删除项目「proj-a」/)).toBeTruthy();
    expect(deletePptProject).not.toHaveBeenCalled();

    // 取消：不调用 API，列表项保留
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByText("删除这个项目？")).toBeNull(),
    );
    expect(deletePptProject).not.toHaveBeenCalled();
    expect(screen.getByText("proj-a")).toBeTruthy();
  });

  it("确认后调用一次删除 API，移除列表项并通知 onDelete", async () => {
    deletePptProject.mockResolvedValue({ ok: true });
    const { onDelete } = await renderHistory();

    fireEvent.click(deleteMenuItem(0));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.queryByText("proj-a")).toBeNull());
    expect(deletePptProject).toHaveBeenCalledTimes(1);
    expect(deletePptProject).toHaveBeenCalledWith("tok", "proj-a");
    expect(onDelete).toHaveBeenCalledWith("proj-a");
    // 其他项目不受影响
    expect(screen.getByText("proj-b")).toBeTruthy();
  });

  it("删除失败保留列表项并显示重试，重试成功后移除", async () => {
    deletePptProject.mockRejectedValueOnce(new Error("目录被占用"));
    await renderHistory();

    fireEvent.click(deleteMenuItem(0));
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    // 失败：列表项保留，错误与重试可见
    await screen.findByText("删除失败：目录被占用");
    expect(screen.getByText("proj-a")).toBeTruthy();

    // 重试成功：列表项移除
    deletePptProject.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText("proj-a")).toBeNull());
    expect(deletePptProject).toHaveBeenCalledTimes(2);
  });

  it("当前打开项目在历史列表中高亮（aria-current）", async () => {
    await renderHistory({ currentProjectName: "proj-a" });

    const current = screen.getByRole("button", {
      name: "打开项目 proj-a，已完成，8 页",
    });
    expect(current.getAttribute("aria-current")).toBe("true");

    const other = screen.getByRole("button", {
      name: "打开项目 proj-b，生成中，3 页",
    });
    expect(other.getAttribute("aria-current")).toBeNull();
  });

  it("加载失败显示错误状态，点击重试恢复列表", async () => {
    fetchPptProjects.mockRejectedValueOnce(new Error("HTTP 500"));
    render(
      <PptHistory onSelect={vi.fn()} onDownload={vi.fn()} onDelete={vi.fn()} />,
    );

    await screen.findByText("加载历史项目失败：HTTP 500");
    expect(screen.queryByText("暂无历史项目")).toBeNull();

    setupLoaded();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("proj-a");
  });
});
