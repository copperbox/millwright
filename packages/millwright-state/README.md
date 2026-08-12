# @copperbox/millwright-state

Millwright's shared data-plane helpers: typed accessors for every state-table
and polling-table row, the SSM config-plane paths under
`/millwright/<name>/…`, and the artifact/cache bucket's object layout.

Used by every component that touches the stores — launcher, decider, reporter,
step-events writer, and the CLI — so key shapes are defined exactly once.
Zero runtime dependencies; deliberately no `aws-cdk-lib` and no AWS SDK.

```ts
import { runKey, parseRunKey, withMetadataTtl } from '@copperbox/millwright-state';

const key = runKey({ repo: 'copperbox/millwright', workflow: 'ci', runNumber: 142 });
// { pk: 'WF#copperbox/millwright#ci', sk: 'RUN#999999999857' }
// Run sort keys are inverted zero-padded numbers: ascending key order is
// descending run number, so a Query returns newest runs first.

parseRunKey(key); // { repo: 'copperbox/millwright', workflow: 'ci', runNumber: 142 }
```

The state table is never a credential store, and `REG#` registry rows are
exempt from the metadata TTL — `withMetadataTtl` enforces the exemption.
