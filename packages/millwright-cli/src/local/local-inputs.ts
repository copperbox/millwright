import { DispatchInputValue } from '@copperbox/millwright-state';
import { ManualInputModel, ManualTriggerModel, WorkflowModel } from '@copperbox/millwright-workflows';
import { CommandError } from '../config-plane';

/**
 * Typed inputs for `millwright run` (spec §14): the same declarations a
 * cloud dispatch validates against, resolved locally — `--input k=v` for
 * non-interactive use, an interactive prompt for anything required that was
 * omitted. The synthesizer applies defaults and re-validates everything as
 * the dispatch path does; this module only gets the raw flags typed and the
 * gaps filled.
 */

/** Repeated `--input k=v` flags → a raw string map (first `=` splits). */
export function parseInputArgs(args: readonly string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const arg of args) {
    const separator = arg.indexOf('=');
    if (separator < 1) {
      throw new CommandError(`--input expects k=v, got "${arg}"`);
    }
    const name = arg.slice(0, separator);
    if (inputs[name] !== undefined) {
      throw new CommandError(`--input "${name}" was given more than once`);
    }
    inputs[name] = arg.slice(separator + 1);
  }
  return inputs;
}

/** The workflow's declared manual inputs, unioned across manual triggers. */
export function declaredManualInputs(
  workflow: WorkflowModel,
): Record<string, ManualInputModel> | undefined {
  let declared: Record<string, ManualInputModel> | undefined;
  for (const trigger of workflow.triggers) {
    if (trigger.kind === 'manual') {
      declared = { ...declared, ...(trigger as ManualTriggerModel).inputs };
    }
  }
  return declared;
}

function typeRawValue(
  name: string,
  raw: string,
  declared: ManualInputModel,
): DispatchInputValue {
  if (declared.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') {
      throw new CommandError(`--input ${name} must be true or false, got "${raw}"`);
    }
    return raw === 'true';
  }
  return raw;
}

export interface ResolveInputsOptions {
  readonly workflow: string;
  readonly raw: Readonly<Record<string, string>>;
  readonly declared: Readonly<Record<string, ManualInputModel>> | undefined;
  /** Absent means non-interactive: required-but-omitted inputs fail. */
  readonly promptLine?: (question: string) => Promise<string>;
}

/**
 * Type the `--input` flags against the declaration and prompt for required
 * choice inputs that were omitted (booleans and defaulted choices fall back
 * to their declared defaults downstream, exactly as a cloud dispatch does).
 * Choice values and unknown names are re-validated by the synthesizer.
 */
export async function resolveLocalInputs(
  options: ResolveInputsOptions,
): Promise<Record<string, DispatchInputValue>> {
  const declared = options.declared;
  if (!declared) {
    if (Object.keys(options.raw).length > 0) {
      throw new CommandError(
        `workflow "${options.workflow}" declares no Trigger.manual inputs — --input has nothing to bind to`,
      );
    }
    return {};
  }

  const values: Record<string, DispatchInputValue> = {};
  for (const [name, raw] of Object.entries(options.raw)) {
    const declaration = declared[name];
    if (!declaration) {
      throw new CommandError(
        `--input "${name}" is not declared on workflow "${options.workflow}" — declared inputs: ` +
          (Object.keys(declared).join(', ') || '(none)'),
      );
    }
    values[name] = typeRawValue(name, raw, declaration);
  }

  const required = Object.entries(declared).filter(
    ([name, input]) =>
      input.type === 'choice' && input.default === undefined && values[name] === undefined,
  );
  for (const [name, input] of required) {
    if (input.type !== 'choice') {
      continue;
    }
    if (!options.promptLine) {
      throw new CommandError(
        `input "${name}" has no default — pass --input ${name}=<${input.choices.join('|')}>`,
      );
    }
    const answer = (await options.promptLine(`? ${name} (${input.choices.join(' | ')}) › `)).trim();
    if (!input.choices.includes(answer)) {
      throw new CommandError(
        `input "${name}" must be one of ${input.choices.join(', ')}, got "${answer}"`,
      );
    }
    values[name] = answer;
  }
  return values;
}
