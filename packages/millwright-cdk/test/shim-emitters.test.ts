import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  STEP_EVENT_DETAIL_TYPE,
  STEP_EVENT_SOURCE,
  StepEventDetail,
  validateStepEvent,
} from '@copperbox/millwright-state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBridgeStepEmitter, FileStepEmitter } from '../src/runtime/shim/emitters';

const DETAIL: StepEventDetail = {
  runId: 'octo/app#ci#7',
  job: 'build',
  stepIndex: 0,
  status: 'RUNNING',
  startedAt: '2026-08-12T06:00:00.000Z',
};

describe('EventBridgeStepEmitter', () => {
  function fakeClient(result: Record<string, unknown>) {
    const sent: PutEventsCommand[] = [];
    return {
      sent,
      client: {
        send: async (command: PutEventsCommand) => {
          sent.push(command);
          return result;
        },
      },
    };
  }

  it('PutEvents one entry on the deployment bus under the step source', async () => {
    const { client, sent } = fakeClient({ FailedEntryCount: 0 });
    await new EventBridgeStepEmitter(client as never, 'ci-bus').emit(DETAIL);

    expect(sent).toHaveLength(1);
    const [entry] = sent[0].input.Entries!;
    expect(entry).toMatchObject({
      EventBusName: 'ci-bus',
      Source: STEP_EVENT_SOURCE,
      DetailType: STEP_EVENT_DETAIL_TYPE,
    });
    // The wire payload round-trips through the writer's validator.
    expect(
      validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, JSON.parse(entry.Detail!)).ok,
    ).toBe(true);
  });

  it('throws on per-entry failures so the shim can warn', async () => {
    const { client } = fakeClient({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'AccessDenied', ErrorMessage: 'no' }],
    });
    await expect(new EventBridgeStepEmitter(client as never, 'ci-bus').emit(DETAIL)).rejects.toThrow(
      'AccessDenied',
    );
  });
});

describe('FileStepEmitter', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shim-emitter-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per event, in the bus payload shape', async () => {
    const path = join(dir, 'events.jsonl');
    const emitter = new FileStepEmitter(path);
    await emitter.emit(DETAIL);
    await emitter.emit({ ...DETAIL, status: 'SUCCEEDED', finishedAt: '2026-08-12T06:00:01.000Z' });

    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(validateStepEvent(line.source, line['detail-type'], line.detail).ok).toBe(true);
    }
    expect(lines[1].detail.status).toBe('SUCCEEDED');
  });
});
