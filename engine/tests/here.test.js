/**
 * #33: every capability the server checks is asked with the place in hand — the STORED request's
 * block or page for triage and for adding details, the block itself for a ✓ — and `/api/me`'s
 * `here` answers per page and per block, in booleans. The three shipped roles give `triage` and
 * `approve` to the same people, so no test against them could tell the two apart: the stub here
 * holds each in a different place, which is the only way to prove which one a check asks.
 * The routes themselves are proved over HTTP in engine/test-contract.sh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoles, scopeCovers, EVERYWHERE } from '../core/roles.js';
import { mayMove, mayAddDetails, statusFor, hereOf, blocksAsked, MAX_BLOCKS_ASKED } from '../api/here.ts';

const TRIAGER = 'triager@example.org';
const AGENT = 'agent@example.org';

/**
 * A `roles` whose one person holds `triage` on page P03 only and `approve` on page P09 only — never
 * the same place, so a check that asked the wrong capability, or asked it of the wrong place, gives
 * the other answer.
 */
const stub = {
  can(capability, who, where) {
    if (where === undefined) throw new Error('asked without where');
    if (who !== TRIAGER) return false;
    if (capability === 'triage') return scopeCovers('P03', where);
    if (capability === 'approve') return scopeCovers('P09', where);
    return capability === 'read' || capability === 'comment' || capability === 'request';
  },
  isAgent: (who) => who === AGENT,
};
const OPTS = { agentStates: ['applying', 'waiting', 'applied'], localMode: false };

test('triage is decided by `triage`, on the stored request\'s block', () => {
  assert.equal(mayMove(stub, TRIAGER, { page: 'P03', block: 'P03.2.1', author: 'x@example.org' }, 'approved', OPTS), true);
  // `approve` holds on P09, `triage` does not: a check that asked `approve` would let this through.
  assert.equal(mayMove(stub, TRIAGER, { page: 'P09', block: 'P09.1', author: 'x@example.org' }, 'approved', OPTS), false);
});

test('triage is judged on the stored block\'s own page, not on the page stored beside it', () => {
  assert.equal(mayMove(stub, TRIAGER, { page: 'P09', block: 'P03.2.1', author: 'x@example.org' }, 'rejected', OPTS), true);
  assert.equal(mayMove(stub, TRIAGER, { page: 'P03', block: 'P09.2.1', author: 'x@example.org' }, 'rejected', OPTS), false);
  assert.equal(mayMove(stub, TRIAGER, { page: 'P03', block: null, author: 'x@example.org' }, 'rejected', OPTS),
    true, 'a page request, judged on its page');
});

test('an agent moves a request only through the states the agent owns, holding no triage anywhere', () => {
  const request = { page: 'P03', block: 'P03.1', author: 'x@example.org' };
  assert.equal(mayMove(stub, AGENT, request, 'applying', OPTS), true);
  assert.equal(mayMove(stub, AGENT, request, 'approved', OPTS), false);
  assert.equal(mayMove(stub, 'member@example.org', request, 'applying', OPTS), false, 'a person who is not an agent');
  assert.equal(mayMove(stub, 'member@example.org', request, 'applying', { ...OPTS, localMode: true }), true, 'the local runner');
});

test('adding details: the author, or whoever may approve where the request was filed', () => {
  assert.equal(mayAddDetails(stub, 'x@example.org', 'x@example.org', { page: 'P03', block: 'P03.1', author: 'x@example.org' }), true);
  assert.equal(mayAddDetails(stub, TRIAGER, TRIAGER, { page: 'P09', block: 'P09.1', author: 'x@example.org' }), true);
  assert.equal(mayAddDetails(stub, TRIAGER, TRIAGER, { page: 'P03', block: 'P03.1', author: 'x@example.org' }), false,
    'triage alone does not let anyone write into somebody else\'s request');
});

test('a request\'s status keeps its triage destinations only for a viewer who may triage it there', () => {
  const status = { state: 'open', triage: ['approved', 'rejected', 'question'], requiresReason: ['rejected'] };
  assert.deepEqual(statusFor(stub, TRIAGER, { page: 'P03', block: 'P03.1', author: 'x' }, status).triage, status.triage);
  assert.deepEqual(statusFor(stub, TRIAGER, { page: 'P09', block: 'P09.1', author: 'x' }, status).triage, []);
  assert.deepEqual(statusFor(stub, null, { page: 'P03', block: 'P03.1', author: 'x' }, status).triage, [], 'nobody signed in');
  assert.deepEqual(statusFor(stub, TRIAGER, { page: 'P09', block: 'P09.1', author: 'x' }, status).requiresReason, ['rejected'],
    'only the destinations go; the rest of the status is the cycle\'s, for everyone');
});

test('here answers per page and per block named, in booleans only', () => {
  const here = hereOf(stub, TRIAGER, 'P03', ['P03.1', 'P03.2.1']);
  assert.deepEqual(here, {
    page: 'P03',
    may: { comment: true, request: true, triage: true, approve: false },
    blocks: { 'P03.1': { triage: true, approve: false }, 'P03.2.1': { triage: true, approve: false } },
  });
  const flat = JSON.stringify(here);
  assert.ok(!flat.includes('P0*') && !/"(?:scope|role|grant)/.test(flat), 'no scope, role or grant in what the panel is sent');
});

test('here, for the shipped roles: the owner and an admin may triage and approve every block, a member none', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  for (const who of ['owner@example.org', 'ana@example.org']) {
    const here = hereOf(roles, who, 'A01', ['A01.1.1']);
    assert.deepEqual(here.blocks['A01.1.1'], { triage: true, approve: true }, who);
    assert.equal(here.may.triage, true, who);
  }
  const member = hereOf(roles, 'carl@example.org', 'A01', ['A01.1.1']);
  assert.deepEqual(member.blocks['A01.1.1'], { triage: false, approve: false });
  assert.deepEqual(member.may, { comment: true, request: true, triage: false, approve: false });
  assert.equal(roles.can('people', 'carl@example.org', EVERYWHERE), false);
});

test('blocksAsked keeps only block ids of the page asked about, and says nothing of the rest', () => {
  assert.deepEqual(blocksAsked('P03', 'P03.1,P03.2.1,P03.1'), { ids: ['P03.1', 'P03.2.1'] }, 'each once');
  assert.deepEqual(blocksAsked('P03', 'P09.1,P03.1,P030.1'), { ids: ['P03.1'] }, 'another page\'s block is left out');
  assert.deepEqual(blocksAsked('P03', 'P03.<b>,P03.1/2,P03."x",P03.1'), { ids: ['P03.1'] }, 'what no event could name is left out');
  assert.deepEqual(blocksAsked('P03', `P03.${'1'.repeat(61)}`), { ids: [] }, 'longer than a block id may be');
  assert.deepEqual(blocksAsked('P03', null), { ids: [] });
  assert.deepEqual(blocksAsked('P03', ''), { ids: [] });
});

test('blocksAsked answers up to MAX_BLOCKS_ASKED ids and refuses one more, whole', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `P03.${i}`).join(',');
  assert.equal(blocksAsked('P03', ids(MAX_BLOCKS_ASKED)).ids.length, MAX_BLOCKS_ASKED);
  assert.deepEqual(blocksAsked('P03', ids(MAX_BLOCKS_ASKED + 1)), { tooMany: true });
});
