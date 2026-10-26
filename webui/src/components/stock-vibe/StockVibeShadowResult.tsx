function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metric(value: unknown, percent = false): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(percent ? value * 100 : value).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${percent ? "%" : ""}`
    : "不可用";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function StockVibeShadowResult({ operation, result }: { operation: string; result: unknown }) {
  const data = record(result);
  if (operation === "run_shadow_backtest") {
    const combined = record(data.combined);
    const window = strings(data.window);
    if (typeof combined.total_return !== "number" || !Number.isFinite(combined.total_return) || combined.error) {
      return <p role="status" className="text-caption text-muted-foreground">这份回测记录没有可用指标，请核对数据范围后重新发起验证。</p>;
    }
    return <section aria-label="影子回测结果" className="space-y-3 rounded-md bg-muted/30 p-3">
      <h3 className="text-body font-medium">本次历史模拟</h3>
      <p className="text-caption text-muted-foreground">{window.length === 2 ? `${window[0]} 至 ${window[1]}` : "区间未报告"} · 行情来源：{typeof data.source === "string" ? data.source : "未报告"}</p>
      <dl className="grid grid-cols-2 gap-3 text-caption md:grid-cols-4">
        <div><dt className="text-muted-foreground">影子收益率</dt><dd>{metric(combined.total_return, true)}</dd></div>
        <div><dt className="text-muted-foreground">最大回撤</dt><dd>{metric(combined.max_drawdown, true)}</dd></div>
        <div><dt className="text-muted-foreground">净值观测点</dt><dd>{metric(data.equity_points)}</dd></div>
        <div><dt className="text-muted-foreground">影子期末值</dt><dd>{metric(combined.final_value)}</dd></div>
      </dl>
      {combined.trade_count === 0 && <p className="text-caption text-muted-foreground">本窗口未记录已完成交易，请核对信号与指标所需的历史数据；此结果不代表策略有效性已验证。</p>}
      <p className="text-caption text-muted-foreground">影子结果与成交文件的区间、本金和资金流不保证可比，未计算真实账户同期收益或经济归因。成交文件复盘需单独查看。</p>
    </section>;
  }
  if (operation === "scan_shadow_signals") {
    const scanned = strings(data.scanned_symbols);
    const available = strings(data.available_symbols);
    const missing = [...new Set([...strings(data.missing_symbols), ...strings(data.unscanned_symbols)])];
    const matches = Array.isArray(data.matches) ? data.matches.map(record) : [];
    return <section aria-label="条件扫描结果" className="space-y-3 rounded-md bg-muted/30 p-3">
      <h3 className="text-body font-medium">本次条件扫描</h3>
      <p className="text-caption">截至 {typeof data.target_date === "string" ? data.target_date : "原生未报告日期"} · 已扫描 {scanned.length} 个 · 有数据 {available.length} 个 · 未覆盖 {missing.length} 个</p>
      {data.status === "partial" && <p className="text-caption text-muted-foreground">本次覆盖不完整，结果仅适用于已取得数据的固定篮子样本。</p>}
      {matches.length ? <ul className="space-y-1 text-caption">{matches.map((match, index) => <li key={index}>
        {String(match.symbol ?? "未报告标的")} · {String(match.rule_id ?? "未报告规则")} · {String(match.reason ?? "未报告原因")}
      </li>)}</ul> : <p className="text-caption">已覆盖样本中没有原生匹配信号。</p>}
      {missing.length > 0 && <p className="break-words text-caption text-muted-foreground">未覆盖：{missing.join("、")}</p>}
    </section>;
  }
  return null;
}
