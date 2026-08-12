/**
 * The run executor's ASL definition (spec C5, §7.3): one generic Standard
 * machine, deployed once, executing one run — synth job, post-synth
 * validation/registry step, then the decider loop with a caught-timeout
 * token wait. Rendered as plain data so tests can pin the protocol.
 *
 * Loop protocol (pinned):
 * - `Decide` invokes the decider with the state's task token; the decider
 *   writes it onto the Run item, acts, and either parks (waits for a wake)
 *   or completes its own token with `terminal` / `carry-over`.
 * - The wait carries `TimeoutSeconds` 60 with a `Catch` on `States.Timeout`
 *   back into the decider — the reconciliation safety net. NO state carries
 *   `HeartbeatSeconds`: no component sends SendTaskHeartbeat.
 * - Senders (build-events handler, CLI cancel) SendTaskSuccess
 *   `{"outcome":"wake"}` best-effort; anything but `terminal`/`carry-over`
 *   just re-enters the decider.
 * - Carry-over: the terminal state StartExecutions a fresh execution of the
 *   same machine under the decider-derived deterministic name, resuming
 *   from table state (`resume: true` skips synth).
 */

export interface RunExecutorDefinitionProps {
  readonly deciderFunctionArn: string;
  /** The synth-phase Lambda (pinned name, owned by the synth issue). */
  readonly synthFunctionArn: string;
  /** The post-synth validation/registry Lambda (pinned name, same issue). */
  readonly postSynthFunctionArn: string;
  /** This machine's own ARN — the carry-over StartExecution target. */
  readonly stateMachineArn: string;
  /** The decider-loop token wait; 60 s per spec §7.3. @default 60 */
  readonly wakeTimeoutSeconds?: number;
  /** Bound on the whole synth phase. @default 3600 */
  readonly synthTimeoutSeconds?: number;
}

/** Transient Lambda invocation failures, retried on every Lambda task. */
const LAMBDA_TRANSIENT_ERRORS = [
  'Lambda.ServiceException',
  'Lambda.AWSLambdaException',
  'Lambda.SdkClientException',
  'Lambda.TooManyRequestsException',
];

export function renderRunExecutorDefinition(
  props: RunExecutorDefinitionProps,
): Record<string, unknown> {
  const wakeTimeout = props.wakeTimeoutSeconds ?? 60;
  const synthTimeout = props.synthTimeoutSeconds ?? 3600;
  return {
    Comment:
      'millwright run executor: synth, post-synth validation/registry, then the decider loop ' +
      'with a caught-timeout token wait',
    StartAt: 'Route',
    States: {
      // Carry-over executions resume the loop directly: synth already
      // happened and the model, token and job state live in the table.
      Route: {
        Type: 'Choice',
        Choices: [
          { Variable: '$.action', StringEquals: 'synth-only', Next: 'Synth' },
          {
            And: [
              { Variable: '$.resume', IsPresent: true },
              { Variable: '$.resume', BooleanEquals: true },
            ],
            Next: 'InitLoop',
          },
        ],
        Default: 'Synth',
      },
      // The synth phase Lambda starts the synth build and completes this
      // token when it lands (contract pinned here; implementation owned by
      // the synth issue). SendTaskFailure or the phase timeout fails the
      // execution — a broken workflows.ts is always a visible failure.
      Synth: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
        Parameters: {
          FunctionName: props.synthFunctionArn,
          Payload: { 'taskToken.$': '$$.Task.Token', 'input.$': '$' },
        },
        TimeoutSeconds: synthTimeout,
        ResultPath: '$.synth',
        Retry: [
          {
            ErrorEquals: LAMBDA_TRANSIENT_ERRORS,
            IntervalSeconds: 2,
            BackoffRate: 2,
            MaxAttempts: 5,
          },
        ],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.synthError', Next: 'SynthFailed' }],
        Next: 'PostSynth',
      },
      // Control-plane side of the synth trust boundary (spec §7.2): read
      // model.json from S3, schema-validate, write the REG# entry, reconcile
      // job-role policy. Owned by the synth issue; invoked by name here.
      PostSynth: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke',
        Parameters: {
          FunctionName: props.postSynthFunctionArn,
          Payload: { 'input.$': '$' },
        },
        ResultPath: '$.postSynth',
        Retry: [
          {
            ErrorEquals: LAMBDA_TRANSIENT_ERRORS,
            IntervalSeconds: 2,
            BackoffRate: 2,
            MaxAttempts: 5,
          },
        ],
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.synthError', Next: 'SynthFailed' }],
        Next: 'IsSynthOnly',
      },
      IsSynthOnly: {
        Type: 'Choice',
        Choices: [
          { Variable: '$.action', StringEquals: 'synth-only', Next: 'SynthOnlyComplete' },
        ],
        Default: 'InitLoop',
      },
      SynthOnlyComplete: { Type: 'Succeed' },
      SynthFailed: {
        Type: 'Fail',
        Error: 'SynthFailed',
        Cause: 'The synth job or post-synth model validation failed',
      },
      // The loop payload is exactly { runId, iteration }; everything else
      // the decider needs lives in the table or the context object.
      InitLoop: {
        Type: 'Pass',
        Parameters: { 'runId.$': '$.runId', iteration: 0 },
        Next: 'Decide',
      },
      // Decide + token wait in one state: the decider receives the token,
      // writes it onto the Run item, and the machine parks here until a
      // sender completes it or the 60 s timeout fires. No HeartbeatSeconds.
      Decide: {
        Type: 'Task',
        Resource: 'arn:aws:states:::lambda:invoke.waitForTaskToken',
        Parameters: {
          FunctionName: props.deciderFunctionArn,
          Payload: {
            'taskToken.$': '$$.Task.Token',
            'runId.$': '$.runId',
            'iteration.$': '$.iteration',
            'executionName.$': '$$.Execution.Name',
          },
        },
        TimeoutSeconds: wakeTimeout,
        ResultPath: '$.decision',
        Retry: [
          {
            // Covers decider crashes and throttles; deliberately NOT
            // States.Timeout, which is the loop's normal wake path below.
            ErrorEquals: [...LAMBDA_TRANSIENT_ERRORS, 'States.TaskFailed'],
            IntervalSeconds: 2,
            BackoffRate: 2,
            MaxAttempts: 5,
          },
        ],
        Catch: [
          { ErrorEquals: ['States.Timeout'], ResultPath: null, Next: 'NextIteration' },
          { ErrorEquals: ['States.ALL'], ResultPath: '$.deciderError', Next: 'DeciderFailed' },
        ],
        Next: 'RouteDecision',
      },
      DeciderFailed: {
        Type: 'Fail',
        Error: 'DeciderFailed',
        Cause: 'The decider failed beyond its retry budget; the run row may still read RUNNING',
      },
      RouteDecision: {
        Type: 'Choice',
        Choices: [
          { Variable: '$.decision.outcome', StringEquals: 'terminal', Next: 'RouteTerminal' },
          { Variable: '$.decision.outcome', StringEquals: 'carry-over', Next: 'StartCarryOver' },
        ],
        // Wakes (and anything unrecognized) re-enter the decider.
        Default: 'NextIteration',
      },
      NextIteration: {
        Type: 'Pass',
        Parameters: {
          'runId.$': '$.runId',
          'iteration.$': 'States.MathAdd($.iteration, 1)',
        },
        Next: 'Decide',
      },
      RouteTerminal: {
        Type: 'Choice',
        Choices: [
          { Variable: '$.decision.runStatus', StringEquals: 'SUCCEEDED', Next: 'RunSucceeded' },
          { Variable: '$.decision.runStatus', StringEquals: 'CANCELLED', Next: 'RunCancelled' },
        ],
        Default: 'RunFailed',
      },
      RunSucceeded: { Type: 'Succeed' },
      // A cancelled run ended exactly as managed; only FAILED runs fail the
      // execution.
      RunCancelled: { Type: 'Succeed' },
      RunFailed: {
        Type: 'Fail',
        Error: 'RunFailed',
        Cause: 'The run finished FAILED (job failure, timeout, or run deadline)',
      },
      // The 25,000-event history cliff becomes a non-event: hand the loop to
      // a fresh execution under the decider's deterministic name. A repeated
      // start of an already-finished carry-over surfaces as
      // ExecutionAlreadyExists and still counts as carried over.
      StartCarryOver: {
        Type: 'Task',
        Resource: 'arn:aws:states:::states:startExecution',
        Parameters: {
          StateMachineArn: props.stateMachineArn,
          'Name.$': '$.decision.carryOver.name',
          'Input.$': '$.decision.carryOver.input',
        },
        ResultPath: '$.carryOver',
        Retry: [
          { ErrorEquals: ['States.TaskFailed'], IntervalSeconds: 2, BackoffRate: 2, MaxAttempts: 4 },
        ],
        Catch: [
          {
            ErrorEquals: ['StepFunctions.ExecutionAlreadyExistsException'],
            ResultPath: '$.carryOverError',
            Next: 'CarriedOver',
          },
        ],
        Next: 'CarriedOver',
      },
      CarriedOver: { Type: 'Succeed' },
    },
  };
}
