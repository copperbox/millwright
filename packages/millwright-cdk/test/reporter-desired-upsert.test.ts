import {
  checkStateKey,
  desiredSynthStarted,
  serializeDesiredCheckState,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { desiredCheckUpsert, isConditionalCheckFailure } from '../src/runtime/shared/checks';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const SHA = 'a'.repeat(40);

const write = {
  repo: 'octocat/app',
  sha: SHA,
  context: 'ci / synth',
  ownerRun: 'ci#142',
  ownerRunNumber: 142,
  desired: desiredSynthStarted('ci#142'),
};

describe('desiredCheckUpsert (spec §13.2 ownership)', () => {
  it('targets the CHECK#<repo>#<sha> / CTX#<context> item', () => {
    const input = desiredCheckUpsert('table', write, NOW, 90);
    expect(input.TableName).toBe('table');
    expect(input.Key).toEqual(checkStateKey('octocat/app', SHA, 'ci / synth'));
  });

  it('is conditional on this run number ≥ the stored owner — a lower-numbered run drops silently', () => {
    const input = desiredCheckUpsert('table', write, NOW, 90);
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(ownerRunNumber) OR ownerRunNumber <= :ownerRunNumber',
    );
    expect(input.ExpressionAttributeValues![':ownerRunNumber']).toBe(142);
  });

  it('writes the canonical desired serialization, owner identity, clock and TTL', () => {
    const input = desiredCheckUpsert('table', write, NOW, 90);
    const values = input.ExpressionAttributeValues!;
    expect(values[':desired']).toBe(serializeDesiredCheckState(write.desired));
    expect(values[':desiredAt']).toBe(new Date(NOW).toISOString());
    expect(values[':ownerRun']).toBe('ci#142');
    expect(values[':expiresAt']).toBe(Math.floor(NOW / 1000) + 90 * 24 * 3600);
    expect(values[':repo']).toBe('octocat/app');
    expect(values[':sha']).toBe(SHA);
    expect(values[':context']).toBe('ci / synth');
  });

  it('never touches checkRunId or reported — same-or-newer writes carry the check run forward', () => {
    const input = desiredCheckUpsert('table', write, NOW, 90);
    expect(input.UpdateExpression).not.toMatch(/checkRunId/);
    expect(input.UpdateExpression).not.toMatch(/reported/);
  });

  it('clears abandonment and backoff so a fresh desired state reconciles again', () => {
    const input = desiredCheckUpsert('table', write, NOW, 90);
    expect(input.UpdateExpression).toMatch(/REMOVE .*abandoned/);
    expect(input.UpdateExpression).toMatch(/backoffAttempts/);
    expect(input.UpdateExpression).toMatch(/nextAttemptAt/);
  });
});

describe('isConditionalCheckFailure', () => {
  it('recognizes the DynamoDB conditional failure by name', () => {
    expect(
      isConditionalCheckFailure(
        Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }),
      ),
    ).toBe(true);
    expect(isConditionalCheckFailure(new Error('boom'))).toBe(false);
    expect(isConditionalCheckFailure(undefined)).toBe(false);
  });
});
