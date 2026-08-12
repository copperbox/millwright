import { validateBusEvent } from '@copperbox/millwright-state';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { describe, expect, it } from 'vitest';
import { EventBridgeBusEmitter } from '../src/runtime/poller/bus';
import { RefEvent } from '../src/runtime/poller/ref-map';

const sha = (seed: number) => seed.toString(16).padStart(40, '0');

interface SentEntry {
  EventBusName?: string;
  Source?: string;
  DetailType?: string;
  Detail?: string;
}

class FakeEventBridge {
  readonly batches: SentEntry[][] = [];
  failFirstEntryOnce = false;

  async send(command: PutEventsCommand) {
    const entries = (command.input.Entries ?? []) as SentEntry[];
    this.batches.push(entries);
    if (this.failFirstEntryOnce) {
      this.failFirstEntryOnce = false;
      return {
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: 'ThrottlingException', ErrorMessage: 'slow down' }],
        $metadata: {},
      };
    }
    return { FailedEntryCount: 0, Entries: entries.map(() => ({})), $metadata: {} };
  }
}

describe('EventBridgeBusEmitter', () => {
  it('emits entries the launcher-side validation accepts', async () => {
    const client = new FakeEventBridge();
    const emitter = new EventBridgeBusEmitter(client, 'mw-bus');
    const events: RefEvent[] = [
      { kind: 'branch', ref: 'refs/heads/feature', sha: sha(1) },
      { kind: 'push', ref: 'refs/heads/main', sha: sha(2) },
      { kind: 'tag', ref: 'refs/tags/v1', sha: sha(3) },
    ];
    await emitter.emit('octo/app', events, 'main');

    expect(client.batches).toHaveLength(1);
    for (const [index, entry] of client.batches[0].entries()) {
      expect(entry.EventBusName).toBe('mw-bus');
      expect(entry.Source).toBe('millwright.poller');
      expect(entry.DetailType).toBe(events[index].kind);
      const validation = validateBusEvent(
        entry.Source!,
        entry.DetailType!,
        JSON.parse(entry.Detail!),
      );
      expect(validation).toMatchObject({ ok: true });
      if (validation.ok) {
        expect(validation.event.defaultBranch).toBe('main');
        expect(validation.event.repo).toBe('octo/app');
      }
    }
  });

  it('splits more than ten events into PutEvents batches', async () => {
    const client = new FakeEventBridge();
    const emitter = new EventBridgeBusEmitter(client, 'mw-bus');
    const events: RefEvent[] = Array.from({ length: 23 }, (_, i) => ({
      kind: 'push',
      ref: `refs/heads/b${i}`,
      sha: sha(i + 1),
    }));
    await emitter.emit('octo/app', events);
    expect(client.batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
  });

  it('throws on a failed entry so the ref-map commit is withheld', async () => {
    const client = new FakeEventBridge();
    client.failFirstEntryOnce = true;
    const emitter = new EventBridgeBusEmitter(client, 'mw-bus');
    await expect(
      emitter.emit('octo/app', [{ kind: 'push', ref: 'refs/heads/main', sha: sha(1) }]),
    ).rejects.toThrow('ThrottlingException');
  });
});
