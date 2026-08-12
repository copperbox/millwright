import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunModelJob } from '@copperbox/millwright-state';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import {
  loadLocalSecrets,
  missingSecrets,
  parseEnvFile,
  secretEnvForJob,
} from '../src/local/secrets-env';

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-secrets-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function job(secrets?: RunModelJob['secrets']): RunModelJob {
  return { name: 'publish', steps: [{ run: 'true' }], secrets };
}

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines, ignoring comments, blanks and quotes', () => {
    const values = parseEnvFile(
      ['# comment', '', 'NPM_TOKEN=abc123', "QUOTED='with spaces'", 'DOUBLE="x=y"', 'not a line'].join(
        '\n',
      ),
    );
    expect(values).toEqual({ NPM_TOKEN: 'abc123', QUOTED: 'with spaces', DOUBLE: 'x=y' });
  });

  it('keeps later duplicates and values containing =', () => {
    expect(parseEnvFile('A=1\nA=2\nURL=https://x?a=b')).toEqual({ A: '2', URL: 'https://x?a=b' });
  });
});

describe('loadLocalSecrets', () => {
  it('treats a missing default file as no secrets', () => {
    const source = loadLocalSecrets(undefined, path.join(tmp(), 'secrets.env'));
    expect(source.values).toEqual({});
    expect(source.path).toBeUndefined();
  });

  it('fails plainly when an explicit --secrets-file does not exist', () => {
    expect(() => loadLocalSecrets(path.join(tmp(), 'nope.env'), 'unused')).toThrow(CommandError);
  });

  it('reads the file it was pointed at', () => {
    const file = path.join(tmp(), 'mine.env');
    fs.writeFileSync(file, 'NPM_TOKEN=t\n');
    const source = loadLocalSecrets(file, 'unused');
    expect(source.values.NPM_TOKEN).toBe('t');
    expect(source.path).toBe(file);
  });
});

describe('missingSecrets', () => {
  it('names every declared secret the source cannot satisfy, with its ref kind', () => {
    const missing = missingSecrets(
      [
        job({
          NPM_TOKEN: { parameter: 'npm-token' },
          DOCKERHUB: { secretsManager: 'arn:aws:secretsmanager:…' },
        }),
      ],
      { values: { DOCKERHUB: 'present' } },
    );
    expect(missing).toEqual([
      { job: 'publish', env: 'NPM_TOKEN', ref: "Secret.named('npm-token')" },
    ]);
  });

  it('passes when everything resolves and skips reserved env names', () => {
    const jobs = [
      job({
        NPM_TOKEN: { parameter: 'npm-token' },
        MILLWRIGHT_EVIL: { parameter: 'nope' },
      }),
    ];
    expect(missingSecrets(jobs, { values: { NPM_TOKEN: 't' } })).toEqual([]);
  });
});

describe('secretEnvForJob', () => {
  it('returns only the declared, resolvable, non-reserved entries', () => {
    const env = secretEnvForJob(
      job({ NPM_TOKEN: { parameter: 'npm-token' }, AWS_SECRET_ACCESS_KEY: { parameter: 'x' } }),
      { values: { NPM_TOKEN: 't', UNRELATED: 'u', AWS_SECRET_ACCESS_KEY: 'k' } },
    );
    expect(env).toEqual({ NPM_TOKEN: 't' });
  });
});
