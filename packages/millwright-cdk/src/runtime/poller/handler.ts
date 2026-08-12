import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EventBridgeBusEmitter } from './bus';
import { SsmConfigPlane } from './config';
import { CronTickDeps, runCronTick } from './cron-tick';
import { lsRefs } from './git/ls-refs';
import { withUploadPack } from './git/ssh';
import { InstallationTokenMinter } from './github-app';
import { fetchGithubMeta } from './host-keys';
import { createCronEmfSink, createEmfSink, createPrEmfSink } from './metrics';
import { PollerDeps, runTick } from './poller';
import { PrPollerDeps, createPullsFetcher, runPrTick } from './pr-poll';
import { DynamoRegistryReader } from './registry';
import { DynamoPollingStore } from './store';

/**
 * Lambda entry point, invoked by the EventBridge Scheduler tick (payload
 * ignored — every tick does the same full pass). Reserved concurrency 1 makes
 * an overlapping tick a throttle, never a concurrent run: overlap
 * self-throttles and the construct alarms on sustained throttling.
 *
 * One tick runs tier 1 (SSH ls-refs, spec §6.1), then the cron pass (spec
 * §6.4 — the tick doubles as the cron clock, evaluating against the ref map
 * tier 1 just committed), and then tier 2 (PR polling, spec §6.2). The cron
 * pass and tier 2 each catch and log their own failures so neither can gate
 * tier-1 correctness or each other.
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
let cronDeps: CronTickDeps | undefined;

function dependencies(): { tier1: PollerDeps; cron: CronTickDeps; tier2: PrPollerDeps } {
  if (!deps || !prDeps || !cronDeps) {
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
    cronDeps = {
      store,
      registry: new DynamoRegistryReader(dynamo, requireEnv('STATE_TABLE_NAME')),
      emitter,
      listRepos: () => config.listRepos(),
      metrics: createCronEmfSink(deploymentName, Date.now),
      log,
      now: Date.now,
    };
  }
  return { tier1: deps, cron: cronDeps, tier2: prDeps };
}

export const handler = async (): Promise<void> => {
  const { tier1, cron, tier2 } = dependencies();
  try {
    await runTick(tier1);
  } finally {
    // The cron pass and tier 2 run even when tier 1 blew up, and never fail
    // the tick themselves.
    try {
      await runCronTick(cron);
    } catch (err) {
      log('cron pass failed', { error: (err as Error).message });
    }
    try {
      await runPrTick(tier2);
    } catch (err) {
      log('tier-2 pr tick failed', { error: (err as Error).message });
    }
  }
};
