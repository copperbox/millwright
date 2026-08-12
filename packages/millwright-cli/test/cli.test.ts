import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src';

describe('buildProgram', () => {
  const program = buildProgram();
  const names = program.commands.map((command) => command.name());

  it('exposes the spec §15 setup & ops surface delivered so far', () => {
    expect(names).toContain('init');
    expect(names).toContain('setup');
    expect(names).toContain('repo');
    expect(names).toContain('doctor');
    expect(names).toContain('refresh-host-keys');
    expect(names).toContain('secrets');
  });

  it('exposes the spec §15 observability surface', () => {
    expect(names).toContain('logs');
    expect(names).toContain('runs');

    const runs = program.commands.find((command) => command.name() === 'runs')!;
    expect(runs.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['list', 'show']),
    );
    const list = runs.commands.find((command) => command.name() === 'list')!;
    expect(list.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--workflow', '--ref', '--status']),
    );

    const logs = program.commands.find((command) => command.name() === 'logs')!;
    expect(logs.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--follow', '--job', '--failed', '--full']),
    );
    expect(logs.options.find((option) => option.long === '--follow')!.short).toBe('-f');
  });

  it('secrets set takes --scope', () => {
    const secrets = program.commands.find((command) => command.name() === 'secrets')!;
    const set = secrets.commands.find((command) => command.name() === 'set')!;
    expect(set.options.map((option) => option.long)).toContain('--scope');
  });

  it('setup takes the --pat fallback and App-creation options', () => {
    const setup = program.commands.find((command) => command.name() === 'setup')!;
    const flags = setup.options.map((option) => option.long);
    expect(flags).toEqual(expect.arrayContaining(['--pat', '--org', '--app-name', '--force']));
  });

  it('repo add/update carry the spec flag set', () => {
    const repo = program.commands.find((command) => command.name() === 'repo')!;
    const subcommands = repo.commands.map((command) => command.name());
    expect(subcommands).toEqual(expect.arrayContaining(['add', 'update', 'list', 'remove']));

    const add = repo.commands.find((command) => command.name() === 'add')!;
    expect(add.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--secrets-refs', '--no-pr-polling', '--fork-prs', '--ecr-repos']),
    );
    const update = repo.commands.find((command) => command.name() === 'update')!;
    expect(update.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--secrets-refs', '--pr-polling', '--fork-prs', '--ecr-repos']),
    );
  });
});
