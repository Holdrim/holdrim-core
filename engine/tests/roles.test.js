/**
 * Who can do what. The invariant the product's security rests on is the first test: exactly one
 * owner, and the service refuses to start otherwise. Everything else here is the shape of the
 * answer — capabilities, never product role names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, capabilitiesOf, createRoles } from '../core/roles.js';

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
