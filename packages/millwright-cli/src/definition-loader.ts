/**
 * Loads a repo's `millwright/workflows.ts` in-process: a CommonJS require
 * with a TypeScript transpile hook, no build step in the watched repo.
 *
 * The definition imports `@copperbox/millwright-workflows` — normally the
 * repo's own installed copy (whose version is exactly what the run-model
 * schemaVersion skew check governs). When the repo has not installed it
 * (fresh clone, no node_modules), resolution falls back to the modules the
 * caller provides, so `millwright synth` still works out of the box.
 */

import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';

export class DefinitionLoadError extends Error {}

export interface LoadOptions {
  /** Module objects used when normal resolution from the entry file fails. */
  readonly fallbackModules?: Readonly<Record<string, unknown>>;
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  resolveJsonModule: true,
};

interface ModuleInternals {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _extensions: Record<string, (module: { _compile(code: string, file: string): void }, file: string) => void>;
}

/**
 * Require `entryPath` (a `.ts` file) and return its default export — the
 * repo's `WorkflowSet`. Hooks are installed for the duration of the call and
 * restored afterwards.
 */
export function loadDefinition(entryPath: string, options: LoadOptions = {}): unknown {
  const resolved = path.resolve(entryPath);
  if (!fs.existsSync(resolved)) {
    throw new DefinitionLoadError(`No workflow definition at ${resolved}`);
  }

  const internals = Module as unknown as ModuleInternals;
  const previousLoad = internals._load;
  const previousTs = internals._extensions['.ts'];
  const fallbacks = options.fallbackModules ?? {};

  internals._load = function patchedLoad(request, parent, isMain): unknown {
    if (request in fallbacks) {
      try {
        return previousLoad.call(this, request, parent, isMain);
      } catch {
        return fallbacks[request];
      }
    }
    return previousLoad.call(this, request, parent, isMain);
  };
  internals._extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: COMPILER_OPTIONS, fileName: filename });
    module._compile(output.outputText, filename);
  };

  try {
    const requireFromEntry = Module.createRequire(resolved);
    delete requireFromEntry.cache[resolved];
    const loaded = requireFromEntry(resolved) as Record<string, unknown>;
    return loaded?.default ?? loaded;
  } catch (err) {
    if (err instanceof DefinitionLoadError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new DefinitionLoadError(`Failed to load ${resolved}: ${detail}`);
  } finally {
    internals._load = previousLoad;
    if (previousTs) {
      internals._extensions['.ts'] = previousTs;
    } else {
      delete internals._extensions['.ts'];
    }
  }
}
