import { runInputPrefix } from '@copperbox/millwright-state';
import { ExecutionInput } from './execution-input';

/**
 * Where a synth's outputs land (spec §9.3): run executions use the run's
 * `in/` prefix; bootstrap (synth-only) executions have no run number, so
 * their model lands under a sha-keyed pseudo-workflow segment. The segment
 * starts with "." — model workflow names must start with an alphanumeric, so
 * no real workflow's prefix can ever collide with it.
 *
 * The bootstrap location is deterministic in (repo, sha), which is half of
 * the bootstrap idempotency story: concurrent duplicates converge on the
 * same execution name (launcher) and the same S3 objects (here).
 */
export const BOOTSTRAP_WORKFLOW_SEGMENT = '.synth';

const SHA_PATTERN = /^[0-9a-f]+$/i;

export function bootstrapInputPrefix(repo: string, sha: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || repo.includes('..')) {
    throw new Error(`repo must be "owner/name", got "${repo}"`);
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`sha must be a non-empty hex string, got "${sha}"`);
  }
  return `runs/${repo}/${BOOTSTRAP_WORKFLOW_SEGMENT}/${sha}/in/`;
}

export function synthDestinationPrefix(input: ExecutionInput): string {
  if (input.action === 'synth-only') {
    return bootstrapInputPrefix(input.repo, input.sha);
  }
  return runInputPrefix({
    repo: input.repo,
    workflow: input.workflow,
    runNumber: input.runNumber,
  });
}
