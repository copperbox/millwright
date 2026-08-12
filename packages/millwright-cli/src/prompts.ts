/**
 * Interactive stdin prompts for the moments the CLI needs a human:
 * pasting a PAT (input muted), confirming a manual deploy-key add, and
 * answering a local run's typed-input questions.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';

/** Read one echoed line; the question goes to stderr like every prompt. */
export function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

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
