import { describe, expect, it } from 'vitest';
import { renderRunExecutorDefinition } from '../src';

const ARNS = {
  deciderFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:mw-decider',
  synthFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:mw-synth',
  postSynthFunctionArn: 'arn:aws:lambda:eu-west-1:123456789012:function:mw-post-synth',
  stateMachineArn: 'arn:aws:states:eu-west-1:123456789012:stateMachine:mw-run-executor',
};

type State = Record<string, any>;

function states(): Record<string, State> {
  return (renderRunExecutorDefinition(ARNS) as any).States;
}

describe('run executor definition — decider loop token protocol (spec §7.3)', () => {
  it('Decide is a waitForTaskToken invoke carrying the token, 60 s timeout, no heartbeat', () => {
    const decide = states().Decide;
    expect(decide.Resource).toBe('arn:aws:states:::lambda:invoke.waitForTaskToken');
    expect(decide.Parameters.FunctionName).toBe(ARNS.deciderFunctionArn);
    expect(decide.Parameters.Payload['taskToken.$']).toBe('$$.Task.Token');
    expect(decide.Parameters.Payload['executionName.$']).toBe('$$.Execution.Name');
    expect(decide.TimeoutSeconds).toBe(60);
    expect(decide.HeartbeatSeconds).toBeUndefined();
  });

  it('no state anywhere carries HeartbeatSeconds — no heartbeat sender exists', () => {
    for (const [name, state] of Object.entries(states())) {
      expect(state.HeartbeatSeconds, `state ${name}`).toBeUndefined();
    }
  });

  it('catches States.Timeout back into the decider, preserving the loop payload', () => {
    const decide = states().Decide;
    const timeoutCatch = decide.Catch.find((c: State) => c.ErrorEquals[0] === 'States.Timeout');
    expect(timeoutCatch).toEqual({
      ErrorEquals: ['States.Timeout'],
      ResultPath: null,
      Next: 'NextIteration',
    });
  });

  it('never retries States.Timeout — the timeout IS the reconciliation wake', () => {
    for (const rule of states().Decide.Retry) {
      expect(rule.ErrorEquals).not.toContain('States.Timeout');
      expect(rule.ErrorEquals).not.toContain('States.ALL');
    }
  });

  it('bumps the iteration counter and re-enters the decider on the loop path', () => {
    const next = states().NextIteration;
    expect(next.Type).toBe('Pass');
    expect(next.Parameters['iteration.$']).toBe('States.MathAdd($.iteration, 1)');
    expect(next.Next).toBe('Decide');
    expect(states().InitLoop.Parameters.iteration).toBe(0);
  });

  it('routes wakes back into the loop and only terminal/carry-over out of it', () => {
    const route = states().RouteDecision;
    expect(route.Default).toBe('NextIteration');
    expect(route.Choices).toEqual([
      { Variable: '$.decision.outcome', StringEquals: 'terminal', Next: 'RouteTerminal' },
      { Variable: '$.decision.outcome', StringEquals: 'carry-over', Next: 'StartCarryOver' },
    ]);
  });

  it('maps terminal run states: SUCCEEDED and CANCELLED succeed, everything else fails', () => {
    const all = states();
    expect(all.RouteTerminal.Default).toBe('RunFailed');
    expect(all.RunSucceeded.Type).toBe('Succeed');
    expect(all.RunCancelled.Type).toBe('Succeed');
    expect(all.RunFailed.Type).toBe('Fail');
  });
});

describe('run executor definition — carry-over re-execution', () => {
  it('starts a fresh execution of the same machine under the decider-derived name', () => {
    const carryOver = states().StartCarryOver;
    expect(carryOver.Resource).toBe('arn:aws:states:::states:startExecution');
    expect(carryOver.Parameters.StateMachineArn).toBe(ARNS.stateMachineArn);
    expect(carryOver.Parameters['Name.$']).toBe('$.decision.carryOver.name');
    expect(carryOver.Parameters['Input.$']).toBe('$.decision.carryOver.input');
  });

  it('treats ExecutionAlreadyExists as carried over', () => {
    const carryOver = states().StartCarryOver;
    expect(carryOver.Catch).toEqual([
      {
        ErrorEquals: ['StepFunctions.ExecutionAlreadyExistsException'],
        ResultPath: '$.carryOverError',
        Next: 'CarriedOver',
      },
    ]);
    expect(states().CarriedOver.Type).toBe('Succeed');
  });

  it('resume executions skip synth straight into the loop', () => {
    const route = states().Route;
    expect(route.Default).toBe('Synth');
    expect(route.Choices).toContainEqual({
      And: [
        { Variable: '$.resume', IsPresent: true },
        { Variable: '$.resume', BooleanEquals: true },
      ],
      Next: 'InitLoop',
    });
  });
});

describe('run executor definition — synth phase', () => {
  it('runs synth as a bounded token wait, then the post-synth validation step', () => {
    const all = states();
    expect(all.Synth.Resource).toBe('arn:aws:states:::lambda:invoke.waitForTaskToken');
    expect(all.Synth.Parameters.FunctionName).toBe(ARNS.synthFunctionArn);
    expect(all.Synth.TimeoutSeconds).toBe(3600);
    expect(all.Synth.Next).toBe('PostSynth');
    expect(all.PostSynth.Resource).toBe('arn:aws:states:::lambda:invoke');
    expect(all.PostSynth.Parameters.FunctionName).toBe(ARNS.postSynthFunctionArn);
    expect(all.PostSynth.Next).toBe('IsSynthOnly');
  });

  it('synth-only executions stop after post-synth; runs continue into the loop', () => {
    const choice = states().IsSynthOnly;
    expect(choice.Choices).toEqual([
      { Variable: '$.action', StringEquals: 'synth-only', Next: 'SynthOnlyComplete' },
    ]);
    expect(choice.Default).toBe('InitLoop');
    expect(states().SynthOnlyComplete.Type).toBe('Succeed');
  });

  it('any synth or validation failure lands in a visible Fail state', () => {
    const all = states();
    for (const state of [all.Synth, all.PostSynth]) {
      expect(state.Catch.at(-1)).toMatchObject({ ErrorEquals: ['States.ALL'], Next: 'SynthFailed' });
    }
    expect(all.SynthFailed.Type).toBe('Fail');
  });

  it('every named Next/Catch target exists', () => {
    const all = states();
    const targets = Object.values(all).flatMap((state: State) => [
      ...(state.Next ? [state.Next] : []),
      ...(state.Default ? [state.Default] : []),
      ...(state.Choices ?? []).map((c: State) => c.Next),
      ...(state.Catch ?? []).map((c: State) => c.Next),
    ]);
    for (const target of targets) {
      expect(all[target], `missing state ${target}`).toBeDefined();
    }
  });
});
