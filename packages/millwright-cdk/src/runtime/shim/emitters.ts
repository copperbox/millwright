import { appendFile } from 'node:fs/promises';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  STEP_EVENT_DETAIL_TYPE,
  STEP_EVENT_SOURCE,
  StepEventDetail,
} from '@copperbox/millwright-state';
import { StepEventEmitter } from './shim';

/**
 * The shim's two event sinks — the ONLY host difference between cloud and
 * local runs (spec §11.2's host-neutrality rule): CodeBuild jobs PutEvents
 * on the deployment bus under `source: millwright.step` (the one source the
 * job role's grant and the bus policy allow); local runs append the same
 * payload as JSON lines to the file the runner named, no AWS in the loop.
 */

export class EventBridgeStepEmitter implements StepEventEmitter {
  constructor(
    private readonly client: Pick<EventBridgeClient, 'send'>,
    private readonly busName: string,
  ) {}

  async emit(detail: StepEventDetail): Promise<void> {
    const result = await this.client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: this.busName,
            Source: STEP_EVENT_SOURCE,
            DetailType: STEP_EVENT_DETAIL_TYPE,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
    );
    if ((result.FailedEntryCount ?? 0) > 0) {
      const entry = result.Entries?.[0];
      throw new Error(
        `PutEvents rejected the step event: ${entry?.ErrorCode ?? 'unknown'} ` +
          `${entry?.ErrorMessage ?? ''}`.trim(),
      );
    }
  }
}

/** The JSON-line shape local step-event files carry, one event per line. */
export interface StepEventLine {
  readonly source: typeof STEP_EVENT_SOURCE;
  readonly 'detail-type': typeof STEP_EVENT_DETAIL_TYPE;
  readonly detail: StepEventDetail;
}

export class FileStepEmitter implements StepEventEmitter {
  constructor(private readonly path: string) {}

  async emit(detail: StepEventDetail): Promise<void> {
    const line: StepEventLine = {
      source: STEP_EVENT_SOURCE,
      'detail-type': STEP_EVENT_DETAIL_TYPE,
      detail,
    };
    await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
  }
}
