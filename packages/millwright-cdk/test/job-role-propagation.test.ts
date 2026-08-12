import { describe, expect, it } from 'vitest';
import {
  IAM_PROPAGATION_BUDGET_MS,
  IAM_PROPAGATION_DELAY_MS,
  isIamPropagationError,
  retryThroughIamPropagation,
} from '../src/runtime/job-roles/propagation';

function propagationError(): Error {
  return Object.assign(
    new Error('CodeBuild is not authorized to perform: sts:AssumeRole on arn:aws:iam::1:role/mw-x'),
    { name: 'InvalidInputException' },
  );
}

/** Fake clock: sleep() advances time, nothing waits for real. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe('isIamPropagationError', () => {
  it.each([
    [propagationError(), true],
    [Object.assign(new Error('Role arn:… does not exist'), { name: 'InvalidInputException' }), true],
    [Object.assign(new Error('not authorized to assume'), { name: 'AccessDeniedException' }), true],
    [Object.assign(new Error('Project name invalid'), { name: 'InvalidInputException' }), false],
    [Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' }), false],
    ['not an error object', false],
  ])('%s → %s', (error, expected) => {
    expect(isIamPropagationError(error)).toBe(expected);
  });
});

describe('retryThroughIamPropagation', () => {
  it('retries propagation errors until the call lands', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = await retryThroughIamPropagation(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw propagationError();
        }
        return 'build-id';
      },
      { ...clock },
    );
    expect(result).toBe('build-id');
    expect(attempts).toBe(3);
    expect(clock.now()).toBe(2 * IAM_PROPAGATION_DELAY_MS);
  });

  it('stays inside the ~60 s budget, then rethrows the propagation error', async () => {
    const clock = fakeClock();
    let attempts = 0;
    await expect(
      retryThroughIamPropagation(
        async () => {
          attempts += 1;
          throw propagationError();
        },
        { ...clock },
      ),
    ).rejects.toThrow(/not authorized/);
    expect(clock.now()).toBeLessThanOrEqual(IAM_PROPAGATION_BUDGET_MS);
    expect(attempts).toBe(IAM_PROPAGATION_BUDGET_MS / IAM_PROPAGATION_DELAY_MS + 1);
  });

  it('surfaces non-propagation errors immediately', async () => {
    const clock = fakeClock();
    let attempts = 0;
    await expect(
      retryThroughIamPropagation(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('AccountLimitExceededException'), {
            name: 'AccountLimitExceededException',
          });
        },
        { ...clock },
      ),
    ).rejects.toThrow(/AccountLimitExceeded/);
    expect(attempts).toBe(1);
    expect(clock.now()).toBe(0);
  });

  it('honors a custom budget and delay', async () => {
    const clock = fakeClock();
    let attempts = 0;
    await expect(
      retryThroughIamPropagation(
        async () => {
          attempts += 1;
          throw propagationError();
        },
        { ...clock, budgetMs: 10_000, delayMs: 4_000 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(3); // t=0, 4s, 8s; a fourth would land past 10s
  });
});
