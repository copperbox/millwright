import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import cdkPkg from '../package.json';
import { ShimAssets, stageShimDelivery } from '../src';

const sh = promisify(execFile);

describe('stageShimDelivery', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shim-stage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stages the dispatcher and the single-file bundle', async () => {
    stageShimDelivery(dir);
    expect(existsSync(join(dir, 'millwright-shim'))).toBe(true);
    expect(existsSync(join(dir, 'millwright-shim.cjs'))).toBe(true);
    const dispatcher = await readFile(join(dir, 'millwright-shim'), 'utf8');
    expect(dispatcher.startsWith('#!/bin/sh')).toBe(true);
    // Never a stray SEA scratch file — everything staged is delivered.
    expect(existsSync(join(dir, 'sea-config.json'))).toBe(false);
    expect(existsSync(join(dir, 'sea-blob.blob'))).toBe(false);
  });

  it('the staged delivery runs a step end to end through sh (spec §11.2 invocation)', async () => {
    stageShimDelivery(dir);
    const eventsPath = join(dir, 'events.jsonl');
    // The exact fragment shape the buildspec renderer authors, exec-bit-free
    // like an S3 materialization.
    const result = await sh(
      'sh',
      [join(dir, 'millwright-shim'), 'step', '--index', '0', '--name', 'greet', '--', 'echo hi'],
      {
        env: {
          ...process.env,
          MILLWRIGHT_RUN_ID: 'octo/app#ci#7',
          MILLWRIGHT_JOB: 'build',
          MILLWRIGHT_STEP_EVENTS_FILE: eventsPath,
        },
      },
    );
    expect(result.stdout).toContain('hi');
    const events = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((e) => e.detail.status)).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(events[0].source).toBe('millwright.step');
  });

  it('skipIf through the staged delivery: SKIPPED, exit 0', async () => {
    stageShimDelivery(dir);
    const eventsPath = join(dir, 'events.jsonl');
    await sh(
      'sh',
      [join(dir, 'millwright-shim'), 'step', '--index', '1', '--skip-if', 'true', '--', 'exit 9'],
      {
        env: {
          ...process.env,
          MILLWRIGHT_RUN_ID: 'octo/app#ci#7',
          MILLWRIGHT_JOB: 'build',
          MILLWRIGHT_STEP_EVENTS_FILE: eventsPath,
        },
      },
    );
    const events = (await readFile(eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ status: 'SKIPPED', reason: 'skip_if' });
  });
});

describe('release build', () => {
  it('the package build script produces the SEA shim delivery', () => {
    // The documented release recipe runs `npm run build` and nothing else
    // before publishing — if build does not invoke build:shim, published
    // packages ship without dist/shim and every npm-installed deployment
    // degrades to the node-on-PATH fallback.
    expect(cdkPkg.scripts.build).toContain('npm run build:shim');
  });
});

describe('shim assets construct (C13)', () => {
  it('deploys the staged delivery to the artifact bucket under control/shim/', () => {
    const stack = new Stack(new App(), 'Test');
    new ShimAssets(stack, 'ShimAssets', {
      deploymentName: 'ci',
      artifactBucket: new s3.Bucket(stack, 'Artifacts'),
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketKeyPrefix: 'control/shim/',
    });
  });
});
