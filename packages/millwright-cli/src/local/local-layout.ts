import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The gitignored `.millwright/` directory a local run lives in (spec §14):
 *
 *   .millwright/
 *     runs/local-<N>.json      run/job/step state — the local StateSink
 *     runs/local-<N>/          the run's data plane:
 *       in/  {model.json, source.tar.gz}   same names as the cloud run prefix
 *       out/ <job>/<artifact>/…            MILLWRIGHT_OUT_URI (a path locally)
 *       work/<job>/                        per-job working-tree copy (unpacked)
 *       events/<job>.jsonl                 shim step events (JSON lines)
 *       scripts/<job>.{sh,env}             rendered phases + env file
 *     cache/                    keyed dependency cache, shared across runs
 *     secrets.env               default local secrets file (operator-authored)
 *
 * Run ids are `local-N`, monotonic per clone, and never mix with cloud run
 * numbers — `runs list` never shows them.
 */

export const MILLWRIGHT_DIR = '.millwright';

export const LOCAL_RUN_ID_PATTERN = /^local-([1-9]\d*)$/;

export function isLocalRunId(text: string): boolean {
  return LOCAL_RUN_ID_PATTERN.test(text);
}

export function localRunNumber(id: string): number {
  const match = LOCAL_RUN_ID_PATTERN.exec(id);
  if (!match) {
    throw new Error(`not a local run id: "${id}"`);
  }
  return Number(match[1]);
}

export interface LocalRunPaths {
  readonly id: string;
  readonly stateFile: string;
  readonly runDir: string;
  readonly inDir: string;
  readonly outDir: string;
  readonly workDir: string;
  readonly eventsDir: string;
  readonly scriptsDir: string;
}

export interface LocalLayout {
  readonly root: string;
  readonly millwrightDir: string;
  readonly runsDir: string;
  readonly cacheDir: string;
  readonly defaultSecretsFile: string;
}

export function localLayout(root: string): LocalLayout {
  const millwrightDir = path.join(root, MILLWRIGHT_DIR);
  return {
    root,
    millwrightDir,
    runsDir: path.join(millwrightDir, 'runs'),
    cacheDir: path.join(millwrightDir, 'cache'),
    defaultSecretsFile: path.join(millwrightDir, 'secrets.env'),
  };
}

export function localRunPaths(layout: LocalLayout, id: string): LocalRunPaths {
  const runDir = path.join(layout.runsDir, id);
  return {
    id,
    stateFile: path.join(layout.runsDir, `${id}.json`),
    runDir,
    inDir: path.join(runDir, 'in'),
    outDir: path.join(runDir, 'out'),
    workDir: path.join(runDir, 'work'),
    eventsDir: path.join(runDir, 'events'),
    scriptsDir: path.join(runDir, 'scripts'),
  };
}

/** Run numbers already allocated in this clone, from the state files. */
export function listLocalRunNumbers(layout: LocalLayout): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(layout.runsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  const numbers: number[] = [];
  for (const entry of entries) {
    const match = /^local-([1-9]\d*)\.json$/.exec(entry);
    if (match) {
      numbers.push(Number(match[1]));
    }
  }
  return numbers.sort((a, b) => a - b);
}

/**
 * Create the `.millwright/` tree (self-gitignored — no repo .gitignore edit
 * needed) and allocate the next `local-N`, with its directories in place.
 */
export function allocateLocalRun(layout: LocalLayout): LocalRunPaths {
  fs.mkdirSync(layout.runsDir, { recursive: true });
  fs.mkdirSync(layout.cacheDir, { recursive: true });
  const gitignore = path.join(layout.millwrightDir, '.gitignore');
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, '*\n');
  }
  const numbers = listLocalRunNumbers(layout);
  const next = numbers.length === 0 ? 1 : numbers[numbers.length - 1] + 1;
  const paths = localRunPaths(layout, `local-${next}`);
  for (const dir of [paths.runDir, paths.inDir, paths.outDir, paths.workDir, paths.eventsDir, paths.scriptsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/**
 * Locate the clone root holding (or due to hold) `.millwright/`: the nearest
 * ancestor of `cwd` with a `.git` entry or an existing `.millwright/`;
 * falls back to `cwd` itself.
 */
export function findLocalRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, MILLWRIGHT_DIR)) || fs.existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.resolve(cwd);
    }
    dir = parent;
  }
}
