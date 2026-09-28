/**
 * Two removals of one person side by side (#181), for the conformance suites to run against every
 * event store and every user store: one run is held inside its removal until the other has answered,
 * and the second must be refused, not run beside it. The removal itself is engine/api/person-removal.ts;
 * its other cases are engine/tests/person-removal.test.js's.
 */
import assert from 'node:assert/strict';
import { createRoles } from '../../core/roles.js';
import { removePerson, PERSON_REMOVED, PEOPLE_PAGE } from '../../api/person-removal.ts';
import { definedEvent, grantedEvent } from '../../api/role-grants.ts';

const OWNER = 'owner@example.org';
const ANA = 'ana@example.org';
const deployment = createRoles(OWNER, '', '', '');

/** Long enough for any store to answer a refusal; a run that is not refused is held until then. */
const PATIENCE_MS = 10_000;

/**
 * Ana — with an account when `users` is given, two texts and one grant — removed twice at once.
 * Whichever run takes the claim is held at its first text until the other has answered, so the two
 * are side by side however fast the store is. A second run that takes no claim is held there too,
 * and after `PATIENCE_MS` both are let go, to run side by side as #181 found them.
 */
export async function removedTwiceAtOnce(events, users) {
  if (users) await users.create(ANA, 'Ana Lima');
  await events.append({ type: 'comment', page: 'A01', text: 'one' }, ANA);
  await events.append({ type: 'comment', page: 'A01', text: 'two' }, ANA);
  await events.append(definedEvent('reviewer', ['approve'], false), OWNER);
  await events.append(grantedEvent('reviewer', await events.personFor(ANA), null, false), OWNER);
  const person = await events.personOf(ANA);

  const removeText = events.removeText.bind(events);
  let letGo;
  const held = new Promise((resolve) => { letGo = resolve; });
  events.removeText = async (...args) => { await held; return removeText(...args); };
  // The refused run writes nothing: its first write, with an account, is closing it.
  let closings = 0;
  if (users) {
    const closeAccount = users.closeAccount.bind(users);
    users.closeAccount = async (email) => { closings++; return closeAccount(email); };
  }
  let timer;
  const patience = new Promise((resolve) => { timer = setTimeout(resolve, PATIENCE_MS, 'neither'); });
  const ctx = { events, users, deployment, by: OWNER, byAgent: false };
  const runs = [0, 1].map(() => removePerson(ctx, { email: ANA, confirmed: true }));
  let first;
  try {
    first = await Promise.race([...runs.map((run, i) => run.then(() => i)), patience]);
  } finally {
    clearTimeout(timer);
    letGo();
  }
  const answers = await Promise.all(runs);
  delete events.removeText;
  if (users) delete users.closeAccount;
  const removed = (await events.list(PEOPLE_PAGE)).filter((e) => e.type === PERSON_REMOVED);
  return { events, users, person, first, answers, removed, closings };
}

/** What two removals at once must have done: one refused while the other ran, and one event of it. */
export async function assertOneRemoval({ events, users, person, first, answers, removed, closings }) {
  assert.notEqual(first, 'neither', 'one of the two answered while the other was still removing');
  assert.deepEqual(answers[first], { status: 409, key: 'api.removal.inProgress', params: { email: ANA } },
    'the second is refused while the first runs');
  // Refused at its claim, before its first write: behind a proxy that first write is a grant's
  // revocation, which a run renews its claim before, so there it is refused at that renewal too.
  if (users) assert.equal(closings, 1, 'the refused run closed nothing');
  const done = answers[1 - first];
  assert.equal(done.status, 201);
  const counts = { person, texts: 2, textsTampered: 0, textsInline: 0, legacyEvents: 0, grants: 1, account: users !== null };
  assert.deepEqual(done.removal, counts, 'the run that removed counts all of it');
  assert.equal(removed.length, 1, 'one person_removed for one person');
  assert.equal(removed[0].id, done.event.id);
  assert.deepEqual(removed[0].data, { ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, String(v)])),
    asAgent: 'false' }, 'and it says what that run did');
  assert.equal(await events.personOf(ANA), null, 'the row is forgotten');
  if (users) assert.equal(await users.find(ANA), null, 'and the account is gone');
  // The claim went with the run: a third run is not refused as running, but finds nobody.
  assert.deepEqual(await removePerson({ events, users, deployment, by: OWNER, byAgent: false }, { email: ANA, confirmed: true }),
    { status: 404, key: 'api.removal.nobody', params: { email: ANA } });
}
