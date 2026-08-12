import { describe, expect, it } from 'vitest';
import { CronParseError, minCronIntervalMinutes } from '../src';

describe('minCronIntervalMinutes', () => {
  it.each<[string, number]>([
    ['* * * * *', 1],
    ['*/5 * * * *', 5],
    ['*/15 9-17 * * 1-5', 15],
    ['0 4 * * *', 60], // one firing minute per hour
    ['0,30 * * * *', 30],
    ['0,5,30 * * * *', 5], // closest pair wins
    ['50,10 * * * *', 20], // wrap-around across the hour: 50 -> 10
    ['0-10 * * * *', 1],
    ['0-30/10 * * * *', 10],
    ['0-30/10,45 * * * *', 10], // {0,10,20,30,45}: the 10-minute strides beat both 15-minute gaps
  ])('%s -> %d minutes', (expression, expected) => {
    expect(minCronIntervalMinutes(expression)).toBe(expected);
  });

  it.each(['* * * *', '61 * * * *', 'a * * * *', '5-2 * * * *', '*/0 * * * *'])(
    'rejects malformed expression %j',
    (expression) => {
      expect(() => minCronIntervalMinutes(expression)).toThrow(CronParseError);
    },
  );
});
