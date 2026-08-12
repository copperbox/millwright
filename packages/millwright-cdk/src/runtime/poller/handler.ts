import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeBusEmitter } from './bus';
import { SsmConfigPlane } from './config';
import { lsRefs } from './git/ls-refs';
import { withUploadPack } from './git/ssh';
import { fetchGithubMeta } from './host-keys';
import { createEmfSink } from './metrics';
import { PollerDeps, runTick } from './poller';
import { DynamoPollingStore } from './store';

/**
 * Lambda entry point, invoked by the EventBridge Scheduler tick (payload
 * ignored — every tick does the same full pass). Reserved concurrency 1 makes
 * an overlapping tick a throttle, never a concurrent run: overlap
 * self-throttles and the construct alarms on sustained throttling.
 *
 * Clients, the config-plane deploy-key cache, and dependency wiring live in
 * module scope: decrypted deploy keys stay cached while the Lambda is warm
 * (spec §6.1 key handling).
 */

/** The operating query: the full watched namespace plus HEAD for the symref. */
const REF_PREFIXES = ['HEAD', 'refs/heads/', 'refs/tags/'] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function log(message: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ message, ...fields }));
}

let deps: PollerDeps | undefined;

function dependencies(): PollerDeps {
  if (!deps) {
    const deploymentName = requireEnv('DEPLOYMENT_NAME');
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    deps = {
      store: new DynamoPollingStore(dynamo, requireEnv('POLLING_TABLE_NAME')),
      config: new SsmConfigPlane(new SSMClient({}), deploymentName),
      emitter: new EventBridgeBusEmitter(new EventBridgeClient({}), requireEnv('EVENT_BUS_NAME')),
      transport: ({ repo, privateKey, hostKeyPins }) =>
        withUploadPack({ repo, privateKey, hostKeyPins }, (stream) =>
          lsRefs(stream, { refPrefixes: REF_PREFIXES }),
        ),
      fetchMeta: fetchGithubMeta,
      metrics: createEmfSink(deploymentName, Date.now),
      log,
      now: Date.now,
      cadenceMs: Number(requireEnv('POLL_CADENCE_SECONDS')) * 1000,
      concurrency: Number(process.env.POLLER_CONCURRENCY ?? '8'),
    };
  }
  return deps;
}

export const handler = async (): Promise<void> => {
  await runTick(dependencies());
};
