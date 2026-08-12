---
type: security
title: permissionsBoundary is a required construct prop
tags:
  - millwright
  - security
  - iam
  - cdk
timestamp: 2026-08-12T21:24:39.447Z
---

`permissionsBoundary` is the **only required prop** on the `Millwright` construct. The construct
**throws at construct time** when it is absent.

```ts
new Millwright(stack, 'Millwright', {
  permissionsBoundary: boundaryArn,  // REQUIRED
  // ...
});
```

## Why required, and why it throws

Throwing at construct time means the failure surfaces as a **`cdk synth` error on the operator's
machine** — never as a deployment that quietly mints unbounded job roles.

This prop is unlike every other knob because it is **the only cap on what repo-editable definitions
can request**. Every job role millwright creates sits under it. That asymmetry is the entire reason
it alone is required; no other prop guards anything.

## The opt-out

The only opt-out is the explicit sentinel `permissionsBoundary: Boundary.NONE`, which emits a
synth-time **warning**. The design principle: *the risk is visible in the file the operator wrote,
which a missing prop never is.*

## History

Ticket 004 accepted repo-resident definitions **conditioned on** the boundary; ticket 014 later
demoted it to an optional knob. It was restored as required — the condition and the feature are not
separable.

Code: `packages/millwright-cdk/src/boundary.ts`, `packages/millwright-cdk/src/millwright.ts`.

## Related

- [Trust model](trust-model.md) · [Job roles](job-roles.md)

# Citations

[1] [Spec §3.2, §10.1, §17 amendment 9](../../docs/specs/1-millwright-v1-implementable-specification.md)
