// Theme-only adaptation of the original Vibe chart theme to Mona's tokens.
function hex(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const [h, s, l] = value.split(/\s+/).map(parseFloat);
  if (![h, s, l].every(Number.isFinite)) return "";
  const a = s / 100 * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l / 100 - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, "0"); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
export function getChartTheme() {
  const info = hex("--info"), warning = hex("--warning"), up = hex("--stock-up"), down = hex("--stock-down");
  return { gridColor: hex("--border"), textColor: hex("--muted-foreground"), axisColor: hex("--foreground"), upColor: up, downColor: down,
    maColors: [warning, info, up], bollColor: info + "80", volumeUp: up + "66", volumeDown: down + "66", infoColor: info, warningColor: warning,
    contrastDark: hex("--brand-ink"), contrastLight: hex("--brand-paper"), tooltipBg: hex("--background"), tooltipBorder: hex("--border"), tooltipText: hex("--foreground") };
}
