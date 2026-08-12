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
