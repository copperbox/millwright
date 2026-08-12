/**
 * Interactive stdin prompts for the two moments the CLI needs a human:
 * pasting a PAT (input muted) and confirming a manual deploy-key add.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

/** Prompt without echoing the input — PATs never land in the scrollback. */
export function promptSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stderr.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

/** Block until the operator presses Enter. */
export function waitForOperator(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${message} `, () => {
      rl.close();
      resolve();
    });
  });
}
