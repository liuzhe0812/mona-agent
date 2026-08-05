import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forwardRef } from "react";

import { ThreeDMakerView } from "./ThreeDMakerView";

vi.mock("@/lib/api", () => ({
  getServicesHttpBase: vi.fn().mockResolvedValue("http://gw"),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: { newChat: vi.fn().mockResolvedValue("chat-1"), sendMessage: vi.fn() },
  }),
}));

vi.mock("./ThreePreview", () => ({
  ThreePreview: (props: { modelSource?: string | null }) => (
    <div data-testid="three-preview">{props.modelSource ?? "no-model"}</div>
  ),
}));

interface ChatPanelCapturedProps {
  chatId: string | null;
  projectName: string | null;
  onStreamingChange?: (streaming: boolean) => void;
}

let chatPanelProps: ChatPanelCapturedProps | null = null;

vi.mock("./ThreeChatPanel", () => ({
  ThreeChatPanel: forwardRef((props: ChatPanelCapturedProps, _ref) => {
    chatPanelProps = props;
    return <div data-testid="three-chat" />;
  }),
}));

const KNIFE_STATE = {
  name: "knife",
  meta: {},
  specPresent: true,
  specHash: "a".repeat(64),
  stages: [
    { id: "blockout", status: "passed" },
    { id: "structural-pass", status: "running" },
  ],
  blockedReason: "",
  components: [{ id: "blade", name: "刀身", role: "core", primitive: "box" }],
  references: [{ name: "front.png", path: "references/front.png" }],
  renders: [{ name: "render-1.png", path: "renders/render-1.png" }],
  comparisons: [],
  reports: [],
  candidatePresent: false,
  candidateBaseHash: null,
  sourcePresent: true,
  lastReview: null,
};

const SWORD_STATE = {
  ...KNIFE_STATE,
  name: "sword",
  components: [{ id: "sblade", name: "剑身", role: "core", primitive: "box" }],
};

const PROJECT_LIST = [
  { name: "knife", meta: {} },
  { name: "sword", meta: {} },
];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/three/projects")) {
        return { ok: true, json: async () => ({ projects: PROJECT_LIST }) };
      }
      if (url.includes("/api/three/project/file")) {
        return { ok: true, text: async () => "// compiled model source" };
      }
      if (url.includes("/api/three/project?name=knife")) {
        return { ok: true, json: async () => KNIFE_STATE };
      }
      if (url.includes("/api/three/project?name=sword")) {
        return { ok: true, json: async () => SWORD_STATE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

function stateFetchCount(name: string): number {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([u]) => String(u).includes(`/api/three/project?name=${name}`)).length;
}

/** Flush pending promise chains without relying on fake-timer-aware waitFor. */
async function flushMicrotasks(times = 10) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe("ThreeDMakerView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatPanelProps = null;
    stubFetch();
  });

  it("shows the three-column workspace after selecting a project", async () => {
    render(<ThreeDMakerView />);
    fireEvent.click(await screen.findByRole("button", { name: "knife" }));
    await waitFor(() => expect(screen.getByText("粗模")).toBeTruthy());
    expect(screen.getByText("刀身")).toBeTruthy();
    expect(screen.getByText(/blade · core · box/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("three-preview").textContent).toBe("// compiled model source"),
    );
  });

  it("switches the center column between preview, reference and compare", async () => {
    render(<ThreeDMakerView />);
    fireEvent.click(await screen.findByRole("button", { name: "knife" }));
    await screen.findByText("粗模");

    // 默认预览
    expect(screen.getByTestId("three-preview")).toBeTruthy();

    // 参考图模式
    fireEvent.click(screen.getByRole("button", { name: "参考图" }));
    const refImg = screen.getByAltText("参考图") as HTMLImageElement;
    expect(refImg.src).toContain("references%2Ffront.png");

    // 对比模式：参考图与最新渲染图并排
    fireEvent.click(screen.getByRole("button", { name: "对比" }));
    const cmpRef = screen.getByAltText("对比-参考图") as HTMLImageElement;
    const cmpRender = screen.getByAltText("对比-渲染图") as HTMLImageElement;
    expect(cmpRef.src).toContain("references%2Ffront.png");
    expect(cmpRender.src).toContain("renders%2Frender-1.png");

    // 回到预览
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.getByTestId("three-preview")).toBeTruthy();
  });

  it("offers spec/source/report export entries with disabled states", async () => {
    render(<ThreeDMakerView />);
    fireEvent.click(await screen.findByRole("button", { name: "knife" }));
    await screen.findByText("粗模");

    await userEvent.click(screen.getByRole("button", { name: "导出" }));
    const specItem = await screen.findByText("规格 JSON");
    const sourceItem = screen.getByText("Three.js 代码");
    const reportItem = screen.getByText("评审报告");
    // spec 与源码存在 → 可导出；无评审报告 → 禁用
    expect(specItem.closest("[data-disabled]")).toBeNull();
    expect(sourceItem.closest("[data-disabled]")).toBeNull();
    expect(reportItem.closest("[data-disabled]")).not.toBeNull();
  });

  it("clears the previous project state immediately when switching projects", async () => {
    render(<ThreeDMakerView />);
    fireEvent.click(await screen.findByRole("button", { name: "knife" }));
    await screen.findByText("刀身");

    fireEvent.click(screen.getByRole("button", { name: "sword" }));
    // 旧项目内容同步消失，进入加载态，不存在旧数据残留窗口
    expect(screen.queryByText("刀身")).toBeNull();
    expect(screen.getByText("正在加载项目状态...")).toBeTruthy();

    await screen.findByText("剑身");
    expect(screen.queryByText("刀身")).toBeNull();
  });

  it("discards a stale state response arriving after the project was switched", async () => {
    let resolveKnife: ((resp: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/three/projects")) {
          return Promise.resolve({ ok: true, json: async () => ({ projects: PROJECT_LIST }) });
        }
        if (url.includes("/api/three/project/file")) {
          return Promise.resolve({ ok: true, text: async () => "// compiled model source" });
        }
        if (url.includes("/api/three/project?name=knife")) {
          // knife 的状态请求挂起，模拟慢响应
          return new Promise((resolve) => {
            resolveKnife = resolve;
          });
        }
        if (url.includes("/api/three/project?name=sword")) {
          return Promise.resolve({ ok: true, json: async () => SWORD_STATE });
        }
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }),
    );

    render(<ThreeDMakerView />);
    fireEvent.click(await screen.findByRole("button", { name: "knife" }));
    // knife 响应未返回前切换到 sword
    fireEvent.click(screen.getByRole("button", { name: "sword" }));
    await screen.findByText("剑身");

    // knife 的迟到响应到达，必须被丢弃，不得覆盖 sword 的界面
    await act(async () => {
      resolveKnife!({ ok: true, json: async () => KNIFE_STATE });
      await Promise.resolve();
    });
    expect(screen.queryByText("刀身")).toBeNull();
    expect(screen.getByText("剑身")).toBeTruthy();
  });

  it("refreshes project state immediately when the agent finishes streaming", async () => {
    render(<ThreeDMakerView />);
    fireEvent.click(await screen.findByRole("button", { name: "knife" }));
    await screen.findByText("刀身");
    expect(chatPanelProps).not.toBeNull();

    const before = stateFetchCount("knife");
    act(() => chatPanelProps!.onStreamingChange?.(true));
    act(() => chatPanelProps!.onStreamingChange?.(false));

    await waitFor(() => expect(stateFetchCount("knife")).toBeGreaterThan(before));
  });

  it("polls project state while streaming and skips requests when the page is hidden", async () => {
    vi.useFakeTimers();
    try {
      render(<ThreeDMakerView />);
      await flushMicrotasks();
      fireEvent.click(screen.getByRole("button", { name: "knife" }));
      await flushMicrotasks();
      expect(screen.getByText("刀身")).toBeTruthy();

      const base = stateFetchCount("knife");
      act(() => chatPanelProps!.onStreamingChange?.(true));

      // 流式期间每 3 秒轮询一次
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await flushMicrotasks();
      expect(stateFetchCount("knife")).toBe(base + 1);

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await flushMicrotasks();
      expect(stateFetchCount("knife")).toBe(base + 2);

      // 页面不可见时跳过请求
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await flushMicrotasks();
      expect(stateFetchCount("knife")).toBe(base + 2);
      Object.defineProperty(document, "hidden", { configurable: true, value: false });

      // 流式结束立即最终刷新
      act(() => chatPanelProps!.onStreamingChange?.(false));
      await flushMicrotasks();
      expect(stateFetchCount("knife")).toBe(base + 3);

      // 结束后不再轮询
      await act(async () => {
        vi.advanceTimersByTime(9000);
      });
      await flushMicrotasks();
      expect(stateFetchCount("knife")).toBe(base + 3);
    } finally {
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      vi.useRealTimers();
    }
  });
});
