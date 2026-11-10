const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "2026-11-10" -> "Nov 10, 2026". Works on the calendar date only, so no timezone shift. */
export function formatEditionDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return date;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/** RFC 822 date as RSS expects, e.g. "Tue, 10 Nov 2026 12:15:00 GMT". */
export function rfc822(iso: string): string | undefined {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : new Date(time).toUTCString();
}

/** Seconds -> "HH:MM:SS". */
export function hhmmss(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
