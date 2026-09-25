/**
 * Feature toggles (docs/ROLES.md, section 7).
 *
 * Two different claims are proved here, and they need different kinds of test:
 *
 *   1. `readFeatures`/`readConfig` behave the way an adopter's `holdrim.json` needs them to: today's
 *      behaviour with no `features` block at all, a closed list, boolean values only.
 *   2. NO TOGGLE CAN REACH A GUARD. That is a claim about the SHAPE of the source, not about any one
 *      input/output pair, so it is proved the way `engine/tests/roles-boundary.test.js` proves its
 *      own boundary: by reading the real files and checking that the guard code is exactly what it
 *      should be, with nothing from `features` anywhere near it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../core/config.js';
import { readFeatures, FEATURE_DEFAULTS, FEATURE_KEYS } from '../core/features.js';
import { CAPABILITIES } from '../core/roles.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const file = (o) => ({ readFile: () => JSON.stringify(o) });

// ============================================================================ readFeatures itself

test('with no "features" at all, every toggle is at its default — today\'s behaviour', () => {
  assert.deepEqual(readFeatures(undefined, '/p'), FEATURE_DEFAULTS);
});

test('a project overrides one toggle and keeps every other default', () => {
  const got = readFeatures({ bugCategory: false }, '/p');
  assert.equal(got.bugCategory, false);
  for (const key of FEATURE_KEYS) if (key !== 'bugCategory') assert.equal(got[key], FEATURE_DEFAULTS[key]);
});

test('every shipped toggle can be set explicitly, on or off', () => {
  const allOff = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false]));
  assert.deepEqual(readFeatures(allOff, '/p'), allOff);
  const allOn = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
  assert.deepEqual(readFeatures(allOn, '/p'), allOn);
});

test('an unknown feature key refuses to start, exactly as an unknown top-level key does', () => {
  assert.throws(() => readFeatures({ comments: true, telemetry: true }, '/p'),
    (e) => e instanceof Error && e.message.includes('/p/holdrim.json names "telemetry"')
      && e.message.includes(FEATURE_KEYS.join(', ')),
    'a misspelled toggle has to say so, and say what it should have been');
});

test('every unknown key is named, not only the first', () => {
  assert.throws(() => readFeatures({ voise: true, sketchpad: false }, '/p'),
    /names "voise", "sketchpad"/);
});

test('a value that is not a boolean refuses to start, like an invalid theme colour', () => {
  for (const bad of ['yes', 1, null, [], {}]) {
    assert.throws(() => readFeatures({ comments: bad }, '/p'),
      (e) => e instanceof Error && e.message.includes('"features.comments" must be true or false'),
      `comments: ${JSON.stringify(bad)} should have refused to start`);
  }
});

test('"features" itself has to be an object, not a list or a string', () => {
  for (const bad of [['comments'], 'comments', 42]) {
    assert.throws(() => readFeatures(bad, '/p'), /"features" must be an object of true\/false/);
  }
});

// ============================================================================ wired through readConfig

test('readConfig hands back today\'s defaults when the project sets no features', () => {
  const c = readConfig('/p', file({}));
  assert.deepEqual(c.features, FEATURE_DEFAULTS);
});

test('readConfig validates "features" the same way it validates the rest of the file', () => {
  assert.throws(() => readConfig('/p', file({ features: { notAToggle: true } })),
    /names "notAToggle" under "features"/);
});

test('a project can turn a built toggle off through holdrim.json', () => {
  const c = readConfig('/p', file({ features: { peopleScreen: false, graph: false } }));
  assert.equal(c.features.peopleScreen, false);
  assert.equal(c.features.graph, false);
  assert.equal(c.features.comments, true, 'untouched toggles keep their default');
});

// ============================================================================ the closed list itself

test('voice and sketch exist, closed and validated, off by default: not built yet', () => {
  assert.equal(FEATURE_DEFAULTS.voice, false);
  assert.equal(FEATURE_DEFAULTS.sketch, false);
  // Read as English, spelled the way the issue names them — not "Voice" or "voz".
  assert.ok(FEATURE_KEYS.includes('voice') && FEATURE_KEYS.includes('sketch'));
});

test('the first seven toggles are exactly the ones the issue names, no more, no fewer', () => {
  assert.deepEqual([...FEATURE_KEYS].sort(),
    ['bugCategory', 'comments', 'graph', 'pageRequests', 'peopleScreen', 'sketch', 'voice'].sort());
});

// ============================================================================ no toggle reaches a guard
//
// `docs/ROLES.md`: "A toggle never turns off a guard. Locks, the owner's powers, 'nothing is
// erased', the theme validation: none of these is a feature, and none gets a toggle." Reduced to
// something a test can check: engine/core/roles.js — the one file that decides every capability and
// the lock (`engine/tests/roles-boundary.test.js` proves nothing else may) — never reads `features`
// at all, and the account guards named by hand in AGENTS.md still read exactly as written, with
// nothing from a toggle wrapped around them.

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('engine/core/roles.js never mentions features: capabilities and the lock cannot be reached by a toggle', () => {
  const roles = read('engine/core/roles.js');
  assert.ok(!/feature/i.test(roles),
    'engine/core/roles.js mentions a feature — capabilities and the lock must come from identity ' +
    '(HOLDRIM_OWNER, HOLDRIM_ADMINS) alone, never from holdrim.json\'s features block');
});

/**
 * The exact guards `AGENTS.md` and `docs/ROLES.md` name by hand, verbatim from `engine/api/server.ts`
 * — the invariants a feature toggle must never be able to wrap. Matched as EXACT text, the same
 * technique `roles-boundary.test.js` uses for its `ALLOWED` list: a mutation that prefixes any of
 * these with `project.features.peopleScreen &&` (or anything else) changes the line, and this stops
 * finding it — which is the point, not a false negative to work around.
 */
const GUARDS = [
  // Nobody but the owner creates the owner's account.
  'if (roles.isOwner(address) && !roles.isOwner(email)) {',
  // Nobody but the owner resets the owner's password.
  'if (roles.isOwner(target) && target !== email) {',
  // The owner cannot be disabled, by anyone, including themselves.
  'if (!body.enabled && roles.isOwner(target)) {',
  // The people-management guard the four /users routes share.
  "const manages = () => roles.can('people', email);",
  // Only the owner's ✓ is the lock the repository trusts.
  "if (e.type === 'approval') return { ...e, locks: roles.can('lock', e.author) };",
  // Approving belongs to owner and admin, never to a toggle.
  "if (incoming.type === 'approval' && !roles.can('approve', email)) {",
];

test('the invariant guards stand exactly as written — no toggle wraps them', () => {
  const server = read('engine/api/server.ts');
  for (const guard of GUARDS) {
    assert.ok(server.includes(guard),
      `guard not found verbatim in engine/api/server.ts (moved, reworded, or now gated by a ` +
      `toggle?): ${guard}`);
  }
});

test('a feature key can never collide with, or be mistaken for, a capability', () => {
  assert.deepEqual(FEATURE_KEYS.filter((k) => CAPABILITIES.includes(k)), []);
});
