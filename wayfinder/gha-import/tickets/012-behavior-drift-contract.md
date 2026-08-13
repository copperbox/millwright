---
id: "012"
title: Behavior-drift contract
type: wayfinder:grilling
status: open
assignee: none
blocked-by: []
---

## Question

What is the contract for translations that **succeed but change behavior**?

Note 2 covers constructs that *cannot* be translated: they become loud runtime failures
at the exact step, plus a console report. Both research tickets independently surfaced a
different class that Note 2 does not cover — the translation works, the generated file
looks clean, it compiles and synths, and the pipeline behaves **differently**. Nothing
announces it. This class is arguably more dangerous than holes, because a hole at least
stops the build.

**The catalogue so far** (from [GHA feature inventory](001-gha-feature-inventory.md) and
[Action mapping table](002-action-mapping-table.md)):

- **`if-no-files-found`** — GHA's default is `warn`; millwright **throws** on a missing
  artifact path. A workflow that tolerated empty output now fails the job.
- **`fail-fast`** — GHA defaults to **true**; millwright has no fail-fast. Every
  imported matrix silently runs to completion, costing money and time.
- **Lost trigger filters** — `Trigger.pullRequest()` takes no arguments, and there are
  no `paths` filters. Workflows fire on refs and paths they previously skipped. This
  *costs money* rather than failing.
- **Deployment `environment:`** — silently removes a **human approval gate on
  production**. The severity outlier of the whole set.
- **Cron `timezone:`** — UTC-only, so every fire time shifts.
- **`.git` absent from `source.tar.gz`** — any `run:` step invoking git breaks, even
  though `checkout` was correctly deleted.
- **`AWS_REGION` unsettable** (reserved prefix, no cross-step env) — cloud silently
  inherits CodeBuild's region; local may have none. A cross-region workflow deploys to
  the wrong region.
- **`consumes` adds ordering** the YAML never stated (artifact pair without `needs:`).
- **`save`-only cache gains an unrequested restore** that materializes files before any
  step runs; `restore`-only gains an unrequested save.
- **`include-hidden-files`** inverts.
- **setup-go's `cache`** defaults to true.

**Decide:**

1. **Is this a third category** alongside translate/hole/drop — call it
   *translated-with-drift* — with its own reporting contract? Or is it just a hole with
   a different rendering?
2. **Reporting**: always reported, never silent, is the obvious floor. But drift has no
   step to fail at, and by definition the code works. Does it get a comment at the site,
   a report section, both? Does it affect the exit code?
3. **Severity tiers.** Losing a production approval gate and gaining an unrequested
   cache restore are not the same event. Does the contract rank them, and does the
   ranking drive behavior (e.g. refuse to write without `--accept-drift` for the
   severe ones)?
4. **Can any of these be *prevented* rather than reported?** Some have a faithful
   translation available at a cost — `if-no-files-found: warn` could become a guard
   step; lost PR filters could become `skipIf` guards that exit early. Decide whether
   the importer prefers fidelity-with-scaffolding or clean-code-plus-a-warning. This is
   the real tension, and it recurs per item.
5. **Does the `environment:` approval gate deserve special handling** — refusing to
   import at all, rather than reporting? It is the one case where silent drift has a
   security consequence rather than a cost or correctness consequence.

Feeds [Hole rendering and the import report](005-hole-rendering-and-report.md), which
owns the report *surface* once this ticket owns the *policy*. If the answer is "third
category", the map gains a framing note.
