/**
 * Who can do what. The invariant the product's security rests on is the first test: exactly one
 * owner, and the service refuses to start otherwise. Everything else here is the shape of the
 * answer — capabilities, never product role names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoles } from '../core/roles.js';

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
  assert.equal(roles.isAdmin('owner@example.org'), true);
  assert.equal(roles.canApprove('owner@example.org'), true);
  assert.equal(roles.canTriage('owner@example.org'), true);
  assert.deepEqual(roles.admins, ['owner@example.org']);
});

test('an admin can do everything the owner does, except be the owner', () => {
  const roles = createRoles('owner@example.org', ' ana@example.org ,bob@example.org,, ');
  assert.equal(roles.isOwner('ana@example.org'), false);
  assert.equal(roles.isAdmin('ana@example.org'), true);
  assert.equal(roles.canApprove('bob@example.org'), true);
  assert.equal(roles.canTriage('bob@example.org'), true);
  assert.deepEqual([...roles.admins].sort(), ['ana@example.org', 'bob@example.org', 'owner@example.org']);
});

test('anybody else can neither approve nor triage', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  for (const who of ['carl@example.org', '', null, undefined]) {
    assert.equal(roles.isOwner(who), false);
    assert.equal(roles.isAdmin(who), false);
    assert.equal(roles.canApprove(who), false);
    assert.equal(roles.canTriage(who), false);
  }
});

test('roleOf answers with the three names the engine knows, and no product role', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  assert.equal(roles.roleOf('OWNER@example.org'), 'owner');
  assert.equal(roles.roleOf('ana@example.org'), 'admin');
  assert.equal(roles.roleOf('carl@example.org'), 'other');
});
