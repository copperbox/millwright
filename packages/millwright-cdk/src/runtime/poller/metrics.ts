/**
 * Tick metrics in CloudWatch Embedded Metric Format — extracted from the log
 * stream, so the poller role needs no `cloudwatch:PutMetricData` beyond the
 * inventory spec §10.3 pins. The construct's alarms (breaker open, host-key
 * rotation) sit on these; sustained tick overlap alarms on the Lambda's own
 * Throttles metric (reserved concurrency 1 turns overlap into throttles).
 */

export const METRICS_NAMESPACE = 'Millwright/Poller';
export const DEPLOYMENT_DIMENSION = 'Deployment';

export interface TickMetrics {
  /** Wall-clock of the whole tick — `doctor`'s last-tick-duration source. */
  readonly TickDurationMs: number;
  readonly ReposPolled: number;
  readonly RefEventsEmitted: number;
  readonly TransportFailures: number;
  readonly QuarantinedRepos: number;
  /** 1 while the circuit breaker is open at tick end. */
  readonly CircuitBreakerOpen: number;
  /** 1 when this tick auto-reconciled a confirmed host-key rotation. */
  readonly HostKeyRotationReconciled: number;
  /** Repo polls hard-failed on an unconfirmed host-key mismatch. */
  readonly HostKeyHardFailures: number;
}

const METRIC_UNITS: Readonly<Record<keyof TickMetrics, string>> = {
  TickDurationMs: 'Milliseconds',
  ReposPolled: 'Count',
  RefEventsEmitted: 'Count',
  TransportFailures: 'Count',
  QuarantinedRepos: 'Count',
  CircuitBreakerOpen: 'Count',
  HostKeyRotationReconciled: 'Count',
  HostKeyHardFailures: 'Count',
};

export type MetricsSink = (metrics: TickMetrics) => void;

/** Tier-2 PR-polling tick metrics (spec §6.2, §6.3), same namespace. */
export interface PrTickMetrics {
  readonly PrTickDurationMs: number;
  /** Repos whose pulls listing was actually requested this tick. */
  readonly PrReposPolled: number;
  readonly PrEventsEmitted: number;
  /** Authenticated 304s — free against the primary rate limit. */
  readonly PrNotModified: number;
  readonly PrApiErrors: number;
  /** Fork-authored PR events dropped by `forkPrPolicy` off. */
  readonly PrForkEventsDropped: number;
  /** Repos skipped inside an active tier-2 backoff window. */
  readonly PrBackoffSkips: number;
}

const PR_METRIC_UNITS: Readonly<Record<keyof PrTickMetrics, string>> = {
  PrTickDurationMs: 'Milliseconds',
  PrReposPolled: 'Count',
  PrEventsEmitted: 'Count',
  PrNotModified: 'Count',
  PrApiErrors: 'Count',
  PrForkEventsDropped: 'Count',
  PrBackoffSkips: 'Count',
};

export type PrMetricsSink = (metrics: PrTickMetrics) => void;

/** Cron pass metrics (spec §6.4), same namespace. */
export interface CronTickMetrics {
  /** (workflow, expression) pairs evaluated across all repos this tick. */
  readonly CronEntriesEvaluated: number;
  readonly CronEventsEmitted: number;
  /** Entries skipped because their expression failed to parse (fail closed). */
  readonly CronInvalidExpressions: number;
  /** Repo- or entry-local failures (registry read, emit) this tick. */
  readonly CronErrors: number;
}

const CRON_METRIC_UNITS: Readonly<Record<keyof CronTickMetrics, string>> = {
  CronEntriesEvaluated: 'Count',
  CronEventsEmitted: 'Count',
  CronInvalidExpressions: 'Count',
  CronErrors: 'Count',
};

export type CronMetricsSink = (metrics: CronTickMetrics) => void;

/** One EMF blob per tick on stdout. */
export function createEmfSink(
  deploymentName: string,
  nowMs: () => number,
  write: (line: string) => void = (line) => console.log(line),
): MetricsSink {
  return emfSink<TickMetrics>(METRIC_UNITS, deploymentName, nowMs, write);
}

/** The tier-2 counterpart — a separate blob so a skipped tier emits nothing. */
export function createPrEmfSink(
  deploymentName: string,
  nowMs: () => number,
  write: (line: string) => void = (line) => console.log(line),
): PrMetricsSink {
  return emfSink<PrTickMetrics>(PR_METRIC_UNITS, deploymentName, nowMs, write);
}

/** The cron pass counterpart. */
export function createCronEmfSink(
  deploymentName: string,
  nowMs: () => number,
  write: (line: string) => void = (line) => console.log(line),
): CronMetricsSink {
  return emfSink<CronTickMetrics>(CRON_METRIC_UNITS, deploymentName, nowMs, write);
}

function emfSink<T extends Record<keyof T, number>>(
  units: Readonly<Record<keyof T, string>>,
  deploymentName: string,
  nowMs: () => number,
  write: (line: string) => void,
): (metrics: T) => void {
  return (metrics) => {
    write(
      JSON.stringify({
        _aws: {
          Timestamp: nowMs(),
          CloudWatchMetrics: [
            {
              Namespace: METRICS_NAMESPACE,
              Dimensions: [[DEPLOYMENT_DIMENSION]],
              Metrics: (Object.keys(metrics) as (keyof T)[]).map((name) => ({
                Name: name,
                Unit: units[name],
              })),
            },
          ],
        },
        [DEPLOYMENT_DIMENSION]: deploymentName,
        ...metrics,
      }),
    );
  };
}
