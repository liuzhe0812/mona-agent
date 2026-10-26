import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import i18n from "../i18n";
import type { RunData } from "../lib/api";
import { runTrades } from "../lib/runReports";

const TRADES_PAGE_SIZE = 100;

function tradeTime(tr: Record<string, string>): string {
  return tr.time || tr.timestamp || "";
}

// The engine writes ISO-shaped times ("YYYY-MM-DD[ HH:MM:SS]"), which order
// correctly as strings; Date.parse would return NaN for the spaced form on Safari.
function compareTradeTime(a: Record<string, string>, b: Record<string, string>): number {
  return tradeTime(a).localeCompare(tradeTime(b));
}

function normalizeSide(value?: string): "BUY" | "SELL" | "" {
  const side = (value || "").trim().toUpperCase();
  if (side.startsWith("B")) return "BUY";
  if (side.startsWith("S")) return "SELL";
  return "";
}

function parseTradeNumber(value?: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function signedNumberClass(value: number | null): string {
  if (value == null || value === 0) return "text-muted-foreground";
  return value > 0 ? "text-[hsl(var(--stock-up))]" : "text-[hsl(var(--stock-down))]";
}

function formatSigned(value: number, suffix = ""): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

export function NativeTrades({ run }: { run: RunData }) {
  const [sideFilter, setSideFilter] = useState<"" | "BUY" | "SELL">("");
  const [symbolFilter, setSymbolFilter] = useState("");
  const [visibleCount, setVisibleCount] = useState(TRADES_PAGE_SIZE);
  const [sortDesc, setSortDesc] = useState(true);
  const source = runTrades(run);
  // Stable sorting preserves engine order for fills sharing a timestamp.
  const trades = useMemo(() => [...source].sort(
    (a, b) => sortDesc ? compareTradeTime(b, a) : compareTradeTime(a, b),
  ), [source, sortDesc]);
  if (trades.length === 0) return <div className="p-8 text-muted-foreground text-ui">{i18n.t("runDetail.noTrades")}</div>;

  const symbols = [...new Set(trades.map((tr) => tr.code).filter(Boolean))];
  const hasPnl = trades.some((tr) => parseTradeNumber(tr.pnl) != null);
  const hasReturnPct = trades.some((tr) => parseTradeNumber(tr.return_pct) != null);
  const hasHoldingDays = trades.some((tr) => (tr.holding_days ?? "") !== "");

  const filtered = trades.filter((tr) => (
    (!sideFilter || normalizeSide(tr.side) === sideFilter)
    && (!symbolFilter || tr.code === symbolFilter)
  ));
  const buys = filtered.filter((tr) => normalizeSide(tr.side) === "BUY").length;
  const sells = filtered.filter((tr) => normalizeSide(tr.side) === "SELL").length;
  const totalPnl = hasPnl
    ? filtered.reduce((sum, tr) => sum + (parseTradeNumber(tr.pnl) ?? 0), 0)
    : null;
  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  const sideChips: { id: "" | "BUY" | "SELL"; label: string }[] = [
    { id: "", label: i18n.t("runDetail.sideAll") },
    { id: "BUY", label: i18n.t("runDetail.sideBuy") },
    { id: "SELL", label: i18n.t("runDetail.sideSell") },
  ];

  return (
    <div className="p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-caption text-muted-foreground">
        <span className="font-medium text-foreground">{i18n.t("runDetail.tradesCount", { count: filtered.length })}</span>
        <span>{i18n.t("runDetail.sideSummary", { buy: buys, sell: sells })}</span>
        {totalPnl != null && (
          <span className="inline-flex items-center gap-1">
            {i18n.t("runDetail.totalPnl")}
            <span className={cn("font-mono font-medium tabular-nums", signedNumberClass(totalPnl))}>
              {formatSigned(totalPnl)}
            </span>
          </span>
        )}
        <div className="ms-auto flex flex-wrap items-center gap-1.5">
          <div className="flex gap-1" role="group">
            {sideChips.map((chip) => (
              <button
                key={chip.id || "all"}
                type="button"
                onClick={() => { setSideFilter(chip.id); setVisibleCount(TRADES_PAGE_SIZE); }}
                className={cn(
                  "rounded-full border px-2.5 py-1 transition-colors",
                  sideFilter === chip.id
                    ? "border-border bg-muted font-medium text-foreground"
                    : "border-border/60 hover:bg-muted/60",
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {symbols.length > 1 && (
            <select
              value={symbolFilter}
              onChange={(event) => { setSymbolFilter(event.target.value); setVisibleCount(TRADES_PAGE_SIZE); }}
              className="h-7 rounded-md border border-border/60 bg-background px-2 text-caption"
              aria-label={i18n.t("runDetail.symbol")}
            >
              <option value="">{i18n.t("runDetail.allSymbols")}</option>
              {symbols.map((symbol) => (
                <option key={symbol} value={symbol}>{symbol}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/60 bg-card shadow-none">
        <table className="w-full text-ui">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-micro uppercase tracking-wide text-muted-foreground [&_th]:font-medium">
              <th className="py-2 ps-4 pr-4" aria-sort={sortDesc ? "descending" : "ascending"}>
                <button
                  type="button"
                  onClick={() => { setSortDesc((desc) => !desc); setVisibleCount(TRADES_PAGE_SIZE); }}
                  className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                >
                  {i18n.t("runDetail.time")}
                  {sortDesc
                    ? <ArrowDown className="h-3 w-3" aria-hidden="true" />
                    : <ArrowUp className="h-3 w-3" aria-hidden="true" />}
                </button>
              </th>
              <th className="py-2 pr-4">{i18n.t("runDetail.code2")}</th>
              <th className="py-2 pr-4">{i18n.t("runDetail.side")}</th>
              <th className="py-2 pr-4 text-right">{i18n.t("runDetail.price")}</th>
              <th className="py-2 pr-4 text-right">{i18n.t("runDetail.qty")}</th>
              {hasPnl && <th className="py-2 pr-4 text-right">{i18n.t("runDetail.pnl")}</th>}
              {hasReturnPct && <th className="py-2 pr-4 text-right">{i18n.t("runDetail.returnPct")}</th>}
              {hasHoldingDays && <th className="py-2 pr-4 text-right">{i18n.t("runDetail.holdingDays")}</th>}
              <th className="py-2">{i18n.t("runDetail.reason")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((tr, i) => {
              const side = normalizeSide(tr.side);
              const pnl = parseTradeNumber(tr.pnl);
              const returnPct = parseTradeNumber(tr.return_pct);
              return (
                <tr key={i} className={cn("border-b last:border-0 hover:bg-muted/40", i % 2 === 1 && "bg-muted/10")}>
                  <td className="py-2 ps-4 pr-4 font-mono text-caption">{tradeTime(tr)}</td>
                  <td className="py-2 pr-4 font-mono text-caption">{tr.code}</td>
                  <td className="py-2 pr-4">
                    <span className={cn(
                      "inline-block rounded-full px-2 py-0.5 text-caption font-medium",
                      side === "BUY" && "bg-[hsl(var(--stock-up))]/10 text-[hsl(var(--stock-up))]",
                      side === "SELL" && "bg-[hsl(var(--stock-down))]/10 text-[hsl(var(--stock-down))]",
                      side === "" && "bg-muted text-muted-foreground",
                    )}>
                      {side === "BUY" ? i18n.t("runDetail.sideBuy") : side === "SELL" ? i18n.t("runDetail.sideSell") : tr.side}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{tr.price}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{tr.qty}</td>
                  {hasPnl && (
                    <td className={cn("py-2 pr-4 text-right font-mono tabular-nums", signedNumberClass(pnl))}>
                      {pnl != null ? formatSigned(pnl) : "—"}
                    </td>
                  )}
                  {hasReturnPct && (
                    <td className={cn("py-2 pr-4 text-right font-mono tabular-nums", signedNumberClass(returnPct))}>
                      {returnPct != null ? formatSigned(returnPct, "%") : "—"}
                    </td>
                  )}
                  {hasHoldingDays && (
                    <td className="py-2 pr-4 text-right font-mono tabular-nums text-muted-foreground">{tr.holding_days ?? "—"}</td>
                  )}
                  <td className="py-2 text-caption text-muted-foreground">{tr.reason ? i18n.t(`monaNative.tradeReason_${tr.reason}`, { defaultValue: tr.reason }) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {remaining > 0 && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setVisibleCount((count) => count + TRADES_PAGE_SIZE)}
            className="rounded-full border border-border/60 px-4 py-1.5 text-caption font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            {i18n.t("runDetail.showMore", { count: Math.min(remaining, TRADES_PAGE_SIZE) })}
          </button>
        </div>
      )}
    </div>
  );
}
