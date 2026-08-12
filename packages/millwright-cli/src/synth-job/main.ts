/**
 * Synth build entry point: the buildspec the synth Lambda renders runs
 * exactly `node synth-job.bundle.js`. The bundle (this file + every
 * dependency, esbuild single-file) ships in the published package's dist and
 * reaches the build as an S3 assets source (C13) — the synth tooling is
 * always the control plane's own version.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSynthCommand } from '../synth-command';
import { runSynthJob } from './synth-job';

function run(
  file: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> },
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      // Per-call vars (GIT_SSH_COMMAND) extend the build's environment.
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${file} ${args.join(' ')} exited ${code}`));
      }
    });
  });
}

async function main(): Promise<number> {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-synth-'));
  const bucket = process.env.MILLWRIGHT_DEST_BUCKET;
  const s3 = new S3Client({});
  try {
    return await runSynthJob({
      env: process.env,
      workdir,
      run,
      putObject: async (key, body) => {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      },
      synth: runSynthCommand,
      stderr: (text) => process.stderr.write(text),
    });
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`millwright synth job crashed: ${String(err)}\n`);
    process.exitCode = 1;
  },
);
