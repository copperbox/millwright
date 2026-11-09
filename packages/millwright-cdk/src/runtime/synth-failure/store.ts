import { RunCoordinates, RunItem } from '@copperbox/millwright-state';
import { DesiredCheckWrite, sendDesiredCheckUpsert } from '../shared/checks';
import { DynamoGroupSlotStore } from '../shared/groups';
import { finishRunConditionally } from '../shared/runs';
import { SynthFailureStore } from './synth-failure';

/**
 * The synth-failure step's state-table access: the shared conditional slot
 * writes, the shared terminal run transition, and the §13.2 desired-check
 * upsert. Every write is conditional, so a lost condition is an answer
 * (already terminal / a newer run owns the context), never an error.
 */
export class DynamoSynthFailureStore extends DynamoGroupSlotStore implements SynthFailureStore {
  async finishRun(
    coords: RunCoordinates,
    status: RunItem['status'],
    nowMs: number,
  ): Promise<boolean> {
    return finishRunConditionally(this.client, this.tableName, coords, status, nowMs);
  }

  async putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean> {
    return sendDesiredCheckUpsert(
      this.client,
      this.tableName,
      write,
      nowMs,
      this.metadataRetentionDays,
    );
  }
}
