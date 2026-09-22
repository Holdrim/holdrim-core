/**
 * The HTTP contract is a shell script, and one shell idiom is banned from it.
 *
 * `curl … | grep -q` under `pipefail` fails at random: grep stops at the first match and closes the
 * pipe, curl's next write fails, and its error becomes the pipeline's status. It can pass on every
 * machine it is written on and still fail in CI, on a check whose answer is right. The contract
 * says why next to `has()`; this is what stops the idiom from coming back one line at a time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONTRACT = readFileSync(new URL('../test-contract.sh', import.meta.url), 'utf8');

test('the contract never pipes into grep -q, which races the writer under pipefail', () => {
  const lines = CONTRACT.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => !line.trimStart().startsWith('#') && /\|\s*grep\s+-[a-zA-Z]*q/.test(line));
  assert.deepEqual(lines.map(([n]) => n), [], 'use `| has …` instead: it reads the input to the end');
});
