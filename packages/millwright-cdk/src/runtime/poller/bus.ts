import { BusEventDetail, POLLER_EVENT_SOURCE } from '@copperbox/millwright-state';
import type { PutEventsCommandOutput } from '@aws-sdk/client-eventbridge';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { BusEmitter, BusEvent } from './poller';

/** The EventBridge client slice the poller uses; tests inject a fake. */
export interface EventBridgeClientLike {
  send(command: PutEventsCommand): Promise<PutEventsCommandOutput>;
}

/** PutEvents accepts at most ten entries per call. */
const PUT_EVENTS_BATCH = 10;

/**
 * Emits one repo's diff events to the C3 bus under `millwright.poller` — the
 * source the bus resource policy binds to the poller role and the launcher's
 * validation requires for push/branch/tag/pr (spec §7.1).
 *
 * Any failed entry throws: the caller then skips the ref-map commit, so the
 * next tick re-diffs and re-emits (emit-then-commit, spec §6.1) and the
 * launcher's content-derived dedupe absorbs whatever did get through.
 */
export class EventBridgeBusEmitter implements BusEmitter {
  constructor(
    private readonly client: EventBridgeClientLike,
    private readonly busName: string,
  ) {}

  async emit(repo: string, events: readonly BusEvent[], defaultBranch?: string): Promise<void> {
    for (let start = 0; start < events.length; start += PUT_EVENTS_BATCH) {
      const batch = events.slice(start, start + PUT_EVENTS_BATCH);
      const result = await this.client.send(
        new PutEventsCommand({
          Entries: batch.map((event) => {
            const detail: BusEventDetail = {
              repo,
              ref: event.ref,
              sha: event.sha,
              kind: event.kind,
              ...(defaultBranch ? { defaultBranch } : {}),
              ...(event.workflow ? { workflow: event.workflow } : {}),
              ...(event.minute ? { minute: event.minute } : {}),
            };
            return {
              EventBusName: this.busName,
              Source: POLLER_EVENT_SOURCE,
              DetailType: event.kind,
              Detail: JSON.stringify(detail),
            };
          }),
        }),
      );
      if ((result.FailedEntryCount ?? 0) > 0) {
        const failure = result.Entries?.find((entry) => entry.ErrorCode);
        throw new Error(
          `PutEvents failed for ${result.FailedEntryCount} of ${batch.length} entries` +
            (failure ? ` (${failure.ErrorCode}: ${failure.ErrorMessage})` : ''),
        );
      }
    }
  }
}
