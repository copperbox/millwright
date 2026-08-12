import { describe, expect, it } from 'vitest';
import {
  CronParseError,
  cronMatchesMinute,
  formatMinute,
  latestMatchingMinute,
  minuteFloor,
  parseCronExpression,
  parseMinute,
} from '../src/runtime/poller/cron';

const utc = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number => Date.UTC(year, month - 1, day, hour, minute, second);

describe('parseCronExpression', () => {
  it('accepts the five standard fields with steps, ranges and lists', () => {
    expect(() => parseCronExpression('*/5 * * * *')).not.toThrow();
    expect(() => parseCronExpression('0 9-17 * * 1-5')).not.toThrow();
    expect(() => parseCronExpression('0,30 0 1,15 1-6/2 *')).not.toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCronExpression('* * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* 24 * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * 0 * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * * 13 *')).toThrow(CronParseError);
    expect(() => parseCronExpression('* * * * 8')).toThrow(CronParseError);
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('a * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('5-1 * * * *')).toThrow(CronParseError);
    expect(() => parseCronExpression('')).toThrow(CronParseError);
  });

  it('normalizes day-of-week 7 to Sunday', () => {
    const sundayAsSeven = parseCronExpression('0 0 * * 7');
    // 2026-08-16 is a Sunday.
    expect(cronMatchesMinute(sundayAsSeven, utc(2026, 8, 16))).toBe(true);
    expect(cronMatchesMinute(sundayAsSeven, utc(2026, 8, 17))).toBe(false);
  });
});

describe('cronMatchesMinute (UTC)', () => {
  it('matches step expressions per minute', () => {
    const every5 = parseCronExpression('*/5 * * * *');
    expect(cronMatchesMinute(every5, utc(2026, 8, 12, 6, 0))).toBe(true);
    expect(cronMatchesMinute(every5, utc(2026, 8, 12, 6, 5))).toBe(true);
    expect(cronMatchesMinute(every5, utc(2026, 8, 12, 6, 7))).toBe(false);
  });

  it('evaluates fixed times in UTC', () => {
    const daily = parseCronExpression('30 14 * * *');
    expect(cronMatchesMinute(daily, utc(2026, 8, 12, 14, 30))).toBe(true);
    expect(cronMatchesMinute(daily, utc(2026, 8, 12, 15, 30))).toBe(false);
  });

  it('ignores seconds within the minute', () => {
    const daily = parseCronExpression('30 14 * * *');
    expect(cronMatchesMinute(daily, utc(2026, 8, 12, 14, 30, 59))).toBe(true);
  });

  it('applies the vixie OR rule when day-of-month and day-of-week are both restricted', () => {
    const orRule = parseCronExpression('0 0 13 * 5');
    // 2026-08-13 is a Thursday: matches by day-of-month alone.
    expect(cronMatchesMinute(orRule, utc(2026, 8, 13))).toBe(true);
    // 2026-08-14 is a Friday: matches by day-of-week alone.
    expect(cronMatchesMinute(orRule, utc(2026, 8, 14))).toBe(true);
    expect(cronMatchesMinute(orRule, utc(2026, 8, 15))).toBe(false);
  });

  it('requires both when only one of day-of-month / day-of-week is restricted', () => {
    const domOnly = parseCronExpression('0 0 13 * *');
    expect(cronMatchesMinute(domOnly, utc(2026, 8, 13))).toBe(true);
    expect(cronMatchesMinute(domOnly, utc(2026, 8, 14))).toBe(false);
  });
});

describe('latestMatchingMinute — bounded catch-up', () => {
  const every5 = parseCronExpression('*/5 * * * *');

  it('returns the single latest matching minute in (after, now], never the backlog', () => {
    // Simulated 3-hour outage: 36 matching minutes elapsed, exactly one fires.
    const lastFired = utc(2026, 8, 12, 3, 0);
    const now = utc(2026, 8, 12, 6, 2, 30);
    expect(latestMatchingMinute(every5, lastFired, now)).toBe(utc(2026, 8, 12, 6, 0));
  });

  it('includes the current minute when it matches', () => {
    const now = utc(2026, 8, 12, 6, 5, 12);
    expect(latestMatchingMinute(every5, utc(2026, 8, 12, 6, 4), now)).toBe(utc(2026, 8, 12, 6, 5));
  });

  it('excludes the lower bound', () => {
    const fired = utc(2026, 8, 12, 6, 5);
    expect(latestMatchingMinute(every5, fired, fired)).toBeUndefined();
    expect(latestMatchingMinute(every5, fired, utc(2026, 8, 12, 6, 9))).toBeUndefined();
    expect(latestMatchingMinute(every5, fired, utc(2026, 8, 12, 6, 10))).toBe(
      utc(2026, 8, 12, 6, 10),
    );
  });

  it('returns undefined when no minute in the window matches', () => {
    const nightly = parseCronExpression('0 3 * * *');
    expect(
      latestMatchingMinute(nightly, utc(2026, 8, 12, 4, 0), utc(2026, 8, 12, 5, 0)),
    ).toBeUndefined();
  });

  it('skips whole non-matching days when catching up across a long window', () => {
    const monthlyNoon = parseCronExpression('0 12 1 * *');
    const found = latestMatchingMinute(monthlyNoon, utc(2026, 5, 20), utc(2026, 8, 12, 6, 0));
    expect(found).toBe(utc(2026, 8, 1, 12, 0));
  });
});

describe('minute formatting', () => {
  it('floors to the minute and formats as UTC YYYY-MM-DDTHH:mm', () => {
    const ms = utc(2026, 8, 12, 6, 5, 42);
    expect(minuteFloor(ms)).toBe(utc(2026, 8, 12, 6, 5));
    expect(formatMinute(ms)).toBe('2026-08-12T06:05');
    expect(parseMinute('2026-08-12T06:05')).toBe(utc(2026, 8, 12, 6, 5));
  });

  it('round-trips across year boundaries', () => {
    expect(parseMinute(formatMinute(utc(2025, 12, 31, 23, 59)))).toBe(utc(2025, 12, 31, 23, 59));
  });
});
