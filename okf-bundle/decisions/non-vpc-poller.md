---
type: decision
title: The poller is non-VPC
tags:
  - millwright
  - polling
  - cost
  - aws
timestamp: 2026-08-12T21:22:32.068Z
---

The poller Lambda is **not** attached to a VPC. This is load-bearing, not an oversight.

## Why

A VPC-attached Lambda needing outbound internet (which the poller does — it SSHes to GitHub)
requires a NAT gateway at roughly **$32/month**. The entire design's standing cost is a KMS CMK
(~$1/mo) plus the poller itself (~$1–3/mo). A NAT would be an order of magnitude larger than
everything else combined and would dominate the stack's cost for every deployment, including idle
ones.

Since the poller makes only outbound connections to GitHub and AWS APIs, and holds its credentials
in memory from SSM under the CMK, VPC attachment buys no meaningful isolation here.

## Consequence for changes

Any proposal that puts the poller in a VPC has to carry the NAT cost explicitly and justify it
against the zero-idle-cost invariant. Same reasoning rejected CodeBuild reserved capacity: reserved
fleets violate zero-idle.

## Related

- [Polling architecture](../architecture/polling.md)
- [Cost and latency](../operations/cost-and-latency.md)

# Citations

[1] [Spec §2 (C2), §11.3, §16](../../docs/specs/1-millwright-v1-implementable-specification.md)
