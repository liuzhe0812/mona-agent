/** Date/time helpers for the schedule module. */

/** Return a Date at the start of the given date's day (00:00:00). */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return a Date at the end of the given date's day (23:59:59.999). */
export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Return a Date at the start of the month containing the given date. */
export function startOfMonth(date: Date): Date {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Return a Date at the end of the month containing the given date. */
export function endOfMonth(date: Date): Date {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Return the Monday of the week containing the given date. */
export function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const day = d.getDay(); // 0=Sun .. 6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

/** Build a 6x7 grid of dates covering the month containing `monthDate`. */
export function monthGridDates(monthDate: Date): Date[] {
  const first = startOfMonth(monthDate);
  const gridStart = startOfWeek(first);
  const dates: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    dates.push(d);
  }
  return dates;
}

/** Check if two dates are the same calendar day. */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Check if a date is in the same month as monthDate. */
export function isSameMonth(date: Date, monthDate: Date): boolean {
  return (
    date.getFullYear() === monthDate.getFullYear() &&
    date.getMonth() === monthDate.getMonth()
  );
}

/** Format a Date as YYYY-MM-DDTHH:MM (local time, for datetime-local input value). */
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Parse a datetime-local string (YYYY-MM-DDTHH:MM) to epoch ms. */
export function fromDatetimeLocalValue(value: string): number {
  return new Date(value).getTime();
}

/** Format ms as a short time string (e.g. "14:30"). */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Format ms as a short date string (e.g. "6月22日"). */
export function formatShortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Format ms as a full datetime string (e.g. "2026-06-22 14:30"). */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Get the weekday name in Chinese. */
export function weekdayName(date: Date): string {
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return names[date.getDay()];
}
