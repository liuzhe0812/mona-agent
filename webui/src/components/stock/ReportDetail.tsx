import { useState } from "react";
import { ArrowLeft, Download, Trash2 } from "lucide-react";

import { MarkdownText } from "@/components/MarkdownText";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTauri } from "@/lib/tauri";
import type {
  StockDigestItem,
  StockReportDetail,
  StockReportKind,
  StockReportV6Document,
} from "@/lib/stock-api";
import { isStockReportV6Document } from "@/lib/stock-api";
import { dataQualityLabel, evidenceTextLabel, stanceLabel } from "./labels";
import { ResearchEvidenceDetail } from "./ResearchEvidenceDetail";
import { ResearchDecisionView } from "./ResearchDecisionView";

/** 报告阅读覆盖层（design §12 阅读态）：覆盖整个工作台，返回键退出。
 *  从 StockView 渲染，供 Hero 简报、投研卡、报告时间线共用。 */

const KIND_LABELS: Record<StockReportKind, string> = {
  deep_research: "深度投研",
  daily_review: "每日复盘",
};

/** 导出报告 Markdown：Tauri 保存对话框，浏览器环境退化为 <a download>。 */
async function exportReportMarkdown(
  reportId: string,
  markdown: string,
): Promise<void> {
  const safeName =
    reportId.trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 64) ||
    "stock-report";
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const filePath = await save({
      defaultPath: `${safeName}.md`,
      filters: [{ name: "Markdown 文档", extensions: ["md"] }],
    });
    if (!filePath) return;
    await writeFile(filePath, new TextEncoder().encode(markdown));
    return;
  }
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeName}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 每日复盘的结构化标的列表（T22c）：每项可一键发起深度投研。 */
function DigestItems({
  items,
  onDeepResearch,
}: {
  items: StockDigestItem[];
  onDeepResearch: (instrumentId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {items.map((item) => {
        const instId = `${item.instrument.exchange}:${item.instrument.symbol}`;
        const label = item.instrument.name || item.instrument.symbol;
        return (
          <div
            key={instId}
            className="flex items-center gap-2 rounded-lg border px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-ui">{label}</span>
                <span className="text-micro text-muted-foreground">
                  {item.instrument.symbol}
                </span>
                <Badge variant="secondary" className="px-1.5 py-0 text-micro">
                  {stanceLabel(item.stance)}
                </Badge>
                <Badge variant="outline" className="px-1.5 py-0 text-micro">
                  {dataQualityLabel(item.data_quality)}
                </Badge>
              </div>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {item.one_liner}
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() => onDeepResearch(instId)}
            >
              深度投研
            </Button>
          </div>
        );
      })}
    </div>
  );
}

interface ReportDetailProps {
  activeReport: StockReportDetail;
  onClose: () => void;
  /** 手动清理（design §9）：删除报告所属运行的整个产物目录。 */
  onDeleteReport: (reportId: string) => void;
  /** 简报单股入口（T22c）：对某只标的直接发起深度投研。 */
  onDeepResearch: (instrumentId: string) => void;
}

function V6ReportSummary({ report }: { report: StockReportV6Document }) {
  return (
    <section className="space-y-4" data-testid="v6-report-summary">
      <div className="border-b pb-3">
        <h1 className="text-title font-semibold">{report.instrument.name}（{report.instrument.symbol}）投研结论</h1>
        <p className="mt-2 text-body text-muted-foreground">{evidenceTextLabel(report.summary)}</p>
        <p className="mt-2 text-micro text-muted-foreground">
          依据来源：{typeof report.sourceCount === "number" ? `${report.sourceCount} 条` : "待确认"}
        </p>
      </div>
      <ResearchDecisionView report={report} />
    </section>
  );
}

export function ReportDetail({
  activeReport,
  onClose,
  onDeleteReport,
  onDeepResearch,
}: ReportDetailProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const v6Report = isStockReportV6Document(activeReport.report)
    ? activeReport.report
    : null;
  const isV6 = v6Report !== null;
  const reportId = v6Report
    ? v6Report.reportId
    : String(activeReport.report.report_id ?? "");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="xs" onClick={onClose} className="gap-1">
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </Button>
        <span className="text-caption text-muted-foreground">
          {activeReport.report.kind ? KIND_LABELS[activeReport.report.kind] : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {!isV6 && (
            <Button
              variant="ghost"
              size="xs"
              className="gap-1"
              onClick={() => void exportReportMarkdown(reportId, activeReport.markdown)}
            >
              <Download className="h-3.5 w-3.5" />
              导出
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      </div>
      <div className="scrollbar-hover flex-1 overflow-y-auto px-4 py-3">
        {activeReport.report.kind === "daily_review" &&
          Array.isArray(activeReport.report.items) && (
            <DigestItems
              items={activeReport.report.items}
              onDeepResearch={onDeepResearch}
            />
          )}
        {v6Report ? (
          <V6ReportSummary report={v6Report} />
        ) : activeReport.report.schema_version === 4 ? (
          <>
            <ResearchEvidenceDetail report={activeReport.report} />
            <details className="mt-3 rounded-lg border bg-card px-3 py-2">
              <summary className="cursor-pointer text-caption font-medium">
                查看原始格式报告
              </summary>
              <div className="mt-3">
                <MarkdownText>{activeReport.markdown}</MarkdownText>
              </div>
            </details>
          </>
        ) : (
          <MarkdownText>{activeReport.markdown}</MarkdownText>
        )}
      </div>
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除研究报告</DialogTitle>
            <DialogDescription>
              将删除该报告所属运行的全部产物（报告及相关研究记录），此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirmDelete(false);
                onDeleteReport(reportId);
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
