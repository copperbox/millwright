/**
 * Bounded retry through IAM eventual consistency (spec §10.2). A role or
 * policy written moments before `StartBuild` may not have propagated to
 * CodeBuild's region yet — the spike (`prototypes/codebuild-provisioning-
 * spike/measure.sh:82-88`) measured exactly this wall. With stable roles the
 * wait lands ONLY on grant-changing runs of trusted refs, so the budget stays
 * small (~60 s) and everything else dispatches with zero added latency.
 */

export const IAM_PROPAGATION_BUDGET_MS = 60_000;
export const IAM_PROPAGATION_DELAY_MS = 5_000;

/**
 * Does this look like `StartBuild` racing IAM propagation? CodeBuild rejects
 * a not-yet-visible or not-yet-assumable service role as an input problem
 * (`InvalidInputException: CodeBuild is not authorized to perform:
 * sts:AssumeRole on …`) rather than a throttle, so plain SDK retries never
 * cover it.
 */
export function isIamPropagationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name !== 'InvalidInputException' && error.name !== 'AccessDeniedException') {
    return false;
  }
  return /not authorized|assumerole|does not exist/i.test(error.message);
}

export interface PropagationRetryOptions {
  /** Total wall-clock budget. @default IAM_PROPAGATION_BUDGET_MS */
  readonly budgetMs?: number;
  /** Pause between attempts. @default IAM_PROPAGATION_DELAY_MS */
  readonly delayMs?: number;
  /** @default isIamPropagationError */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt` until it succeeds, a non-propagation error surfaces, or the
 * budget is exhausted — in which case the LAST propagation error is thrown,
 * so the caller's failure handling sees the real cause.
 */
export async function retryThroughIamPropagation<T>(
  attempt: () => Promise<T>,
  options: PropagationRetryOptions = {},
): Promise<T> {
  const budgetMs = options.budgetMs ?? IAM_PROPAGATION_BUDGET_MS;
  const delayMs = options.delayMs ?? IAM_PROPAGATION_DELAY_MS;
  const isRetryable = options.isRetryable ?? isIamPropagationError;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  const deadline = now() + budgetMs;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryable(error) || now() + delayMs > deadline) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}
