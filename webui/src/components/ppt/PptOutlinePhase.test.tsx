import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type PptDesignSpecSummary, type PptOutlinePage } from "@/lib/api";
import { PptOutlinePhase } from "./PptOutlinePhase";

// --- API mocks（保留真实 ApiError） ---
const fetchPptOutline = vi.fn();
const savePptOutline = vi.fn();
const lockPptOutline = vi.fn();
const fetchPptDesignSpecSummary = vi.fn();
const updatePptDesignSpecSummary = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchPptOutline: (...args: unknown[]) => fetchPptOutline(...args),
    savePptOutline: (...args: unknown[]) => savePptOutline(...args),
    lockPptOutline: (...args: unknown[]) => lockPptOutline(...args),
    fetchPptDesignSpecSummary: (...args: unknown[]) => fetchPptDesignSpecSummary(...args),
    updatePptDesignSpecSummary: (...args: unknown[]) => updatePptDesignSpecSummary(...args),
  };
});

const PAGE: PptOutlinePage = {
  page: "page_1",
  file: "page_1.svg",
  title: "封面",
  bullets: ["要点一"],
  visual_type: "cover",
  chart_template: null,
  layout_template: "",
  has_ai_image: false,
  layout: "居中大标题",
  notes: "",
  summary: "开场页",
  image_plan: "",
};

const SUMMARY: PptDesignSpecSummary = {
  schemaVersion: 1,
  canvasFormat: "ppt169",
  pageCount: 8,
  audience: "管理层",
  styleMode: "consulting",
  primaryColor: "#1A73E8",
};

/** 记录 spec/save/lock 调用顺序 */
let order: string[] = [];

function setupDefaults() {
  order = [];
  fetchPptOutline.mockResolvedValue({
    ok: true,
    pages: [PAGE],
    revision: 0,
    schemaVersion: 2,
    locked: false,
  });
  fetchPptDesignSpecSummary.mockResolvedValue({ ok: true, summary: SUMMARY });
  updatePptDesignSpecSummary.mockImplementation(async () => {
    order.push("spec");
    return { ok: true, summary: SUMMARY };
  });
  savePptOutline.mockImplementation(async () => {
    order.push("save");
    return { ok: true, revision: 1, pages: [PAGE] };
  });
  lockPptOutline.mockImplementation(async () => {
    order.push("lock");
    return { ok: true, revision: 1 };
  });
}

async function renderLoaded(onLocked = vi.fn()) {
  const utils = render(
    <PptOutlinePhase projectName="proj" token="tok" onLocked={onLocked} />,
  );
  // 等待大纲与规格摘要加载完成（规格面板输入框出现）
  await screen.findByPlaceholderText("如：管理层/客户/团队");
  return { onLocked, ...utils };
}

function editAudience(value: string) {
  fireEvent.change(screen.getByPlaceholderText("如：管理层/客户/团队"), {
    target: { value },
  });
}

function clickConfirm() {
  fireEvent.click(screen.getByRole("button", { name: /确认大纲并继续/ }));
}

describe("PptOutlinePhase 规格保存门控", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it("修改规格后立即确认：规格 PUT 在大纲保存和 lock 之前完成", async () => {
    const onLocked = vi.fn();
    await renderLoaded(onLocked);

    editAudience("新客户");
    clickConfirm();

    await waitFor(() => expect(onLocked).toHaveBeenCalled());
    expect(order).toEqual(["spec", "save", "lock"]);
    expect(updatePptDesignSpecSummary).toHaveBeenCalledWith(
      "tok",
      "proj",
      expect.objectContaining({ audience: "新客户" }),
    );
  });

  it("规格保存失败时不调用 lock，错误可见，重试后可继续", async () => {
    const onLocked = vi.fn();
    updatePptDesignSpecSummary.mockRejectedValueOnce(new Error("网络错误"));
    await renderLoaded(onLocked);

    editAudience("新客户");
    clickConfirm();

    // 停留在纲页，错误可见，lock 未被调用
    await screen.findByText("整体规格保存失败，无法确认大纲。请重试。");
    expect(lockPptOutline).not.toHaveBeenCalled();
    expect(onLocked).not.toHaveBeenCalled();

    // 规格面板显示保存失败与重试入口；重试保存成功
    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() =>
      expect(updatePptDesignSpecSummary).toHaveBeenCalledTimes(2),
    );

    // 再次确认可走通完整流程
    clickConfirm();
    await waitFor(() => expect(onLocked).toHaveBeenCalled());
    expect(order).toEqual(["spec", "save", "lock"]);
  });

  it("延迟保存进行中点击确认：确认等待该请求，期间新增修改仍在 lock 前提交", async () => {
    const onLocked = vi.fn();
    let resolveFirst: ((v: { ok: boolean; summary: PptDesignSpecSummary }) => void) | null =
      null;
    updatePptDesignSpecSummary
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(async () => {
        order.push("spec");
        return { ok: true, summary: SUMMARY };
      });

    await renderLoaded(onLocked);

    // 第一次修改 → 800ms 防抖后发出请求并挂起
    editAudience("第一批");
    await waitFor(() => expect(updatePptDesignSpecSummary).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });

    // 请求进行中继续修改 → patch 累积；随后点击确认
    editAudience("第二批");
    clickConfirm();

    // 确认正在等待进行中的保存
    await act(async () => {
      await Promise.resolve();
    });
    expect(onLocked).not.toHaveBeenCalled();

    // 第一个请求完成 → 确认流程继续，第二批 patch 在 lock 前发出
    await act(async () => {
      resolveFirst?.({ ok: true, summary: SUMMARY });
    });
    await waitFor(() => expect(onLocked).toHaveBeenCalled());
    expect(updatePptDesignSpecSummary).toHaveBeenCalledTimes(2);
    expect(updatePptDesignSpecSummary).toHaveBeenLastCalledWith(
      "tok",
      "proj",
      expect.objectContaining({ audience: "第二批" }),
    );
    expect(order).toEqual(["spec", "save", "lock"]);
  });

  it("大纲 revision 冲突（409）时重新加载，不调用 lock", async () => {
    const onLocked = vi.fn();
    savePptOutline.mockRejectedValueOnce(new ApiError(409, "HTTP 409"));
    await renderLoaded(onLocked);

    // 无规格修改：直接确认
    clickConfirm();

    // 初始加载 + 409 后 refetch
    await waitFor(() => expect(fetchPptOutline).toHaveBeenCalledTimes(2));
    expect(lockPptOutline).not.toHaveBeenCalled();
    expect(onLocked).not.toHaveBeenCalled();
    // refetch 成功后错误清除，确认按钮恢复可用
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /确认大纲并继续/ }),
      ).not.toBeDisabled(),
    );
  });
});
