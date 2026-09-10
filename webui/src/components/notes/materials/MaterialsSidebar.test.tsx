import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaterialsSidebar } from "./MaterialsSidebar";
import * as materialsApi from "@/lib/materials-api";
import * as tauri from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
  isTauri: vi.fn(),
  materialsEnsureInitialized: vi.fn(),
  materialsImportFiles: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("@/lib/materials-api", () => ({
  cancelWikiCompile: vi.fn(),
  createKnowledgeLibrary: vi.fn(),
  createMaterialsDirectory: vi.fn(),
  deleteKnowledgeLibrary: vi.fn(),
  deleteMaterialsFile: vi.fn(),
  extractMaterialsText: vi.fn(),
  getMaterialsStatus: vi.fn(),
  getWikiCompileStatus: vi.fn(),
  listKnowledgeLibraries: vi.fn(),
  listMaterialsFiles: vi.fn(),
  listWikiPages: vi.fn(),
  moveMaterialsFile: vi.fn(),
  reconcileMaterials: vi.fn(),
  searchMaterials: vi.fn(),
  startWikiCompile: vi.fn(),
  updateKnowledgeLibrary: vi.fn(),
}));

const library = (id: string, name: string) => ({
  id,
  name,
  description: "",
  createdAt: "2026-08-30T00:00:00Z",
  updatedAt: "2026-08-30T00:00:00Z",
});

describe("MaterialsSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauri.isTauri).mockReturnValue(true);
    vi.mocked(tauri.materialsEnsureInitialized).mockResolvedValue(undefined);
    vi.mocked(materialsApi.listKnowledgeLibraries).mockResolvedValue([
      library("kb-product", "产品知识库"),
      library("kb-project", "项目资料库"),
    ]);
    vi.mocked(materialsApi.reconcileMaterials).mockResolvedValue({
      requeued: [],
      removedOrphans: [],
      staleWiki: [],
    });
    vi.mocked(materialsApi.listMaterialsFiles).mockResolvedValue([]);
    vi.mocked(materialsApi.listWikiPages).mockImplementation(async (knowledgeBaseId) => [
      {
        id: `wiki-${knowledgeBaseId}`,
        path: `${knowledgeBaseId}/overview.md`,
        title: knowledgeBaseId === "kb-project" ? "项目概览" : "产品概览",
        mtime: 1,
      },
    ]);
    vi.mocked(materialsApi.getMaterialsStatus).mockResolvedValue({
      rawFiles: 0,
      textFiles: 0,
      wikiFiles: 1,
      extract: { pending: 0, ok: 0, error: 0 },
    });
    vi.mocked(materialsApi.searchMaterials).mockResolvedValue([]);
    vi.mocked(materialsApi.createKnowledgeLibrary).mockResolvedValue(
      library("kb-created", "新知识库"),
    );
  });

  it("loads knowledge libraries and switches the active library", async () => {
    render(<MaterialsSidebar selection={null} onSelect={() => undefined} />);

    const selector = await screen.findByRole("combobox", { name: "当前知识库" });
    expect(selector).toHaveValue("kb-product");
    expect(await screen.findByRole("button", { name: "产品概览" })).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: "kb-project" } });

    await waitFor(() => {
      expect(selector).toHaveValue("kb-project");
      expect(screen.getByRole("button", { name: "项目概览" })).toBeInTheDocument();
    });
    expect(materialsApi.listWikiPages).toHaveBeenCalledWith("kb-project");
    expect(materialsApi.listMaterialsFiles).toHaveBeenCalledWith(undefined, "kb-project");
  });

  it("collapses and expands the knowledge pages group", async () => {
    render(<MaterialsSidebar selection={null} onSelect={() => undefined} />);

    expect(await screen.findByRole("button", { name: "产品概览" })).toBeInTheDocument();

    const wikiHeader = screen.getByRole("button", { name: "知识页面" });
    fireEvent.click(wikiHeader);
    expect(screen.queryByRole("button", { name: "产品概览" })).not.toBeInTheDocument();

    fireEvent.click(wikiHeader);
    expect(screen.getByRole("button", { name: "产品概览" })).toBeInTheDocument();
  });

  it("closes the create-library dialog after creation succeeds", async () => {
    vi.mocked(materialsApi.listKnowledgeLibraries)
      .mockResolvedValueOnce([
        library("kb-product", "产品知识库"),
        library("kb-project", "项目资料库"),
      ])
      .mockResolvedValueOnce([
        library("kb-product", "产品知识库"),
        library("kb-project", "项目资料库"),
        library("kb-created", "新知识库"),
      ]);
    render(<MaterialsSidebar selection={null} onSelect={() => undefined} />);

    await screen.findByRole("combobox", { name: "当前知识库" });
    fireEvent.click(screen.getByRole("button", { name: "新建知识库" }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "新知识库" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(materialsApi.createKnowledgeLibrary).toHaveBeenCalledWith("新知识库");
  });

  it("explains changed sources and updates affected pages", async () => {
    vi.mocked(materialsApi.listWikiPages).mockResolvedValue([
      {
        id: "wiki-stale",
        path: "overview.md",
        title: "产品概览",
        sources: ["docs/product.pdf"],
        stale: true,
        mtime: 1,
      },
    ]);
    vi.mocked(materialsApi.startWikiCompile).mockResolvedValue({
      taskId: "task-1",
      totalFiles: 1,
    });
    vi.mocked(materialsApi.getWikiCompileStatus).mockResolvedValue({
      taskId: "task-1",
      knowledgeBaseId: "kb-product",
      state: "done",
      currentFile: "",
      totalFiles: 1,
      completedFiles: 1,
      errors: [],
      warnings: [],
      pagesWritten: 1,
      writtenPaths: ["overview.md"],
      coverage: {
        complete: true,
        totalSegments: 1,
        processedSegments: 1,
        totalBatches: 1,
        processedBatches: 1,
        failedBatches: 0,
        missingSegments: 0,
        missingLocations: [],
      },
    });
    render(<MaterialsSidebar selection={null} onSelect={() => undefined} />);

    expect(await screen.findByText("来源资料有变化，1 个知识页面需要更新")).toBeInTheDocument();
    expect(screen.getByText("需更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "一键更新" }));

    await waitFor(() => {
      expect(materialsApi.startWikiCompile).toHaveBeenCalledWith(
        ["docs/product.pdf"],
        "kb-product",
      );
    });
  });

  it("uses user language for unfinished organization", async () => {
    vi.mocked(materialsApi.getMaterialsStatus).mockResolvedValue({
      rawFiles: 1,
      textFiles: 1,
      wikiFiles: 0,
      extract: { pending: 0, ok: 1, error: 0 },
      evidence: { represented: 0, excluded: 0, uncovered: 1, complete: false },
    });
    render(<MaterialsSidebar selection={null} onSelect={() => undefined} />);

    expect(await screen.findByText("有部分来源资料尚未完成整理")).toBeInTheDocument();
    expect(screen.queryByText(/证据：|明确排除|未覆盖/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续整理" })).toBeInTheDocument();
  });
});
