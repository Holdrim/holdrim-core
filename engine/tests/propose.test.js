/**
 * `holdrim propose-deps` — a deterministic, no-model proposal that two blocks sharing a glossary
 * term are worth linking, written as a `request` and nothing else.
 *
 * `proposalsOf` is pure (no fs, no events source) and is where every rule lives; `proposeDeps` is
 * the thin I/O shell around it, proved separately with a fake `Source` so a real project is not
 * needed to check that it writes exactly one `request` per new proposal and none for a pair already
 * covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalsOf, existingProposalMarkers, proposeDeps } from '../cli/propose.ts';

const EXAMPLE = new URL('../../examples/hello-world/', import.meta.url).pathname;

/** A block with just what `proposalsOf` reads. */
const block = (id, page, text, dependsOn = []) => [id, { id, page, kind: 'text', text, dependsOn, fingerprint: id }];

test('two blocks that share a glossary term, with no dependency either way, are proposed', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'The traffic light shows a lock.'),
    block('A.1.2', 'A', 'Only the owner\'s lock counts.'),
  ]);
  const proposals = proposalsOf(blocks, new Set());
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].a, 'A.1.1');
  assert.equal(proposals[0].b, 'A.1.2');
  assert.deepEqual(proposals[0].terms, ['lock']);
  assert.match(proposals[0].text, /Proposed dependency: A\.1\.1 ⇄ A\.1\.2/);
  assert.match(proposals[0].text, /"lock"/);
});

test('a pair that already declares data-depends, in EITHER direction, is not proposed', () => {
  const forward = new Map([
    block('A.1.1', 'A', 'mentions a lock', ['A.1.2']),
    block('A.1.2', 'A', 'mentions a lock too'),
  ]);
  assert.equal(proposalsOf(forward, new Set()).length, 0, 'A depends on B already');

  const backward = new Map([
    block('A.1.1', 'A', 'mentions a lock'),
    block('A.1.2', 'A', 'mentions a lock too', ['A.1.1']),
  ]);
  assert.equal(proposalsOf(backward, new Set()).length, 0, 'B depends on A already — the OTHER direction still counts');
});

test('two blocks with no glossary term in common are never proposed', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'a paragraph about nothing in particular'),
    block('A.1.2', 'A', 'another paragraph, also about nothing in particular'),
  ]);
  assert.deepEqual(proposalsOf(blocks, new Set()), []);
});

test('deterministic: the same blocks, read in the other insertion order, propose byte-for-byte the same thing', () => {
  const forward = new Map([
    block('A.1.1', 'A', 'a fingerprint locks the text'),
    block('A.1.2', 'A', 'the fingerprint is 16 characters'),
    block('B.1.1', 'B', 'a fingerprint again, for a third block'),
  ]);
  const backward = new Map([...forward.entries()].reverse());
  assert.deepEqual(proposalsOf(forward, new Set()), proposalsOf(backward, new Set()));
  // Stable order: A.1.1↔A.1.2 sorts before A.1.1↔B.1.1 sorts before A.1.2↔B.1.1.
  assert.deepEqual(proposalsOf(forward, new Set()).map((p) => `${p.a}~${p.b}`),
    ['A.1.1~A.1.2', 'A.1.1~B.1.1', 'A.1.2~B.1.1']);
});

test('a pair already proposed before is not proposed again — idempotent across runs', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'the owner holds the lock'),
    block('A.1.2', 'A', 'a lock is only the owner\'s'),
  ]);
  const first = proposalsOf(blocks, new Set());
  assert.equal(first.length, 1);
  const already = existingProposalMarkers([
    { type: 'request', data: { category: 'dependency' }, text: first[0].text },
  ]);
  assert.equal(proposalsOf(blocks, already).length, 0, 'the same pair does not come back a second run');
});

test('a rejected or applied proposal is still not proposed again — the DECISION, not the outcome, is what stops it', () => {
  // `existingProposalMarkers` reads every request with this category, whatever its state: a
  // proposal the owner already rejected must not come back just because nobody approved it.
  const blocks = new Map([block('A.1.1', 'A', 'a fingerprint'), block('A.1.2', 'A', 'another fingerprint')]);
  const marker = 'Proposed dependency: A.1.1 ⇄ A.1.2';
  const already = existingProposalMarkers([{ type: 'request', data: { category: 'dependency' }, text: `${marker} — rejected already` }]);
  assert.equal(proposalsOf(blocks, already).length, 0);
});

test('sharing more than one term produces ONE proposal, naming every shared term, not one per term', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'a lock and an event, both'),
    block('A.1.2', 'A', 'this block is about a lock and an event too'),
  ]);
  const proposals = proposalsOf(blocks, new Set());
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].terms, ['event', 'lock'], 'sorted, so the wording never depends on scan order');
});

test('proposalsOf never mutates the blocks it reads — a proposal is not a write', () => {
  const b = { id: 'A.1.1', page: 'A', kind: 'text', text: 'a lock', dependsOn: [], fingerprint: 'A.1.1' };
  const blocks = new Map([['A.1.1', b], ['A.1.2', { id: 'A.1.2', page: 'A', kind: 'text', text: 'another lock', dependsOn: [], fingerprint: 'A.1.2' }]]);
  proposalsOf(blocks, new Set());
  assert.deepEqual(b.dependsOn, [], 'still no data-depends — proposing is never writing one');
});

// ---------------------------------------------------------------- proposeDeps (the I/O shell)

test('proposeDeps writes exactly one request per new proposal, as category "dependency"', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const added = [];
  const source = { events: async () => [], add: async (e) => { added.push(e); return `req-${added.length}`; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  t.after(() => { console.log = log; });

  await proposeDeps(EXAMPLE, source);

  assert.ok(added.length > 0, 'hello-world has at least one pair sharing a glossary term');
  for (const e of added) {
    assert.equal(e.type, 'request');
    assert.equal(e.data.category, 'dependency');
    assert.match(e.text, /^Proposed dependency: /);
  }
  assert.ok(said.some((line) => line.startsWith('proposed:')));
});

test('proposeDeps proposes nothing new the second time it runs against the same events', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const written = [];
  const source = {
    events: async () => written,
    add: async (e) => { written.push({ type: 'request', page: e.page, block: e.block, text: e.text, data: e.data, author: 'agent@local', when: new Date().toISOString(), id: `req-${written.length}` }); return `req-${written.length}`; },
  };
  await proposeDeps(EXAMPLE, source);
  const afterFirst = written.length;
  assert.ok(afterFirst > 0);

  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(EXAMPLE, source);
  } finally {
    console.log = log;
  }
  assert.equal(written.length, afterFirst, 'nothing new got added the second run');
  assert.ok(said.some((line) => line.startsWith('no proposed dependency')));
});

test('--dry-run proposes nothing: it prints, and writes no request at all', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  let calls = 0;
  const source = { events: async () => [], add: async () => { calls++; return 'unused'; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(EXAMPLE, source, { dryRun: true });
  } finally {
    console.log = log;
  }
  assert.equal(calls, 0, 'dry-run never calls add');
  assert.ok(said.some((line) => line.startsWith('would propose:')));
});

test('end to end on examples/hello-world: the four blocks that share a term propose the pairs that make sense', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const source = { events: async () => [], add: async (e) => { void e; return 'req'; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(EXAMPLE, source);
  } finally {
    console.log = log;
  }
  const pairs = said.filter((l) => l.startsWith('proposed:')).map((l) => l.split('  (')[0]);
  assert.ok(pairs.some((l) => l.includes('A01.1.3') && l.includes('A01.1.4')), '"fingerprint" is shared by A01.1.3 and A01.1.4');
  assert.ok(pairs.some((l) => l.includes('A01.1.3') && l.includes('A02.1.2')), '"block" is shared by A01.1.3 and A02.1.2');
  assert.ok(pairs.some((l) => l.includes('A01.2.1') && l.includes('A02.1.2')), '"event" is shared by A01.2.1 and A02.1.2');
  assert.ok(pairs.some((l) => l.includes('A02.1.1') && l.includes('A02.1.2')), '"sheet" is shared by A02.1.1 and A02.1.2');
});
