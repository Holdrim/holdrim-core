/**
 * `holdrim propose-deps` — a deterministic, no-model proposal that two blocks sharing a term of the
 * PROJECT's own glossary (`content.glossary` in `holdrim.json`) are worth linking, written as a
 * `request` and nothing else.
 *
 * `proposalsOf` is pure (no fs, no events source) and is where every rule lives; `proposeDeps` is
 * the thin I/O shell around it, proved separately with a fake `Source` so a real project is not
 * needed to check that it writes exactly one `request` per new proposal and none for a pair already
 * covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposalsOf, existingProposalMarkers, proposeDeps } from '../cli/propose.ts';
import { readConfig } from '../core/config.js';

/** A block with just what `proposalsOf` reads. */
const block = (id, page, text, dependsOn = []) => [id, { id, page, kind: 'text', text, dependsOn, fingerprint: id }];

test('two blocks that share a glossary term, with no dependency either way, are proposed', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'The traffic light shows a lock.'),
    block('A.1.2', 'A', 'Only the owner\'s lock counts.'),
  ]);
  const proposals = proposalsOf(blocks, ['lock'], new Set());
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
  assert.equal(proposalsOf(forward, ['lock'], new Set()).length, 0, 'A depends on B already');

  const backward = new Map([
    block('A.1.1', 'A', 'mentions a lock'),
    block('A.1.2', 'A', 'mentions a lock too', ['A.1.1']),
  ]);
  assert.equal(proposalsOf(backward, ['lock'], new Set()).length, 0, 'B depends on A already — the OTHER direction still counts');
});

test('two blocks with no glossary term in common are never proposed', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'a paragraph about nothing in particular'),
    block('A.1.2', 'A', 'another paragraph, also about nothing in particular'),
  ]);
  assert.deepEqual(proposalsOf(blocks, ['lock', 'event'], new Set()), []);
});

test('an empty glossary proposes nothing, whatever the blocks say', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'a lock, an event, a fingerprint'),
    block('A.1.2', 'A', 'a lock, an event, a fingerprint too'),
  ]);
  assert.deepEqual(proposalsOf(blocks, [], new Set()), []);
});

test('deterministic: the same blocks, read in the other insertion order, propose byte-for-byte the same thing', () => {
  const forward = new Map([
    block('A.1.1', 'A', 'a fingerprint locks the text'),
    block('A.1.2', 'A', 'the fingerprint is 16 characters'),
    block('B.1.1', 'B', 'a fingerprint again, for a third block'),
  ]);
  const backward = new Map([...forward.entries()].reverse());
  const glossary = ['fingerprint'];
  assert.deepEqual(proposalsOf(forward, glossary, new Set()), proposalsOf(backward, glossary, new Set()));
  // Stable order: A.1.1↔A.1.2 sorts before A.1.1↔B.1.1 sorts before A.1.2↔B.1.1.
  assert.deepEqual(proposalsOf(forward, glossary, new Set()).map((p) => `${p.a}~${p.b}`),
    ['A.1.1~A.1.2', 'A.1.1~B.1.1', 'A.1.2~B.1.1']);
});

test('a pair already proposed before is not proposed again — idempotent across runs', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'the owner holds the lock'),
    block('A.1.2', 'A', 'a lock is only the owner\'s'),
  ]);
  const first = proposalsOf(blocks, ['lock'], new Set());
  assert.equal(first.length, 1);
  const already = existingProposalMarkers([
    { type: 'request', data: { category: 'dependency' }, text: first[0].text },
  ]);
  assert.equal(proposalsOf(blocks, ['lock'], already).length, 0, 'the same pair does not come back a second run');
});

test('a rejected or applied proposal is still not proposed again — the DECISION, not the outcome, is what stops it', () => {
  // `existingProposalMarkers` reads every request with this category, whatever its state: a
  // proposal the owner already rejected must not come back just because nobody approved it.
  const blocks = new Map([block('A.1.1', 'A', 'a fingerprint'), block('A.1.2', 'A', 'another fingerprint')]);
  const marker = 'Proposed dependency: A.1.1 ⇄ A.1.2';
  const already = existingProposalMarkers([{ type: 'request', data: { category: 'dependency' }, text: `${marker} — rejected already` }]);
  assert.equal(proposalsOf(blocks, ['fingerprint'], already).length, 0);
});

test('sharing more than one term produces ONE proposal, naming every shared term, not one per term', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'a lock and an event, both'),
    block('A.1.2', 'A', 'this block is about a lock and an event too'),
  ]);
  const proposals = proposalsOf(blocks, ['lock', 'event'], new Set());
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].terms, ['event', 'lock'], 'sorted, so the wording never depends on scan order');
});

test('proposalsOf never mutates the blocks it reads — a proposal is not a write', () => {
  const b = { id: 'A.1.1', page: 'A', kind: 'text', text: 'a lock', dependsOn: [], fingerprint: 'A.1.1' };
  const blocks = new Map([['A.1.1', b], ['A.1.2', { id: 'A.1.2', page: 'A', kind: 'text', text: 'another lock', dependsOn: [], fingerprint: 'A.1.2' }]]);
  proposalsOf(blocks, ['lock'], new Set());
  assert.deepEqual(b.dependsOn, [], 'still no data-depends — proposing is never writing one');
});

// ---------------------------------------------------------------- language: any, not just ASCII

test('a non-ASCII term matches, case-insensitively, on a Unicode word boundary', () => {
  const blocks = new Map([
    block('A.1.1', 'A', 'A transação foi registrada ontem.'),
    block('A.1.2', 'A', 'Toda TRANSAÇÃO precisa de aprovação.'),
  ]);
  const proposals = proposalsOf(blocks, ['transação'], new Set());
  assert.equal(proposals.length, 1, 'matched case-insensitively across both blocks');
  assert.deepEqual(proposals[0].terms, ['transação']);
});

test('a term that sits inside a longer word does not match', () => {
  // "ção" is the tail of "transação", never a word of its own here. A plain ASCII `\b` gets this
  // wrong in exactly this shape: `ç` is not a "word character" to `\b`, so it reads the letter
  // BEFORE `ç` ("a", a word character) and `ç` itself as a false word boundary, and would count
  // "ção" as matching right there. `\p{L}` treats `ç` as the letter it is, sees no boundary between
  // two adjacent letters, and correctly refuses the match.
  const blocks = new Map([
    block('A.1.1', 'A', 'a transação foi aprovada ontem'),
    block('A.1.2', 'A', 'outra transação foi registrada'),
  ]);
  assert.deepEqual(proposalsOf(blocks, ['ção'], new Set()), [],
    '"ção" is not a whole word inside "transação" in either block');
});

// ---------------------------------------------------------------- content.glossary, at config load

test('content.glossary is read as the project\'s own terms, defaulting to none', () => {
  const read = (file) => file.endsWith('holdrim.json')
    ? JSON.stringify({ content: { glossary: ['fingerprint', 'transação'] } }) : '';
  const config = readConfig('/p', { readFile: read });
  assert.deepEqual(config.glossary, ['fingerprint', 'transação']);
  const empty = readConfig('/p', { readFile: () => JSON.stringify({}) });
  assert.deepEqual(empty.glossary, []);
});

test('content.glossary refuses a term over 64 characters', () => {
  const long = 'x'.repeat(65);
  const read = () => JSON.stringify({ content: { glossary: [long] } });
  assert.throws(() => readConfig('/p', { readFile: read }), /content\.glossary\[0\]/);
});

test('content.glossary refuses a term with a control character', () => {
  const read = () => JSON.stringify({ content: { glossary: ['a\u0007b'] } });
  assert.throws(() => readConfig('/p', { readFile: read }), /control character/);
});

test('content.glossary refuses more than 1000 terms, and anything that is not an array of strings', () => {
  const tooMany = () => JSON.stringify({ content: { glossary: Array.from({ length: 1001 }, (_, i) => `t${i}`) } });
  assert.throws(() => readConfig('/p', { readFile: tooMany }), /1000/);
  const notArray = () => JSON.stringify({ content: { glossary: 'lock' } });
  assert.throws(() => readConfig('/p', { readFile: notArray }), /must be an array/);
  const notString = () => JSON.stringify({ content: { glossary: [42] } });
  assert.throws(() => readConfig('/p', { readFile: notString }), /content\.glossary\[0\]/);
});

// ---------------------------------------------------------------- proposeDeps (the I/O shell)

function project(t, glossary) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-propose-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'p', 'A.html'),
    '<main>' +
    '<div data-id="A.1.1" data-code="1.1">a fingerprint locks the text</div>' +
    '<div data-id="A.1.2" data-code="1.2">the fingerprint is 16 characters</div>' +
    '</main>');
  writeFileSync(join(dir, 'holdrim.json'),
    JSON.stringify({ content: { folders: ['p'], registry: 'r.json', glossary } }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('proposeDeps writes exactly one request per new proposal, as category "dependency"', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const root = project(t, ['fingerprint']);
  const added = [];
  const source = { events: async () => [], add: async (e) => { added.push(e); return `req-${added.length}`; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  t.after(() => { console.log = log; });

  await proposeDeps(root, source);

  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'request');
  assert.equal(added[0].data.category, 'dependency');
  assert.match(added[0].text, /^Proposed dependency: /);
  assert.ok(said.some((line) => line.startsWith('proposed:')));
});

test('with no glossary configured, propose-deps says so and proposes nothing', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const root = project(t, undefined);
  let calls = 0;
  const source = { events: async () => [], add: async () => { calls++; return 'unused'; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(root, source);
  } finally {
    console.log = log;
  }
  assert.equal(calls, 0, 'no glossary means nothing is even read for blocks to propose from');
  assert.ok(said.some((line) => line.startsWith('no glossary configured')));
});

test('proposeDeps proposes nothing new the second time it runs against the same events', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const root = project(t, ['fingerprint']);
  const written = [];
  const source = {
    events: async () => written,
    add: async (e) => { written.push({ type: 'request', page: e.page, block: e.block, text: e.text, data: e.data, author: 'agent@local', when: new Date().toISOString(), id: `req-${written.length}` }); return `req-${written.length}`; },
  };
  await proposeDeps(root, source);
  const afterFirst = written.length;
  assert.ok(afterFirst > 0);

  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(root, source);
  } finally {
    console.log = log;
  }
  assert.equal(written.length, afterFirst, 'nothing new got added the second run');
  assert.ok(said.some((line) => line.startsWith('no proposed dependency')));
});

test('--dry-run proposes nothing: it prints, and writes no request at all', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const root = project(t, ['fingerprint']);
  let calls = 0;
  const source = { events: async () => [], add: async () => { calls++; return 'unused'; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(root, source, { dryRun: true });
  } finally {
    console.log = log;
  }
  assert.equal(calls, 0, 'dry-run never calls add');
  assert.ok(said.some((line) => line.startsWith('would propose:')));
});

test('end to end on examples/hello-world: the project\'s own glossary proposes the pairs that make sense', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const EXAMPLE = new URL('../../examples/hello-world/', import.meta.url).pathname;
  const source = { events: async () => [], add: async (e) => { void e; return 'req'; } };
  const said = [];
  const log = console.log;
  console.log = (line) => said.push(line);
  try {
    await proposeDeps(EXAMPLE, source);
  } finally {
    console.log = log;
  }
  const pairs = said.filter((l) => l.startsWith('proposed:'));
  assert.ok(pairs.length > 0, 'examples/hello-world\'s own content.glossary should propose at least one pair');
});
