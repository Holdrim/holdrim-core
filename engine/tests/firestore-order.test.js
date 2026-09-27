/**
 * The order Firestore's events are read in (`byServerTime`, engine/api/firestore-order.ts), proved
 * with timestamps made up for it: a store test's appends mostly land inside one second, so only here
 * does crossing a second boundary happen every run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byServerTime } from '../api/firestore-order.ts';

const at = (seconds, nanoseconds) => ({ seconds, nanoseconds });
const order = (...times) => times.map((t, i) => ({ t, i })).sort((a, b) => byServerTime(a.t, b.t)).map((x) => x.i);

test('across a second boundary, the earlier second comes first, whatever the nanoseconds say', () => {
  assert.deepEqual(order(at(2, 100), at(1, 900)), [1, 0]);
  assert.ok(byServerTime(at(1, 900), at(2, 100)) < 0);
  assert.ok(byServerTime(at(2, 100), at(1, 900)) > 0);
});

test('within one second, the nanoseconds decide', () => {
  assert.deepEqual(order(at(5, 700), at(5, 200), at(5, 450)), [1, 2, 0]);
  assert.ok(byServerTime(at(5, 200), at(5, 700)) < 0);
});

test('the same instant is a tie, and a timestamp not stamped yet sorts first, without throwing', () => {
  assert.equal(byServerTime(at(3, 3), at(3, 3)), 0);
  assert.ok(byServerTime(undefined, at(0, 1)) < 0);
  assert.equal(byServerTime(undefined, undefined), 0);
});
