import type { ReactNode } from "react";
import type { StockVibeWorkbenchMarketData } from "@/lib/stock-vibe-api";
import { stockDirection, stockNumber, stockPrice } from "@/lib/stock-vibe-market";

const PRICE_STATES = { open: "盘中", recess: "午间休市", closed: "已收盘", stale: "历史行情" };

function numberText(value: unknown, digits = 2) {
  return stockNumber(value) ? value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
}

function compactAmount(value: unknown) {
  if (!stockNumber(value)) return "—";
  const absolute = Math.abs(value);
  const [unit, divisor] = absolute >= 1e12 ? ["万亿", 1e12] : absolute >= 1e8 ? ["亿", 1e8] : absolute >= 1e4 ? ["万", 1e4] : ["元", 1];
  return `${numberText(value / divisor)}${unit}`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(timestamp)).replaceAll("/", "-");
}

function SignedValue({ value, suffix = "" }: { value: unknown; suffix?: string }) {
  if (!stockNumber(value)) return <>—</>;
  return <>{value > 0 ? "+" : ""}{numberText(value)}{suffix}</>;
}

export function StockVibeQuoteSummary({ symbol, market, stale = false, loading = false, intervalControl, tradeActions }: {
  symbol: string | null;
  market: StockVibeWorkbenchMarketData | null;
  stale?: boolean;
  loading?: boolean;
  /** 周期切换落在标的行右侧，与行情标题同排。 */
  intervalControl?: ReactNode;
  /** 模拟买卖贴着价格出现，不另起一行。 */
  tradeActions?: ReactNode;
}) {
  if (!symbol) return <section className="stock-vibe-quote-summary" aria-label="A股行情">
    <div className="stock-vibe-quote-identity">
      <h2 className="text-title-sm">A 股行情</h2>
      {intervalControl}
    </div>
    {tradeActions ? <div className="stock-vibe-quote-side">{tradeActions}</div> : null}
  </section>;

  const current = market?.symbol === symbol ? market : null;
  const quote = current?.quote;
  const previousClose = quote?.previous_close;
  const direction = stockDirection(quote?.price, previousClose);
  const asOf = formatTimestamp(quote?.as_of ?? current?.trading_date);
  const fetchedAt = !asOf ? formatTimestamp(current?.observed_at) : null;
  const dataIsStale = Boolean(current && (stale || current.market_state === "stale"));
  const code = symbol.split(".")[0];
  const name = quote?.name?.trim();
  type QuoteStat = { label: string; value: string; directionValue?: number | null };
  // 指标带只放原型里的七项，不另起第二排。
  const stats: QuoteStat[] = [
    { label: "今开", value: stockPrice(quote?.open), directionValue: quote?.open },
    { label: "最高", value: stockPrice(quote?.high), directionValue: quote?.high },
    { label: "最低", value: stockPrice(quote?.low), directionValue: quote?.low },
    { label: "成交额", value: compactAmount(quote?.amount) },
    { label: "换手率", value: stockNumber(quote?.turnover_rate) ? `${numberText(quote.turnover_rate)}%` : "—" },
    { label: "总市值", value: compactAmount(quote?.market_cap) },
    { label: quote?.pe_label || "市盈率", value: stockNumber(quote?.pe_ratio) ? numberText(quote.pe_ratio) : "—" },
  ];
  const renderStat = ({ label, value, directionValue }: QuoteStat) => {
    const metric = stockNumber(directionValue) ? stockDirection(directionValue, previousClose) : "";
    return <div className="stock-vibe-quote-stat" key={label}>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className={`text-body font-medium tabular-nums ${metric}`}>{value}</dd>
    </div>;
  };

  return <section className="stock-vibe-quote-summary" aria-label={`${name ? `${name} ` : ""}${code}行情`}>
    <div className="stock-vibe-quote-body">
      <div className="stock-vibe-quote-identity">
        <div className="stock-vibe-quote-title">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-title-sm">{name || code}</h2>
            {name && <span className="text-caption text-muted-foreground">{code}</span>}
          </div>
          {tradeActions}
        </div>
        {intervalControl}
      </div>
      <div className="stock-vibe-quote-price-row">
        <div className={`stock-vibe-quote-price ${direction}`}>
          <strong className="text-display-sm tabular-nums">{stockPrice(quote?.price)}</strong>
          <div className="flex flex-wrap gap-x-3 text-body tabular-nums">
            <span><SignedValue value={quote?.change} /></span>
            <span><SignedValue value={quote?.change_pct} suffix="%" /></span>
          </div>
        </div>
        <div className="stock-vibe-quote-side">
          <div className="flex flex-wrap items-center justify-end gap-x-2 text-caption text-muted-foreground">
            {asOf && <span>行情时点 {asOf}</span>}
            {!asOf && fetchedAt && <span>获取于 {fetchedAt}</span>}
            {dataIsStale && <span role="status">显示上次行情</span>}
            {!dataIsStale && current?.status === "ok" && <span>{PRICE_STATES[current.market_state]}</span>}
            {!current && <span role="status">{loading ? "正在获取行情…" : "尚未取得报价"}</span>}
            {current?.status === "unavailable" && <span role="status">行情暂不可用</span>}
          </div>
        </div>
      </div>
      <dl className="stock-vibe-quote-stats">{stats.map(renderStat)}</dl>
    </div>
  </section>;
}
