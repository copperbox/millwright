/**
 * Just enough cron parsing for the synth-time cadence lint: how close
 * together, in minutes, can this expression fire? Only the minute field
 * matters — an expression firing every 5 minutes during one hour is still
 * finer than a 10-minute poll cadence.
 */

const MINUTE_TERM = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/;

export class CronParseError extends Error {}

function expandMinuteTerm(term: string): number[] {
  const match = MINUTE_TERM.exec(term);
  if (!match) {
    throw new CronParseError(`unparseable minute term "${term}"`);
  }
  const [, base, stepRaw] = match;
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (step < 1) {
    throw new CronParseError(`step must be >= 1 in "${term}"`);
  }
  let from: number;
  let to: number;
  if (base === '*') {
    [from, to] = [0, 59];
  } else if (base.includes('-')) {
    [from, to] = base.split('-').map(Number);
  } else {
    from = to = Number(base);
  }
  if (from > to || to > 59) {
    throw new CronParseError(`minute term "${term}" is out of the 0-59 range`);
  }
  const minutes: number[] = [];
  for (let m = from; m <= to; m += step) {
    minutes.push(m);
  }
  return minutes;
}

/**
 * Smallest gap in minutes between two consecutive firings implied by the
 * expression's minute field (wrap-around across the hour included). A single
 * firing minute yields 60. Throws `CronParseError` on a malformed expression.
 */
export function minCronIntervalMinutes(expression: string): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const minutes = [...new Set(fields[0].split(',').flatMap(expandMinuteTerm))].sort((a, b) => a - b);
  if (minutes.length === 1) {
    return 60;
  }
  let minGap = minutes[0] + 60 - minutes[minutes.length - 1];
  for (let i = 1; i < minutes.length; i++) {
    minGap = Math.min(minGap, minutes[i] - minutes[i - 1]);
  }
  return minGap;
}
