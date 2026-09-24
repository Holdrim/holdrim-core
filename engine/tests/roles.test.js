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
 */
test('the three shipped roles hold exactly the capabilities docs/ROLES.md gives them', () => {
  assert.deepEqual([...capabilitiesOf('owner')].sort(), [...CAPABILITIES].sort(),
    'the owner holds every capability, lock included');
  assert.deepEqual([...capabilitiesOf('admin')].sort(), CAPABILITIES.filter((c) => c !== 'lock').sort(),
    'admin is every capability but lock');
  assert.deepEqual([...capabilitiesOf('member')].sort(), ['comment', 'read', 'request'],
    'member is read, comment and request — and nothing that decides anything');
  // Asked the other way too: naming exactly what admin must NOT hold, so a mutation that adds a
  // capability to admin's set fails here even if the sorted-array comparison above did not catch
  // a reordering bug in some other change.
  assert.equal(capabilitiesOf('admin').has('lock'), false);
});

test('capabilitiesOf refuses a role this version does not ship', () => {
  assert.throws(() => capabilitiesOf('superadmin'), /"superadmin" is not one of the roles this version ships/);
});
