import { CheckCircle2, Clock3, FolderSearch } from "lucide-react";

import { Button } from "@/components/ui/button";

import { PanelCard } from "../SystemUi";
import {
  formatStorage,
  type DirectorySize,
  type StorageScanResult,
} from "../useSystemData";

export type StorageQuickInsightKind = "cleanable" | "directory" | "oldFiles";

export interface StorageQuickInsight {
  id: StorageQuickInsightKind;
  title: string;
  metric: string;
  detail: string;
  tone: "green" | "blue" | "orange";
}

export function buildStorageQuickInsights(
  result: StorageScanResult,
  selectedDirectory: DirectorySize | null,
): StorageQuickInsight[] {
  const insights: StorageQuickInsight[] = [];
  const cleanableItems = result.cleanupItems.filter((item) => item.cleanable && item.sizeGb > 0);
  const cleanableTotal = cleanableItems.reduce((sum, item) => sum + item.sizeGb, 0);

  if (cleanableTotal > 0) {
    insights.push({
      id: "cleanable",
      title: "可释放的系统清理项",
      metric: formatStorage(cleanableTotal),
      detail: `${cleanableItems.length} 项，仅包含扫描标记为可清理的系统项`,
      tone: "green",
    });
  }

  const largestDirectory = selectedDirectory
    ?? result.directories.reduce<DirectorySize | null>(
      (largest, directory) => (!largest || directory.sizeGb > largest.sizeGb ? directory : largest),
      null,
    );

  if (largestDirectory) {
    insights.push({
      id: "directory",
      title: selectedDirectory ? "当前范围占用" : "最大占用目录",
      metric: formatStorage(largestDirectory.sizeGb),
      detail: `${largestDirectory.path} · ${largestDirectory.fileCount.toLocaleString()} 个文件`,
      tone: "blue",
    });
  }

  const oldFiles = (result.topFiles ?? []).filter((file) => file.modifiedBucket === "old");
  const oldFilesTotal = oldFiles.reduce((sum, file) => sum + file.sizeGb, 0);
  if (oldFiles.length > 0 && oldFilesTotal > 0) {
    insights.push({
      id: "oldFiles",
      title: "长期未修改的大文件",
      metric: `${oldFiles.length} 个 · ${formatStorage(oldFilesTotal)}`,
      detail: "按修改时间桶统计，建议先审查后决定处理方式",
      tone: "orange",
    });
  }

  return insights.slice(0, 3);
}

const INSIGHT_ICONS = {
  cleanable: CheckCircle2,
  directory: FolderSearch,
  oldFiles: Clock3,
} satisfies Record<StorageQuickInsightKind, typeof CheckCircle2>;

const INSIGHT_TONES: Record<StorageQuickInsight["tone"], string> = {
  green: "bg-success/10 text-success",
  blue: "bg-info/10 text-info",
  orange: "bg-warning/10 text-warning",
};

export function StorageInsights({
  result,
  selectedDirectory,
  onAnalyzeScope,
  onPlanCleanup,
}: {
  result: StorageScanResult;
  selectedDirectory: DirectorySize | null;
  onAnalyzeScope: () => void;
  onPlanCleanup: () => void;
}) {
  const insights = buildStorageQuickInsights(result, selectedDirectory);
  const hasCleanable = insights.some((insight) => insight.id === "cleanable");

  return (
    <PanelCard title="Mona 发现">
      {insights.length > 0 ? (
        <ul className="space-y-3">
          {insights.map((insight) => {
            const Icon = INSIGHT_ICONS[insight.id];
            return (
              <li key={insight.id} className="flex items-start gap-2.5">
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${INSIGHT_TONES[insight.tone]}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <p className="text-caption font-medium">{insight.title}</p>
                    <span className="text-body font-semibold">{insight.metric}</span>
                  </div>
                  <p className="mt-0.5 break-words text-micro text-muted-foreground">{insight.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-caption text-muted-foreground">扫描结果中暂时没有可归纳的重点。</p>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="interaction" size="sm" onClick={onAnalyzeScope}>
          分析当前范围
        </Button>
        {hasCleanable ? (
          <Button type="button" variant="default" size="sm" onClick={onPlanCleanup}>
            生成清理方案
          </Button>
        ) : null}
      </div>
    </PanelCard>
  );
}
