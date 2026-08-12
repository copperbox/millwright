---
type: operations
title: Cost and latency expectations
tags:
  - millwright
  - operations
  - cost
  - aws
timestamp: 2026-08-12T21:28:24.041Z
---

Figures are from the v1 spec's measured and derived sources. Treat them as the baseline a change
should be compared against, not as guarantees.

| | Figure | Source / assumptions |
|---|---|---|
| Push → detection | ~30–90 s typical, ~2 min worst | holds under bounded fan-out |
| Poller per tick | ~7–8 s at 50 repos, 10-way fan-out | binding constraint is **wall-clock, not dollars** |
| CodeBuild PROVISIONING | 2–7 s across the v1 matrix | measured |
| Push → first log line | "typically under two minutes" | measured |
| Polling stack | ~$0.80–2.40/mo at 10–50 repos | moderate ref counts; large-ref repos add DynamoDB I/O for the compressed ref map |
| Step Functions | ~4–6 transitions/iteration ≈ tenths of a cent per typical run; ~$0.20/day pinned at the caps | |
| CMK | ~$1/mo | the one standing cost |
| Compute at 100 runs/day × 5 min | ~$51/mo on ARM small on-demand | |
| Per-build minute rounding | +5–15% at typical job lengths | |
| Concurrent-start bursts | intermittent 30–40 s QUEUED | **queue, don't fail** |

At 50 watched repos the whole-deployment estimate is a few dollars a month idle, roughly
**$80–130/mo at 100 runs/day**, dominated by **CodeBuild minutes and CloudWatch Logs ingestion**.

## What the numbers imply

- **The poller's binding constraint is wall-clock, not cost.** Scaling conversations should be about
  tick duration and fan-out, not the Lambda bill. See
  [Polling architecture](../architecture/polling.md).
- **Zero-idle is a design constraint**, which is why the poller is
  [non-VPC](../decisions/non-vpc-poller.md) and why CodeBuild reserved capacity is rejected.
- **Per-build minute rounding** means many short jobs cost disproportionately more than a few long
  ones — relevant when advising on job granularity.

# Citations

[1] [Spec §16](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [AWS cost analysis](../../docs/aws-cost-analysis.md)
