---
id: "003"
title: Trigger translation
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["001"]
---

## Question

How does a GHA `on:` block become millwright `Trigger.*` calls?

The shipped API offers `Trigger.push({ branches })`, `Trigger.tag({ pattern })`,
`Trigger.pullRequest()`, `Trigger.cron(expr)`, `Trigger.manual({ inputs })` — a
deliberately smaller set than GHA's event surface. Decide, per event:

- **`push`** — GHA conflates branch and tag pushes in one event with `branches:` and
  `tags:` filters; millwright splits them into `Trigger.push` and `Trigger.tag`. A
  single GHA `on.push` with both filters becomes **two** millwright triggers.
- **`paths:` / `paths-ignore:`** — millwright has no path filter (confirm against
  `trigger.ts`). Likely a hole. Decide whether it degrades to an unfiltered trigger
  plus a warning, or a `skipIf` guard on the first step, or refuses.
- **`branches-ignore:` / `tags-ignore:`** — negation. Check whether
  `matchesRefPattern` supports it; if not, decide the disposition.
- **`pull_request` `types:`** — `Trigger.pullRequest()` takes no type filter. Which
  GHA default types does it correspond to, and what happens to a workflow filtering on
  `types: [closed]` (a merge-detection idiom with no tier-2 equivalent)?
- **`pull_request_target`** — a privileged-context event that exists for a threat model
  millwright doesn't share. Probably drop-with-explanation; confirm.
- **`schedule`** — cron syntax translation, plus `minCronIntervalMinutes` in the shipped
  API: a GHA schedule finer than millwright's floor must be rejected or coarsened.
  Note GHA cron is UTC-only and best-effort-delayed; millwright's is EventBridge.
- **`workflow_dispatch`** — maps to `Trigger.manual({ inputs })` with typed inputs.
  Translate GHA's `inputs:` (`type: choice/boolean/string/number`, `required`,
  `default`, `description`) onto `ManualInput`. Check which types the shipped API
  actually supports.
- **`workflow_call`** — this workflow *is* a shared workflow. It is not a trigger in
  millwright; it becomes an exported function (ticket 007). Decide what the importer
  does when it imports a repo whose workflow is `workflow_call`-only.
- **`workflow_run`, `release`, `issues`, `issue_comment`, and the rest** — no
  equivalent, and most are API-polling-shaped (tier 2) or webhook-shaped. Confirm the
  blanket disposition and how loudly it's reported.

Also decide: where a workflow has **multiple** unrelated triggers that the job-level
`if:` was discriminating between (Note 5), does this ticket own the recommendation to
split into several `Workflow`s, or does ticket 004?
