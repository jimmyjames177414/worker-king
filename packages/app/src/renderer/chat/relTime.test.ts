import { describe, it, expect } from 'vitest';
import { relTime, dayStamp, sameDay, daysApart } from './relTime.js';

/** Local noon on the day `offset` days before `base`'s day. */
function noonDaysAgo(base: number, offset: number): number {
  const d = new Date(base);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

// Fixed reference so the tests never straddle a real midnight: 2026-03-18, 15:00 local.
const NOW = new Date(2026, 2, 18, 15, 0, 0, 0).getTime();

describe('relTime', () => {
  it('collapses anything under 45s to "just now"', () => {
    expect(relTime(NOW, NOW)).toBe('just now');
    expect(relTime(NOW - 44_000, NOW)).toBe('just now');
  });

  it('counts minutes up to the hour', () => {
    expect(relTime(NOW - 2 * 60_000, NOW)).toBe('2m ago');
    expect(relTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('shows a clock time for earlier today', () => {
    const earlier = new Date(2026, 2, 18, 9, 41, 0, 0).getTime();
    expect(relTime(earlier, NOW)).toMatch(/\d/);
    expect(relTime(earlier, NOW)).not.toMatch(/ago/);
  });

  it('names yesterday and the rest of the week', () => {
    expect(relTime(noonDaysAgo(NOW, 1), NOW)).toBe('Yesterday');
    const threeDaysAgo = noonDaysAgo(NOW, 3);
    expect(relTime(threeDaysAgo, NOW)).toBe(
      new Date(threeDaysAgo).toLocaleDateString(undefined, { weekday: 'short' }),
    );
  });

  it('falls back to a short date beyond a week', () => {
    const old = noonDaysAgo(NOW, 30);
    expect(relTime(old, NOW)).toBe(
      new Date(old).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });

  it('returns empty for a missing timestamp', () => {
    expect(relTime(0, NOW)).toBe('');
    expect(relTime(Number.NaN, NOW)).toBe('');
  });
});

describe('dayStamp', () => {
  it('labels today and yesterday', () => {
    expect(dayStamp(noonDaysAgo(NOW, 0), NOW)).toMatch(/^Today · /);
    expect(dayStamp(noonDaysAgo(NOW, 1), NOW)).toMatch(/^Yesterday · /);
  });

  it('spells out older days', () => {
    const stamp = dayStamp(noonDaysAgo(NOW, 9), NOW);
    expect(stamp).not.toMatch(/^Today/);
    expect(stamp).toContain(' · ');
  });

  it('returns empty for a missing timestamp', () => {
    expect(dayStamp(0, NOW)).toBe('');
  });
});

describe('sameDay / daysApart', () => {
  it('groups by local calendar day, not by elapsed hours', () => {
    const morning = new Date(2026, 2, 18, 0, 30, 0, 0).getTime();
    const evening = new Date(2026, 2, 18, 23, 30, 0, 0).getTime();
    expect(sameDay(morning, evening)).toBe(true);
    expect(daysApart(morning, evening)).toBe(0);

    const lastNight = new Date(2026, 2, 17, 23, 30, 0, 0).getTime();
    expect(sameDay(lastNight, morning)).toBe(false);
    expect(daysApart(lastNight, morning)).toBe(1);
  });
});
