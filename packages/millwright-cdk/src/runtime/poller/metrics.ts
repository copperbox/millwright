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

/** One EMF blob per tick on stdout. */
export function createEmfSink(
  deploymentName: string,
  nowMs: () => number,
  write: (line: string) => void = (line) => console.log(line),
): MetricsSink {
  return (metrics) => {
    write(
      JSON.stringify({
        _aws: {
          Timestamp: nowMs(),
          CloudWatchMetrics: [
            {
              Namespace: METRICS_NAMESPACE,
              Dimensions: [[DEPLOYMENT_DIMENSION]],
              Metrics: (Object.keys(metrics) as (keyof TickMetrics)[]).map((name) => ({
                Name: name,
                Unit: METRIC_UNITS[name],
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
