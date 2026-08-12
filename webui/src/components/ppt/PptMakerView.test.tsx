import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forwardRef } from "react";

import { PptMakerView, resolveNextPhase, type PptConfig } from "./PptMakerView";

// --- API mocks ---
const fetchPptExportStatus = vi.fn();
const markPptGenerating = vi.fn().mockResolvedValue({ ok: true });
const savePptChatId = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getApiBase: vi.fn().mockResolvedValue("http://api"),
    fetchPptExportStatus: (...args: unknown[]) => fetchPptExportStatus(...args),
    markPptGenerating: (...args: unknown[]) => markPptGenerating(...args),
    savePptChatId: (...args: unknown[]) => savePptChatId(...args),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: () => false,
    httpFetch: vi.fn(),
  };
});

vi.mock("@/lib/project-name", () => ({
  generateProjectName: vi.fn().mockReturnValue("ppt-test-project"),
}));

const newChat = vi.fn().mockResolvedValue("chat-1");
const sendMessage = vi.fn();

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: { newChat, sendMessage, onPptPhaseChanged: () => () => {} },
    token: "tok",
  }),
}));

vi.mock("@/hooks/useBreakpoint", () => ({
  useBreakpoint: () => "narrow",
}));

// --- Child component mocks ---
interface ConfigPanelProps {
  config: PptConfig;
  setConfig: React.Dispatch<React.SetStateAction<PptConfig>>;
  phase: string;
  onStart: () => void;
}
let configPanelProps: ConfigPanelProps | null = null;

vi.mock("./PptConfigWizard", () => ({
  PptConfigWizard: (props: ConfigPanelProps) => {
    configPanelProps = props;
    return <div data-testid="config-panel" />;
  },
}));

vi.mock("./PptChatPanel", () => ({
  PptChatPanel: forwardRef((_props, _ref) => <div data-testid="chat-panel" />),
}));

vi.mock("./PptPreview", () => ({
  PptPreview: () => <div data-testid="ppt-preview" />,
}));

vi.mock("./PptHistory", () => ({
  PptHistory: () => <div data-testid="ppt-history" />,
}));

vi.mock("./PptOutlinePhase", () => ({
  PptOutlinePhase: () => <div data-testid="outline-phase" />,
}));

vi.mock("./PptProducingPhase", () => ({
  PptProducingPhase: () => <div data-testid="producing-phase" />,
}));

const EXPORT_STATUS_BASE = {
  status: "generating" as const,
  slideCount: 0,
  hasExport: false,
  hasSvgOutput: false,
  hasPptxOutput: false,
  hasSpecLock: false,
  exportFile: null,
  pipelineStage: "init",
  svgOutputCount: 0,
  svgFinalCount: 0,
};

function statusWithPhase(phase: string) {
  return { ...EXPORT_STATUS_BASE, phase };
}

async function startGeneration() {
  await act(async () => {
    configPanelProps?.onStart();
  });
}

describe("resolveNextPhase", () => {
  it("allows forward transitions", () => {
    expect(resolveNextPhase("generating", "outline")).toBe("outline");
    expect(resolveNextPhase("generating", "done")).toBe("done");
    expect(resolveNextPhase("outline", "producing")).toBe("producing");
    expect(resolveNextPhase("producing", "exporting")).toBe("exporting");
    expect(resolveNextPhase("exporting", "done")).toBe("done");
  });

  it("allows staying at the same phase", () => {
    expect(resolveNextPhase("outline", "outline")).toBe("outline");
  });

  it("rejects regressive transitions (stale poll responses)", () => {
    expect(resolveNextPhase("exporting", "outline")).toBeNull();
    expect(resolveNextPhase("producing", "generating")).toBeNull();
    expect(resolveNextPhase("done", "producing")).toBeNull();
  });

  it("rejects unknown phase names", () => {
    expect(resolveNextPhase("generating", "bogus")).toBeNull();
  });
});

describe("PptMakerView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configPanelProps = null;
    localStorage.clear();
    fetchPptExportStatus.mockResolvedValue(statusWithPhase("outline"));
  });

  it("starts in generating phase, then advances to outline when backend reports it", async () => {
    // 第一次轮询挂起：generating 态可观测，避免轮询立即返回 outline 竞态
    let resolvePoll: ((v: ReturnType<typeof statusWithPhase>) => void) | null = null;
    fetchPptExportStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePoll = resolve;
        }),
    );
    render(<PptMakerView />);
    expect(screen.getByTestId("config-panel")).toBeTruthy();

    await startGeneration();

    // 启动序列：标记 generating → 创建会话 → 保存 chatId → 发送 prompt
    expect(markPptGenerating).toHaveBeenCalledWith("tok", "ppt-test-project", "start");
    expect(newChat).toHaveBeenCalled();
    expect(savePptChatId).toHaveBeenCalledWith("tok", "ppt-test-project", "chat-1");
    expect(sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("PPT_UI_CHECKPOINTS=1"));

    // 统一进入 generating，不直接跳 outline
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.queryByTestId("outline-phase")).toBeNull();

    // 轮询返回 outline 后进入大纲页
    await act(async () => {
      resolvePoll?.(statusWithPhase("outline"));
    });
    await waitFor(() => expect(screen.getByTestId("outline-phase")).toBeTruthy());
  });

  it("reaches the done phase with a download entry when backend reports done (template mode path)", async () => {
    fetchPptExportStatus.mockResolvedValue({
      ...statusWithPhase("done"),
      status: "done",
      hasExport: true,
      hasPptxOutput: true,
    });
    render(<PptMakerView />);
    await startGeneration();

    await waitFor(() => expect(screen.getByText("PPT 已生成")).toBeTruthy());
    // 完成态结果操作条：唯一主下载按钮
    const downloads = screen.getAllByRole("button", { name: /下载 PPTX/ });
    expect(downloads).toHaveLength(1);
    expect(screen.getByTestId("ppt-preview")).toBeTruthy();
  });

  it("keeps the user on the config page with an error when startup fails", async () => {
    newChat.mockRejectedValueOnce(new Error("连接失败"));
    render(<PptMakerView />);
    await startGeneration();

    await waitFor(() =>
      expect(screen.getByText(/启动失败：连接失败/)).toBeTruthy(),
    );
    // 停留在配置页，可重试；不留活动项目假状态
    expect(screen.getByTestId("config-panel")).toBeTruthy();
    expect(screen.queryByText("正在处理")).toBeNull();
    expect(configPanelProps?.phase).toBe("config");
    // best-effort 结束后端 generating 标记
    expect(markPptGenerating).toHaveBeenCalledWith("tok", "ppt-test-project", "finish");
  });

  it("restores a persisted project to its saved phase instead of the done page", async () => {
    localStorage.setItem(
      "mona.ppt.activeProject",
      JSON.stringify({ name: "ppt-old", chatId: "chat-old", phase: "generating" }),
    );
    fetchPptExportStatus.mockResolvedValue(statusWithPhase("generating"));

    render(<PptMakerView />);

    // 存在性校验通过 → 恢复到 generating，不渲染完成页
    await waitFor(() => expect(screen.getByText("正在处理")).toBeTruthy());
    expect(screen.queryByText("PPT 已生成")).toBeNull();
    expect(screen.queryByTestId("outline-phase")).toBeNull();
  });

  it("cleans up persisted state when the restored project no longer exists", async () => {
    localStorage.setItem(
      "mona.ppt.activeProject",
      JSON.stringify({ name: "ppt-gone", chatId: null, phase: "outline" }),
    );
    fetchPptExportStatus.mockRejectedValue(new Error("HTTP 404"));

    render(<PptMakerView />);

    // 校验失败后回到新建页
    await waitFor(() => expect(screen.getByTestId("config-panel")).toBeTruthy());
    expect(localStorage.getItem("mona.ppt.activeProject")).toBeNull();
  });

  it("corrects a stale persisted phase from the backend on restore", async () => {
    localStorage.setItem(
      "mona.ppt.activeProject",
      JSON.stringify({ name: "ppt-old", chatId: "chat-old", phase: "generating" }),
    );
    fetchPptExportStatus.mockResolvedValue(statusWithPhase("outline"));

    render(<PptMakerView />);

    // 后端权威 phase 为 outline，校正后渲染大纲页而非 generating
    await waitFor(() => expect(screen.getByTestId("outline-phase")).toBeTruthy());
    expect(screen.queryByText("正在处理")).toBeNull();
    // localStorage 同步被校正
    const persisted = JSON.parse(localStorage.getItem("mona.ppt.activeProject")!);
    expect(persisted.phase).toBe("outline");
  });
});
