import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { StockReportListItem } from "@/lib/stock-api";
import { cn } from "@/lib/utils";
import { stanceLabel } from "./labels";

/** 研究档案时间线（design §12 工作台第五区）：全部报告按时间倒序的
 *  横向卡片流，点击打开阅读覆盖层。区别于右列「本标的研究」——
 *  这里承载跨标的的全局历史（复盘简报 + 历次深度投研）。 */

interface ReportTimelineProps {
  reports: StockReportListItem[];
  onOpenReport: (reportId: string) => void;
}

export function ReportTimeline({ reports, onOpenReport }: ReportTimelineProps) {
  if (reports.length === 0) return null;
  return (
    <section className="px-4 pb-4 pt-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h2 className="text-ui">研究档案</h2>
        <span className="text-micro text-muted-foreground">
          {reports.length} 份
        </span>
      </div>
      <div className="scrollbar-thin flex gap-2.5 overflow-x-auto pb-1">
        {reports.map((r) => (
          <Button
            key={r.reportId}
            type="button"
            variant="ghost"
            onClick={() => onOpenReport(r.reportId)}
            className={cn(
              "h-auto w-44 shrink-0 flex-col items-start justify-start gap-1 rounded-lg border bg-card px-3 py-2.5",
              "whitespace-normal text-left font-normal hover:bg-accent/60",
            )}
          >
            <div className="flex items-center gap-1.5">
              <Badge
                variant={r.kind === "daily_review" ? "secondary" : "default"}
                className="px-1.5 py-0 text-micro"
              >
                {r.kind === "daily_review" ? "复盘" : "投研"}
              </Badge>
              {r.stance && (
                <span className="text-micro text-muted-foreground">
                  {stanceLabel(r.stance)}
                </span>
              )}
            </div>
            <span className="truncate text-caption">
              {r.instrument?.name ?? `${r.symbols.length} 只自选股`}
            </span>
            <span className="text-micro text-muted-foreground">
              {r.asOf ? r.asOf.slice(0, 10) : r.modifiedAt.slice(0, 10)}
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}
