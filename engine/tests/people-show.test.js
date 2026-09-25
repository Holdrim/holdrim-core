/**
 * `people.show`: how much of a person's identity a reader is sent (docs/ROLES.md, "How a person
 * appears"). Two different claims, proved separately, the way `features.test.js`'s own header
 * explains it does for `features`:
 *
 *   1. `readPeopleShow`/`readConfig` behave the way an adopter's `holdrim.json` needs: today's
 *      behaviour with no `people` block at all, a closed list, and a loud refusal for anything else.
 *   2. `personAs` computes the four cases, and the two overrides, correctly — the pure function every
 *      reader (the API, the home, the CLI) is meant to share, so this is the one place its logic is
 *      proved once rather than once per caller.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConfig } from '../core/config.js';
import { readPeopleShow, personAs, PEOPLE_SHOW_VALUES, DEFAULT_PEOPLE_SHOW } from '../core/people-show.js';

const ROOT = new URL('../../', import.meta.url).pathname;

const file = (o) => ({ readFile: () => JSON.stringify(o) });

// ============================================================================ readPeopleShow itself

test('with no "people" at all, the default is today\'s behaviour: the address', () => {
  assert.equal(readPeopleShow(undefined, '/p'), DEFAULT_PEOPLE_SHOW);
  assert.equal(DEFAULT_PEOPLE_SHOW, 'email');
});

test('every shipped value is accepted', () => {
  for (const value of PEOPLE_SHOW_VALUES) assert.equal(readPeopleShow(value, '/p'), value);
});

test('the four values are exactly the ones the issue names, no more, no fewer', () => {
  assert.deepEqual([...PEOPLE_SHOW_VALUES].sort(), ['email', 'id', 'name', 'role'].sort());
});

test('an unknown value refuses to start the service, and names the key', () => {
  assert.throws(() => readPeopleShow('username', '/p'),
    (e) => e instanceof Error && e.message.includes('/p/holdrim.json\'s "people.show"')
      && e.message.includes(PEOPLE_SHOW_VALUES.join(', ')) && e.message.includes('"username"'),
    'a misspelled value has to say so, and say what it should have been');
});

test('a value that is not a string refuses to start, not a raw TypeError', () => {
  for (const bad of [1, null, true, [], {}]) {
    assert.throws(() => readPeopleShow(bad, '/p'), /"people\.show" must be one of/,
      `${JSON.stringify(bad)} should have refused to start, by name`);
  }
});

// ============================================================================ wired through readConfig

test('readConfig hands back the default when the project sets no "people" block', () => {
  assert.equal(readConfig('/p', file({})).peopleShow, DEFAULT_PEOPLE_SHOW);
});

test('readConfig reads "people.show" the way it reads every other section', () => {
  assert.equal(readConfig('/p', file({ people: { show: 'role' } })).peopleShow, 'role');
});

test('readConfig validates "people.show" the same way it validates the rest of the file', () => {
  assert.throws(() => readConfig('/p', file({ people: { show: 'username' } })),
    /"people\.show" must be one of/);
});

test('"people" is content, never authority: a holdrim.json naming it is not refused', () => {
  // docs/ROLES.md, "How a person appears" is explicit that this is NOT the same list `owner`,
  // `admins`, `locks`, `roles` and `grants` refuse — a widened AUTHORITY_KEYS would refuse this the
  // same way, and this is the test that would catch it.
  assert.doesNotThrow(() => readConfig('/p', file({ people: { show: 'id' } })));
});

// ============================================================================ personAs

const base = { show: 'email', email: 'ana@example.org', id: 'p_aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Ana Silva', role: 'Admin', alwaysNamed: false };

test('"email" shows the address', () => {
  assert.equal(personAs({ ...base, show: 'email' }), 'ana@example.org');
});

test('"name" shows the name, and the address when there is none', () => {
  assert.equal(personAs({ ...base, show: 'name' }), 'Ana Silva');
  assert.equal(personAs({ ...base, show: 'name', name: null }), 'ana@example.org');
});

test('"role" shows the role the caller already resolved — never asked of a role\'s name here', () => {
  assert.equal(personAs({ ...base, show: 'role' }), 'Admin');
});

test('"id" shows the row id, and the address when there is none to show', () => {
  assert.equal(personAs({ ...base, show: 'id' }), 'p_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(personAs({ ...base, show: 'id', id: null }), 'ana@example.org');
});

test('alwaysNamed wins over every setting: the owner, a `people` holder, or the person themselves', () => {
  for (const show of PEOPLE_SHOW_VALUES) {
    assert.equal(personAs({ ...base, show, alwaysNamed: true }), 'Ana Silva',
      `alwaysNamed should show the name even with people.show: "${show}"`);
  }
});

test('alwaysNamed with no name falls back to the address, exactly like "name" alone does', () => {
  assert.equal(personAs({ ...base, show: 'id', alwaysNamed: true, name: null }), 'ana@example.org');
});

// ============================================================================ not authority
//
// docs/ROLES.md, "How a person appears": this decides what a reader is SENT, never what they may
// DO. `engine/core/roles.js` is the one file that decides every capability and the lock
// (`engine/tests/roles-boundary.test.js` proves nothing else may) — if `people.show` could ever
// reach a guard, it would have to reach it FROM THERE, exactly the claim `features.test.js` proves
// the same way for `features`.
test('engine/core/roles.js never mentions people.show: capabilities and the lock cannot be reached by it', () => {
  const roles = readFileSync(`${ROOT}engine/core/roles.js`, 'utf8');
  assert.ok(!/peopleShow|people\.show/.test(roles),
    'engine/core/roles.js mentions people.show — capabilities and the lock must come from identity ' +
    '(HOLDRIM_OWNER, HOLDRIM_ADMINS) alone, never from holdrim.json\'s people.show setting');
});
