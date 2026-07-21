/**
 * Relative-time formatting for history rows, the activity timeline, and the
 * chat day separators. Pure functions on (timestamp, now) so they unit-test
 * without a clock or a DOM.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Local midnight preceding `t`, as an epoch ms value. */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole local days between two timestamps (0 = same calendar day). */
export function daysApart(ts: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
}

/** True when both timestamps fall on the same local calendar day. */
export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * "just now" / "4m ago" / "9:41 AM" / "Yesterday" / "Mon" / "12 Jun", picking
 * the coarsest form that still says something useful.
 */
export function relTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = now - ts;
  if (diff < 45_000) return 'just now';
  if (diff < HOUR) return `${Math.round(diff / MINUTE)}m ago`;

  const days = daysApart(ts, now);
  if (days <= 0) return clockTime(ts);
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Chat day separator: "Today · 9:41 AM". */
export function dayStamp(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const days = daysApart(ts, now);
  const label =
    days <= 0
      ? 'Today'
      : days === 1
        ? 'Yesterday'
        : new Date(ts).toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
  return `${label} · ${clockTime(ts)}`;
}
