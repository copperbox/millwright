/** A typed input on a manually dispatched workflow. */
export type ManualInput =
  | { readonly choices: readonly string[]; readonly default?: string }
  | { readonly type: 'boolean'; readonly default?: boolean };

export interface PushTriggerOptions {
  /** Branch names or globs; omit to match every branch. */
  readonly branches?: readonly string[];
}

export interface TagTriggerOptions {
  /** Tag glob, e.g. `v*`. */
  readonly pattern: string;
}

export interface ManualTriggerOptions {
  readonly inputs?: Record<string, ManualInput>;
}

export type TriggerKind = 'push' | 'tag' | 'pull_request' | 'cron' | 'manual';

/**
 * What starts a workflow. Push/tag ride the git-protocol tier; pull_request
 * rides best-effort REST polling; cron fires at poll cadence; manual dispatch
 * always carries a ref.
 */
export class Trigger {
  static push(options: PushTriggerOptions = {}): Trigger {
    return new Trigger('push', { branches: options.branches });
  }

  static tag(options: TagTriggerOptions): Trigger {
    if (!options?.pattern) {
      throw new Error('Trigger.tag requires a pattern, e.g. Trigger.tag({ pattern: "v*" })');
    }
    return new Trigger('tag', { pattern: options.pattern });
  }

  static pullRequest(): Trigger {
    return new Trigger('pull_request', {});
  }

  /** Cron expression evaluated in UTC; granularity degrades to the deployment's poll cadence. */
  static cron(expression: string): Trigger {
    if (!expression || !expression.trim()) {
      throw new Error('Trigger.cron requires a non-empty cron expression');
    }
    return new Trigger('cron', { expression });
  }

  static manual(options: ManualTriggerOptions = {}): Trigger {
    return new Trigger('manual', { inputs: options.inputs ?? {} });
  }

  private constructor(
    readonly kind: TriggerKind,
    readonly config: Record<string, unknown>,
  ) {}
}
