/**
 * Synth-events completer core: the synth build "rides its own token" — this
 * handler watches the shared project's terminal build-state events, finds
 * the task token the synth Lambda stamped onto the build's environment, and
 * completes it. User-job builds carry no token and fall through to the
 * build-events handler's `BUILD#` mapping path (its issue), so the two
 * rules on the same project never race for the same build.
 *
 * Wakes here are pure signal delivery: a duplicate or late event hits an
 * already-consumed token and is swallowed as stale. With this handler down,
 * the synth phase still terminates via the state machine's phase timeout.
 */

export interface SynthBuildEvent {
  readonly source?: string;
  readonly 'detail-type'?: string;
  readonly detail?: {
    readonly 'build-status'?: string;
    /** The build ARN (EventBridge's field name, not actually the id). */
    readonly 'build-id'?: string;
    readonly 'project-name'?: string;
    readonly 'additional-information'?: {
      readonly environment?: {
        readonly 'environment-variables'?: readonly {
          readonly name?: string;
          readonly value?: string;
          readonly type?: string;
        }[];
      };
      readonly logs?: { readonly 'stream-name'?: string };
    };
  };
}

export interface TokenSender {
  /** `stale` when the token was already consumed or the execution is gone. */
  sendSuccess(token: string, output: string): Promise<'sent' | 'stale'>;
  sendFailure(token: string, error: string, cause: string): Promise<'sent' | 'stale'>;
}

export interface SynthEventsDeps {
  readonly sender: TokenSender;
  /** Best-effort read of `synth-error.json`; undefined when absent. */
  readonly readObject: (bucket: string, key: string) => Promise<string | undefined>;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type SynthEventDisposition =
  | 'ignored'
  | 'completed'
  | 'failed'
  | 'stale-token';

export const SYNTH_ERROR_OBJECT_NAME = 'synth-error.json';

/** SendTaskFailure's cause is display text; keep it far under the API cap. */
const MAX_CAUSE_LENGTH = 4096;

const FAILURE_STATUSES = ['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'];

function environmentOf(event: SynthBuildEvent): Record<string, string> {
  const variables =
    event.detail?.['additional-information']?.environment?.['environment-variables'] ?? [];
  const env: Record<string, string> = {};
  for (const variable of variables) {
    if (variable.name && variable.value !== undefined) {
      env[variable.name] = variable.value;
    }
  }
  return env;
}

/** `arn:aws:codebuild:…:build/<project>:<uuid>` → `<project>:<uuid>`. */
function buildIdFromArn(buildArn: string | undefined): string | undefined {
  if (!buildArn) {
    return undefined;
  }
  const marker = ':build/';
  const index = buildArn.indexOf(marker);
  return index < 0 ? buildArn : buildArn.slice(index + marker.length) || undefined;
}

async function failureCause(
  deps: SynthEventsDeps,
  env: Record<string, string>,
  status: string,
): Promise<string> {
  const bucket = env.MILLWRIGHT_DEST_BUCKET;
  const prefix = env.MILLWRIGHT_DEST_PREFIX;
  if (bucket && prefix) {
    try {
      const body = await deps.readObject(bucket, `${prefix}${SYNTH_ERROR_OBJECT_NAME}`);
      if (body) {
        const message = (JSON.parse(body) as { message?: unknown }).message;
        if (typeof message === 'string' && message.length > 0) {
          return message.slice(0, MAX_CAUSE_LENGTH);
        }
      }
    } catch (err) {
      deps.log('could not read synth error object', { error: String(err) });
    }
  }
  return `The synth build finished ${status} without a synth-error.json — see the build log`;
}

export async function processSynthBuildEvent(
  deps: SynthEventsDeps,
  event: SynthBuildEvent,
): Promise<SynthEventDisposition> {
  const env = environmentOf(event);
  const token = env.MILLWRIGHT_TASK_TOKEN;
  if (!token) {
    return 'ignored'; // a user-job build, or not ours at all
  }

  const status = event.detail?.['build-status'];
  if (status === 'SUCCEEDED') {
    const output = JSON.stringify({
      buildId: buildIdFromArn(event.detail?.['build-id']),
      logStreamName: event.detail?.['additional-information']?.logs?.['stream-name'],
    });
    const sent = await deps.sender.sendSuccess(token, output);
    return sent === 'sent' ? 'completed' : 'stale-token';
  }

  if (status && FAILURE_STATUSES.includes(status)) {
    const cause = await failureCause(deps, env, status);
    const sent = await deps.sender.sendFailure(token, 'SynthJobFailed', cause);
    return sent === 'sent' ? 'failed' : 'stale-token';
  }

  return 'ignored'; // IN_PROGRESS and anything unrecognized
}
