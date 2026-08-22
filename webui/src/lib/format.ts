import i18n, { currentLocale } from "@/i18n";

const LOW_INFORMATION_TITLE_PREVIEWS = new Set([
  "hi",
  "hello",
  "hey",
  "hello nano",
  "hello mona",
  "hi nano",
  "hi mona",
  "你好",
  "您好",
  "嗨",
  "哈喽",
  "哈啰",
  "在吗",
]);

function isLowInformationTitlePreview(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[.!?。！？~～\s]+$/g, "").trim();
  return (
    normalized.startsWith("/") ||
    LOW_INFORMATION_TITLE_PREVIEWS.has(normalized)
  );
}

/** Truncate the first user message into a chat title. */
export function deriveTitle(preview: string | undefined, fallback: string): string {
  if (!preview) return fallback;
  const oneLine = preview.replace(/\s+/g, " ").trim();
  if (!oneLine) return fallback;
  if (isLowInformationTitlePreview(oneLine)) return fallback;
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** Loose ISO-or-epoch parser; returns ``null`` for missing/invalid input. */
function parseDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const RELATIVE_THRESHOLDS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, "second"],
  [60, "minute"],
  [24, "hour"],
  [7, "day"],
  [4.345, "week"],
  [12, "month"],
  [Number.POSITIVE_INFINITY, "year"],
];

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function activeLocale(locale?: string): string {
  return locale || i18n.resolvedLanguage || i18n.language || currentLocale();
}

function relativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  const existing = relativeTimeFormatters.get(locale);
  if (existing) return existing;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  relativeTimeFormatters.set(locale, formatter);
  return formatter;
}

function dateTimeFormatter(locale: string): Intl.DateTimeFormat {
  const existing = dateTimeFormatters.get(locale);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  dateTimeFormatters.set(locale, formatter);
  return formatter;
}

export function relativeTime(
  value: string | number | null | undefined,
  locale?: string,
): string {
  const date = parseDate(value);
  if (!date) return "";
  let delta = (date.getTime() - Date.now()) / 1000;
  const formatter = relativeTimeFormatter(activeLocale(locale));
  for (const [step, unit] of RELATIVE_THRESHOLDS) {
    if (Math.abs(delta) < step) {
      return formatter.format(Math.round(delta), unit);
    }
    delta /= step;
  }
  return formatter.format(Math.round(delta), "year");
}

export function fmtDateTime(
  value: string | number | null | undefined,
  locale?: string,
): string {
  const date = parseDate(value);
  return date ? dateTimeFormatter(activeLocale(locale)).format(date) : "";
}

const SESSION_LIST_MINUTE_MS = 60_000;
const SESSION_LIST_HOUR_MS = 60 * SESSION_LIST_MINUTE_MS;
const SESSION_LIST_DAY_MS = 24 * SESSION_LIST_HOUR_MS;

/** Session-list timestamp (session-list redesign §11): exactly one rule
 *  matches at a time — under 1h "12分钟前", today "14:30", yesterday "昨天",
 *  within 7 days "星期三", earlier this year "7/30", older "2025/12/31".
 *  Never mixes granularities like "5天前"/"2周前". */
export function sessionListTime(
  value: string | number | null | undefined,
  locale?: string,
): string {
  const date = parseDate(value);
  if (!date) return "";
  const ts = date.getTime();
  const loc = activeLocale(locale);
  const now = new Date();
  const diff = now.getTime() - ts;
  if (diff >= 0 && diff < SESSION_LIST_HOUR_MS) {
    const minutes = Math.max(1, Math.floor(diff / SESSION_LIST_MINUTE_MS));
    return new Intl.RelativeTimeFormat(loc, { numeric: "always" }).format(-minutes, "minute");
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) {
    return new Intl.DateTimeFormat(loc, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }
  if (ts >= startOfToday - SESSION_LIST_DAY_MS) {
    return relativeTimeFormatter(loc).format(-1, "day");
  }
  if (diff < 7 * SESSION_LIST_DAY_MS) {
    return new Intl.DateTimeFormat(loc, { weekday: "long" }).format(date);
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) return `${month}/${day}`;
  return `${date.getFullYear()}/${month}/${day}`;
}

/** Human-readable turn duration (wall-clock), locale-aware via ``Intl`` (seconds/minutes). */
export function formatTurnLatency(ms: number, locale?: string): string {
  const loc = activeLocale(locale);
  const msClamped = Math.max(0, ms);
  const secTotal = msClamped / 1000;
  if (secTotal < 60) {
    return new Intl.NumberFormat(loc, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
      maximumFractionDigits: secTotal < 10 ? 1 : 0,
      minimumFractionDigits: 0,
    }).format(secTotal);
  }
  const wholeMin = Math.floor(secTotal / 60);
  const remSec = Math.max(0, Math.round(secTotal - wholeMin * 60));
  const minStr = new Intl.NumberFormat(loc, {
    style: "unit",
    unit: "minute",
    unitDisplay: "narrow",
  }).format(wholeMin);
  const secStr = new Intl.NumberFormat(loc, {
    style: "unit",
    unit: "second",
    unitDisplay: "narrow",
    maximumFractionDigits: 0,
  }).format(remSec);
  return `${minStr}\u00a0${secStr}`;
}
