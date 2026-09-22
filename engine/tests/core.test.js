/** Tests for the shared core. They run with `node --test`, with no dependency at all.
 *
 *  The gold cases (engine/tests/cases/cycle-cases.json) are the fixed point of the request cycle.
 *  They exist because copies of a state machine drift: the same request shows as approved in one
 *  place and awaiting triage in another. The cases guard the single implementation against that
 *  drift. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCycle } from '../core/cycle.js';
import { fingerprintOfText, normalize, SIZE } from '../core/fingerprint.js';
import { overLimit, validCommit } from '../core/limits.js';

const root = new URL('../', import.meta.url);
const table = JSON.parse(readFileSync(new URL('cycle.json', root), 'utf8'));
const cycle = createCycle(table);
const gold = JSON.parse(readFileSync(new URL('tests/cases/cycle-cases.json', root), 'utf8'));

test('gold cases: the same history always gives the same state', () => {
  for (const theCase of gold.cases) {
    const events = [{ id: 'p1', type: 'request', when: '2026-09-18T10:00:00Z', data: null }];
    theCase.events.forEach((e, i) => {
      const data = { request: 'p1' };
      if (!e.supplement) { data.state = e.state; if (e.from) data.from = e.from; }
      events.push({ id: 'e' + i, type: e.supplement ? 'supplement' : 'request_state',
                    when: `2026-09-18T10:00:${String(i + 1).padStart(2, '0')}Z`, data });
    });
    assert.equal(cycle.currentState('p1', events, theCase.authorIsAdmin), theCase.expected, theCase.name);
  }
});

test('the gold cases only name states the table has', () => {
  // A case that names a state the table does not know would pass `currentState` by accident: the
  // reducer takes whatever `state` says. Checking the cases against the table is what makes a typo
  // in the cases a failure instead of a silently weaker proof.
  for (const theCase of gold.cases) {
    assert.ok(cycle.exists(theCase.expected), `${theCase.name}: expected "${theCase.expected}"`);
    for (const e of theCase.events) {
      if (e.state) assert.ok(cycle.exists(e.state), `${theCase.name}: state "${e.state}"`);
      if (e.from) assert.ok(cycle.exists(e.from), `${theCase.name}: from "${e.from}"`);
    }
  }
});

test('the whole transition table: 49 pairs, no exception', () => {
  const states = Object.keys(table.states);
  for (const from of states) {
    for (const to of states) {
      const expected = (table.transitions[from] ?? []).includes(to);
      assert.equal(cycle.canGo(from, to), expected, `${from} → ${to}`);
    }
  }
  assert.equal(states.length ** 2, 49, 'there are 7 states: 49 pairs');
});

test('no state goes to itself', () => {
  for (const s of Object.keys(table.states)) assert.equal(cycle.canGo(s, s), false, `${s} → ${s}`);
});

test('an unknown state goes nowhere', () => {
  assert.equal(cycle.canGo('made_up', 'approved'), false);
  assert.equal(cycle.canGo('open', 'made_up'), false);
});

test('approved offers no triage; open offers the three the owner has', () => {
  assert.deepEqual(cycle.status('approved').triage, []);
  assert.deepEqual(cycle.status('open').triage, ['approved', 'rejected', 'question']);
});

test('the status of a state says who owns it and what it demands', () => {
  const open = cycle.status('open');
  assert.equal(open.ownedBy, 'owner');
  assert.deepEqual(open.requiresReason, ['rejected', 'question']);
  assert.equal(open.acceptsSupplement, true);
  const applying = cycle.status('applying');
  assert.equal(applying.ownedBy, 'agent');
  assert.equal(applying.acceptsSupplement, false);
  assert.deepEqual(cycle.agentStates, ['applying', 'waiting', 'applied']);
  assert.deepEqual(cycle.ownerStates, ['open', 'approved', 'rejected', 'question']);
});

/**
 * A bug report is not a ticket here: it is a request against a block, like every other request, and
 * the category is the only thing that says which kind of disagreement it is (docs/BUGS.md). The
 * table and the dictionaries have to agree, and nothing but this test looks at them at once.
 */
test('every category is in the cycle, in every language, and rides an event', () => {
  assert.ok(table.request_categories.bug,
    'cycle.json is the source of the categories, and bug has to be one of them');

  // The label of EVERY category, in every dictionary. The parity check in i18n.test.js would catch
  // a key present in one and missing in another; it would NOT catch the key missing from all of
  // them, which is exactly how a new category ships untranslated.
  for (const [language, file] of [['en', '../locales/en.json'],
                                  ['pt-BR', '../locales/pt-BR.json'],
                                  ['es', '../locales/es.json']]) {
    const dictionary = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
    for (const category of Object.keys(table.request_categories)) {
      assert.ok(dictionary[`cycle.category.${category}`], `${language} has no label for ${category}`);
    }
  }

  // A request carrying a category has to fit the limits the API applies before recording, or the
  // request is refused with 400 and nobody knows why.
  const event = { type: 'request', page: 'D01', block: 'D01.1.1',
    text: 'the screen does not do what this block says', data: { category: 'bug' } };
  assert.equal(overLimit(event), null, 'a request carrying the bug category is within the limits');
});

test('an invalid table does not slip through', () => {
  assert.throws(() => createCycle({ states: {}, transitions: {} }), /no states or no transitions/);
  assert.throws(() => createCycle({ ...table, initial: 'does_not_exist' }), /initial state/);
  assert.throws(() => createCycle({ ...table, transitions: { open: ['ghost'] } }), /does not exist/);
});

test('fingerprint: spaces do not count, 16 characters, different text changes it', async () => {
  assert.equal(await fingerprintOfText('Hello   world'), await fingerprintOfText('Hello world'));
  assert.equal((await fingerprintOfText('x')).length, SIZE);
  assert.notEqual(await fingerprintOfText('a'), await fingerprintOfText('b'));
  assert.equal(normalize('  a   b  '), 'a b');
});

test('fingerprint: compatible with what is already validated', () => {
  // Every approval ever recorded names a fingerprint of this size and this definition. This test
  // holds the contract: change the definition of the fingerprint and every existing approval falls.
  assert.equal(SIZE, 16, 'changing the size invalidates the recorded approvals');
  // The first sixteen hex characters of SHA-256("a b"), computed independently. A normalisation
  // that stopped trimming, or a digest that stopped being SHA-256, changes this.
  return fingerprintOfText(' a  b ').then((fp) => assert.equal(fp, 'c8687a08aa5d6ed2'));
});

test('a data value that is an object does not cross the size limit', () => {
  // String({...}) gives "[object Object]": 15 characters. Without the type check, an object with
  // megabytes inside would sail past the 200-character ceiling without ever touching it.
  const huge = { filling: 'x'.repeat(500_000) };
  assert.equal(overLimit({ page: 'D01', data: { extra: huge } })?.key, 'limits.data.notScalar');
  assert.equal(overLimit({ page: 'D01', data: { extra: ['x'.repeat(500_000)] } })?.key, 'limits.data.notScalar');
  assert.equal(overLimit({ page: 'D01', data: { extra: 'normal value', n: 7, nothing: null } }), null);
});

test('limits: what comes in has a size and a shape', () => {
  assert.equal(overLimit({ page: 'UC-01', text: 'ok' }), null);
  // Without examples configured, the message is the one that does not promise any: a sentence
  // ending in "like " with nothing after it is worse than no example at all.
  assert.equal(overLimit({ page: '../etc' })?.key, 'limits.page.invalidNoExamples');
  assert.equal(overLimit({ page: '../etc' }, 'A01')?.key, 'limits.page.invalid');
  assert.equal(overLimit({ page: 'D01', text: 'x'.repeat(4001) })?.key, 'limits.text.tooLong');
  assert.equal(overLimit({ page: 'D01', block: 'D01 1' })?.key, 'limits.block.badChars');
  // The message says WHICH field blew up: "invalid" without saying where makes the reviewer try again in the dark.
  assert.equal(overLimit({ page: 'D01', snapshot: 'y'.repeat(20001) })?.key, 'limits.snapshot.tooLong');
  assert.equal(overLimit({ page: 'D01', block: 'b'.repeat(65) })?.key, 'limits.block.tooLong');
  assert.equal(overLimit({ page: 'D01', fingerprint: 'f'.repeat(65) })?.key, 'limits.fingerprint.tooLong');
  assert.equal(overLimit({ page: 'D01', data: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, 1])) })?.key,
    'limits.data.tooManyKeys');
  assert.equal(overLimit({ page: 'D01', data: { ['k'.repeat(41)]: 1 } })?.key, 'limits.data.keyTooLong');
  assert.equal(overLimit({ page: 'D01', data: { k: 'v'.repeat(201) } })?.key, 'limits.data.valueTooLong');
});

test('limits: every key it can return has a sentence in every language', () => {
  // The key is only half the message. A key with no sentence behind it reaches the reviewer as
  // `limits.data.keyTooLong`, which says nothing about what to fix.
  const source = readFileSync(new URL('core/limits.js', root), 'utf8');
  const keys = [...source.matchAll(/key: '(limits\.[^']+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 11, 'the keys are read out of the source, and there are at least eleven');
  for (const file of ['en', 'pt-BR', 'es']) {
    const dictionary = JSON.parse(readFileSync(new URL(`locales/${file}.json`, root), 'utf8'));
    for (const key of keys) assert.ok(dictionary[key], `${file} has no sentence for ${key}`);
  }
});

test('limits: applied without a real commit does not pass', () => {
  assert.equal(validCommit({ commit: 'abc1234' }), true);
  assert.equal(validCommit({ commit: 'done' }), false);
  assert.equal(validCommit({}), false);
  assert.equal(validCommit(null), false);
});

test('a request\'s thread gives the state the whole list gives, and nothing else is in it', () => {
  // Three requests on two pages, moves interleaved, and events that belong to no request.
  const at = (m) => `2026-09-22T10:${String(m).padStart(2, '0')}:00Z`;
  const ask = (id, page, m) => ({ id, type: 'request', page, author: 'r@x.org', when: at(m) });
  const move = (request, state, from, m) =>
    ({ id: `${request}-${m}`, type: 'request_state', page: 'X', author: 'o@x.org', when: at(m), data: { request, state, from } });
  const all = [
    ask('a', 'P1', 1), ask('b', 'P1', 2), ask('c', 'P2', 3),
    { id: 'n1', type: 'approval', page: 'P1', author: 'o@x.org', when: at(4) },
    move('a', 'approved', 'open', 5), move('b', 'rejected', 'open', 6), move('a', 'applying', 'approved', 7),
    { id: 's1', type: 'supplement', page: 'P1', author: 'r@x.org', when: at(8), data: { request: 'b' } },
    { id: 'n2', type: 'comment', page: 'P2', author: 'r@x.org', when: at(9), data: null },
  ];
  const threads = cycle.threadsOf(all);
  assert.deepEqual([...threads.keys()].sort(), ['a', 'b'], 'a request nobody moved has no thread');
  assert.deepEqual(threads.get('a').map((e) => e.id), ['a-5', 'a-7']);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(cycle.currentState(id, threads.get(id) ?? []), cycle.currentState(id, all), id);
  }
  assert.deepEqual(['a', 'b', 'c'].map((id) => cycle.currentState(id, threads.get(id) ?? [])),
    ['applying', 'open', 'open'], 'b went back to open on the supplement');
});
