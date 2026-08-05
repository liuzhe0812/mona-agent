import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { PptTemplate } from "@/lib/types";
import { isTauri } from "@/lib/tauri";
import { DEFAULT_CONFIG, type PptConfig } from "./PptMakerView";
import { PptConfigPanel } from "./PptConfigPanel";

// --- API mocks ---
const pptAddSources = vi.fn();
const fetchPptOfficeCliCheck = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getApiBase: vi.fn().mockResolvedValue("http://api"),
    pptAddSources: (...args: unknown[]) => pptAddSources(...args),
    fetchPptOfficeCliCheck: (...args: unknown[]) => fetchPptOfficeCliCheck(...args),
    downloadPptOfficeCli: vi.fn(),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    isTauri: vi.fn(() => false),
  };
});

const tauriOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => tauriOpen(...args),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: {
      onPptUploadResult: vi.fn(() => () => {}),
      sendPptUpload: vi.fn(),
    },
    token: "tok",
  }),
}));

// --- Template dialog mock：捕获 props 并提供选择入口 ---
interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedKey: string | null;
  selectedKind: string | null;
  onSelect: (tpl: PptTemplate) => void;
}
let dialogProps: DialogProps | null = null;

const MOCK_TEMPLATE: PptTemplate = {
  key: "tpl-1",
  kind: "layout",
  group: "business",
  name: "商务蓝",
  summary: "",
  coverSvgUrl: "",
};

vi.mock("./PptTemplateDialog", () => ({
  PptTemplateDialog: (props: DialogProps) => {
    dialogProps = props;
    if (!props.open) return null;
    return (
      <button
        type="button"
        data-testid="mock-pick-template"
        onClick={() => props.onSelect(MOCK_TEMPLATE)}
      >
        选择模板
      </button>
    );
  },
}));

let harnessConfig: PptConfig | null = null;

function Harness({ initial, onStart }: { initial?: Partial<PptConfig>; onStart?: () => void }) {
  const [config, setConfig] = useState<PptConfig>({ ...DEFAULT_CONFIG, ...initial });
  harnessConfig = config;
  return (
    <PptConfigPanel
      config={config}
      setConfig={setConfig}
      phase="config"
      onStart={onStart ?? vi.fn()}
    />
  );
}

describe("PptConfigPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogProps = null;
    harnessConfig = null;
    vi.mocked(isTauri).mockReturnValue(false);
    fetchPptOfficeCliCheck.mockResolvedValue({
      ok: true,
      version: "1.2.3",
      path: "/x",
      error: null,
      supported: true,
    });
  });

  it("可从配置页打开模板选择器，选择后写入 templateKey/templateKind", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: /选择内置版式、品牌或自定义模板/ }));
    expect(dialogProps?.open).toBe(true);

    fireEvent.click(screen.getByTestId("mock-pick-template"));

    await waitFor(() => expect(harnessConfig?.templateKey).toBe("tpl-1"));
    expect(harnessConfig?.templateKind).toBe("layout");
    // 配置页显示已选模板名称与类型标签
    await screen.findByText("商务蓝");
    expect(screen.getByText("内置版式")).toBeTruthy();
  });

  it("切换到「沿用现有 PPT」后显示模版上传入口，不再显示内置版式入口", async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "沿用现有 PPT" }));

    // 引擎检测完成后显示模版上传入口
    await screen.findByText("PPT 编辑组件已就绪（1.2.3）");
    expect(screen.getByRole("button", { name: /选择 \.pptx 模版文件/ })).toBeTruthy();
    // 内置版式入口消失
    expect(screen.queryByText(/选择内置版式、品牌或自定义模板/)).toBeNull();
    expect(harnessConfig?.mode).toBe("template");
  });

  it("无主题且无来源文件时主按钮不可用，并给出原因", () => {
    render(<Harness />);

    const start = screen.getByRole("button", { name: "开始生成" });
    expect(start).toBeDisabled();
    expect(screen.getByText("请先填写主题或添加源文件")).toBeTruthy();
  });

  it("上传失败后错误可见且可重试，已填写主题不丢失", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    tauriOpen.mockResolvedValue(["/tmp/a.pdf"]);
    pptAddSources.mockRejectedValueOnce(new Error("磁盘已满"));

    render(<Harness initial={{ topic: "季度总结" }} />);

    // 切到源文件 tab 并选择文件
    fireEvent.click(screen.getByRole("button", { name: /源文件/ }));
    fireEvent.click(screen.getByRole("button", { name: /点击选择文件或拖拽到此处/ }));

    // 上传失败：错误区域可见，提供重试
    await screen.findByText("文件上传失败：磁盘已满");
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();

    // 重试成功：错误消除，文件进入配置
    pptAddSources.mockResolvedValueOnce({ files: [{ name: "a.pdf", path: "/ws/a.pdf" }] });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() =>
      expect(screen.queryByText(/文件上传失败/)).toBeNull(),
    );
    await waitFor(() => expect(harnessConfig?.sourceFiles).toContain("/ws/a.pdf"));

    // 已填写主题仍在
    expect(harnessConfig?.topic).toBe("季度总结");
    fireEvent.click(screen.getByRole("button", { name: /输入主题/ }));
    expect(
      (screen.getByPlaceholderText("描述你想要制作的 PPT 主题...") as HTMLTextAreaElement).value,
    ).toBe("季度总结");
  });
});
