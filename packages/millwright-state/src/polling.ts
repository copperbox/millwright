import { ItemKey, KeyFormatError, SINGLETON_SORT_KEY } from './keys';

/**
 * Polling-table key shapes (spec §9.4, C10). Purely operational poller state:
 * per-repo items plus one deployment-wide circuit-breaker item. Never queried
 * by the CLI.
 */

/** Quorum circuit-breaker item (spec §6.3) — one per deployment. */
export const CIRCUIT_BREAKER_KEY: ItemKey = { pk: 'CIRCUIT', sk: SINGLETON_SORT_KEY };

const REPO_PK_PREFIX = 'REPO#';
const CRON_SK_PREFIX = 'CRON#';

/** Sort keys of the fixed per-repo items. */
export const REF_MAP_SORT_KEY = 'REFS';
export const PR_ETAG_SORT_KEY = 'PR-ETAG';
export const QUARANTINE_SORT_KEY = 'QUARANTINE';

function repoPartitionKey(repo: string): string {
  if (!repo || repo.includes('#')) {
    throw new KeyFormatError(`repo must be non-empty and free of "#", got "${repo}"`);
  }
  return `${REPO_PK_PREFIX}${repo}`;
}

/** Last-seen ref→sha map (compressed — required, spec §6.1). */
export function refMapKey(repo: string): ItemKey {
  return { pk: repoPartitionKey(repo), sk: REF_MAP_SORT_KEY };
}

/** Tier-2 PR-polling ETag for the repo's pulls listing (spec §6.2). */
export function prEtagKey(repo: string): ItemKey {
  return { pk: repoPartitionKey(repo), sk: PR_ETAG_SORT_KEY };
}

/** Per-repo quarantine marker (spec §6.3). */
export function quarantineKey(repo: string): ItemKey {
  return { pk: repoPartitionKey(repo), sk: QUARANTINE_SORT_KEY };
}

/**
 * `last-fired-minute` bookkeeping for one cron entry (spec §6.4). Keyed per
 * (workflow, expression): a workflow may declare several cron triggers.
 */
export function cronLastFiredKey(repo: string, workflow: string, expression: string): ItemKey {
  if (!workflow || workflow.includes('#')) {
    throw new KeyFormatError(`workflow must be non-empty and free of "#", got "${workflow}"`);
  }
  if (!expression || expression.includes('#')) {
    throw new KeyFormatError(`cron expression must be non-empty and free of "#", got "${expression}"`);
  }
  return { pk: repoPartitionKey(repo), sk: `${CRON_SK_PREFIX}${workflow}#${expression}` };
}

export type PollingRowKind = 'refs' | 'pr-etag' | 'quarantine' | 'cron';

export interface ParsedPollingKey {
  readonly repo: string;
  readonly kind: PollingRowKind;
  readonly workflow?: string;
  readonly expression?: string;
}

/** Classify a per-repo polling-table key back into its typed shape. */
export function parseRepoPollingKey(key: ItemKey): ParsedPollingKey {
  if (!key.pk.startsWith(REPO_PK_PREFIX)) {
    throw new KeyFormatError(`Not a per-repo polling key: pk="${key.pk}"`);
  }
  const repo = key.pk.slice(REPO_PK_PREFIX.length);
  if (key.sk === REF_MAP_SORT_KEY) {
    return { repo, kind: 'refs' };
  }
  if (key.sk === PR_ETAG_SORT_KEY) {
    return { repo, kind: 'pr-etag' };
  }
  if (key.sk === QUARANTINE_SORT_KEY) {
    return { repo, kind: 'quarantine' };
  }
  if (key.sk.startsWith(CRON_SK_PREFIX)) {
    const rest = key.sk.slice(CRON_SK_PREFIX.length);
    const separator = rest.indexOf('#');
    if (separator > 0 && separator < rest.length - 1) {
      return {
        repo,
        kind: 'cron',
        workflow: rest.slice(0, separator),
        expression: rest.slice(separator + 1),
      };
    }
  }
  throw new KeyFormatError(`Unrecognized polling-table sort key "${key.sk}"`);
}
