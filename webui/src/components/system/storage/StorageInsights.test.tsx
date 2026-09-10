import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StorageInsights, buildStorageQuickInsights } from "./StorageInsights";
import type { DirectorySize, StorageScanResult } from "../useSystemData";

function result(overrides: Partial<StorageScanResult> = {}): StorageScanResult {
  return {
    scanId: "scan-test",
    disks: [],
    directories: [],
    cleanupItems: [],
    fileTypes: [],
    totalScannedGb: 0,
    ...overrides,
  };
}

function directory(path: string, sizeGb: number, fileCount = 10): DirectorySize {
  return { id: path, path, sizeGb, fileCount, directSizeGb: sizeGb };
}

describe("StorageInsights", () => {
  it("summarizes only positive cleanable items and exposes the cleanup action", () => {
    const insights = buildStorageQuickInsights(result({
      cleanupItems: [
        { id: "cache", name: "缓存", sizeGb: 2.5, path: "C:\\cache", cleanable: true, recommended: true, reason: "缓存" },
        { id: "notice", name: "旧系统", sizeGb: 8, path: "C:\\Windows.old", cleanable: false, recommended: false, reason: "需系统设置处理" },
      ],
    }), null);

    expect(insights[0]).toMatchObject({
      id: "cleanable",
      metric: "2.5 GB",
      detail: "1 项，仅包含扫描标记为可清理的系统项",
    });

    const onPlanCleanup = vi.fn();
    render(
      <StorageInsights
        result={result({
          cleanupItems: [
            { id: "cache", name: "缓存", sizeGb: 2.5, path: "C:\\cache", cleanable: true, recommended: true, reason: "缓存" },
          ],
        })}
        selectedDirectory={null}
        onAnalyzeScope={vi.fn()}
        onPlanCleanup={onPlanCleanup}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成清理方案" }));
    expect(onPlanCleanup).toHaveBeenCalledTimes(1);
  });

  it("describes old large files without calling them safe to delete", () => {
    const insights = buildStorageQuickInsights(result({
      topFiles: [
        { id: "archive", extension: ".zip", parentDirName: "Downloads", sizeGb: 3, modifiedBucket: "old", path: "C:\\Downloads\\archive.zip" },
        { id: "clip", extension: ".mp4", parentDirName: "Videos", sizeGb: 1.5, modifiedBucket: "old", path: "C:\\Videos\\clip.mp4" },
      ],
    }), null);
    const oldFilesInsight = insights.find((insight) => insight.id === "oldFiles");

    expect(oldFilesInsight).toMatchObject({
      metric: "2 个 · 4.5 GB",
      detail: "按修改时间桶统计，建议先审查后决定处理方式",
    });
    expect(`${oldFilesInsight?.title} ${oldFilesInsight?.detail}`).not.toContain("安全");
  });

  it("prefers the selected directory over the largest root directory", () => {
    const insights = buildStorageQuickInsights(
      result({ directories: [directory("C:\\Projects", 80), directory("C:\\Downloads", 40)] }),
      directory("C:\\Downloads", 40, 24),
    );

    expect(insights.find((insight) => insight.id === "directory")).toMatchObject({
      title: "当前范围占用",
      metric: "40.0 GB",
      detail: "C:\\Downloads · 24 个文件",
    });
  });

  it("always offers scope analysis and hides cleanup planning without cleanable space", () => {
    const onAnalyzeScope = vi.fn();
    render(
      <StorageInsights
        result={result()}
        selectedDirectory={null}
        onAnalyzeScope={onAnalyzeScope}
        onPlanCleanup={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "分析当前范围" }));
    expect(onAnalyzeScope).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "生成清理方案" })).toBeNull();
  });
});
