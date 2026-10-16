import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StorageConversation } from "./StorageConversation";
import { STORAGE_DIRECTORY_ANALYSIS_PROMPT, STORAGE_FILE_ANALYSIS_PROMPT, type StorageAssessment } from "./systemAgentApi";
import type { StorageCleanupResult, StorageScanResult, useStorageScan } from "./useSystemData";

const storageConversationMock = vi.hoisted(() => ({
  analyze: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./systemAgentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemAgentApi")>()),
  requestStorageAnalysis: storageConversationMock.analyze,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: storageConversationMock.invoke }));

function makeResult(scanId = "scan-1", drive = "C:"): StorageScanResult {
  const driveKey = drive[0].toLowerCase();
  return {
    scanId,
    disks: [],
    directories: [{ id: `dir-${driveKey}`, path: `${drive}\\Data`, sizeGb: 8, fileCount: 4, directSizeGb: 8 }],
    cleanupItems: [
      { id: "temp", name: "系统临时文件", sizeGb: 2.5, path: `${drive}\\Temp`, cleanable: true, recommended: true, reason: "临时文件" },
      { id: "trash", name: "回收站", sizeGb: 0.7, path: `${drive}\\$Recycle.Bin`, cleanable: true, recommended: true, reason: "回收站文件" },
    ],
    fileTypes: [],
    totalScannedGb: 120,
    topFiles: [{
      id: `file-${driveKey}`,
      path: `${drive}\\Data\\backup.zip`,
      parentDirName: "Data",
      extension: "zip",
      sizeGb: 3,
      modifiedBucket: "old",
    }],
  };
}

function makeStorage(
  result: StorageScanResult | null = makeResult(),
  cleaningIds = new Set<string>(),
  clean: (ids: string[]) => Promise<StorageCleanupResult> = async () => ({ freedGb: 1.2, cleanedIds: ["temp"], failures: [] }),
  selectedDrive = "C:",
) {
  return {
    status: result ? "done" as const : "idle" as const,
    result,
    lastScanAt: null,
    progress: null,
    error: null,
    cleaning: cleaningIds.size > 0,
    cleaningIds,
    start: vi.fn(async () => result),
    cancel: vi.fn(async () => undefined),
    clean: vi.fn(clean),
    trashFiles: vi.fn(),
    selectedDrive,
    selectDrive: vi.fn(),
  } as unknown as ReturnType<typeof useStorageScan>;
}

function assessment(scanId: string, targetIds: string[] = []): StorageAssessment {
  return {
    scanId,
    summary: "占用主要来自用户目录。",
    findings: targetIds.length > 0 ? [{
      id: "finding-cleanup",
      title: "可以清理临时文件",
      detail: "这项操作只处理扫描确认的清理项。",
      confidence: "high",
      risk: "low",
      evidenceIds: ["temp"],
      action: "plan_cleanup",
      targetIds,
      relatedSizeGb: 2.5,
    }] : [],
    cautions: [],
  };
}

function directoryAndFileAssessment(scanId: string, directoryId: string, fileId: string): StorageAssessment {
  return {
    scanId,
    summary: "这是 C 盘旧扫描的分析结论。",
    findings: [
      {
        id: "finding-directory",
        title: "查看目录占用",
        detail: "可以继续查看扫描时选中的目录。",
        confidence: "high",
        risk: "review",
        evidenceIds: [directoryId],
        action: "inspect_directory",
        targetIds: [directoryId],
        relatedSizeGb: 8,
      },
      {
        id: "finding-file",
        title: "审查大文件",
        detail: "大文件应由用户检查后决定。",
        confidence: "medium",
        risk: "review",
        evidenceIds: [fileId],
        action: "review_files",
        targetIds: [fileId],
        relatedSizeGb: 3,
      },
    ],
    cautions: [],
  };
}

function renderConversation(storage = makeStorage()) {
  return render(<StorageConversation storage={storage} selection={null} analysisRequest={null} />);
}

async function ask(question: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("存储空间问题"), { target: { value: question } });
    fireEvent.click(screen.getByRole("button", { name: "发送给 Mona" }));
    await Promise.resolve();
  });
}

describe("StorageConversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageConversationMock.invoke.mockResolvedValue(undefined);
  });

  it("answers a chosen nested directory directly and keeps its context for follow-ups", async () => {
    const result = makeResult();
    const child = { id: "dir-nested", path: "C:\\Data\\Cache", sizeGb: 2, fileCount: 3, directSizeGb: 2 };
    result.directories[0].children = [child];
    storageConversationMock.analyze.mockResolvedValue({ ...assessment("scan-1", ["temp"]), summary: "这个目录主要用于应用缓存。" });
    const storage = makeStorage(result);
    const { rerender } = render(<StorageConversation storage={storage} selection={null} />);
    expect(storageConversationMock.analyze).not.toHaveBeenCalled();
    const request = { goal: STORAGE_DIRECTORY_ANALYSIS_PROMPT, nonce: 1, directoryId: child.id, scanId: "scan-1" };
    rerender(<StorageConversation storage={storage} selection={null} analysisRequest={request} />);
    await screen.findByText(/这个目录主要用于应用缓存/);
    expect(storageConversationMock.analyze).toHaveBeenCalledTimes(1);
    const evidence = storageConversationMock.analyze.mock.calls[0][1];
    expect(evidence.selectedDirectory).toMatchObject({ id: "dir-nested", name: "Cache" });
    expect(evidence.scope.id).toBe("dir-nested");
    expect(screen.queryByRole("button", { name: "清理系统临时文件" })).toBeNull();
    expect(storage.clean).not.toHaveBeenCalled();
    rerender(<StorageConversation storage={storage} selection={result.directories[0]} analysisRequest={request} />);
    await ask("清理它之前需要确认什么？");
    expect(storageConversationMock.analyze.mock.calls[1][1].selectedDirectory.id).toBe("dir-nested");
    expect(storageConversationMock.analyze.mock.calls[1][3]).toEqual(expect.arrayContaining([
      { role: "user", content: "分析目录「Cache」的作用、占用和清理办法" },
    ]));
    expect(storage.start).not.toHaveBeenCalled();
  });

  it("does not send a directory request from an expired scan", async () => {
    render(<StorageConversation storage={makeStorage()} selection={null} analysisRequest={{ goal: STORAGE_DIRECTORY_ANALYSIS_PROMPT, nonce: 1, directoryId: "dir-c", scanId: "expired" }} />);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("暂时无法回答这个问题");
    expect(storageConversationMock.analyze).not.toHaveBeenCalled();
  });

  it("analyzes an explicitly chosen file once and retains it for follow-ups without native actions", async () => {
    storageConversationMock.analyze.mockResolvedValue(assessment("scan-1", ["temp"]));
    const storage = makeStorage();
    const onBusy = vi.fn();
    const { rerender } = render(<StorageConversation storage={storage} selection={null} onFileAnalysisChange={onBusy} />);
    expect(storageConversationMock.analyze).not.toHaveBeenCalled();
    const request = { goal: STORAGE_FILE_ANALYSIS_PROMPT, nonce: 1, fileId: "file-c", scanId: "scan-1" };
    rerender(<StorageConversation storage={storage} selection={null} analysisRequest={request} onFileAnalysisChange={onBusy} />);
    await screen.findByText(/占用主要来自用户目录。.*这项操作只处理扫描确认的清理项。/s);
    expect(storageConversationMock.analyze).toHaveBeenCalledTimes(1);
    expect(storageConversationMock.analyze.mock.calls[0][0]).toBe(STORAGE_FILE_ANALYSIS_PROMPT);
    expect(storageConversationMock.analyze.mock.calls[0][1].selectedFile).toMatchObject({ id: "file-c", name: "backup.zip" });
    expect(screen.queryByRole("button", { name: "清理系统临时文件" })).toBeNull();
    expect(storage.clean).not.toHaveBeenCalled();
    expect(onBusy).toHaveBeenCalledWith("file-c");
    expect(onBusy).toHaveBeenLastCalledWith(null);

    rerender(<StorageConversation storage={storage} selection={storage.result!.directories[0]} analysisRequest={request} onFileAnalysisChange={onBusy} />);
    expect(storageConversationMock.analyze).toHaveBeenCalledTimes(1);
    await ask("删除会丢失什么？");
    expect(storageConversationMock.analyze.mock.calls[1][1].selectedFile.id).toBe("file-c");
    expect(storageConversationMock.analyze.mock.calls[1][3]).toEqual(expect.arrayContaining([
      { role: "user", content: "分析文件「backup.zip」的用途及是否可以清理" },
    ]));
    expect(storage.start).not.toHaveBeenCalled();
  });

  it("cancels a previous file analysis when another file is chosen and ignores its late answer", async () => {
    let finishFirst!: (value: StorageAssessment) => void;
    let finishSecond!: (value: StorageAssessment) => void;
    storageConversationMock.analyze
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve; }));
    const result = makeResult();
    result.topFiles!.push({ ...result.topFiles![0], id: "file-second", path: "C:\\Data\\second.bin" });
    const storage = makeStorage(result);
    const onBusy = vi.fn();
    const { rerender } = render(<StorageConversation storage={storage} selection={null} analysisRequest={{ goal: STORAGE_FILE_ANALYSIS_PROMPT, nonce: 1, fileId: "file-c", scanId: "scan-1" }} onFileAnalysisChange={onBusy} />);
    await waitFor(() => expect(storageConversationMock.analyze).toHaveBeenCalledTimes(1));
    const firstSignal = storageConversationMock.analyze.mock.calls[0][2] as AbortSignal;
    rerender(<StorageConversation storage={storage} selection={null} analysisRequest={{ goal: STORAGE_FILE_ANALYSIS_PROMPT, nonce: 2, fileId: "file-second", scanId: "scan-1" }} onFileAnalysisChange={onBusy} />);
    await waitFor(() => expect(storageConversationMock.analyze).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);
    expect(storageConversationMock.analyze.mock.calls[1][1].selectedFile.id).toBe("file-second");
    expect(storageConversationMock.analyze.mock.calls[1][3]).toEqual([]);
    await act(async () => finishFirst({ ...assessment("scan-1"), summary: "旧文件晚到回答" }));
    expect(screen.queryByText("旧文件晚到回答")).toBeNull();
    expect(onBusy).toHaveBeenLastCalledWith("file-second");
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(onBusy).toHaveBeenLastCalledWith(null);
    expect((storageConversationMock.analyze.mock.calls[1][2] as AbortSignal).aborted).toBe(true);
    await act(async () => finishSecond({ ...assessment("scan-1"), summary: "停止后第二个回答" }));
    expect(screen.queryByText("停止后第二个回答")).toBeNull();
  });

  it("rejects a stale file request instead of analyzing a different snapshot", async () => {
    render(<StorageConversation storage={makeStorage()} selection={null} analysisRequest={{ goal: STORAGE_FILE_ANALYSIS_PROMPT, nonce: 1, fileId: "file-c", scanId: "expired-scan" }} />);
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("暂时无法回答这个问题");
    expect(storageConversationMock.analyze).not.toHaveBeenCalled();
  });

  it("carries earlier user and Mona messages into a natural follow-up", async () => {
    storageConversationMock.analyze
      .mockResolvedValueOnce(assessment("scan-1"))
      .mockResolvedValueOnce({ ...assessment("scan-1"), summary: "Users 是当前扫描范围内最大的目录。" });
    const storage = makeStorage();
    renderConversation(storage);

    await ask("C 盘空间都用在哪里？");
    expect(await screen.findByText("占用主要来自用户目录。")).toBeInTheDocument();
    await ask("能展开说说吗？");

    await waitFor(() => expect(storageConversationMock.analyze).toHaveBeenCalledTimes(2));
    expect(storageConversationMock.analyze.mock.calls[1][0]).toBe("能展开说说吗？");
    expect(storageConversationMock.analyze.mock.calls[1][3]).toEqual([
      { role: "user", content: "C 盘空间都用在哪里？" },
      { role: "assistant", content: "占用主要来自用户目录。" },
    ]);
  });

  it("requires confirmation, shows hook cleaning state in the row, and excludes stale, unknown, and recycle-bin targets", async () => {
    storageConversationMock.analyze.mockResolvedValueOnce(assessment("scan-1", ["temp", "unknown-id", "trash"]));
    let finishClean!: (result: StorageCleanupResult) => void;
    const storage = makeStorage(makeResult(), new Set(), () => new Promise((resolve) => { finishClean = resolve; }));
    const { rerender } = renderConversation(storage);

    await ask("清理可以安全清理的临时文件");
    const cleanButton = await screen.findByRole("button", { name: "清理系统临时文件" });
    expect(screen.getByRole("button", { name: "查看回收站内容" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /清理回收站/ })).toBeNull();
    fireEvent.click(cleanButton);
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation).toHaveTextContent("系统临时文件");
    expect(confirmation).toHaveTextContent("预计释放 2.5 GB");
    expect(confirmation).not.toHaveTextContent("预计释放 3.2 GB");
    expect(storage.clean).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
    expect(storage.clean).not.toHaveBeenCalled();

    rerender(<StorageConversation storage={makeStorage(makeResult("scan-2"), new Set(), storage.clean)} selection={null} analysisRequest={null} />);
    expect(screen.getByRole("button", { name: "清理系统临时文件" })).toBeDisabled();
    rerender(<StorageConversation storage={storage} selection={null} analysisRequest={null} />);
    fireEvent.click(screen.getByRole("button", { name: "清理系统临时文件" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认清理" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(storage.clean).toHaveBeenCalledWith(["temp"]);
    expect(screen.getByLabelText("存储空间问题")).toBeEnabled();

    rerender(<StorageConversation storage={makeStorage(makeResult(), new Set(["temp"]), storage.clean)} selection={null} analysisRequest={null} />);
    const cleaningButton = screen.getByRole("button", { name: "清理中" });
    expect(cleaningButton).toHaveAttribute("aria-busy", "true");
    expect(cleaningButton).toBeDisabled();

    await act(async () => finishClean({ freedGb: 1.2, cleanedIds: ["temp"], failures: [] }));
    expect(await screen.findByText(/清理完成，实际释放 1.2 GB/)).toBeInTheDocument();
  });

  it("rejects cleanup confirmation if the scan changes while the dialog is open", async () => {
    storageConversationMock.analyze.mockResolvedValueOnce(assessment("scan-1", ["temp"]));
    const originalStorage = makeStorage(makeResult("scan-1"));
    const { rerender } = renderConversation(originalStorage);

    await ask("清理系统临时文件");
    fireEvent.click(await screen.findByRole("button", { name: "清理系统临时文件" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("确认清理");

    const refreshedStorage = makeStorage(makeResult("scan-2"));
    rerender(<StorageConversation storage={refreshedStorage} selection={null} analysisRequest={null} />);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认清理" }));

    expect(await screen.findByText("清理内容已变化")).toBeInTheDocument();
    expect(originalStorage.clean).not.toHaveBeenCalled();
    expect(refreshedStorage.clean).not.toHaveBeenCalled();
  });

  it("keeps a late C-drive answer as history and disables directory and file actions for a different context", async () => {
    let finishAnalysis!: (result: StorageAssessment) => void;
    storageConversationMock.analyze.mockReturnValueOnce(new Promise((resolve) => { finishAnalysis = resolve; }));
    const cResult = makeResult("scan-c", "C:");
    const { rerender } = renderConversation(makeStorage(cResult, new Set(), undefined, "C:"));

    await ask("C 盘这个目录占用如何？");
    await waitFor(() => expect(storageConversationMock.analyze).toHaveBeenCalledTimes(1));
    const dStorage = makeStorage(makeResult("scan-d", "D:"), new Set(), undefined, "D:");
    rerender(<StorageConversation storage={dStorage} selection={null} analysisRequest={null} />);

    await act(async () => finishAnalysis(directoryAndFileAssessment("scan-c", "dir-c", "file-c")));
    expect(await screen.findByText(/这是 C 盘旧扫描的分析结论/)).toBeInTheDocument();
    expect(screen.getByText("以下回答基于 C: 的先前扫描范围。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开Data" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看大文件" })).toBeDisabled();

    const otherScope = { id: "dir-other", path: "C:\\Other", sizeGb: 1, fileCount: 1, directSizeGb: 1 };
    rerender(<StorageConversation storage={makeStorage(cResult, new Set(), undefined, "C:")} selection={otherScope} analysisRequest={null} />);
    expect(screen.getByRole("button", { name: "打开Data" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看大文件" })).toBeDisabled();
  });

  it("cancels a component-started scan and ignores its late result after stop", async () => {
    let finishScan!: (result: StorageScanResult) => void;
    const storage = makeStorage(null);
    storage.start = vi.fn(() => new Promise((resolve) => { finishScan = resolve; }));
    renderConversation(storage);

    await ask("C 盘为什么这么满？");
    await waitFor(() => expect(storage.start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(storage.cancel).toHaveBeenCalledTimes(1);

    await act(async () => finishScan(makeResult()));
    expect(storageConversationMock.analyze).not.toHaveBeenCalled();
    expect(screen.queryByText("占用主要来自用户目录。")).toBeNull();
  });

  it("does not render an answer that arrives after stop", async () => {
    let finishAnalysis!: (result: StorageAssessment) => void;
    storageConversationMock.analyze.mockReturnValueOnce(new Promise((resolve) => { finishAnalysis = resolve; }));
    renderConversation();

    await ask("C 盘占用情况如何？");
    await waitFor(() => expect(storageConversationMock.analyze).toHaveBeenCalledTimes(1));
    const signal = storageConversationMock.analyze.mock.calls[0][2] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(signal.aborted).toBe(true);

    await act(async () => finishAnalysis({ ...assessment("scan-1"), summary: "停止后晚到的回答" }));
    expect(screen.queryByText("停止后晚到的回答")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
