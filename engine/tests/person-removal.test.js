/**
 * Removing a person, at their request (docs/PRIVACY.md, section 5; issue #37): what
 * `engine/api/person-removal.ts` lets go of, what it keeps, whom it refuses, and that a removal that
 * stopped half-way finishes when run again.
 *
 * That only the owner reaches it, only from the settings screen's own page, and that the refusals
 * below hold through that form against a real server, is `engine/test-contract.sh`'s to prove; in a
 * browser, `engine/test-browser.js`'s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEventStore } from '../api/store.ts';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { createRoles } from '../core/roles.js';
import { removePerson, removedPersonEvent, PERSON_REMOVED, PEOPLE_PAGE } from '../api/person-removal.ts';
import { ROLES_PAGE, definedEvent, grantedEvent, projectRolesOf, GRANT_REVOKED } from '../api/role-grants.ts';
import { EVENT_TYPES } from '../api/types.ts';
import { TEXT_REMOVED, noText } from '../api/texts.ts';
import { PERSON_ID } from '../api/people.ts';

const OWNER = 'owner@example.org';
const ADMIN = 'admin@example.org';
const LOCKED = 'locked@example.org';
const AGENT = 'agent@example.org';
const ANA = 'ana@example.org';
const BEA = 'bea@example.org';
const deployment = createRoles(OWNER, ADMIN, `${LOCKED}:A0*`, AGENT);

/** A deployment with a person who wrote, was granted a role, and signed in: everything §5 reaches. */
async function world({ users = true } = {}) {
  const events = new MemoryEventStore();
  const store = users ? new UsersSqlite(':memory:') : null;
  let password = null;
  let session = null;
  if (store) {
    password = await store.create(ANA, 'Ana Lima');
    session = await store.openSession(ANA);
  }
  const comment = await events.append({ type: 'comment', page: 'A01', block: 'A01.1.1', text: 'my CPF is 123' }, ANA);
  const request = await events.append({ type: 'request', page: 'A01', block: 'A01.1.2', text: 'call me at home',
    data: { category: 'text' } }, ANA);
  // A ✓ carries the block's own text as its snapshot, and no text of the person's.
  const approval = await events.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f',
    snapshot: 'the block as it read' }, ANA);
  const others = await events.append({ type: 'comment', page: 'A01', block: 'A01.1.1', text: 'somebody else' }, BEA);
  await events.append(definedEvent('reviewer', ['approve'], false), OWNER);
  const grant = await events.append(grantedEvent('reviewer', await events.personFor(ANA), null, false), OWNER);
  const person = await events.personOf(ANA);
  return { events, store, password, session, comment, request, approval, others, grant, person };
}

const context = (w, extra = {}) => ({ events: w.events, users: w.store, deployment, by: OWNER, byAgent: false, ...extra });
const byId = async (events, id) => (await events.list(null)).find((e) => e.id === id);

test('removing a person empties their account, their texts, their grants and their row, and writes one event with ids only', async () => {
  const w = await world();
  const outcome = await removePerson(context(w), { email: ' Ana@Example.org ', confirmed: true });
  assert.equal(outcome.status, 201);
  assert.deepEqual(outcome.removal, { person: w.person, texts: 2, textsLeft: 0, grants: 1, account: true });

  // The account: no e-mail, no name, no password, no session — and the row kept.
  assert.equal(await w.store.find(ANA), null, 'the address finds no account');
  assert.equal(await w.store.check(ANA, w.password), null, 'the password opens nothing');
  assert.equal(await w.store.fromSession(w.session), null, 'the open session is gone');
  assert.deepEqual((await w.store.list()).map((u) => u.email), [], 'the people screen lists nobody');
  assert.equal(await w.store.isEmpty(), false, 'the row stays: an emptied account, never a deleted one');

  // The texts: each of theirs removed, with its own removal event; the snapshot and others' stay.
  for (const id of [w.comment.id, w.request.id]) {
    const e = await byId(w.events, id);
    assert.equal(e.text, null, `the text of ${e.type} is gone`);
    assert.equal(e.textRemoved?.by, OWNER, 'and the trail says the owner let it go');
    assert.equal(e.textTampered, false, 'a removal, never read as tampering');
  }
  assert.equal((await byId(w.events, w.approval.id)).snapshot, 'the block as it read', 'the snapshot is the documentation\'s, and stays');
  assert.equal((await byId(w.events, w.others.id)).text, 'somebody else', 'nobody else\'s text is touched');
  assert.equal((await w.events.list(null)).filter((e) => e.type === TEXT_REMOVED).length, 2);

  // The grant: revoked by a later event; the grant itself stays in the trail.
  const roles = projectRolesOf(await w.events.listBare(ROLES_PAGE));
  assert.deepEqual(roles.grants, [], 'no grant in force names them');
  assert.deepEqual(roles.ended.map((g) => g.id), [w.grant.id], 'and the grant they held is in the trail, ended');
  assert.equal((await w.events.list(ROLES_PAGE)).filter((e) => e.type === GRANT_REVOKED).length, 1);

  // The row: the id stays, the e-mail goes, and every event of theirs still names the id.
  assert.deepEqual(await w.events.person(w.person), { id: w.person, email: null });
  assert.equal(await w.events.personOf(ANA), null);
  assert.equal((await byId(w.events, w.approval.id)).author, w.person, 'their ✓ now reads as the id, and still as a ✓');

  // The event: on `_people`, by the owner, naming the person by id and nothing else about them.
  const [removed] = await w.events.list(PEOPLE_PAGE);
  assert.equal(removed.id, outcome.event.id);
  assert.equal(removed.type, PERSON_REMOVED);
  assert.equal(removed.author, OWNER);
  assert.deepEqual(removed.data, { person: w.person, texts: '2', textsLeft: '0', grants: '1', account: 'true', asAgent: 'false' });
  assert.match(removed.data.person, PERSON_ID);
  assert.doesNotMatch(JSON.stringify(removed.data), /@/, 'no address in what an event keeps for good');
});

test('the event every removal writes carries ids and counts, as strings, and nothing a client may post', () => {
  const event = removedPersonEvent({ person: `p_${'a'.repeat(24)}`, texts: 3, textsLeft: 1, grants: 0, account: false }, true);
  assert.deepEqual(event, { type: PERSON_REMOVED, page: PEOPLE_PAGE, block: null,
    data: { person: `p_${'a'.repeat(24)}`, texts: '3', textsLeft: '1', grants: '0', account: 'false', asAgent: 'true' } });
  assert.ok(!EVENT_TYPES.has(PERSON_REMOVED), 'POST /events refuses it as an unknown type');
});

/** What the store and the people table hold, so a refusal can be shown to have touched nothing. */
async function snapshotOf(w) {
  return JSON.stringify({ events: await w.events.list(null), people: await w.events.person(w.person),
    users: w.store ? await w.store.list() : null });
}

test('the owner is refused as the owner, and nothing is touched', async () => {
  const w = await world();
  const before = await snapshotOf(w);
  // By key: the owner is in `admins` too, so without its own check the refusal would still come, as
  // "named in HOLDRIM_ADMINS", and a test on the status alone would not see the check go.
  assert.deepEqual(await removePerson(context(w), { email: OWNER, confirmed: true }),
    { status: 409, key: 'api.removal.notTheOwner' });
  assert.equal(await snapshotOf(w), before);
});

for (const [address, variable] of [[ADMIN, 'HOLDRIM_ADMINS'], [LOCKED, 'HOLDRIM_LOCKS'], [AGENT, 'HOLDRIM_AGENTS']]) {
  test(`an address ${variable} names is refused, naming the variable, and nothing is touched`, async () => {
    const w = await world();
    await w.events.append({ type: 'comment', page: 'A01', text: 'said by someone the deployment names' }, address);
    const before = await snapshotOf(w);
    assert.deepEqual(await removePerson(context(w), { email: address, confirmed: true }),
      { status: 409, key: 'api.removal.namedByDeployment', params: { email: address, variable } });
    assert.equal(await snapshotOf(w), before);
  });
}

test('an address holding an agent token is refused until the token is revoked', async () => {
  const w = await world();
  await w.store.issueAgentToken(BEA);
  const before = await snapshotOf(w);
  assert.deepEqual(await removePerson(context(w), { email: BEA, confirmed: true }),
    { status: 409, key: 'api.removal.holdsAgentToken', params: { email: BEA } });
  assert.equal(await snapshotOf(w), before);
  await w.store.revokeAgentToken(BEA);
  assert.equal((await removePerson(context(w), { email: BEA, confirmed: true })).status, 201);
});

test('without the box ticked, nothing is removed', async () => {
  const w = await world();
  const before = await snapshotOf(w);
  assert.deepEqual(await removePerson(context(w), { email: ANA, confirmed: false }),
    { status: 400, key: 'api.removal.unconfirmed' });
  assert.equal(await snapshotOf(w), before);
});

test('something that is not an address is refused', async () => {
  const w = await world();
  for (const email of ['', 'ana', null, 7]) {
    assert.equal((await removePerson(context(w), { email, confirmed: true })).key, 'api.users.emailInvalid');
  }
});

test('nobody by that address is refused as nobody, and so is a second run', async () => {
  const w = await world();
  assert.deepEqual(await removePerson(context(w), { email: 'nobody@example.org', confirmed: true }),
    { status: 404, key: 'api.removal.nobody', params: { email: 'nobody@example.org' } });
  assert.equal(await w.events.personOf('nobody@example.org'), null, 'asking made nobody a person');
  assert.equal((await removePerson(context(w), { email: ANA, confirmed: true })).status, 201);
  const after = await snapshotOf(w);
  assert.deepEqual(await removePerson(context(w), { email: ANA, confirmed: true }),
    { status: 404, key: 'api.removal.nobody', params: { email: ANA } });
  assert.equal(await snapshotOf(w), after, 'the second run wrote nothing');
});

test('behind an identity proxy there is no account: the texts, the grants and the row go all the same', async () => {
  const w = await world({ users: false });
  const outcome = await removePerson(context(w), { email: ANA, confirmed: true });
  assert.deepEqual(outcome.removal, { person: w.person, texts: 2, textsLeft: 0, grants: 1, account: false });
  assert.equal(await w.events.personOf(ANA), null);
});

test('an account whose person never acted is emptied, and the event names an id made for it', async () => {
  const events = new MemoryEventStore();
  const store = new UsersSqlite(':memory:');
  await store.create(BEA, 'Bea');
  const outcome = await removePerson({ events, users: store, deployment, by: OWNER, byAgent: false }, { email: BEA, confirmed: true });
  assert.equal(outcome.status, 201);
  assert.equal(outcome.removal.account, true);
  assert.match(outcome.removal.person, PERSON_ID);
  assert.deepEqual(await events.person(outcome.removal.person), { id: outcome.removal.person, email: null });
  assert.equal(await store.find(BEA), null);
});

/** A store whose list reads one event's text as tampered, as `withTexts` would after a direct write. */
class TamperedAt extends MemoryEventStore {
  constructor(id) { super(); this.tampered = id; }
  async list(page, found) {
    return (await super.list(page, found)).map((e) => (e.id === this.tampered ? { ...e, text: null, textTampered: true } : e));
  }
}

test('a tampered text is left and counted, never removed: a removal would silence the finding', async () => {
  const events = new TamperedAt(null);
  const comment = await events.append({ type: 'comment', page: 'A01', text: 'edited behind our back' }, ANA);
  await events.append({ type: 'comment', page: 'A01', text: 'untouched' }, ANA);
  events.tampered = comment.id;
  const outcome = await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false }, { email: ANA, confirmed: true });
  assert.equal(outcome.removal.texts, 1);
  assert.equal(outcome.removal.textsLeft, 1);
  // Read past the stub: the row of the tampered text was not removed, so no removal claims it.
  const removals = (await MemoryEventStore.prototype.list.call(events, null)).filter((e) => e.type === TEXT_REMOVED);
  assert.deepEqual(removals.map((e) => e.data.event).includes(comment.id), false);
});

/** A store whose removeText throws once, for the event named, whatever `make` says. */
class FailingAt extends MemoryEventStore {
  constructor() { super(); this.failing = null; this.make = null; }
  async removeText(event, field, by) {
    if (event === this.failing) { this.failing = null; throw this.make(event, field); }
    return super.removeText(event, field, by);
  }
}

test('a text already gone goes on to the next, counted as left', async () => {
  const events = new FailingAt();
  const first = await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  await events.append({ type: 'comment', page: 'A01', text: 'two' }, ANA);
  events.failing = first.id;
  events.make = noText;
  const outcome = await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false }, { email: ANA, confirmed: true });
  assert.equal(outcome.status, 201);
  assert.deepEqual([outcome.removal.texts, outcome.removal.textsLeft], [1, 1]);
});

test('a store failing stops the removal before the row is emptied, and a second run finishes it', async () => {
  const events = new FailingAt();
  const store = new UsersSqlite(':memory:');
  await store.create(ANA, 'Ana Lima');
  const first = await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  await events.append({ type: 'comment', page: 'A01', text: 'two' }, ANA);
  const person = await events.personOf(ANA);
  events.failing = first.id;
  events.make = () => new Error('the disk is full');
  const ctx = { events, users: store, deployment, by: OWNER, byAgent: false };
  await assert.rejects(removePerson(ctx, { email: ANA, confirmed: true }), /the disk is full/);
  assert.equal(await store.find(ANA), null, 'the account went first, so no session of theirs acted meanwhile');
  assert.equal(await events.personOf(ANA), person, 'the row still finds them: the run can be taken up again');
  assert.equal((await events.list(PEOPLE_PAGE)).length, 0, 'and no event claims a removal that did not finish');
  const outcome = await removePerson(ctx, { email: ANA, confirmed: true });
  assert.equal(outcome.status, 201);
  assert.deepEqual(outcome.removal, { person, texts: 2, textsLeft: 0, grants: 0, account: false });
  assert.equal(await events.personOf(ANA), null);
});
