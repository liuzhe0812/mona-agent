import { useEffect, useState } from "react";
import { getStockVibeMessages } from "@/lib/stock-vibe-api";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const LABELS: Record<string, string> = {
  get_market_data: "行情资料", get_stock_profile: "公司资料", get_financial_statements: "财报资料",
  get_cn_announcements: "公告", get_stock_news: "新闻", web_search: "资料搜索", web_fetch: "网页资料",
  read_file: "附件资料", read_document: "文档分析", write_file: "研究文件", load_skill: "分析方法",
  run_swarm: "协作研究", backtest: "历史回测", quantlib_call: "指标计算",
};
export function StockVibeResearchEvidence({ sessionId, attemptId }: { sessionId: string; attemptId: string }) {
  const [trail, setTrail] = useState<Record<string, unknown>[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setTrail(null); setFailed(false);
    void getStockVibeMessages(sessionId).then(({ native }) => {
      if (!Array.isArray(native)) throw new Error("invalid research evidence");
      const entries = native.flatMap((value) => {
        const message = record(value);
        return message?.linked_attempt_id === attemptId && Array.isArray(message.tool_trail) ? message.tool_trail.flatMap((entry) => record(entry) ? [record(entry)!] : []) : [];
      });
      if (active) setTrail(entries);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [sessionId, attemptId]);
  return failed ? <p>暂时无法读取依据，请稍后重新打开。</p> : trail === null ? <p role="status">正在读取已有依据…</p>
    : !trail.length ? <p>原记录没有可读取的工具依据，请核查报告中的引用和资料时点。</p>
      : <ul className="space-y-3">{trail.map((entry, index) => {
        const args = record(entry.arguments);
        return <li key={index}><p className="font-medium">{LABELS[String(entry.tool)] ?? "研究分析"} · {entry.status === "ok" ? "已完成" : entry.status === "error" ? "未完成" : "结果待核对"}</p>
          {Object.entries({ symbol: "标的", code: "标的", source: "请求数据源", start_date: "开始日期", end_date: "结束日期" }).map(([field, label]) =>
            typeof args?.[field] === "string" ? <p key={field} className="text-muted-foreground">{label}：{String(args[field])}</p> : null)}</li>;
      })}</ul>;
}
