import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { StockMaterialEvidencePanel } from "./StockMaterialEvidencePanel";

const fetchStockMaterials = vi.fn();
const createStockMaterialBinding = vi.fn();
const confirmStockMaterialBinding = vi.fn();
const fetchStockMaterialPage = vi.fn();
const isTauriMock = vi.fn(() => false);
const materialsImportFiles = vi.fn();
const extractMaterialsText = vi.fn();
const openFileDialog = vi.fn();

vi.mock("@/lib/stock-api", () => ({
  fetchStockMaterials: (...args: unknown[]) => fetchStockMaterials(...args),
  createStockMaterialBinding: (...args: unknown[]) => createStockMaterialBinding(...args),
  confirmStockMaterialBinding: (...args: unknown[]) => confirmStockMaterialBinding(...args),
  fetchStockMaterialPage: (...args: unknown[]) => fetchStockMaterialPage(...args),
}));

vi.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  materialsImportFiles: (...args: unknown[]) => materialsImportFiles(...args),
}));

vi.mock("@/lib/materials-api", () => ({
  extractMaterialsText: (...args: unknown[]) => extractMaterialsText(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openFileDialog(...args),
}));

const BASE_MATERIAL = {
  material_id: "material_pdf_1",
  material_name: "C:\\reports\\贵州茅台半年报.pdf",
  extraction_status: "已完成",
  page_count: 12,
  bindings: [],
};

const CONFIRMED_BINDING = {
  binding_id: "binding_confirmed",
  status: "已确认",
  status_code: "confirmed",
  report_period: "2026-06-30",
  first_published_at: "2026-08-20T18:00:00+08:00",
  publisher: "贵州茅台股份有限公司",
  pages: [1, 3],
  confirmed_facts: [{
    metric_name: "营业收入",
    value_text: "100",
    unit: "亿元",
    page: 1,
    excerpt: "营业收入 100 亿元。",
  }],
  confirmed_at: "2026-08-21T09:00:00+08:00",
  invalidation_reason: null,
};

const PENDING_BINDING = {
  binding_id: "binding_pending",
  status: "待用户确认",
  status_code: "pending",
  report_period: "2026-06-30",
  first_published_at: "2026-08-20T18:00:00+08:00",
  publisher: "贵州茅台股份有限公司",
  pages: [2],
  confirmed_at: null,
  invalidation_reason: null,
};

const INVALID_BINDING = {
  binding_id: "binding_invalid",
  status: "已失效",
  status_code: "invalidated",
  report_period: "2026-06-30",
  first_published_at: "2026-08-20T18:00:00+08:00",
  publisher: "贵州茅台股份有限公司",
  pages: [4],
  confirmed_at: null,
  invalidation_reason: "页码已失效",
};

function renderPanel(onSelectionChange = vi.fn()) {
  return render(
    <StockMaterialEvidencePanel
      instrumentId="XSHG:600519"
      open
      onSelectionChange={onSelectionChange}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(false);
  fetchStockMaterials.mockResolvedValue({ instrument_id: "XSHG:600519", materials: [BASE_MATERIAL] });
  createStockMaterialBinding.mockResolvedValue(null);
  confirmStockMaterialBinding.mockResolvedValue(null);
  fetchStockMaterialPage.mockResolvedValue({ material_name: "贵州茅台半年报.pdf", page: 1, page_count: 12, text: "财报原文" });
  materialsImportFiles.mockResolvedValue([{ name: "贵州茅台半年报.pdf", path: "贵州茅台半年报.pdf", kind: "file", size: 1, mtime: null }]);
  extractMaterialsText.mockResolvedValue(undefined);
  openFileDialog.mockResolvedValue(["C:\\reports\\贵州茅台半年报.pdf"]);
});

describe("StockMaterialEvidencePanel", () => {
  it("shows only Chinese material states and no upload button outside the desktop app", async () => {
    renderPanel();
    expect(await screen.findByText("贵州茅台半年报.pdf")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "上传财报" })).toBeNull();
    expect(screen.getByText("请在桌面端上传财报")).toBeTruthy();
    expect(screen.getByTestId("stock-material-evidence-panel").textContent).not.toMatch(
      /material_pdf_1|binding_|ready|pending|confirmed|invalidated|XSHG:600519/,
    );
  });

  it("allows only confirmed and valid records to be selected", async () => {
    fetchStockMaterials.mockResolvedValueOnce({
      instrument_id: "XSHG:600519",
      materials: [{ ...BASE_MATERIAL, bindings: [CONFIRMED_BINDING, PENDING_BINDING, INVALID_BINDING] }],
    });
    const onSelectionChange = vi.fn();
    renderPanel(onSelectionChange);
    expect(await screen.findByText("已确认")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择贵州茅台半年报.pdf" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["binding_confirmed"]);
    expect(screen.getAllByText("发布机构：贵州茅台股份有限公司").length).toBe(3);
    expect(screen.getAllByText("首次公开：2026-08-20 18:00:00+08:00").length).toBe(3);
    expect(screen.getByText("使用页码：第 1 页、第 3 页")).toBeTruthy();
    expect(screen.getByText("已核对关键财务数据")).toBeTruthy();
    expect(screen.getByText("营业收入：100 亿元 · 第 1 页")).toBeTruthy();
    expect(screen.getByText("原文摘录：营业收入 100 亿元。")).toBeTruthy();
  });

  it("preserves the material list when preview or explicit confirmation fails", async () => {
    fetchStockMaterials.mockResolvedValueOnce({
      instrument_id: "XSHG:600519",
      materials: [{ ...BASE_MATERIAL, bindings: [PENDING_BINDING] }],
    });
    fetchStockMaterialPage.mockRejectedValueOnce(new Error("upstream unavailable"));
    renderPanel();
    await screen.findByText("贵州茅台半年报.pdf");
    fireEvent.click(screen.getByRole("button", { name: "逐页核对并确认" }));
    expect(await screen.findByText("财报页文本读取失败，请重试")).toBeTruthy();
    expect(screen.getByText("贵州茅台半年报.pdf")).toBeTruthy();

    fetchStockMaterialPage.mockResolvedValueOnce({ material_name: "贵州茅台半年报.pdf", page: 2, page_count: 12, text: "第 2 页原文" });
    fireEvent.click(screen.getByRole("button", { name: "逐页核对并确认" }));
    expect(await screen.findByText("第 2 页原文")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "添加关键财务数据" }));
    fireEvent.change(screen.getByLabelText("第 1 项指标"), { target: { value: "revenue" } });
    fireEvent.change(screen.getByLabelText("原文中的数值"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("第 1 项单位"), { target: { value: "hundred_million_yuan" } });
    fireEvent.change(screen.getByLabelText("第 1 项页码"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("精确原文摘录"), { target: { value: "第 2 页原文中的营业收入 100 亿元。" } });
    confirmStockMaterialBinding.mockRejectedValueOnce(new Error("confirm failed"));
    fireEvent.click(screen.getByRole("button", { name: "确认这份财报" }));
    expect(await screen.findByText("财报确认失败，已保留已填写内容，请修正后重试")).toBeTruthy();
    expect(screen.getByText("贵州茅台半年报.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认这份财报" })).toBeEnabled();
    expect(screen.getByLabelText("第 1 项指标")).toHaveValue("revenue");
    expect(screen.getByLabelText("原文中的数值")).toHaveValue("100");
    expect(screen.getByLabelText("第 1 项单位")).toHaveValue("hundred_million_yuan");
    expect(screen.getByLabelText("第 1 项页码")).toHaveValue("2");
    expect(screen.getByLabelText("精确原文摘录")).toHaveValue("第 2 页原文中的营业收入 100 亿元。");
  });

  it("allows zero facts and sends an explicit empty fact list", async () => {
    fetchStockMaterials.mockResolvedValueOnce({
      instrument_id: "XSHG:600519",
      materials: [{ ...BASE_MATERIAL, bindings: [PENDING_BINDING] }],
    });
    fetchStockMaterialPage.mockResolvedValueOnce({ material_name: "贵州茅台半年报.pdf", page: 2, page_count: 12, text: "第 2 页原文" });
    renderPanel();
    await screen.findByText("贵州茅台半年报.pdf");
    fireEvent.click(screen.getByRole("button", { name: "逐页核对并确认" }));
    await screen.findByText("第 2 页原文");
    fireEvent.click(screen.getByRole("button", { name: "确认这份财报" }));
    await waitFor(() => expect(confirmStockMaterialBinding).toHaveBeenCalledWith("binding_pending", []));
  });

  it("sends manually entered facts and requires an explicit unit choice", async () => {
    fetchStockMaterials.mockResolvedValueOnce({
      instrument_id: "XSHG:600519",
      materials: [{ ...BASE_MATERIAL, bindings: [PENDING_BINDING] }],
    });
    fetchStockMaterialPage.mockImplementation(async (_materialId: string, page: number) => ({
      material_name: "贵州茅台半年报.pdf",
      page,
      page_count: 12,
      text: "营业收入 100 亿元。",
    }));
    renderPanel();
    await screen.findByText("贵州茅台半年报.pdf");
    fireEvent.click(screen.getByRole("button", { name: "逐页核对并确认" }));
    await screen.findByText("营业收入 100 亿元。");
    fireEvent.click(screen.getByRole("button", { name: "添加关键财务数据" }));
    const metric = screen.getByLabelText("第 1 项指标");
    const unit = screen.getByLabelText("第 1 项单位");
    fireEvent.change(metric, { target: { value: "revenue" } });
    expect(unit).toHaveValue("");
    fireEvent.change(screen.getByLabelText("原文中的数值"), { target: { value: "100" } });
    fireEvent.change(unit, { target: { value: "hundred_million_yuan" } });
    fireEvent.change(screen.getByLabelText("第 1 项页码"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("精确原文摘录"), { target: { value: "营业收入 100 亿元。" } });
    fireEvent.click(screen.getByRole("button", { name: "确认这份财报" }));
    await waitFor(() => expect(confirmStockMaterialBinding).toHaveBeenCalledWith("binding_pending", [{
      metric: "revenue",
      value_text: "100",
      unit: "hundred_million_yuan",
      page: 2,
      excerpt: "营业收入 100 亿元。",
    }]));
  });

  it("uploads only PDF files at the material root and keeps extraction errors in Chinese", async () => {
    isTauriMock.mockReturnValue(true);
    extractMaterialsText.mockRejectedValueOnce(new Error("extract failed"));
    renderPanel();
    await screen.findByText("贵州茅台半年报.pdf");
    fireEvent.click(screen.getByRole("button", { name: "上传财报" }));
    await waitFor(() => expect(materialsImportFiles).toHaveBeenCalledWith(
      ["C:\\reports\\贵州茅台半年报.pdf"],
      "",
    ));
    expect(extractMaterialsText).toHaveBeenCalledWith("贵州茅台半年报.pdf");
    expect(await screen.findByText("财报已上传，但部分文本提取失败，请稍后重试。")).toBeTruthy();
    expect(screen.getByText("贵州茅台半年报.pdf")).toBeTruthy();
  });

  it("requires explicit report metadata before creating a pending record", async () => {
    renderPanel();
    await screen.findByText("贵州茅台半年报.pdf");
    fireEvent.click(screen.getByRole("button", { name: "登记财报信息" }));
    fireEvent.change(screen.getByLabelText("报告期（日期）"), { target: { value: "2026-06-30" } });
    fireEvent.change(screen.getByLabelText("首次公开时间"), { target: { value: "2026-08-20T18:00" } });
    fireEvent.change(screen.getByLabelText("发布机构"), { target: { value: "贵州茅台股份有限公司" } });
    fireEvent.change(screen.getByLabelText("使用页码"), { target: { value: "1, 3" } });
    fireEvent.click(screen.getByRole("button", { name: "登记为待确认财报" }));
    await waitFor(() => expect(createStockMaterialBinding).toHaveBeenCalledWith({
      instrument_id: "XSHG:600519",
      material_id: "material_pdf_1",
      report_period: "2026-06-30",
      first_published_at: "2026-08-20T18:00",
      publisher: "贵州茅台股份有限公司",
      pages: [1, 3],
    }));
  });

  it("clears selected records when the stock changes", async () => {
    const onSelectionChange = vi.fn();
    fetchStockMaterials.mockImplementation(async (instrumentId: string) => ({
      instrument_id: instrumentId,
      materials: instrumentId === "XSHG:600519"
        ? [{ ...BASE_MATERIAL, bindings: [CONFIRMED_BINDING] }]
        : [],
    }));
    function Harness() {
      const [instrumentId, setInstrumentId] = useState("XSHG:600519");
      return <>
        <button type="button" onClick={() => setInstrumentId("XSHE:000001")}>切换股票</button>
        <StockMaterialEvidencePanel instrumentId={instrumentId} open onSelectionChange={onSelectionChange} />
      </>;
    }
    render(<Harness />);
    await screen.findByText("贵州茅台半年报.pdf");
    fireEvent.click(screen.getByRole("checkbox", { name: "选择贵州茅台半年报.pdf" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(["binding_confirmed"]);
    fireEvent.click(screen.getByRole("button", { name: "切换股票" }));
    await screen.findByText("当前股票暂无可用财报。");
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });
});
