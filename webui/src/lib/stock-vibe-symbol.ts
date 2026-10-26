export type StockVibeExchange = "SH" | "SZ" | "BJ";

const EXCHANGES: readonly [StockVibeExchange, RegExp][] = [
  ["SH", /^(?:600|601|603|605|688)\d{3}$/],
  ["SZ", /^(?:000|001|002|003|300|301)\d{3}$/],
  ["BJ", /^(?:43|83|87|92)\d{4}$/],
];

export function inferStockVibeExchange(code: string): StockVibeExchange | null {
  if (!/^\d{6}$/.test(code)) return null;
  return EXCHANGES.find(([, pattern]) => pattern.test(code))?.[0] ?? null;
}
