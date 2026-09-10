export function formatMoneyAmount(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return value;
  const integer = BigInt(match[2]).toLocaleString("zh-CN");
  const significant = (match[3] ?? "").replace(/0+$/, "");
  const fraction = significant.padEnd(2, "0");
  return `${match[1]}${integer}.${fraction}`;
}

/** Format a stored balance for compact UI display, rounded to cents. */
export function formatBalanceAmount(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const fraction = match[3] ?? "";
  let minorUnits = BigInt(match[2]) * 100n;
  minorUnits += BigInt(fraction.slice(0, 2).padEnd(2, "0") || "0");
  if ((fraction[2] ?? "0") >= "5") minorUnits += 1n;
  const integer = (minorUnits / 100n).toLocaleString("zh-CN");
  const cents = (minorUnits % 100n).toString().padStart(2, "0");
  return `${match[1]}${integer}.${cents}`;
}
