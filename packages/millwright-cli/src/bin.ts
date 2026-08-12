#!/usr/bin/env node
import { main } from './cli';

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`millwright: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
