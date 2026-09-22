/**
 * The review panel's rules, without a browser.
 *
 * A panel proved only by opening a page and clicking can ship a traffic light that calls every
 * approval stale, with the suite green. So what decides a light — `engine/web/src/state.js` —
 * is tested here as plain functions, and the stylesheet is held to the classes the panel creates.
 *
 * What the panel does on a page — the buttons, what it sends, what it says when the API is down —
 * is proved in a real browser against a real server: `engine/test-browser.js`. A DOM imitation here
 * would prove the imitation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trafficLightOf, blockState, byWhen, day, foreignDependencies, summaryOf } from '../web/src/state.js';

// West of Greenwich, where `new Date('2026-09-22')` is already the 21st. Each test file runs in its
// own process, so this reaches no other suite.
process.env.TZ = 'America/Los_Angeles';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(ROOT + path, 'utf8');
const CYCLE = JSON.parse(read('engine/cycle.json'));

// ---------------------------------------------------------------- dates

test('byWhen says "equal" for two events at the same instant', () => {
  const a = { when: '2026-09-22T10:00:00.000Z' }, b = { when: '2026-09-22T10:00:00.000Z' };
  assert.equal(byWhen(a, b), 0);
  assert.ok(byWhen({ when: '2026-09-21' }, a) < 0);
});

test('a validation date is the day it says, west of Greenwich too', () => {
  assert.equal(new Date(2026, 8, 22).toLocaleDateString(), day('2026-09-22'));
  assert.equal(day('not a date'), '', 'no date prints nothing, never "Invalid Date"');
});

// ---------------------------------------------------------------- the React panel's rules

// `locks` is the server's word on whether this ✓ is the owner's: GET /api/events says it on every one.
const approvalOf = (fingerprint, locks = true) => ({ id: fingerprint, type: 'approval', block: 'X.1', fingerprint, locks });

test('an approval holds only for the text it approved', () => {
  const s = blockState([approvalOf('old'), approvalOf('new')], 'X.1', 'new');
  assert.equal(s.approved, true);
  assert.deepEqual(s.holding.map((e) => e.fingerprint), ['new']);
  assert.deepEqual(s.expired.map((e) => e.fingerprint), ['old']);
  assert.equal(blockState([approvalOf('old')], 'X.1', 'new').approved, false);
});

test('only the owner\'s ✓ turns a block green; an admin\'s is shown, and is not the lock', () => {
  const s = blockState([approvalOf('f', false)], 'X.1', 'f');
  assert.equal(s.approved, false, 'an admin\'s ✓ is an opinion');
  assert.deepEqual(s.seconded.map((e) => e.fingerprint), ['f']);
  assert.equal(trafficLightOf({ validated: null, fingerprint: 'f' }, s, new Map()).color, 'none');
  // Nor does an old one paint the block yellow: 🟡 says the LOCK's text changed.
  const old = blockState([approvalOf('old', false)], 'X.1', 'f');
  assert.deepEqual(old.expired, []);
  assert.equal(trafficLightOf({ validated: null, fingerprint: 'f' }, old, new Map()).color, 'none');
  // And the owner's, next to it, is the one that counts.
  const both = blockState([approvalOf('f', false), { ...approvalOf('f'), id: 'owner' }], 'X.1', 'f');
  assert.equal(both.approved, true);
  assert.deepEqual(both.holding.map((e) => e.id), ['owner']);
});

test('open requests are the ones still in someone\'s hands', () => {
  const request = (state) => ({ id: state, type: 'request', block: 'X.1', status: { state } });
  const s = blockState(['open', 'approved', 'applying', 'waiting', 'question', 'applied', 'rejected'].map(request), 'X.1', 'f');
  assert.deepEqual(s.open.map((r) => r.id), ['open', 'approved', 'applying', 'waiting', 'question']);
});

test('the history is the block\'s own story: triage moves live in the request\'s thread', () => {
  const s = blockState([
    { id: 'a', type: 'request', block: 'X.1' },
    { id: 'b', type: 'request_state', block: 'X.1', data: { request: 'a' } },
    { id: 'c', type: 'supplement', block: 'X.1', data: { request: 'a' } },
    { id: 'd', type: 'comment', block: 'X.1' },
  ], 'X.1', 'f');
  assert.deepEqual(s.history.map((e) => e.id), ['a', 'd']);
});

test('the traffic light: none, valid, stale from the repository, stale from the events, broken', () => {
  const now = new Map([['dep', 'd1']]);
  const nothing = blockState([], 'X.1', 'f');
  const approved = blockState([approvalOf('f')], 'X.1', 'f');
  const expired = blockState([approvalOf('old')], 'X.1', 'f');
  const block = (extra = {}) => ({ validated: null, fingerprint: 'f', ...extra });

  assert.equal(trafficLightOf(block(), nothing, now).color, 'none');
  assert.equal(trafficLightOf(block(), approved, now).color, 'valid');
  assert.equal(trafficLightOf(block({ validated: '2026-09-20', validatedFingerprint: 'f' }), nothing, now).color, 'valid');
  assert.equal(trafficLightOf(block({ validated: '2026-09-20', validatedFingerprint: 'other' }), nothing, now).color, 'stale',
    'the repository\'s ✓ was for another text');
  assert.equal(trafficLightOf(block({ validated: '2026-09-20' }), expired, now).color, 'stale');
  assert.deepEqual(trafficLightOf(block({ validated: '2026-09-20', dependedOn: { dep: 'd0' } }), nothing, now),
    { color: 'broken', culprits: ['dep'] });
  assert.equal(trafficLightOf(block({ validated: '2026-09-20', dependedOn: { dep: 'd1' } }), nothing, now).color, 'valid');
  assert.deepEqual(trafficLightOf(block({ validated: '2026-09-20', dependedOn: { gone: 'g' } }), nothing, now).culprits, ['gone'],
    'a dependency that vanished moved too');
});

// ---------------------------------------------------------------- panel.css

test('the tokens panel.css declares are base.css\'s values, so a page without base.css looks the same', () => {
  const tokens = (css) => new Map([...css.matchAll(/(--holdrim-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const panel = tokens(read('engine/web/panel.css'));
  const base = tokens(read('engine/web/base.css'));
  assert.ok(panel.size >= 10);
  for (const [name, value] of panel) assert.equal(value, base.get(name), name);
  const used = new Set([...read('engine/web/panel.css').matchAll(/var\((--holdrim-[a-z0-9-]+)\)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(panel.has(name), `${name} is used but not declared in panel.css`);
});

test('every class the panel creates has a rule in panel.css, and every rule a class', () => {
  const css = read('engine/web/panel.css');
  const js = ['engine/web/src/entry.jsx', 'engine/web/src/Panel.jsx'].map(read).join('\n');
  // Two classes are hooks with no look of their own: they tell a project's stylesheet which
  // history line is which. Listed here so that a NEW unstyled class still fails, and has to be
  // added on purpose.
  const hooks = new Set(['rv-h--approval', 'rv-h--request']);
  const created = new Set([...js.matchAll(/\brv-[a-z]+(?:-[a-z]+)*(?:--[a-z]+)?/g)].map((m) => m[0])
    .filter((c) => !c.endsWith('-')));
  for (const c of created) {
    if (!hooks.has(c)) assert.match(css, new RegExp(`\\.${c}(?![a-z-])`), `.${c} has no rule`);
  }
  // `rv-state--` is completed with a state at run time, so each state is checked by name.
  const states = Object.keys(CYCLE.states).filter((s) => s !== 'open');
  for (const state of states) {
    assert.match(css, new RegExp(`\\.rv-state--${state}\\b`), `.${state} has no colour`);
  }
  // And the other way: a rule for a class nothing creates is a rule for a panel that is gone.
  const styled = new Set([...css.matchAll(/\.(rv-[a-z-]+)/g)].map((m) => m[1]));
  const dynamic = new Set(states.map((s) => `rv-state--${s}`));
  for (const c of styled) assert.ok(created.has(c) || dynamic.has(c), `.${c} is styled, and nothing creates it`);
});

test('a dependency on another page is asked of the server, once, and judged by its answer', () => {
  const blocks = [
    { id: 'R03.1.2', dependedOn: { 'R02.1.3': 'f-then' } },
    { id: 'R03.1.3', dependedOn: { 'R02.2.1': 'f-old', 'R03.1.2': 'f-here' } },
    { id: 'R03.1.4', dependedOn: { 'R02.1.3': 'f-then' } },
  ];
  assert.deepEqual(foreignDependencies(blocks), ['R02.1.3', 'R02.2.1'],
    'only what is not on this page, each once, in a stable order');

  // What the server said about those two, next to what the browser computed for its own blocks.
  const now = new Map([['R02.1.3', 'f-then'], ['R02.2.1', 'f-new'], ['R03.1.2', 'f-here']]);
  const approved = { approved: true, expired: [] };
  const block = (dependedOn) => ({ validated: '2026-09-20', fingerprint: 'x', validatedFingerprint: 'x', dependedOn });
  assert.equal(trafficLightOf(block({ 'R02.1.3': 'f-then' }), approved, now).color, 'valid',
    'unchanged on another page is unchanged: it must not be painted red for not being on this one');
  assert.deepEqual(trafficLightOf(block({ 'R02.2.1': 'f-old' }), approved, now),
    { color: 'broken', culprits: ['R02.2.1'] });
  assert.equal(trafficLightOf(block({ 'R99.1.1': 'f' }), approved, now).color, 'broken',
    'a dependency nobody can find any more is broken, as the CLI says');
});

test('a block is named by its first words, cut at a word, and says when it was cut', () => {
  assert.equal(summaryOf('  Short\n  and   whole. '), 'Short and whole.');
  const long = 'Returns are counted on the day they happen, which is why the return period decides everything';
  assert.equal(summaryOf(long, 60), 'Returns are counted on the day they happen, which is why the…');
  assert.equal(summaryOf('exactly ten', 11), 'exactly ten', 'a text that fits is not cut');
  assert.equal(summaryOf('one two three', 7), 'one two…', 'a cut that lands on a space keeps the word before it');
});

test('the panel names no language: which ones exist is the locales folder\'s to say', () => {
  // Only the fallback is bundled; the rest are fetched from the folder the server reads. A second
  // dictionary imported here is a list of languages the folder no longer governs.
  const source = read('engine/web/src/i18n.js');
  const imported = [...source.matchAll(/from '[^']*locales\/([^']+)\.json'/g)].map((m) => m[1]);
  assert.deepEqual(imported, ['en']);
});

test('every sentence the panel asks for exists in every dictionary', () => {
  // A key the panel asks for and a dictionary lacks shows on screen as `panel.something` — only in
  // that language, and only to the reader who happens to speak it. Read from the source, so a new
  // `t('…')` is held to this without anyone remembering to list it.
  const source = ['engine/web/src/Panel.jsx', 'engine/web/src/entry.jsx'].map(read).join('\n');
  // Every `t('…')`, and every quoted `'panel.…'` — a key kept in a table and translated later, as
  // the history's verbs are, is a key too.
  const keys = [...new Set([...source.matchAll(/\bt\('([\w.]+)'|'(panel\.[\w.]+)'/g)].map((m) => m[1] ?? m[2]))];
  assert.ok(keys.length >= 30, `only ${keys.length} keys found: the scan is not reading the panel`);
  // The two built from a value: every state and every category the cycle has.
  keys.push(...Object.keys(CYCLE.states).map((s) => `cycle.${s}`),
    ...Object.keys(CYCLE.request_categories).map((c) => `cycle.category.${c}`));
  for (const lang of ['en', 'pt-BR', 'es']) {
    const dictionary = JSON.parse(read(`engine/locales/${lang}.json`));
    const missing = keys.filter((k) => typeof dictionary[k] !== 'string');
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});
