/**
 * Who can do what. The invariant the product's security rests on is the first test: exactly one
 * owner, and the service refuses to start otherwise. Everything else here is the shape of the
 * answer — capabilities, never product role names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES, capabilitiesOf, createRoles, projectRoles, projectGrants, isValidGrantScope,
  ROLE_NAME_FORMAT,
} from '../core/roles.js';

test('exactly one owner: zero or two refuse to start', () => {
  assert.throws(() => createRoles('', ''), /HOLDRIM_OWNER needs exactly one e-mail \(got 0\)/);
  assert.throws(() => createRoles(undefined, 'a@example.org'), /exactly one e-mail \(got 0\)/);
  assert.throws(() => createRoles('a@example.org,b@example.org', ''), /exactly one e-mail \(got 2\)/);
  // The same address twice is one owner, not two: a copy-paste in a compose file must not take
  // the service down.
  assert.equal(createRoles('a@example.org, A@example.org', '').owner, 'a@example.org');
});

test('the owner is an admin by consequence, not by configuration', () => {
  const roles = createRoles('Owner@Example.org', '');
  assert.equal(roles.isOwner('owner@example.org'), true, 'case does not count in an e-mail');
  assert.equal(roles.roleOf('owner@example.org'), 'owner');
  for (const capability of CAPABILITIES) assert.equal(roles.can(capability, 'owner@example.org'), true, capability);
  assert.deepEqual(roles.admins, ['owner@example.org']);
});

test('an admin can do everything the owner does, except be the owner and lock', () => {
  const roles = createRoles('owner@example.org', ' ana@example.org ,bob@example.org,, ');
  assert.equal(roles.isOwner('ana@example.org'), false);
  assert.equal(roles.roleOf('ana@example.org'), 'admin');
  assert.equal(roles.can('approve', 'bob@example.org'), true);
  assert.equal(roles.can('triage', 'bob@example.org'), true);
  assert.equal(roles.can('people', 'bob@example.org'), true);
  // Only the owner's ✓ becomes a lock (AGENTS.md). An admin who could also lock would make every
  // admin an owner in every way that matters, which is exactly the invariant this file guards.
  assert.equal(roles.can('lock', 'bob@example.org'), false);
  assert.deepEqual([...roles.admins].sort(), ['ana@example.org', 'bob@example.org', 'owner@example.org']);
});

test('anybody else — a member — can only read, comment and request', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  for (const who of ['carl@example.org', '', null, undefined]) {
    assert.equal(roles.isOwner(who), false);
    assert.equal(roles.roleOf(who), 'member');
    assert.equal(roles.can('read', who), true);
    assert.equal(roles.can('comment', who), true);
    assert.equal(roles.can('request', who), true);
    for (const capability of ['triage', 'approve', 'lock', 'people']) {
      assert.equal(roles.can(capability, who), false, capability);
    }
  }
});

test('roleOf answers with the three names the engine ships, and no product role', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  assert.equal(roles.roleOf('OWNER@example.org'), 'owner');
  assert.equal(roles.roleOf('ana@example.org'), 'admin');
  assert.equal(roles.roleOf('carl@example.org'), 'member');
});

test('can throws on a capability outside the closed list, rather than silently answering false', () => {
  const roles = createRoles('owner@example.org', '');
  assert.throws(() => roles.can('superadmin', 'owner@example.org'), /"superadmin" is not a capability/);
  // A typo must not read as "no": a mistyped capability that quietly refused everyone would look
  // exactly like a correct refusal, and nobody would notice which one it was.
  assert.throws(() => roles.can('Approve', 'owner@example.org'), /"Approve" is not a capability/);
});

// ------------------------------------------------------------------ the mapping the whole issue is
/**
 * The three shipped roles hold EXACTLY the capabilities docs/ROLES.md gives them, no more and no
 * less. This is the test the issue's mutations are aimed at: widen or narrow one shipped role's set
 * in `engine/core/roles.js` and this is the named test that fails.
 *
 * `lock` is checked separately, through `can`, not through `capabilitiesOf`: it is never part of a
 * role's GRANTABLE set, owner included — see `docs/ROLES.md`, "Capabilities are the engine's", and
 * the test right after this one.
 */
test('the three shipped roles hold exactly the capabilities docs/ROLES.md gives them', () => {
  const grantable = CAPABILITIES.filter((c) => c !== 'lock');
  assert.deepEqual([...capabilitiesOf('owner')].sort(), grantable.sort(),
    'the owner\'s table entry is everything but lock — lock comes from identity, never from here');
  assert.deepEqual([...capabilitiesOf('admin')].sort(), grantable.sort(), 'admin is every capability but lock');
  assert.deepEqual([...capabilitiesOf('member')].sort(), ['comment', 'read', 'request'],
    'member is read, comment and request — and nothing that decides anything');
  // Asked the other way too: naming exactly what admin (and the table itself) must NOT hold, so a
  // mutation that adds a capability to admin's set, or puts lock back in the table for anyone, fails
  // here even if the sorted-array comparison above did not catch a reordering bug in some other
  // change.
  assert.equal(capabilitiesOf('admin').has('lock'), false);
  assert.equal(capabilitiesOf('owner').has('lock'), false);
});

test('capabilitiesOf refuses a role this version does not ship', () => {
  assert.throws(() => capabilitiesOf('superadmin'), /"superadmin" is not one of the roles this version ships/);
});

// ------------------------------------------------------------------ the lock cannot come from a table edit
/**
 * `Object.freeze` on a `Set` freezes the BINDING, not the Set's contents — `.add()` still works,
 * frozen or not. `capabilitiesOf` must therefore hand out a Set nobody else can reach again, and
 * `can('lock', …)` must never consult the table at all: this is the test that proves both, and the
 * one the issue's `capabilitiesOf('admin').add('lock')` mutation is aimed at.
 */
test('mutating what capabilitiesOf returns changes nothing the next caller reads', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  const mutated = capabilitiesOf('admin');
  mutated.add('lock');
  mutated.add('anything-else-nobody-granted');
  // The mutated Set is a copy: a fresh call reads the frozen source again, not what somebody did to
  // an earlier call's answer.
  assert.equal(capabilitiesOf('admin').has('lock'), false);
  assert.equal(roles.can('lock', 'ana@example.org'), false, 'an admin\'s ✓ must not have just become a lock');
});

// ------------------------------------------------------------------ #29: project roles and grants
/**
 * A project's own role (`holdrim.json`'s `roles`) grants exactly the capabilities it names, to
 * whoever an UNSCOPED grant names. This is the test #29's mutations are aimed at: change what a
 * granted capability answers, or let a scoped grant leak into `can` unconsulted, and this is the
 * named test that fails.
 */
test('a project role granted without a scope reaches can() — "no scope means everywhere"', () => {
  const roles = createRoles('owner@example.org', '',
    { 'clinical-lead': ['triage', 'approve'] },
    { 'bea@example.org': [{ role: 'clinical-lead' }] });
  assert.equal(roles.can('triage', 'bea@example.org'), true);
  assert.equal(roles.can('approve', 'bea@example.org'), true);
  // Only what was granted — 'people' was never in the role's list.
  assert.equal(roles.can('people', 'bea@example.org'), false);
  assert.equal(roles.roleOf('bea@example.org'), 'clinical-lead');
});

test('a scoped grant is validated but not yet consulted by can() — scopes are not built', () => {
  // docs/ROLES.md, "Built / not built": scopes are validated (this file, isValidGrantScope) but the
  // engine does not yet ask `can` with a page or block in hand — so honouring one here would grant
  // MORE than the file asked for, everywhere, instead of only where it said.
  const roles = createRoles('owner@example.org', '',
    { 'clinical-lead': ['triage'] },
    { 'cara@example.org': [{ role: 'clinical-lead', scope: 'P03' }] });
  assert.equal(roles.can('triage', 'cara@example.org'), false);
  assert.equal(roles.roleOf('cara@example.org'), 'member', 'a scoped-only grant shows no display role either');
});

test('a role a project defines cannot grant lock — only the owner can hold what the file cannot grant', () => {
  // `lock` is a KNOWN capability (no typo), so listing it does not refuse to start — but `can`'s
  // `'lock'` branch never reads a role's capabilities, project-defined or shipped, so it changes
  // nothing. This is the test the issue's "only the owner can hold what the file cannot grant"
  // mutation is aimed at.
  const roles = createRoles('owner@example.org', '',
    { 'super-role': ['lock', 'triage', 'approve', 'people'] },
    { 'zoe@example.org': [{ role: 'super-role' }] });
  assert.equal(roles.can('lock', 'zoe@example.org'), false, 'the file cannot grant lock, whatever it lists');
  assert.equal(roles.can('lock', 'owner@example.org'), true, 'only the owner holds it');
  // Every OTHER capability the role names still applies — only lock is refused.
  assert.equal(roles.can('triage', 'zoe@example.org'), true);
  assert.equal(roles.can('people', 'zoe@example.org'), true);
});

test('an unknown capability in a project role refuses to start the server', () => {
  assert.throws(
    () => createRoles('owner@example.org', '', { 'clinical-lead': ['aproove'] }, {}),
    /"clinical-lead" grants "aproove", which is not a capability/);
});

test('a role name outside the known format refuses to start', () => {
  for (const bad of ['Clinical-Lead', 'clinical_lead', '2fast', '', 'has space']) {
    assert.throws(() => createRoles('owner@example.org', '', { [bad]: ['read'] }, {}),
      /role name must be lowercase letters, digits and hyphens/, JSON.stringify(bad));
  }
});

test('a project role cannot reuse a shipped role\'s name', () => {
  for (const shipped of ['owner', 'admin', 'member']) {
    assert.throws(() => createRoles('owner@example.org', '', { [shipped]: ['read'] }, {}),
      /already ships/, shipped);
  }
});

test('a grant naming a role the file never defined refuses to start', () => {
  assert.throws(
    () => createRoles('owner@example.org', '', { 'clinical-lead': ['read'] },
      { 'x@example.org': [{ role: 'ghost-role' }] }),
    /not one of the project's own roles/);
});

test('a grant scope outside the known shapes refuses to start', () => {
  for (const bad of ['', '**', 'P0**', '<script>', 'P0 3']) {
    assert.throws(
      () => createRoles('owner@example.org', '', { 'clinical-lead': ['read'] },
        { 'x@example.org': [{ role: 'clinical-lead', scope: bad }] }),
      /is none of a page, a page family/, JSON.stringify(bad));
  }
});

test('isValidGrantScope accepts exactly the three shapes docs/ROLES.md describes', () => {
  assert.equal(isValidGrantScope('P03'), true, 'an exact page');
  assert.equal(isValidGrantScope('P0*'), true, 'a page family, with its explicit star');
  assert.equal(isValidGrantScope('P03.2.1'), true, 'a single block id');
  assert.equal(isValidGrantScope(''), false, 'empty names nothing');
  assert.equal(isValidGrantScope('P0**'), false, 'two stars is not a family');
  assert.equal(isValidGrantScope(42), false, 'not even a string');
});

test('ROLE_NAME_FORMAT is anchored — it does not merely find a match somewhere inside', () => {
  assert.equal(ROLE_NAME_FORMAT.test('clinical-lead and then some junk'), false);
});

test('projectRoles and projectGrants read no file at all as no project role and no grant', () => {
  assert.deepEqual(projectRoles(undefined), new Map());
  assert.deepEqual(projectRoles(null), new Map());
  assert.deepEqual(projectGrants(undefined, new Map()), new Map());
  assert.deepEqual(projectGrants(null, new Map()), new Map());
});

test('projectRoles refuses a "roles" that is not an object', () => {
  for (const bad of ['nope', 42, ['a', 'b']]) {
    assert.throws(() => projectRoles(bad), /must be an object mapping/, JSON.stringify(bad));
  }
});

test('projectGrants refuses a grant list that is not an array', () => {
  const roles = projectRoles({ 'clinical-lead': ['read'] });
  assert.throws(() => projectGrants({ 'x@example.org': { role: 'clinical-lead' } }, roles),
    /must be an array of \{role, scope\} entries/);
});

test('the owner locks and admin and member do not, whatever a caller does to what capabilitiesOf returned', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  // `capabilitiesOf` hands out a FRESH Set on every call (proved above), so this loop mutates three
  // throwaway copies, never the table itself — it is here to show that `can('lock', …)` does not care
  // either way: it never reads `capabilitiesOf` for `'lock'` at all (see `can`, in roles.js), so even
  // a caller that DID manage to poison the table would still get isOwner's answer, not the table's.
  // The table's own shape — that no role's entry carries `lock` in the first place — is the mapping
  // test above ("the three shipped roles hold exactly the capabilities docs/ROLES.md gives them").
  for (const role of ['owner', 'admin', 'member']) capabilitiesOf(role).add('lock');
  assert.equal(roles.can('lock', 'owner@example.org'), true);
  assert.equal(roles.can('lock', 'ana@example.org'), false, 'admin must not lock, whatever the table says');
  assert.equal(roles.can('lock', 'carl@example.org'), false, 'member must not lock, whatever the table says');
});
