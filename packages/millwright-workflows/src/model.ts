/**
 * The run model — the one JSON document `millwright synth` emits, and the
 * contract between definition, cloud orchestration, and the local runner.
 *
 * `model.json` is a named privilege boundary: it is authored inside the synth
 * job, which executes repo-controlled code, so the control plane
 * schema-validates it (see `validate.ts`) and treats every grant it requests
 * as attacker-influenceable. The `(triggers, concurrency)` map is extracted
 * into the per-ref registry by control-plane code after validation, never by
 * the synth job itself.
 */

import { ComputeArch, ComputeSize } from './values';

export interface RunModel {
  readonly schemaVersion: number;
  /** `owner/repo` identity of the watched repository. */
  readonly repo: string;
  /** Commit sha the definition was synthesized at. */
  readonly commit: string;
  readonly workflows: readonly WorkflowModel[];
}

export interface WorkflowModel {
  readonly name: string;
  readonly triggers: readonly TriggerModel[];
  readonly concurrency?: ConcurrencyModel;
  readonly jobs: readonly JobModel[];
}

export interface ConcurrencyModel {
  /** Static string with launcher-evaluable `${repo}`/`${ref}`/`${workflow}`/`${event}` tokens. */
  readonly group: string;
  readonly policy: 'queue' | 'supersede';
}

export type TriggerModel =
  | PushTriggerModel
  | TagTriggerModel
  | PullRequestTriggerModel
  | CronTriggerModel
  | ManualTriggerModel;

export interface PushTriggerModel {
  readonly kind: 'push';
  /** Branch names or globs; absent means every branch. */
  readonly branches?: readonly string[];
}

export interface TagTriggerModel {
  readonly kind: 'tag';
  readonly pattern: string;
}

export interface PullRequestTriggerModel {
  readonly kind: 'pull_request';
}

export interface CronTriggerModel {
  readonly kind: 'cron';
  /** Five-field cron expression, evaluated in UTC. */
  readonly expression: string;
}

export interface ManualTriggerModel {
  readonly kind: 'manual';
  readonly inputs: Readonly<Record<string, ManualInputModel>>;
}

export type ManualInputModel =
  | { readonly type: 'choice'; readonly choices: readonly string[]; readonly default?: string }
  | { readonly type: 'boolean'; readonly default?: boolean };

export interface JobModel {
  readonly name: string;
  /** Plain docker-run image string; already resolved through the job > Workflow > WorkflowSet cascade. */
  readonly image: string;
  readonly compute: ComputeModel;
  readonly privileged: boolean;
  readonly timeoutMinutes?: number;
  readonly steps: readonly StepModel[];
  /** Secret references keyed by the env var each lands in; omitted when none. */
  readonly secrets?: Readonly<Record<string, SecretModel>>;
  readonly produces?: readonly ArtifactModel[];
  readonly consumes?: readonly ArtifactRefModel[];
  /** Explicit artifact-less ordering; `consumes` edges are additional implicit dependencies. */
  readonly dependsOn: readonly string[];
  readonly cache?: CacheModel;
}

export interface ComputeModel {
  readonly arch: ComputeArch;
  readonly size: ComputeSize;
}

export interface StepModel {
  readonly run: string;
  /** Exit-0 condition → the step reports SKIPPED (reason: skip_if) and the job continues. */
  readonly skipIf?: string;
}

/**
 * One secret reference — the wire shape the decider and buildspec renderer
 * consume. `Secret.named` emits a parameter reference (scope defaults to the
 * run's repo downstream); `Secret.fromSecretsManager` a passthrough ARN.
 * Which refs actually receive grants is decided at dispatch (§12a) — nothing
 * here is trusted beyond naming what the job would like.
 */
export type SecretModel =
  | { readonly parameter: string; readonly scope?: string }
  | { readonly secretsManager: string };

/** One declared artifact: uploaded to `out/<job>/<name>/` after the steps. */
export interface ArtifactModel {
  readonly name: string;
  readonly paths: readonly string[];
}

/** Consumption edge: names the producing job and its declared artifact. */
export interface ArtifactRefModel {
  readonly job: string;
  readonly artifact: string;
}

/**
 * Keyed dependency cache (spec §12): GHA-style semantics. `key` is emitted
 * fully resolved — `hashFiles(...)` is evaluated at synth, where the checked-
 * out source is — and `restoreKeys` are prefix fallbacks tried in order on an
 * exact-key miss. An exact hit skips the save phase.
 */
export interface CacheModel {
  readonly key: string;
  readonly paths: readonly string[];
  readonly restoreKeys?: readonly string[];
}
