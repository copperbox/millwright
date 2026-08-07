/**
 * PROTOTYPE — mechanics sketch for "Local execution parity". Not a design
 * commitment. Shows the one structural idea: the decider from the orchestration
 * decision is a pure library, and cloud/local are two thin hosts around it.
 */

// ---------------------------------------------------------------------------
// The shared core (already implied by the orchestration decision):
// decider = f(jobModel, jobStates) → actions. Pure, no AWS types.
// ---------------------------------------------------------------------------

interface JobState {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'
        | 'CANCELLED' | 'SKIPPED';
  reason?: 'upstream_failed' | 'skip_if' | 'upstream_cancelled';
}

interface DeciderAction {
  kind: 'start' | 'stop' | 'finishRun';
  job?: string;
  runStatus?: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
}

/** Same function the decider Lambda calls. */
declare function decide(
  jobModel: JobModel,
  states: Record<string, JobState>,
  cancelRequested: boolean,
): DeciderAction[];

// ---------------------------------------------------------------------------
// The two seams the hosts implement. Cloud: CodeBuild + DynamoDB.
// Local: docker + a JSON state file. Nothing else differs.
// ---------------------------------------------------------------------------

interface Executor {
  /** Cloud: StartBuild with overrides. Local: docker run. */
  start(job: SynthesizedJob, ctx: RunContext): Promise<void>;
  /** Cloud: StopBuild. Local: docker stop. */
  stop(job: string): Promise<void>;
}

interface StateSink {
  /** Cloud: DynamoDB run/job/step items. Local: .millwright/runs/local-N.json */
  putJobState(job: string, state: JobState): Promise<void>;
  putStepState(job: string, step: number, state: StepState): Promise<void>;
  getStates(): Promise<Record<string, JobState>>;
}

// ---------------------------------------------------------------------------
// The local host — the entire "orchestrator" for a local run.
// ---------------------------------------------------------------------------

async function runLocal(workflow: string, opts: LocalRunOpts) {
  const model = await synthInProcess('millwright/workflows.ts', workflow, opts.inputs);

  gateSecrets(model, loadSecretsEnv(opts.secretsFile));   // fail before any job

  const src = opts.clean ? gitArchiveHead() : copyWorkingTree(); // git-aware copy
  const sink = new LocalStateSink(nextLocalRunId());
  const exec = new DockerExecutor(src, sink, {
    artifactsDir: sink.runDir('artifacts'),   // mirrors the S3 layout
    cacheDir: '.millwright/cache',            // same keys as S3 cache objects
    parallel: opts.parallel,
  });

  let cancel = false;
  process.on('SIGINT', () => { cancel = true; exec.wake(); });  // same flag, same path

  // The decider loop — byte-for-byte the logic the Step Functions loop runs.
  while (true) {
    const actions = decide(model, await sink.getStates(), cancel);
    for (const a of actions) {
      if (a.kind === 'start') void exec.start(model.jobs[a.job!], ctx);
      if (a.kind === 'stop') await exec.stop(a.job!);
      if (a.kind === 'finishRun') return report(a.runStatus!, sink);
    }
    await exec.nextEvent();   // local stand-in for waitForTaskToken
  }
}

// DockerExecutor.start, roughly:
//   docker run --rm <image> \
//     -v <srcCopy>:/workspace -v <artifactsDir>:/artifacts -v <cacheDir>:/cache \
//     [--privileged? no: -v /var/run/docker.sock:… + warning] \
//     --env-file <resolved secrets + synthesized MILLWRIGHT_* context> \
//     sh -c "<generated step script with the SAME step shim, shim → StateSink>"
// The step script is the same one synth emits for CodeBuild's buildspec, with
// upload/download steps rewired from S3 to /artifacts by the executor.
