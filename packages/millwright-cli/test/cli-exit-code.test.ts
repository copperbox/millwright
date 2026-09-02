import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli';
import { localRun } from '../src/local/local-run';

// `run` needs docker, git, and a delivered step shim; the exit-code contract
// under test only needs the action to see a run outcome.
vi.mock('../src/local/local-run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/local/local-run')>()),
  localRun: vi.fn(),
}));
vi.mock('../src/local/shim-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/local/shim-delivery')>()),
  resolveShimDir: () => path.join(os.tmpdir(), 'millwright-shim-unused'),
}));

const DEFINITION = `
import { Trigger, Workflow, WorkflowSet } from '@copperbox/millwright-workflows';

const app = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });
const ci = new Workflow(app, 'ci', { on: [Trigger.push({ branches: ['main'] })] });
ci.job('build', { steps: ['npm test'] });

export default app;
`;

const tmpdirs: string[] = [];
let stderr = '';
let restoreStderr: () => void;

function fixture(definition: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-exit-'));
  tmpdirs.push(dir);
  fs.mkdirSync(path.join(dir, 'millwright'));
  fs.writeFileSync(path.join(dir, 'millwright', 'workflows.ts'), definition);
  return path.join(dir, 'millwright', 'workflows.ts');
}

function synth(entry: string): Promise<number> {
  return main([
    'node',
    'millwright',
    'synth',
    '--entry',
    entry,
    '--repo',
    'copperbox/example',
    '--commit',
    'deadbeef',
    '--out',
    '/dev/null',
  ]);
}

beforeEach(() => {
  process.exitCode = undefined;
  stderr = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  restoreStderr = () => spy.mockRestore();
});

afterEach(() => {
  restoreStderr();
  process.exitCode = undefined;
  vi.mocked(localRun).mockReset();
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('main() exit codes', () => {
  it('synth resolves 0 for a valid definition', async () => {
    await expect(synth(fixture(DEFINITION))).resolves.toBe(0);
  });

  it('synth resolves 1 when the definition fails to synthesize', async () => {
    const broken = DEFINITION.replace(
      "new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' })",
      'new WorkflowSet()',
    );
    await expect(synth(fixture(broken))).resolves.toBe(1);
    expect(stderr).toContain('error[image-unresolved]');
    expect(stderr).toContain('no run model emitted');
  });

  it('synth resolves 1 when the definition throws while loading', async () => {
    await expect(synth(fixture("throw new Error('boom');\n"))).resolves.toBe(1);
    expect(stderr).toContain('boom');
  });

  it('run resolves 0 only when the local run SUCCEEDED', async () => {
    vi.mocked(localRun).mockResolvedValue({ id: 'local-1', status: 'SUCCEEDED', stateFile: '' });
    await expect(main(['node', 'millwright', 'run', 'ci'])).resolves.toBe(0);
    expect(localRun).toHaveBeenCalledTimes(1);
  });

  it.each(['FAILED', 'CANCELLED'] as const)('run resolves 1 when the local run %s', async (status) => {
    vi.mocked(localRun).mockResolvedValue({ id: 'local-1', status, stateFile: '' });
    await expect(main(['node', 'millwright', 'run', 'ci'])).resolves.toBe(1);
    expect(localRun).toHaveBeenCalledTimes(1);
  });
});
