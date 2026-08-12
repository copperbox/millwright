/**
 * Cron expression evaluation for the poller tick (spec §6.4). Five standard
 * fields (minute, hour, day-of-month, month, day-of-week), numeric values
 * with `*`, lists, ranges and steps; day-of-week 7 is Sunday. Everything is
 * evaluated in UTC — the documented, only timezone.
 *
 * The tick fires AT MOST the latest matching minute in `(last-fired, now]`
 * (bounded catch-up): after an outage exactly one run catches up instead of
 * the whole backlog thundering in.
 */

export const MINUTE_MS = 60_000;

const DAY_MS = 24 * 60 * MINUTE_MS;

export class CronParseError extends Error {}

export interface CronExpression {
  /** Sorted ascending; each field lists every value it matches. */
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0 = Sunday … 6 = Saturday (7 normalized to 0 at parse). */
  readonly daysOfWeek: readonly number[];
  /** Whether the field was written as something narrower than `*`. */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  /** day-of-week: fold 7 onto 0 (both mean Sunday). */
  readonly foldMaxToMin?: boolean;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7, foldMaxToMin: true },
];

function parseField(spec: FieldSpec, field: string): { values: number[]; restricted: boolean } {
  const matched = new Set<number>();
  let restricted = false;
  for (const part of field.split(',')) {
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined || rangePart === '' || stepPart === '') {
      throw new CronParseError(`invalid ${spec.name} field "${field}"`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(`invalid step in ${spec.name} field "${field}"`);
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      // Vixie semantics: `*` keeps its star flag even with a step, so the
      // day-of-month/day-of-week OR rule only engages on explicit values.
      from = spec.min;
      to = spec.max;
    } else {
      restricted = true;
      const bounds = rangePart.split('-');
      if (bounds.length > 2 || bounds.some((b) => !/^\d+$/.test(b))) {
        throw new CronParseError(`invalid ${spec.name} field "${field}"`);
      }
      from = Number(bounds[0]);
      if (bounds.length === 2) {
        to = Number(bounds[1]);
      } else if (stepPart !== undefined) {
        // A bare value with a step (`5/15`) means "from 5 to the max".
        to = spec.max;
      } else {
        to = from;
      }
      if (from > to) {
        throw new CronParseError(`inverted range in ${spec.name} field "${field}"`);
      }
    }
    if (from < spec.min || to > spec.max) {
      throw new CronParseError(
        `${spec.name} value out of range [${spec.min}, ${spec.max}] in "${field}"`,
      );
    }
    for (let value = from; value <= to; value += step) {
      matched.add(spec.foldMaxToMin && value === spec.max ? spec.min : value);
    }
  }
  return { values: [...matched].sort((a, b) => a - b), restricted };
}

export function parseCronExpression(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELDS.length) {
    throw new CronParseError(
      `cron expression must have exactly ${FIELDS.length} fields, got "${expression}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = FIELDS.map((spec, i) =>
    parseField(spec, fields[i]),
  );
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

/**
 * The vixie day rule: with BOTH day fields restricted the day matches when
 * EITHER does; otherwise the restricted one (if any) must match.
 */
function dayMatches(expr: CronExpression, date: Date): boolean {
  if (!expr.months.includes(date.getUTCMonth() + 1)) {
    return false;
  }
  const domMatch = expr.daysOfMonth.includes(date.getUTCDate());
  const dowMatch = expr.daysOfWeek.includes(date.getUTCDay());
  return expr.dayOfMonthRestricted && expr.dayOfWeekRestricted
    ? domMatch || dowMatch
    : domMatch && dowMatch;
}

/** Whether the UTC minute containing `ms` matches the expression. */
export function cronMatchesMinute(expr: CronExpression, ms: number): boolean {
  const date = new Date(minuteFloor(ms));
  return (
    dayMatches(expr, date) &&
    expr.hours.includes(date.getUTCHours()) &&
    expr.minutes.includes(date.getUTCMinutes())
  );
}

/**
 * The LATEST minute in `(afterMs, nowMs]` matching the expression, as epoch
 * milliseconds on the minute — or undefined when none does. Scans day by day
 * so multi-month catch-up windows stay cheap.
 */
export function latestMatchingMinute(
  expr: CronExpression,
  afterMs: number,
  nowMs: number,
): number | undefined {
  const upper = minuteFloor(nowMs);
  const lower = minuteFloor(afterMs); // exclusive
  const hoursDesc = [...expr.hours].reverse();
  const minutesDesc = [...expr.minutes].reverse();
  const upperDate = new Date(upper);
  const upperDayStart = Date.UTC(
    upperDate.getUTCFullYear(),
    upperDate.getUTCMonth(),
    upperDate.getUTCDate(),
  );
  for (let day = upperDayStart; day + DAY_MS > lower + MINUTE_MS; day -= DAY_MS) {
    if (!dayMatches(expr, new Date(day))) {
      continue;
    }
    for (const hour of hoursDesc) {
      for (const minute of minutesDesc) {
        const candidate = day + (hour * 60 + minute) * MINUTE_MS;
        if (candidate > upper) {
          continue;
        }
        if (candidate <= lower) {
          return undefined;
        }
        return candidate;
      }
    }
  }
  return undefined;
}

export function minuteFloor(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

const MINUTE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `YYYY-MM-DDTHH:mm` in UTC — the wire and stored form of a cron minute. */
export function formatMinute(ms: number): string {
  return new Date(minuteFloor(ms)).toISOString().slice(0, 16);
}

export function parseMinute(minute: string): number {
  const match = MINUTE_FORMAT.exec(minute);
  if (!match) {
    throw new CronParseError(`not a cron minute ("YYYY-MM-DDTHH:mm"): "${minute}"`);
  }
  const [, year, month, day, hour, min] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(min));
}
