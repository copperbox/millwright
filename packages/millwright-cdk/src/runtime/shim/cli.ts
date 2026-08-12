import { MAX_STEP_INDEX } from '@copperbox/millwright-state';
import { StepSpec } from './shim';

/**
 * Argument parsing for the shim binary, whose invocation shape is authored
 * in ONE place — the shared buildspec renderer (`stepCommand` in
 * `@copperbox/millwright-state`):
 *
 *     millwright-shim step --index <n> [--name <name>] [--skip-if <cmd>] -- <command>
 *
 * The data-plane subcommands the renderer also emits (`source unpack`,
 * `artifact fetch/upload`, `cache restore/save`) belong to the artifacts and
 * caching issue; until it lands they parse to a distinct 'unimplemented'
 * result so a build fails with a versioned, greppable message instead of a
 * generic unknown-command error.
 */

/** Sysexits-style usage error — argv authored by the renderer never hits it. */
export const USAGE_EXIT_CODE = 64;
/** Exit for known-but-not-yet-delivered subcommands. */
export const UNIMPLEMENTED_EXIT_CODE = 69;

/** Renderer-authored subcommands not delivered by this issue. */
const UNIMPLEMENTED_COMMANDS = ['source', 'artifact', 'cache'] as const;

export type ParsedCli =
  | { readonly kind: 'step'; readonly spec: StepSpec }
  | { readonly kind: 'unimplemented'; readonly command: string }
  | { readonly kind: 'error'; readonly message: string };

export function parseCli(argv: readonly string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (!command) {
    return { kind: 'error', message: 'usage: millwright-shim step --index <n> [...] -- <command>' };
  }
  if ((UNIMPLEMENTED_COMMANDS as readonly string[]).includes(command)) {
    return { kind: 'unimplemented', command };
  }
  if (command !== 'step') {
    return { kind: 'error', message: `unknown subcommand "${command}"` };
  }

  let index: number | undefined;
  let name: string | undefined;
  let skipIf: string | undefined;
  let commandWords: string[] | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') {
      commandWords = rest.slice(i + 1);
      break;
    }
    if (arg === '--index' || arg === '--name' || arg === '--skip-if') {
      const value = rest[i + 1];
      if (value === undefined) {
        return { kind: 'error', message: `${arg} requires a value` };
      }
      i += 1;
      if (arg === '--index') {
        if (!/^\d+$/.test(value) || Number(value) > MAX_STEP_INDEX) {
          return {
            kind: 'error',
            message: `--index must be an integer in [0, ${MAX_STEP_INDEX}], got "${value}"`,
          };
        }
        index = Number(value);
      } else if (arg === '--name') {
        name = value;
      } else {
        skipIf = value;
      }
    } else {
      return { kind: 'error', message: `unknown flag "${arg}"` };
    }
  }

  if (index === undefined) {
    return { kind: 'error', message: 'step requires --index' };
  }
  if (commandWords === undefined || commandWords.length === 0) {
    return { kind: 'error', message: 'step requires a command after "--"' };
  }
  return {
    kind: 'step',
    spec: { index, name, skipIf, command: commandWords.join(' ') },
  };
}
