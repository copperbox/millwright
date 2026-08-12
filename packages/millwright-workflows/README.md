# @copperbox/millwright-workflows

Millwright's workflow definition library — the only millwright package a
watched repo installs. Definitions live at `millwright/workflows.ts` and are
synthesized to millwright's declarative run model at the triggering commit.

Zero runtime dependencies; deliberately no `aws-cdk-lib`.

```ts
import { WorkflowSet, Workflow, Trigger, Artifact } from '@copperbox/millwright-workflows';

const app = new WorkflowSet();
const ci = new Workflow(app, 'ci', {
  on: [Trigger.push({ branches: ['main'] }), Trigger.pullRequest()],
});
const build = ci.job('build', {
  image: 'public.ecr.aws/docker/library/node:22',
  steps: ['npm ci', 'npm test', 'npm run build'],
  produces: { dist: Artifact.dir('dist') },
});
ci.job('integration', {
  image: 'public.ecr.aws/docker/library/node:22',
  consumes: { dist: build.artifacts.dist },
  steps: ['npm run test:integration'],
});

export default app;
```

## Artifacts and caches (spec §12)

`produces`/`consumes` declarations are synth-checked (a `consumes` with no
matching `produces` fails at synth) and double as the job DAG. At runtime an
artifact is uploaded to the run's `out/<job>/<name>/` subtree — each job can
write **only its own** `out/<job>/` — and consumers fetch it back to the same
workspace-relative paths.

`Cache.keyed` has GitHub-Actions-style semantics: `hashFiles(...)` key parts
are resolved **at synth**, against the checked-out source, so `model.json`
carries the final key string; `restoreKeys` are prefix fallbacks tried in
order on an exact-key miss, and an exact hit skips the save phase. Give the
key a literal part (`key: ['npm-', hashFiles('package-lock.json')]`) —
`hashFiles` resolves to the empty string when nothing matches, and an
all-hash key that resolves empty fails synth.

## Secrets and `secretsAllowedRefs` (spec §12a)

Jobs declare secrets; **which refs actually receive them is repo
configuration** (`millwright repo add --secrets-refs …`), enforced by the
decider at dispatch. Unset means no ref receives secrets. Patterns match the
short ref name as pushed (`main`, `release/1.2`), anchored at both ends;
`*` is the only metacharacter and crosses `/` — `main` matches exactly
`main`, never `mainline`. PR runs (`refs/pull/N`) can never match: no
secrets on PR runs is a rule, not an accident. The synth-time check you see
from this package is fail-fast UX only.

> **Warning — the honest limit.** An allowlisted ref *name* is only as
> strong as the GitHub-side protection of that namespace.
> `--secrets-refs 'release/*'` hands secrets to **anyone who can push a
> branch named `release/anything`** unless a ruleset or branch protection
> locks that namespace down. Protect the namespace first; `millwright
> doctor` warns where it can read ruleset state, but the protection itself
> is yours to configure.
