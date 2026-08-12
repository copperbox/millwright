import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeBusEmitter } from './bus';
import { SsmConfigPlane } from './config';
import { lsRefs } from './git/ls-refs';
import { withUploadPack } from './git/ssh';
import { InstallationTokenMinter } from './github-app';
import { fetchGithubMeta } from './host-keys';
import { createEmfSink, createPrEmfSink } from './metrics';
import { PollerDeps, runTick } from './poller';
import { PrPollerDeps, createPullsFetcher, runPrTick } from './pr-poll';
import { DynamoPollingStore } from './store';

/**
 * Lambda entry point, invoked by the EventBridge Scheduler tick (payload
 * ignored — every tick does the same full pass). Reserved concurrency 1 makes
 * an overlapping tick a throttle, never a concurrent run: overlap
 * self-throttles and the construct alarms on sustained throttling.
 *
 * One tick runs tier 1 (SSH ls-refs, spec §6.1) and then tier 2 (PR polling,
 * spec §6.2). Tier 2 is best-effort by decree: its failures are caught and
 * logged, never thrown, so nothing on the REST side can gate tier-1
 * correctness.
 *
 * Clients, the config-plane deploy-key cache, the tier-2 installation-token
 * cache, and dependency wiring live in module scope: decrypted deploy keys
 * and minted tokens stay cached in memory while the Lambda is warm (spec
 * §6.1 key handling, §13.1 token handling).
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
let prDeps: PrPollerDeps | undefined;

function dependencies(): { tier1: PollerDeps; tier2: PrPollerDeps } {
  if (!deps || !prDeps) {
    const deploymentName = requireEnv('DEPLOYMENT_NAME');
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const store = new DynamoPollingStore(dynamo, requireEnv('POLLING_TABLE_NAME'));
    const config = new SsmConfigPlane(new SSMClient({}), deploymentName);
    const emitter = new EventBridgeBusEmitter(
      new EventBridgeClient({}),
      requireEnv('EVENT_BUS_NAME'),
    );
    const cadenceMs = Number(requireEnv('POLL_CADENCE_SECONDS')) * 1000;
    const concurrency = Number(process.env.POLLER_CONCURRENCY ?? '8');
    deps = {
      store,
      config,
      emitter,
      transport: ({ repo, privateKey, hostKeyPins }) =>
        withUploadPack({ repo, privateKey, hostKeyPins }, (stream) =>
          lsRefs(stream, { refPrefixes: REF_PREFIXES }),
        ),
      fetchMeta: fetchGithubMeta,
      metrics: createEmfSink(deploymentName, Date.now),
      log,
      now: Date.now,
      cadenceMs,
      concurrency,
    };
    prDeps = {
      store,
      config,
      emitter,
      fetchPulls: createPullsFetcher(fetch),
      minter: new InstallationTokenMinter(
        () => config.getGithubAppParameter(),
        fetch,
        Date.now,
      ),
      metrics: createPrEmfSink(deploymentName, Date.now),
      log,
      now: Date.now,
      random: Math.random,
      cadenceMs,
      concurrency,
    };
  }
  return { tier1: deps, tier2: prDeps };
}

export const handler = async (): Promise<void> => {
  const { tier1, tier2 } = dependencies();
  try {
    await runTick(tier1);
  } finally {
    // Tier 2 runs even when tier 1 blew up, and never fails the tick itself.
    try {
      await runPrTick(tier2);
    } catch (err) {
      log('tier-2 pr tick failed', { error: (err as Error).message });
    }
  }
};
