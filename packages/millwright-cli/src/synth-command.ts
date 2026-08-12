import * as millwrightWorkflows from '@copperbox/millwright-workflows';
import {
  SynthError,
  SynthOptions,
  WorkflowSet,
  formatDiagnostic,
  synthesize,
} from '@copperbox/millwright-workflows';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DefinitionLoadError, loadDefinition } from './definition-loader';
import { createHashFilesResolver } from './hash-files';

export const DEFAULT_ENTRY = path.join('millwright', 'workflows.ts');

export interface SynthCommandOptions {
  /** Directory of the watched repo checkout. @default process.cwd() */
  readonly cwd?: string;
  /** Definition entry point, relative to cwd. @default millwright/workflows.ts */
  readonly entry?: string;
  /** `owner/repo`; derived from the git remote "origin" when omitted. */
  readonly repo?: string;
  /** Commit sha; derived from git HEAD when omitted. */
  readonly commit?: string;
  /** Short name of the triggering ref (enables the secrets fail-fast lint). */
  readonly ref?: string;
  /** Write the model here instead of stdout. */
  readonly out?: string;
  /** The control plane's supported schemaVersion (cloud synth passes it). */
  readonly schemaCeiling?: number;
  /** Deployment poll cadence in minutes (enables the cron lint). */
  readonly pollCadence?: number;
  /** The repo's secretsAllowedRefs config, fail-fast UX only. */
  readonly secretsAllowedRefs?: readonly string[];
  readonly pretty?: boolean;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export class SynthCommandError extends Error {}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** `git@github.com:o/r.git`, `https://github.com/o/r.git`, `ssh://git@github.com/o/r` → `o/r`. */
export function repoFromRemoteUrl(url: string): string | undefined {
  const segments = url
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter((s) => s.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  const [owner, name] = segments.slice(-2);
  if (!owner || !name || owner.includes('@') || /^(https?|ssh|git)$/.test(owner)) {
    return undefined;
  }
  return `${owner}/${name}`;
}

function resolveIdentity(options: SynthCommandOptions, cwd: string): { repo: string; commit: string } {
  let repo = options.repo;
  if (!repo) {
    const url = git(cwd, ['remote', 'get-url', 'origin']);
    repo = url ? repoFromRemoteUrl(url) : undefined;
    if (!repo) {
      throw new SynthCommandError(
        'Cannot determine the repo identity: no --repo given and no parseable git remote ' +
          '"origin" here. Pass --repo <owner/name>.',
      );
    }
  }
  let commit = options.commit;
  if (!commit) {
    commit = git(cwd, ['rev-parse', 'HEAD']);
    if (!commit) {
      throw new SynthCommandError(
        'Cannot determine the commit: no --commit given and this is not a git checkout ' +
          'with a HEAD. Pass --commit <sha>.',
      );
    }
  }
  return { repo, commit };
}

/**
 * `millwright synth`: load the definition, compile it, emit the run model.
 * Returns the process exit code; diagnostics go to stderr, the model to
 * stdout (or --out).
 */
export function runSynthCommand(options: SynthCommandOptions = {}): number {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  try {
    const entry = path.resolve(cwd, options.entry ?? DEFAULT_ENTRY);
    const identity = resolveIdentity(options, cwd);
    const definition = loadDefinition(entry, {
      fallbackModules: { '@copperbox/millwright-workflows': millwrightWorkflows },
    });
    if (!(definition instanceof WorkflowSet) && !isWorkflowSetLike(definition)) {
      throw new SynthCommandError(
        `${path.relative(cwd, entry)} must default-export a WorkflowSet, got ` +
          `${definition === undefined ? 'no default export' : typeof definition}`,
      );
    }

    const synthOptions: SynthOptions = {
      ...identity,
      // Cache keys resolve at synth, against this checkout (spec §12).
      resolveHashFiles: createHashFilesResolver(cwd),
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
      ...(options.schemaCeiling !== undefined
        ? { controlPlaneSchemaVersion: options.schemaCeiling }
        : {}),
      ...(options.pollCadence !== undefined ? { pollCadenceMinutes: options.pollCadence } : {}),
      ...(options.secretsAllowedRefs !== undefined
        ? { secretsAllowedRefs: options.secretsAllowedRefs }
        : {}),
    };
    const { model, diagnostics } = synthesize(definition as WorkflowSet, synthOptions);
    for (const diagnostic of diagnostics) {
      stderr(`${formatDiagnostic(diagnostic)}\n`);
    }

    const json = JSON.stringify(model, null, options.pretty ? 2 : undefined);
    if (options.out) {
      const outPath = path.resolve(cwd, options.out);
      fs.writeFileSync(outPath, `${json}\n`);
      stderr(`Wrote run model to ${outPath}\n`);
    } else {
      stdout(`${json}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof SynthError) {
      for (const diagnostic of err.diagnostics) {
        stderr(`${formatDiagnostic(diagnostic)}\n`);
      }
      stderr('Synth failed; no run model emitted.\n');
      return 1;
    }
    if (err instanceof SynthCommandError || err instanceof DefinitionLoadError) {
      stderr(`millwright: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

/**
 * The definition may have been constructed by the repo's own installed copy
 * of the library — a different class identity than ours — so accept anything
 * with the WorkflowSet shape.
 */
function isWorkflowSetLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { workflows?: unknown }).workflows)
  );
}
