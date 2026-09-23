/**
 * The showcase example keeps showing what it exists to show.
 *
 * `examples/cash-register` is the example put in front of someone who has never seen the method:
 * one rule changed and re-approved, and two rules written on top of the old one — one of them on
 * another page — red without a letter of them changing. A tidy-up that re-approves them, or an edit
 * that drops a dependency, would leave an example that is all green and proves nothing, with every
 * other test still passing. This one fails instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readBlocks } from '../cli/pages.ts';
import { loadRegistry, check } from '../cli/validation.ts';
import { trafficLight } from '../core/validity.js';

const ROOT = join(new URL('../../', import.meta.url).pathname, 'examples', 'cash-register');

test('the changed rule is approved, and exactly the two rules built on it are red', async () => {
  const { byBlock } = trafficLight(await readBlocks(ROOT), loadRegistry(ROOT));
  const red = [...byBlock].filter(([, r]) => r.state === 'broken').map(([id]) => id).sort();
  assert.deepEqual(red, ['R02.2.2', 'R03.1.3']);
  assert.equal(byBlock.get('R02.2.1').state, 'valid', 'the new return period itself was approved');
  for (const id of red) assert.deepEqual(byBlock.get(id).blame, ['R02.2.1']);
  assert.ok([...byBlock.values()].every((r) => r.state !== 'stale' && r.state !== 'none'),
    'nothing else is waiting: the red is the only thing to look at');
});

test('and the lock holds: the example commits clean, as a real project would', async () => {
  assert.equal(await check(ROOT), 0);
});
