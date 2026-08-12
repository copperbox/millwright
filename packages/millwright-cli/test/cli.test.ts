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
