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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { MemoryEventStore } from '../api/store.ts';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { createRoles } from '../core/roles.js';
import { removePerson, removedPersonEvent, PERSON_REMOVED, PEOPLE_PAGE, REMOVAL_CLAIM_MS } from '../api/person-removal.ts';
import { ROLES_PAGE, definedEvent, grantedEvent, projectRolesOf, GRANT_REVOKED } from '../api/role-grants.ts';
import { EVENT_TYPES, ensureLockBaseline, earliestLockBaseline, isLocked, LOCK_BASELINE_PAGE } from '../api/types.ts';
import { TEXT_REMOVED, noText, hashText, newSalt } from '../api/texts.ts';
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
  assert.deepEqual(outcome.removal, { person: w.person, texts: 2, textsTampered: 0, textsInline: 0, legacyEvents: 0, grants: 1, account: true });

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
  assert.deepEqual(removed.data, { person: w.person, texts: '2', textsTampered: '0', textsInline: '0', legacyEvents: '0',
    grants: '1', account: 'true', asAgent: 'false' });
  assert.match(removed.data.person, PERSON_ID);
  assert.doesNotMatch(JSON.stringify(removed.data), /@/, 'no address in what an event keeps for good');
});

test('the event every removal writes carries ids and counts, as strings, and nothing a client may post', () => {
  const event = removedPersonEvent({ person: `p_${'a'.repeat(24)}`, texts: 3, textsTampered: 1, textsInline: 2,
    legacyEvents: 4, grants: 0, account: false }, true);
  assert.deepEqual(event, { type: PERSON_REMOVED, page: PEOPLE_PAGE, block: null,
    data: { person: `p_${'a'.repeat(24)}`, texts: '3', textsTampered: '1', textsInline: '2', legacyEvents: '4', grants: '0',
      account: 'false', asAgent: 'true' } });
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
  assert.deepEqual(outcome.removal, { person: w.person, texts: 2, textsTampered: 0, textsInline: 0, legacyEvents: 0, grants: 1, account: false });
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
  assert.equal(outcome.removal.textsTampered, 1);
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
  assert.deepEqual([outcome.removal.texts, outcome.removal.textsInline], [1, 1]);
});

test('a store failing stops the removal with the address still taken and the grants gone, and a second run finishes it', async () => {
  const events = new FailingAt();
  const store = new UsersSqlite(':memory:');
  await store.create(ANA, 'Ana Lima');
  const first = await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  await events.append({ type: 'comment', page: 'A01', text: 'two' }, ANA);
  await events.append(definedEvent('reviewer', ['approve'], false), OWNER);
  await events.append(grantedEvent('reviewer', await events.personFor(ANA), null, false), OWNER);
  const person = await events.personOf(ANA);
  events.failing = first.id;
  events.make = () => new Error('the disk is full');
  const ctx = { events, users: store, deployment, by: OWNER, byAgent: false };
  await assert.rejects(removePerson(ctx, { email: ANA, confirmed: true }), /the disk is full/);
  assert.equal(await store.find(ANA), null, 'the account went first, so no session of theirs acted meanwhile');
  // While the row still leads to the person, nobody else may take the address: an account made for
  // it would act under their id.
  await assert.rejects(store.create(ANA, 'Somebody else'), 'the address is still taken');
  assert.deepEqual(projectRolesOf(await events.listBare(ROLES_PAGE)).grants, [], 'and the grants were gone before the texts');
  assert.equal(await events.personOf(ANA), person, 'the row still finds them: the run can be taken up again');
  assert.equal((await events.list(PEOPLE_PAGE)).length, 0, 'and no event claims a removal that did not finish');
  const outcome = await removePerson(ctx, { email: ANA, confirmed: true });
  assert.equal(outcome.status, 201);
  assert.deepEqual(outcome.removal, { person, texts: 2, textsTampered: 0, textsInline: 0, legacyEvents: 0, grants: 0, account: true },
    'what this run did: the grants went on the first');
  assert.equal(await events.personOf(ANA), null);
  assert.equal(typeof await store.create(ANA, 'Somebody new'), 'string', 'and once the row is forgotten, the address is free');
});

/**
 * A removal whose run fails once at `step`, then runs again: the stores, both answers, and the
 * `person_removed` events on `_people`. Ana has an account, two texts and one grant.
 */
async function stoppedAt(step) {
  let armed = true;
  const once = (name) => { if (armed && step === name) { armed = false; throw new Error(`the store failed at ${name}`); } };
  const events = new (class extends MemoryEventStore {
    async append(event, author) { if (event.type === GRANT_REVOKED) once('grant'); return super.append(event, author); }
    async forget(id) { once('forget'); return super.forget(id); }
  })();
  const users = new (class extends UsersSqlite {
    async closeAccount(email) { once('close'); return super.closeAccount(email); }
    async emptyAccount(email, keep) { once(keep ? 'empty' : 'free'); return super.emptyAccount(email, keep); }
  })(':memory:');
  await users.create(ANA, 'Ana Lima');
  await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  await events.append({ type: 'comment', page: 'A01', text: 'two' }, ANA);
  await events.append(definedEvent('reviewer', ['approve'], false), OWNER);
  await events.append(grantedEvent('reviewer', await events.personFor(ANA), null, false), OWNER);
  const person = await events.personOf(ANA);
  const ctx = { events, users, deployment, by: OWNER, byAgent: false };
  await assert.rejects(removePerson(ctx, { email: ANA, confirmed: true }), new RegExp(`failed at ${step}`));
  // Whatever step stopped it, the address was never left free while the row still led to Ana.
  if (await events.personOf(ANA)) {
    assert.ok((await users.readAllUsers()).some((r) => r.email === ANA), 'the address is still taken while the row leads to her');
  }
  const second = await removePerson(ctx, { email: ANA, confirmed: true });
  const removed = (await events.list(PEOPLE_PAGE)).filter((e) => e.type === PERSON_REMOVED);
  return { events, users, person, second, removed };
}

/** What every resumed run has to have done in the end, whichever step stopped the first. */
async function finished({ events, users, person, removed }) {
  assert.equal(removed.length, 1, 'one person_removed per person');
  assert.equal(await events.personOf(ANA), null, 'the row is forgotten');
  assert.deepEqual(projectRolesOf(await events.listBare(ROLES_PAGE)).grants, [], 'no grant in force names them');
  assert.equal((await events.list(null)).filter((e) => e.authorId === person && e.text).length, 0, 'no text of theirs is left');
  assert.equal(await users.find(ANA), null);
}

const COUNTS = { texts: '2', textsTampered: '0', textsInline: '0', legacyEvents: '0', grants: '1', account: 'true' };
const countsOf = (e) => Object.fromEntries(Object.keys(COUNTS).map((k) => [k, e.data[k]]));

test('a run stopped at closing the account finishes when run again, with one event counting all of it', async () => {
  const run = await stoppedAt('close');
  assert.equal(run.second.status, 201);
  await finished(run);
  assert.deepEqual(countsOf(run.removed[0]), COUNTS);
});

test('a run stopped at revoking a grant finishes when run again, and the grant is revoked', async () => {
  const run = await stoppedAt('grant');
  assert.equal(run.second.status, 201);
  await finished(run);
  assert.deepEqual(countsOf(run.removed[0]), COUNTS, 'the second run did all of it: nothing had gone but the account');
});

test('a run stopped at emptying the account, after the event, finishes without a second event', async () => {
  const run = await stoppedAt('empty');
  assert.equal(run.second.status, 201);
  assert.equal(run.second.event.id, run.removed[0].id, 'answered with the event the first run wrote');
  await finished(run);
  assert.deepEqual(countsOf(run.removed[0]), COUNTS, 'and the event counts what the first run did');
});

test('a run stopped at forgetting the row finishes without a second event', async () => {
  const run = await stoppedAt('forget');
  assert.equal(run.second.status, 201);
  assert.equal(run.second.event.id, run.removed[0].id);
  await finished(run);
  assert.deepEqual(countsOf(run.removed[0]), COUNTS);
});

test('a run stopped at freeing the address leaves it taken, never free while anything led to the person', async () => {
  // Past the forget, nothing finds the person again: the second run answers nobody, and the address
  // stays taken by an emptied account, as it does while older events name it.
  const run = await stoppedAt('free');
  assert.deepEqual(run.second, { status: 404, key: 'api.removal.nobody', params: { email: ANA } });
  await finished(run);
  await assert.rejects(run.users.create(ANA, 'Somebody new'), 'the address stays taken');
  const [row] = await run.users.readAllUsers();
  assert.deepEqual([row.name, row.enabled, row.removed], ['', false, true], 'by a row with nothing of theirs but the address');
});

test('a person with a grant and no account: a stopped run leaves the address taken, a finished one frees it', async () => {
  let failing = true;
  const events = new (class extends MemoryEventStore {
    async removeText(event, field, by) {
      if (failing) { failing = false; throw new Error('the disk is full'); }
      return super.removeText(event, field, by);
    }
  })();
  const users = new UsersSqlite(':memory:');
  await events.append({ type: 'comment', page: 'A01', text: 'granted before I was invited' }, ANA);
  await events.append(definedEvent('reviewer', ['approve'], false), OWNER);
  await events.append(grantedEvent('reviewer', await events.personFor(ANA), null, false), OWNER);
  const ctx = { events, users, deployment, by: OWNER, byAgent: false };
  await assert.rejects(removePerson(ctx, { email: ANA, confirmed: true }), /the disk is full/);
  // While the row still leads to Ana, an account made for her address would act under her id.
  await assert.rejects(users.create(ANA, 'Somebody else'), 'the address is taken though she had no account');
  const outcome = await removePerson(ctx, { email: ANA, confirmed: true });
  assert.equal(outcome.status, 201);
  assert.equal(outcome.removal.account, false, 'she had no account of her own');
  assert.equal(typeof await users.create(ANA, 'Ana, invited later'), 'string', 'and once the removal is done, the address is free');
});

test('when the address cannot be taken for a person with no account, the removal stops before anything else', async () => {
  const events = new MemoryEventStore();
  const users = new (class extends UsersSqlite {
    async insertUser() { throw new Error('the users store is unavailable'); }
  })(':memory:');
  await events.append(definedEvent('reviewer', ['approve'], false), OWNER);
  await events.append(grantedEvent('reviewer', await events.personFor(ANA), null, false), OWNER);
  await assert.rejects(removePerson({ events, users, deployment, by: OWNER, byAgent: false }, { email: ANA, confirmed: true }),
    /the users store is unavailable/);
  assert.equal(projectRolesOf(await events.listBare(ROLES_PAGE)).grants.length, 1, 'no step past it ran');
  assert.ok(await events.personOf(ANA), 'and the row still finds her, for a run that can take the address');
});

// ---------------------------------------------------------------- one run at a time (#181)
// Held side by side, one run inside the other's, against every store: engine/tests/helpers/removal.js,
// from the events and users conformance suites. Here, the orders a claim alone would not settle.

const removedOnce = async (events) => (await events.list(PEOPLE_PAGE)).filter((e) => e.type === PERSON_REMOVED);

test('two removals sent together, as a form sent twice: one removes, the other is refused, and one event counts it all', async () => {
  const w = await world();
  const [one, two] = await Promise.all([0, 1].map(() => removePerson(context(w), { email: ANA, confirmed: true })));
  const [done, other] = one.status === 201 ? [one, two] : [two, one];
  assert.equal(done.status, 201);
  assert.deepEqual(done.removal, { person: w.person, texts: 2, textsTampered: 0, textsInline: 0, legacyEvents: 0, grants: 1, account: true });
  // Refused while the first ran, or — had it finished first — nobody left: never a second removal.
  assert.ok(['api.removal.inProgress', 'api.removal.nobody'].includes(other.key), `the other answered ${JSON.stringify(other)}`);
  assert.equal((await removedOnce(w.events)).length, 1);
});

/**
 * Runs `first` in full inside `second`'s first read of the account, so `second` goes on with what it
 * read before `first` began: a run that read the stores, then waited, while another finished.
 */
function finishedInside(users, first) {
  const find = users.find.bind(users);
  let armed = true;
  users.find = async (email) => {
    const read = await find(email);
    if (armed) { armed = false; await first(); }
    return read;
  };
}

test('a run that read the stores before another finished the removal answers nobody, and adds nothing', async () => {
  const w = await world();
  let first;
  finishedInside(w.store, async () => { first = await removePerson(context(w), { email: ANA, confirmed: true }); });
  const second = await removePerson(context(w), { email: ANA, confirmed: true });
  assert.equal(first.status, 201);
  assert.deepEqual(second, { status: 404, key: 'api.removal.nobody', params: { email: ANA } });
  assert.equal((await removedOnce(w.events)).length, 1);
  // Gone on, it would have taken the freed address again with a closed row of its own.
  assert.equal((await w.store.readAllUsers()).length, 1, 'the one emptied account, and no row besides');
  assert.equal(typeof await w.store.create(ANA, 'Ana, invited later'), 'string', 'and the address is free');
});

test('an account whose person never acted, removed by another run meanwhile: the row the late run made is forgotten again', async () => {
  const events = new MemoryEventStore();
  const users = new UsersSqlite(':memory:');
  await users.create(BEA, 'Bea');
  const ctx = { events, users, deployment, by: OWNER, byAgent: false };
  let first;
  finishedInside(users, async () => { first = await removePerson(ctx, { email: BEA, confirmed: true }); });
  const second = await removePerson(ctx, { email: BEA, confirmed: true });
  assert.equal(first.status, 201);
  // The late run found no row, the first run's already forgotten, and made one for the address: the
  // claim on it was free, since nobody else had that id. Gone on, it would remove that new person.
  assert.deepEqual(second, { status: 404, key: 'api.removal.nobody', params: { email: BEA } });
  assert.equal((await removedOnce(events)).length, 1, 'one person_removed, not one more for the row the late run made');
  assert.equal(await events.personOf(BEA), null, 'and no row holds the address');
});

/**
 * A store where another run takes the claim over, at `at` in the fake clock, while this run removes
 * a text: as a run would that found this one's claim lapsed.
 */
class TakenOverAt extends MemoryEventStore {
  constructor() { super(); this.person = null; this.rival = null; this.at = null; }
  async removeText(event, field, by) {
    if (this.at != null && this.rival == null) {
      this.rival = await this.claimRemoval(this.person, 'rival', new Date(this.at).toISOString(),
        new Date(this.at + REMOVAL_CLAIM_MS).toISOString());
    }
    return super.removeText(event, field, by);
  }
}

test('a run whose claim another run took over stops where it is, and writes no person_removed', async () => {
  const events = new TakenOverAt();
  await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  const second = await events.append({ type: 'comment', page: 'A01', text: 'two' }, ANA);
  events.person = await events.personOf(ANA);
  // A clock that moves on half a claim at each reading: this run's claim, renewed before the first
  // text, ends two and a half claims in, and the other run takes it over exactly then, as it would a
  // lapsed one. Before the next text this run renews, and finds the claim gone.
  let now = Date.parse('2026-09-28T10:00:00.000Z');
  events.at = now + 5 * REMOVAL_CLAIM_MS / 2;
  const clock = () => (now += REMOVAL_CLAIM_MS / 2);
  const outcome = await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false, clock }, { email: ANA, confirmed: true });
  assert.equal(events.rival, true, '(the other run did take it over)');
  assert.deepEqual(outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  assert.equal((await removedOnce(events)).length, 0, 'the run that holds the claim writes the event');
  assert.equal((await byId(events, second.id)).text, 'two', 'and the next text is left for it');
  assert.equal(await events.claimRemoval(events.person, 'third', new Date(events.at).toISOString(),
    new Date(events.at + REMOVAL_CLAIM_MS).toISOString()), false,
    'the claim the other run holds is not let go of by this one');
});

test('a run renews its claim right before writing person_removed, and stops if it was taken over', async () => {
  // A clock that never moves: no renewal on the way, only the one before the event. The other run
  // takes the claim over at the moment it ends, as it would a lapsed one.
  const events = new TakenOverAt();
  await events.append({ type: 'comment', page: 'A01', text: 'the only one' }, ANA);
  events.person = await events.personOf(ANA);
  const now = Date.parse('2026-09-28T10:00:00.000Z');
  events.at = now + REMOVAL_CLAIM_MS;
  const outcome = await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false, clock: () => now },
    { email: ANA, confirmed: true });
  assert.equal(events.rival, true, '(the other run did take it over)');
  assert.deepEqual(outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  assert.equal((await removedOnce(events)).length, 0);
});

test('a long run keeps its claim: another run is refused long after the first claim would have ended', async () => {
  // Each grant revoked and each text removed takes half a claim's length, in the fake clock: four of
  // them outlast the first claim twice over.
  let now = Date.parse('2026-09-28T10:00:00.000Z');
  const rivals = [];
  const events = new (class extends MemoryEventStore {
    async rival() {
      now += REMOVAL_CLAIM_MS / 2;
      rivals.push(await this.claimRemoval(this.person, 'rival', new Date(now).toISOString(),
        new Date(now + REMOVAL_CLAIM_MS).toISOString()));
    }
    async append(event, author) { if (event.type === GRANT_REVOKED) await this.rival(); return super.append(event, author); }
    async removeText(event, field, by) { await this.rival(); return super.removeText(event, field, by); }
  })();
  for (const text of ['one', 'two']) await events.append({ type: 'comment', page: 'A01', text }, ANA);
  events.person = await events.personFor(ANA);
  for (const role of ['reviewer', 'editor']) {
    await events.append(definedEvent(role, ['approve'], false), OWNER);
    await events.append(grantedEvent(role, events.person, null, false), OWNER);
  }
  const outcome = await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false, clock: () => now },
    { email: ANA, confirmed: true });
  assert.deepEqual(rivals, [false, false, false, false], 'refused at every grant and every text');
  assert.equal(outcome.status, 201);
  assert.deepEqual([outcome.removal.grants, outcome.removal.texts], [2, 2]);
});

/**
 * A removal of Ana stopped at `where` — `reread`, right after it reads the row again under its
 * claim, `event`, right after `person_removed` is written, or `forget`, right after the row is
 * forgotten — while `meanwhile` runs, with the clock moved
 * past the end of the claim, as a run that stalled there would find it. Answers what the stalled
 * run answered, and the `person_removal_stopped` lines it logged.
 */
async function stalledIn(where, meanwhile, { withUsers = true } = {}) {
  let now = Date.parse('2026-09-28T10:00:00.000Z');
  const clock = () => now;
  let armed = true;
  const pause = async () => {
    if (!armed) return;
    armed = false;
    now += 2 * REMOVAL_CLAIM_MS;
    await meanwhile(ctx);
  };
  const events = new (class extends MemoryEventStore {
    async append(event, author) {
      const e = await super.append(event, author);
      if (where === 'event' && event.type === PERSON_REMOVED) await pause();
      return e;
    }
    async forget(id) { await super.forget(id); if (where === 'forget') await pause(); }
    // The second read of the row is the one under the claim; the first is before it.
    async personOf(email) {
      const read = await super.personOf(email);
      if (where === 'reread' && armed && ++this.reads === 2) await pause();
      return read;
    }
    reads = 0;
  })();
  const users = withUsers ? new UsersSqlite(':memory:') : null;
  if (users) await users.create(ANA, 'Ana Lima');
  await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  const ctx = { events, users, deployment, by: OWNER, byAgent: false, clock };
  const logged = [];
  const info = console.log;
  console.log = (line) => logged.push(line);
  let outcome;
  try {
    outcome = await removePerson(ctx, { email: ANA, confirmed: true });
  } finally {
    console.log = info;
  }
  const stopped = logged.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((l) => l?.event === 'person_removal_stopped');
  return { outcome, stopped, events, users };
}

test('a run stalled after its event, while another finished and somebody new took the address: the new account is untouched', async () => {
  let dana;
  const run = await stalledIn('event', async (ctx) => {
    assert.equal((await removePerson(ctx, { email: ANA, confirmed: true })).status, 201, '(the other run finished it)');
    dana = await ctx.users.create(ANA, 'Dana');
  });
  assert.deepEqual(run.outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  assert.equal(run.stopped.length, 1, 'and it says it stopped');
  assert.equal((await run.users.check(ANA, dana))?.name, 'Dana', 'Dana\'s account opens with her password, as it was');
  assert.equal((await removedOnce(run.events)).length, 1);
});

test('a run stalled before closing the account, while another finished and somebody new took the address: never closes it', async () => {
  let dana;
  const run = await stalledIn('reread', async (ctx) => {
    assert.equal((await removePerson(ctx, { email: ANA, confirmed: true })).status, 201, '(the other run finished it)');
    dana = await ctx.users.create(ANA, 'Dana');
  });
  assert.deepEqual(run.outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  assert.equal(run.stopped.length, 1);
  assert.equal((await run.users.check(ANA, dana))?.name, 'Dana', 'Dana\'s account is open, and opens with her password');
  assert.equal((await removedOnce(run.events)).length, 1);
});

test('a run stalled after its event, while another run took the claim over, leaves the rest to it', async () => {
  const run = await stalledIn('event', async (ctx) => {
    const person = await ctx.events.personOf(ANA);
    const at = new Date(ctx.clock()).toISOString();
    assert.equal(await ctx.events.claimRemoval(person, 'rival', at, new Date(ctx.clock() + REMOVAL_CLAIM_MS).toISOString()), true);
  });
  assert.deepEqual(run.outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  assert.equal(run.stopped.length, 1);
  const [row] = await run.users.readAllUsers();
  assert.deepEqual([row.email, row.name], [ANA, 'Ana Lima'], 'closed, and not emptied: the run holding the claim does that');
});

test('behind an identity proxy, a run stalled after its event, while another run took the claim over, leaves the row to it', async () => {
  // No account to empty first, so the check before forgetting the row is the first one this run meets.
  let person;
  const run = await stalledIn('event', async (ctx) => {
    person = await ctx.events.personOf(ANA);
    const at = new Date(ctx.clock()).toISOString();
    assert.equal(await ctx.events.claimRemoval(person, 'rival', at, new Date(ctx.clock() + REMOVAL_CLAIM_MS).toISOString()), true);
  }, { withUsers: false });
  assert.deepEqual(run.outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  assert.equal(run.stopped.length, 1);
  assert.equal(await run.events.personOf(ANA), person, 'the row still leads to the person, for the run holding the claim');
});

test('a run stalled after forgetting the row, while another run took the claim over, does not free the address', async () => {
  const run = await stalledIn('forget', async (ctx) => {
    const person = (await removedOnce(ctx.events))[0].data.person;
    const at = new Date(ctx.clock()).toISOString();
    assert.equal(await ctx.events.claimRemoval(person, 'rival', at, new Date(ctx.clock() + REMOVAL_CLAIM_MS).toISOString()), true);
  });
  assert.deepEqual(run.outcome, { status: 409, key: 'api.removal.inProgress', params: { email: ANA } });
  const [row] = await run.users.readAllUsers();
  assert.equal(row.email, ANA, 'still keyed by the address');
});

/** A store that cannot let a claim go: the claim then lapses on its own. */
class Unreleasing extends MemoryEventStore {
  async releaseRemoval() { throw new Error('the store could not let the claim go'); }
}

/** `fn`'s answer, and the `removal_claim_kept` lines it logged. */
async function keptLines(fn) {
  const logged = [];
  const info = console.log;
  console.log = (line) => logged.push(line);
  try {
    const answer = await fn().then((value) => ({ value }), (error) => ({ error }));
    return { ...answer, kept: logged.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((l) => l?.event === 'removal_claim_kept') };
  } finally {
    console.log = info;
  }
}

test('a claim that cannot be let go of leaves a finished removal finished: its answer, and a line saying so', async () => {
  const events = new Unreleasing();
  await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  const person = await events.personOf(ANA);
  const run = await keptLines(() => removePerson({ events, users: null, deployment, by: OWNER, byAgent: false },
    { email: ANA, confirmed: true }));
  assert.equal(run.error, undefined, `answered, not thrown: ${run.error}`);
  assert.equal(run.value.status, 201);
  assert.equal((await removedOnce(events)).length, 1);
  assert.deepEqual(run.kept.map((l) => [l.severity, l.person]), [['WARNING', person]], 'said once, by id');
});

test('a claim that cannot be let go of after a step failed: the step\'s own error is the one thrown', async () => {
  const events = new (class extends Unreleasing {
    async removeText() { throw new Error('the disk is full'); }
  })();
  await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  const run = await keptLines(() => removePerson({ events, users: null, deployment, by: OWNER, byAgent: false },
    { email: ANA, confirmed: true }));
  assert.match(String(run.error?.message), /the disk is full/);
  assert.equal(run.kept.length, 1);
});

// ---------------------------------------------------------------- stores from before ids and texts moved
/** A SQLite store in a folder of its own, and a way to write rows the way an older version did. */
async function olderStore() {
  const path = join(mkdtempSync(join(tmpdir(), 'holdrim-removal-')), 'events.db');
  await new SqliteEventStore(path).close();
  const raw = (sql, ...values) => { const db = new DatabaseSync(path); try { db.prepare(sql).run(...values); } finally { db.close(); } };
  return { path, raw, open: () => new SqliteEventStore(path) };
}
const INSERT = 'INSERT INTO events (id, type, page, block, fingerprint, text, text_hash, author, happened_at, data) '
  + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

test('the first owner is refused while a ✓ from before the lock baseline names their address, and it stays a lock', async () => {
  const old = await olderStore();
  // A ✓ an older version recorded, its author the address itself — spelled as the person typed it,
  // which `legacyLock` reads as the same address — then this version's first start.
  old.raw(INSERT, 'old-approval', 'approval', 'A01', 'A01.1.1', 'f', null, null, 'Bea@Example.ORG', '2026-01-01T00:00:00.000Z', null);
  const events = old.open();
  const baseline = await ensureLockBaseline(events, BEA);
  const approval = async () => (await events.list('A01')).find((e) => e.id === 'old-approval');
  assert.equal(isLocked(await approval(), baseline), true, '(a lock, through the baseline\'s author)');
  // Bea hands over to the owner, who is asked to remove her.
  const before = JSON.stringify(await events.list(null));
  assert.deepEqual(await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false }, { email: BEA, confirmed: true }),
    { status: 409, key: 'api.removal.holdsOldLocks', params: { email: BEA } });
  assert.equal(JSON.stringify(await events.list(null)), before, 'nothing was touched');
  assert.equal(isLocked(await approval(), earliestLockBaseline(await events.list(LOCK_BASELINE_PAGE))), true, 'and it is still a lock');
  await events.close();
});

test('the first owner whose older events are only comments is removed: a comment is no lock', async () => {
  const old = await olderStore();
  old.raw(INSERT, 'old-comment', 'comment', 'A01', 'A01.1.1', null, 'an old remark', null, BEA, '2026-01-01T00:00:00.000Z', '{}');
  const events = old.open();
  await ensureLockBaseline(events, BEA);
  const outcome = await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false }, { email: BEA, confirmed: true });
  assert.equal(outcome.status, 201);
  assert.equal(outcome.removal.legacyEvents, 1);
  await events.close();
});

test('two people removed from one store: one person_removed each, each naming its own person', async () => {
  const w = await world();
  await w.events.append({ type: 'comment', page: 'A01', text: 'Bea says' }, BEA);
  const bea = await w.events.personOf(BEA);
  const first = await removePerson(context(w), { email: ANA, confirmed: true });
  const second = await removePerson(context(w), { email: BEA, confirmed: true });
  assert.equal(second.event.data.person, bea, 'the second answer names the second person');
  assert.notEqual(second.event.id, first.event.id);
  const removed = (await w.events.list(PEOPLE_PAGE)).filter((e) => e.type === PERSON_REMOVED);
  assert.deepEqual(removed.map((e) => e.data.person), [w.person, bea]);
});

test('the first owner with no ✓ from before the baseline is removed, and their ✓s since stay locks', async () => {
  const events = new MemoryEventStore();
  const baseline = await ensureLockBaseline(events, BEA);
  // Later than the baseline by the clock, as a ✓ given after a start always is: in the same
  // millisecond, `isLocked` would not trust what is written on it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const given = await events.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f', data: { locks: 'true' } }, BEA);
  assert.equal((await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false }, { email: BEA, confirmed: true })).status, 201);
  assert.equal(isLocked(await byId(events, given.id), baseline), true);
});

test('texts from before ids and before texts moved out are removed where they can be, and counted where they cannot', async () => {
  const old = await olderStore();
  const events = old.open();
  const id = await events.personFor(ANA);
  await events.close();
  const salt = newSalt();
  // Three shapes an older store holds: text inside the event, under the id; text inside the event,
  // under the address; and text in its own row, under the address.
  old.raw(INSERT, 'inline-id', 'comment', 'A01', null, null, 'my CPF is 123', null, id, '2025-01-01T00:00:00.000Z', '{}');
  old.raw(INSERT, 'inline-address', 'comment', 'A01', null, null, 'call me at 555', null, ANA, '2025-01-01T00:00:01.000Z', '{}');
  old.raw(INSERT, 'row-address', 'comment', 'A01', null, null, null, hashText('my home address', salt), ANA,
    '2025-01-01T00:00:02.000Z', '{}');
  old.raw('INSERT INTO texts (event, field, value, salt) VALUES (?, ?, ?, ?)', 'row-address', 'text', 'my home address', salt);
  const reopened = old.open();
  const users = new UsersSqlite(':memory:');
  await users.create(ANA, 'Ana Lima');
  const [before] = await users.readAllUsers();
  const outcome = await removePerson({ events: reopened, users, deployment, by: OWNER, byAgent: false }, { email: ANA, confirmed: true });
  assert.deepEqual(outcome.removal, { person: id, texts: 1, textsTampered: 0, textsInline: 2, legacyEvents: 2, grants: 0, account: true });
  const text = async (eventId) => (await byId(reopened, eventId)).text;
  assert.equal(await text('row-address'), null, 'the one with a row of its own, under the address, is removed');
  assert.equal(await text('inline-address'), 'call me at 555', 'held inside the event: nothing removes it');
  // Those events still name the address, so the address stays taken: nobody new becomes their author.
  await assert.rejects(users.create(ANA, 'Somebody new'), 'the address stays taken');
  assert.equal(await users.find(ANA), null, 'by an account nothing finds');
  const [row] = await users.readAllUsers();
  assert.deepEqual([row.email, row.name, row.enabled, row.removed], [ANA, '', false, true], 'emptied, and closed');
  assert.notDeepEqual([row.salt, row.hash], [before.salt, before.hash], 'its credential replaced, the address kept');
  await reopened.close();
});

test('somebody only older events name is refused as such, and no person is made for them', async () => {
  const old = await olderStore();
  old.raw(INSERT, 'inline-address', 'comment', 'A01', null, null, 'call me at 555', null, ANA, '2025-01-01T00:00:01.000Z', '{}');
  const events = old.open();
  assert.deepEqual(await removePerson({ events, users: null, deployment, by: OWNER, byAgent: false }, { email: ANA, confirmed: true }),
    { status: 409, key: 'api.removal.onlyOlderEvents', params: { email: ANA } });
  assert.equal(await events.personOf(ANA), null, 'no row made for them');
  assert.deepEqual((await events.list(null)).map((e) => e.id), ['inline-address'], 'and nothing written');
  await events.close();
});
