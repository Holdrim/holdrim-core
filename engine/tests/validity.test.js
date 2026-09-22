/**
 * The traffic light. The case that matters most is RED: the block's text did not change, and yet
 * its validation stopped being trustworthy because the ground moved. No fingerprint of this block
 * denounces that — you have to keep what the dependencies were at the moment of the ✓.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateOf, trafficLight, dependentsOf } from '../core/validity.js';

const block = (id, fingerprint, dependsOn = []) => [id, { id, fingerprint, dependsOn }];

test('white: nobody has validated it yet', () => {
  const r = stateOf({ id: 'A.1.1', fingerprint: 'aaa' }, undefined, new Map());
  assert.equal(r.state, 'none');
});

test('green: validated and nothing changed', () => {
  const r = stateOf({ id: 'A.1.1', fingerprint: 'aaa' }, { fingerprint: 'aaa' }, new Map());
  assert.equal(r.state, 'valid');
});

test("yellow: the block's own text changed after the ✓", () => {
  const r = stateOf({ id: 'A.1.1', fingerprint: 'NEW' }, { fingerprint: 'aaa' }, new Map());
  assert.equal(r.state, 'stale');
  assert.match(r.why, /nobody approved the new text/);
});

test('RED: the text is unchanged, but the ground moved', () => {
  // This is the case that justifies the module existing. The block's fingerprint matches — it is
  // identical to what was approved. What moved was the rule it leans on.
  const now = new Map([['B.2.1', 'MOVED']]);
  const r = stateOf(
    { id: 'A.1.1', fingerprint: 'aaa', dependsOn: ['B.2.1'] },
    { fingerprint: 'aaa', dependsOn: { 'B.2.1': 'was-this' } },
    now,
  );
  assert.equal(r.state, 'broken');
  assert.deepEqual(r.blame, ['B.2.1']);
});

test('red when the dependency VANISHES, too', () => {
  // Pointing at a block that no longer exists is as broken as pointing at one that changed — and
  // easier to do, because deleting leaves no trace in the text of whoever depended on it.
  const r = stateOf(
    { id: 'A.1.1', fingerprint: 'aaa', dependsOn: ['GONE.1.1'] },
    { fingerprint: 'aaa', dependsOn: { 'GONE.1.1': 'existed' } },
    new Map(),
  );
  assert.equal(r.state, 'broken');
  assert.deepEqual(r.blame, ['GONE.1.1']);
});

test("yellow beats red: if the block's own text changed, that is the problem to fix", () => {
  // Order matters. Telling someone "the ground moved" when they also rewrote the text sends them
  // to the wrong place — you re-approve what is in front of your eyes first.
  const r = stateOf(
    { id: 'A.1.1', fingerprint: 'NEW', dependsOn: ['B.2.1'] },
    { fingerprint: 'aaa', dependsOn: { 'B.2.1': 'was-this' } },
    new Map([['B.2.1', 'MOVED']]),
  );
  assert.equal(r.state, 'stale');
});

test('the tally for the whole documentation', () => {
  const blocks = new Map([
    block('A.1.1', 'aaa'),                     // validated, intact  → green
    block('A.1.2', 'NEW'),                    // text changed       → yellow
    block('A.1.3', 'ccc', ['A.1.4']),          // ground moved       → red
    block('A.1.4', 'MOVED'),                   // never validated    → white
    block('A.1.5', 'eee'),                     // never validated    → white
  ]);
  const records = {
    'A.1.1': { fingerprint: 'aaa' },
    'A.1.2': { fingerprint: 'old' },
    'A.1.3': { fingerprint: 'ccc', dependsOn: { 'A.1.4': 'was-this' } },
  };
  const { tally, byBlock } = trafficLight(blocks, records);
  assert.deepEqual(tally, { none: 2, valid: 1, stale: 1, broken: 1 });
  assert.equal(byBlock.get('A.1.3').state, 'broken');
});

test('what depends on a block — the question people ask before editing', () => {
  const blocks = new Map([
    block('A.1.1', 'aaa'),
    block('A.2.1', 'bbb', ['A.1.1']),
    block('A.3.1', 'ccc', ['A.1.1', 'A.2.1']),
    block('A.4.1', 'ddd'),
  ]);
  assert.deepEqual(dependentsOf('A.1.1', blocks).sort(), ['A.2.1', 'A.3.1']);
  assert.deepEqual(dependentsOf('A.4.1', blocks), []);
});
