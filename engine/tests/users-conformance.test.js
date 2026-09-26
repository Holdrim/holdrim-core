/**
 * ONE set of tests, run against EVERY user store.
 *
 * This is what turns "we support several databases" from a sentence in the README into a fact. An
 * implementation that does not pass this file is not supported — not "mostly working", not
 * "should be fine": not supported. The three stores exist because a password hashed one way in
 * SQLite and another way in Postgres is an account that works in one deployment and not in the
 * other, and the person hits "e-mail or password do not match" holding the right password.
 *
 * ⚠️ What is NOT proved here is said out loud, on purpose:
 *
 *   - **Postgres** runs against a real server. If Docker is not up, the tests SKIP with a message
 *     saying so. They do not pass quietly. A green test that never ran is worse than no test,
 *     because it buys confidence with nothing behind it.
 *   - **Firestore** needs the emulator. Without `FIRESTORE_EMULATOR_HOST` its tests SKIP, and the
 *     implementation is proved by reading the code and by nothing else. With it, they run for
 *     real, against the same suite as the other two.
 *
 * CI's `stores` job starts both, and says so with HOLDRIM_TEST_REQUIRE — see the test that reads it.
 *
 * To run Postgres locally:
 *   docker run -d -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *
 * To run Firestore locally:
 *   eval "$(bash scripts/firestore-emulator.sh)"
 *   npm test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { AGENT_TOKEN_FORMAT } from '../api/users.ts';
import { freshFirestoreProject } from './helpers/firestore.js';

const PG_URL = process.env.HOLDRIM_TEST_POSTGRES
  ?? 'postgres://postgres:test@127.0.0.1:55432/postgres';

/**
 * Every store under test, and for the ones that are not here, WHY.
 *
 * `open()` has to hand back an EMPTY store every time: the tests below check `isEmpty`, and a
 * leftover row from the previous test would make that pass or fail for the wrong reason.
 */
const stores = [];
const skipped = [];
const closers = [];

// --------------------------------------------------------------------- SQLite: always available
stores.push({
  name: 'sqlite',
  open: async () => new UsersSqlite(':memory:'),
});

// --------------------------------------------------------------------- Postgres: needs a server
try {
  const { UsersPostgres } = await import('../api/users-postgres.ts');
  const pg = await import('pg');
  const { Client } = pg.default ?? pg;
  const admin = new Client({ connectionString: PG_URL });
  // A five-second ceiling: a Postgres that is not there should cost the suite five seconds, not
  // the driver's default of "wait until the operating system gives up".
  await withTimeout(admin.connect(), 5000, 'connecting to Postgres');
  closers.push(() => admin.end());

  stores.push({
    name: 'postgres',
    open: async () => {
      const store = new UsersPostgres(PG_URL);
      await store.isEmpty();                       // forces the connection and creates the schema
      await admin.query('TRUNCATE sessions, users, agent_tokens');
      return store;
    },
  });
} catch (error) {
  // Two different reasons, and they need two different fixes. Telling someone to start Docker when
  // the driver is missing sends them off to debug a container that was never the problem.
  skipped.push({
    name: 'postgres',
    why: error.code === 'ERR_MODULE_NOT_FOUND'
      ? `the optional 'pg' package is not installed (${error.message}). Install it with: npm install pg`
      : `no Postgres at ${PG_URL} (${error.message}). `
        + 'Start one with: docker run -d -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine',
  });
}

// --------------------------------------------------------------------- Firestore: needs emulator
if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { UsersFirestore } = await import('../api/users-firestore.ts');
  stores.push({
    name: 'firestore',
    // A project of its own on every open, the same way events-conformance.test.js does it — not a
    // fixed name wiped before use. The emulator keeps everything every earlier test AND every other
    // run against the same emulator has ever written: two of this suite's own runs sharing one
    // emulator at the same time — this file's job and another agent's, in this same container, are
    // both real — would otherwise TRUNCATE-style wipe or overwrite each other's rows mid-test, and
    // a count or a "this session is gone" assertion would pass or fail for the wrong reason. A fresh
    // random project has nothing to wipe, because nothing has ever written to it before.
    open: async () => new UsersFirestore(freshFirestoreProject('holdrim-conformance')),
  });
} else {
  skipped.push({
    name: 'firestore',
    why: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. This '
      + 'implementation is proved by code review only — do not read this suite as evidence that '
      + 'it works. Start one with: eval "$(bash scripts/firestore-emulator.sh)", then re-run.',
  });
}

// Said on stderr as well as in the TAP output: a skip buried among a hundred passing lines is a
// skip nobody reads, and the whole point of this file is that silence never counts as proof.
for (const s of skipped) console.error(`  ⚠️  user store NOT tested: ${s.name} — ${s.why}`);

/**
 * The stores this run was promised, by name: `HOLDRIM_TEST_REQUIRE=postgres,firestore`.
 *
 * A skip is honest on a laptop, where nobody started a database. In the CI job that DID start one,
 * the same skip means the setup broke — a port moved, a password changed, the emulator never came
 * up — and the job would go green having tested SQLite alone, which is the exact silence this file
 * exists to refuse. So whoever starts a store says so, and a promised store that did not run fails.
 */
const required = (process.env.HOLDRIM_TEST_REQUIRE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
test('every store this run was told to expect actually ran', () => {
  const missing = required.filter((name) => !stores.some((s) => s.name === name));
  assert.deepEqual(missing, [], `promised by HOLDRIM_TEST_REQUIRE and not run: ${missing.join(', ')}`);
});

after(async () => {
  for (const close of closers) await close();
});

/** Rejects instead of hanging. A test suite that hangs gets killed, and killed is not "failed". */
function withTimeout(promise, ms, what) {
  let timer;
  const alarm = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}

/** Nanoseconds a promise took, as a Number of milliseconds. */
async function millisecondsOf(fn) {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * Registers the same test for every available store, and a skipped one for every store that is
 * not available — so the reason shows up in the output even when nothing ran.
 */
function forEachStore(title, body) {
  for (const store of stores) {
    // ⚠️ Firestore only: a loop over pages that never terminates — an off-by-one in what counts as
    // "the page was full", say — would otherwise hang until CI's own ten-minute ceiling, on every
    // run that touches it, and "the job never finished" is a far worse signal than a named test
    // failing in fifteen seconds. SQLite and Postgres have no such loop to run away.
    //
    // Best-effort, not a guarantee: `timeout` cancels a test whose promise is genuinely stuck, but
    // a loop that keeps making REAL round trips to the emulator — resolving, then looping again,
    // forever — keeps the event loop busy with real work the whole time, and Node has no way to
    // preempt a running `while` loop from the outside. What this buys is the common case (a bug
    // that hangs on one call that never resolves) failing fast and by name; a true runaway loop
    // still falls back to whatever kills the process from outside it — CI's own job timeout.
    const options = store.name === 'firestore' ? { timeout: 15_000 } : {};
    test(`[${store.name}] ${title}`, options, async () => {
      const s = await store.open();
      try {
        await body(s);
      } finally {
        await s.close();
      }
    });
  }
  for (const s of skipped) {
    test(`[${s.name}] ${title}`, { skip: s.why }, () => {});
  }
}

// ===================================================================== the conformance suite
forEachStore('creates a person and finds them again', async (s) => {
  await s.create('someone@example.org', 'Someone', 'a-long-enough-password');

  const found = await s.find('someone@example.org');
  assert.equal(found.email, 'someone@example.org');
  assert.equal(found.name, 'Someone');
  assert.match(found.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'createdAt is an ISO string in every store');

  assert.equal(await s.find('nobody@example.org'), null, 'an unknown e-mail is not found');
  // What comes out of the store must not carry the secret: this object reaches the HTTP layer.
  assert.equal(found.salt, undefined);
  assert.equal(found.hash, undefined);
});

forEachStore('the generated password is what gets in, and only it', async (s) => {
  const password = await s.create('x@example.org', 'X');
  assert.ok(password.length >= 12, 'a generated password nobody chose still has to be hard');

  assert.ok(await s.check('x@example.org', password), 'the right password gets in');
  assert.equal(await s.check('x@example.org', password + 'x'), null, 'the wrong one does not');
  assert.equal(await s.check('x@example.org', ''), null, 'and neither does an empty one');
});

/**
 * The property here is not "it returns null" — that is easy and any implementation does it by
 * accident. It is that checking an e-mail nobody has costs the SAME WORK as checking one that
 * exists, so the response time does not tell an attacker who has an account.
 *
 * The threshold is deliberately loose (a quarter of the real cost). A store that skipped the hash
 * would answer in a fraction of a millisecond against scrypt's tens — a difference of two orders
 * of magnitude. Measuring loosely catches that and does not turn red because the machine was busy.
 */
forEachStore('checking an e-mail that does not exist costs the same as one that does', async (s) => {
  const password = await s.create('exists@example.org', 'Exists', 'a-long-enough-password');

  await s.check('exists@example.org', 'warming-up-the-jit');      // not measured
  const known = await millisecondsOf(() => s.check('exists@example.org', 'wrong-password'));
  const unknown = await millisecondsOf(() => s.check('unknown@example.org', 'wrong-password'));

  assert.equal(await s.check('unknown@example.org', password), null);
  assert.ok(unknown > known / 4,
    `an unknown e-mail answered in ${unknown.toFixed(1)}ms against ${known.toFixed(1)}ms for a `
    + 'known one — the hash is being skipped, and the response time says who has an account');
});

forEachStore('the first password demands a change; once changed, it does not', async (s) => {
  const first = await s.create('admin@example.org', 'Admin');
  assert.equal((await s.check('admin@example.org', first)).mustChangePassword, true);
  assert.equal((await s.find('admin@example.org')).mustChangePassword, true,
    'reloading the page must not forget that the password is still the first-access one');

  await s.changePassword('admin@example.org', 'a-very-long-password');
  assert.equal((await s.check('admin@example.org', 'a-very-long-password')).mustChangePassword, false);
  assert.equal(await s.check('admin@example.org', first), null, 'the old password has to stop working');
});

forEachStore('a password created with one chosen by hand does not demand a change', async (s) => {
  await s.create('y@example.org', 'Y', 'a-long-enough-password', false);
  assert.equal((await s.check('y@example.org', 'a-long-enough-password')).mustChangePassword, false);
});

forEachStore('a short password is refused', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  await assert.rejects(() => s.changePassword('x@example.org', 'short'), /12 characters/);
  assert.ok(await s.check('x@example.org', 'a-long-enough-password'),
    'a refused change must not have half-written the new credential');
});

forEachStore('a session opens, is found, and stops being found when it closes', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const id = await s.openSession('x@example.org');

  assert.equal((await s.fromSession(id)).email, 'x@example.org');
  assert.equal(await s.fromSession('made-up'), null, 'an invented id is worth nothing');
  assert.equal(await s.fromSession(undefined), null, 'no cookie at all is not a session');

  await s.closeSession(id);
  assert.equal(await s.fromSession(id), null, 'a closed session is worth nothing');
  await s.closeSession(id);                        // closing twice must not blow up
});

forEachStore('an expired session is worth nothing, and gets purged', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const dead = await s.openSession('x@example.org', -1);      // opened already expired
  const alive = await s.openSession('x@example.org', 12);

  assert.equal(await s.fromSession(dead), null, 'past its expiry, a session does not identify anyone');
  assert.equal((await s.fromSession(alive)).email, 'x@example.org');

  await s.purgeExpiredSessions();
  assert.equal(await s.fromSession(dead), null);
  assert.equal((await s.fromSession(alive)).email, 'x@example.org',
    'the purge must not take the living ones with it');
});

forEachStore('isEmpty is true before anyone exists and false after', async (s) => {
  assert.equal(await s.isEmpty(), true, 'this is the condition for creating the first access');
  await s.create('first@example.org', 'First', 'a-long-enough-password');
  assert.equal(await s.isEmpty(), false, 'otherwise every restart would recreate the owner');
});

forEachStore('the e-mail does not depend on case or on spacing', async (s) => {
  const password = await s.create('  Someone@Example.ORG  ', 'Someone', 'a-long-enough-password');

  assert.ok(await s.check('someone@example.org', password), 'stored lowercased and trimmed');
  assert.ok(await s.check('SOMEONE@EXAMPLE.ORG', password), 'shouting still gets in');
  assert.ok(await s.find(' Someone@Example.org '), 'find normalises the same way check does');

  const id = await s.openSession('SOMEONE@example.ORG');
  assert.equal((await s.fromSession(id)).email, 'someone@example.org',
    'a session opened under one spelling has to belong to the one stored person');

  await s.changePassword('Someone@EXAMPLE.org', 'another-long-password');
  assert.ok(await s.check('someone@example.org', 'another-long-password'),
    'a change under a different spelling must reach the same row, not a second one');
});

// ===================================================================== management of people
//
// Nothing below deletes anybody, and that is the point. The event store refuses UPDATE and DELETE
// by trigger so a review history can be trusted years later; an approval signed by somebody who was
// removed would be a ✓ with no owner. Disabling takes the access away and keeps the history.

forEachStore('list gives everyone, ordered by e-mail, and carries no secret', async (s) => {
  assert.deepEqual(await s.list(), [], 'an empty store lists nobody');

  await s.create('zoe@example.org', 'Zoe', 'a-long-enough-password');
  await s.create('Ana@Example.ORG', 'Ana', 'a-long-enough-password');
  await s.create('mid@example.org', 'Mid', 'a-long-enough-password');

  const all = await s.list();
  assert.deepEqual(all.map((p) => p.email), ['ana@example.org', 'mid@example.org', 'zoe@example.org'],
    'the order is the same in every store, or the same team sees three different lists');
  assert.deepEqual(all.map((p) => p.name), ['Ana', 'Mid', 'Zoe']);
  // This list goes straight into an HTTP response: a secret here is a secret on the wire.
  for (const person of all) {
    assert.equal(person.salt, undefined, 'a listing must never carry the salt');
    assert.equal(person.hash, undefined, 'a listing must never carry the hash');
  }
});

forEachStore('whoever is created is able to get in, and list says so', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  assert.equal((await s.find('x@example.org')).enabled, true,
    'being disabled is an explicit act, never a starting state');
  assert.equal((await s.list())[0].enabled, true);
});

forEachStore('a disabled person does not get in, and is refused like a wrong password', async (s) => {
  await s.create('gone@example.org', 'Gone', 'a-long-enough-password');
  assert.ok(await s.check('gone@example.org', 'a-long-enough-password'));

  await s.setEnabled('gone@example.org', false);
  assert.equal(await s.check('gone@example.org', 'a-long-enough-password'), null,
    'the right password must stop working the moment the access is taken away');
  // The same answer as a wrong password, for the same reason: saying WHICH of the two failed
  // confirms that this address has an account here, to somebody holding no valid password.
  assert.equal(await s.check('gone@example.org', 'the-wrong-password'), null);

  // ⚠️ Still findable. Management has to SEE whoever it disabled; making them vanish from the
  // screen is indistinguishable from deleting them, which is the thing this design refuses.
  const still = await s.find('gone@example.org');
  assert.equal(still.email, 'gone@example.org', 'disabling is not deleting');
  assert.equal(still.enabled, false);
  assert.equal((await s.list()).length, 1, 'and they are still in the list');
});

forEachStore('disabling closes the door on a session that is already open', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const id = await s.openSession('x@example.org');
  assert.equal((await s.fromSession(id)).email, 'x@example.org');

  await s.setEnabled('x@example.org', false);
  // Without this, revoking an access would take effect whenever the cookie happened to expire —
  // up to twelve hours of somebody just removed still reading, still commenting, still approving.
  assert.equal(await s.fromSession(id), null,
    'a revoked access has to mean the next request, or it means nothing');
});

forEachStore('disabling DELETES the session, not just refuses it while the flag is off', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const id = await s.openSession('x@example.org');
  assert.equal((await s.fromSession(id)).email, 'x@example.org');

  await s.setEnabled('x@example.org', false);
  await s.setEnabled('x@example.org', true);
  // This is issue #113: a cookie stolen before the disable must not come back to life the moment
  // the account is restored. If the row survived the disable, re-enabling would make it valid
  // again, because `fromSession` was the ONLY thing refusing it — the flag it checked is now back
  // to `true`. The row has to be gone, not merely irrelevant for a while.
  assert.equal(await s.fromSession(id), null,
    're-enabling the account must not resurrect a session opened before the disable');
});

forEachStore('a password reset alone drops every open session for the account', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const id = await s.openSession('x@example.org');
  assert.equal((await s.fromSession(id)).email, 'x@example.org');

  // Nobody was disabled here — only the password changed. A cookie taken before the reset is
  // exactly as exposed as the credential the reset was meant to invalidate, so it has to die with
  // it, not go on working off a stolen password that no longer means anything.
  await s.resetPassword('x@example.org');
  assert.equal(await s.fromSession(id), null,
    'a reset must drop existing sessions, not just replace the credential they were opened with');
});

// ===================================================================== changing your own password
//
// Issue #115: unlike `resetPassword` above, this credential change was chosen by the very session
// that is asking for it — dropping that session too would sign the person out of the tab they just
// proved is theirs. Every other session for the account is exactly as exposed as `resetPassword`'s
// stale sessions are, so it drops those and only those.

forEachStore('changing your own password drops every OTHER session, and keeps the caller\'s', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const mine = await s.openSession('x@example.org');
  const stolen = await s.openSession('x@example.org');
  assert.equal((await s.fromSession(mine)).email, 'x@example.org');
  assert.equal((await s.fromSession(stolen)).email, 'x@example.org');

  await s.changePassword('x@example.org', 'a-new-long-password', mine);

  assert.equal(await s.fromSession(stolen), null,
    'a session that is not the one asking for the change is exactly as exposed as a stolen password');
  assert.equal((await s.fromSession(mine)).email, 'x@example.org',
    'the session that just proved it is the account owner must not be the one that pays for it');
});

forEachStore('changing your own password with no session named to keep drops nothing', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const id = await s.openSession('x@example.org');

  // `keepSessionId` omitted entirely — the shape `resetPassword` itself uses, and the one nothing in
  // this codebase actually calls `changePassword` with (the real caller, `/api/change-password`,
  // always knows its own session). Dropping every session here regardless would silently turn a
  // no-op into `resetPassword`'s job.
  const result = await s.changePassword('x@example.org', 'a-new-long-password');

  assert.equal((await s.fromSession(id)).email, 'x@example.org',
    'omitting the session to keep must not be read as "keep none of them"');
  assert.equal(result.sessionsDropped, true, 'nothing was asked to be dropped, so nothing failed');
});

forEachStore("changing one account's password does not touch another account's session", async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  await s.create('y@example.org', 'Y', 'a-long-enough-password');
  const mine = await s.openSession('x@example.org');
  const y = await s.openSession('y@example.org');

  // A delete not scoped to x's e-mail — `id != ?` alone, with the `email = ?` half dropped or
  // OR'd instead of AND'd — would still pass the single-account test above, because that one has
  // nothing else to reach. Only a second account's session can catch a WHERE clause that is too wide.
  await s.changePassword('x@example.org', 'a-new-long-password', mine);

  assert.equal((await s.fromSession(y))?.email, 'y@example.org',
    "a delete scoped to x's e-mail and x's kept session must not reach y's session at all");
});

forEachStore('every other open session is dropped, not just the first one found', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const mine = await s.openSession('x@example.org');
  const others = [await s.openSession('x@example.org'), await s.openSession('x@example.org'),
    await s.openSession('x@example.org')];

  await s.changePassword('x@example.org', 'a-new-long-password', mine);

  for (const id of others) assert.equal(await s.fromSession(id), null,
    'a delete that only reaches the first other session it finds would pass with fewer sessions open');
  assert.equal((await s.fromSession(mine)).email, 'x@example.org');
});

forEachStore('a session landing right after the change\'s credential write does not survive', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const mine = await s.openSession('x@example.org');
  // Same shape as the reset race above: whatever lands between the credential write and the delete
  // that follows it is still caught, because the delete has not run yet either.
  const originalWriteCredential = s.writeCredential.bind(s);
  let raced = null;
  s.writeCredential = async (...args) => {
    await originalWriteCredential(...args);
    raced = await s.openSession(args[0]);
  };
  await s.changePassword('x@example.org', 'a-new-long-password', mine);
  assert.equal(await s.fromSession(raced), null,
    'the delete that follows the credential write has to catch a session opened before it runs');
  assert.equal((await s.fromSession(mine)).email, 'x@example.org',
    'and still must not catch the one session this whole call exists to keep alive');
});

forEachStore('changing your own password still changes the credential when dropping the others fails', async (s) => {
  const first = await s.create('x@example.org', 'X', 'a-long-enough-password');
  const mine = await s.openSession('x@example.org');
  s.deleteSessionsForEmailExcept = async () => { throw new Error('boom'); };

  const result = await s.changePassword('x@example.org', 'a-new-long-password', mine);

  // The write happens BEFORE the delete that just failed — same ordering as the reset test above,
  // and for the same reason: a caller that let this throw would answer 500 with no
  // `password_changed` line ever written, for a credential that changed regardless.
  assert.equal(await s.check('x@example.org', first), null, 'the old password really did stop working');
  assert.ok(await s.check('x@example.org', 'a-new-long-password'), 'and the new one really does get in');
  assert.equal(result.sessionsDropped, false,
    'a delete that fails has to say so, not report a success it did not have');
});

forEachStore("disabling and resetting one account leaves another account's session alive", async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  await s.create('y@example.org', 'Y', 'a-long-enough-password');
  const y = await s.openSession('y@example.org');

  // Both operations target x only. A delete that is not actually scoped to the e-mail it was given
  // — a stray `OR` in the WHERE clause, a `.where('email', ...)` call that got dropped on the way
  // to the query — would still pass every test above, because those only ever create ONE account.
  // Nothing catches a delete that is too wide unless something else exists to be too wide onto.
  await s.setEnabled('x@example.org', false);
  await s.resetPassword('x@example.org');

  assert.equal((await s.fromSession(y))?.email, 'y@example.org',
    "a delete scoped to x's e-mail must not reach a session that belongs to y");
});

forEachStore('an account with several open sessions has every one of them dropped', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const ids = [await s.openSession('x@example.org'), await s.openSession('x@example.org'),
    await s.openSession('x@example.org')];
  for (const id of ids) assert.equal((await s.fromSession(id))?.email, 'x@example.org');

  // A delete that only reaches the FIRST session it finds — `LIMIT 1`, a loop that returns after
  // one document — would pass every single-session test above and still leave two of these three
  // cookies live. Real accounts keep more than one open session at once: a phone and a laptop, or
  // two tabs, are the ordinary case, not an edge case.
  //
  // ⚠️ Re-enabled before the check, the same way the resurrection test above does: while the flag
  // is still `false`, `fromSession`'s per-request check refuses every one of these regardless of
  // whether its ROW is gone, and a delete that missed two of the three would pass this test by
  // accident. Only after giving the access back does surviving a delete become the one thing left
  // that could make a check here pass.
  await s.setEnabled('x@example.org', false);
  await s.setEnabled('x@example.org', true);
  for (const id of ids) assert.equal(await s.fromSession(id), null);
});

forEachStore('a session landing right after the disable flag is written does not survive re-enable', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  // Stages the write-then-race the delete inside `setEnabled` has to survive: a session opened in
  // the instant right after the flag flips to `false`, before the delete that follows it runs. This
  // is `setEnabled`'s OWN internal ordering, not the sign-in race in `identity-password.ts` — the
  // point here is that whatever lands between the write and the delete is still caught, because the
  // delete has not run yet either.
  const originalWriteEnabled = s.writeEnabled.bind(s);
  let raced = null;
  s.writeEnabled = async (email, enabled) => {
    await originalWriteEnabled(email, enabled);
    if (!enabled) raced = await s.openSession(email);
  };
  await s.setEnabled('x@example.org', false);
  await s.setEnabled('x@example.org', true);
  assert.equal(await s.fromSession(raced), null,
    'the delete that follows the flag write has to catch a session opened before it runs');
});

forEachStore('a session landing right after the reset credential is written does not survive', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const originalWriteCredential = s.writeCredential.bind(s);
  let raced = null;
  s.writeCredential = async (...args) => {
    await originalWriteCredential(...args);
    raced = await s.openSession(args[0]);
  };
  await s.resetPassword('x@example.org');
  assert.equal(await s.fromSession(raced), null,
    'the delete that follows the credential write has to catch a session opened before it runs');
});

forEachStore('re-enabling an already enabled account keeps its session', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  const id = await s.openSession('x@example.org');

  // The route never checks whether an account was already enabled before calling `setEnabled(true)`
  // on it — asking to give an access back that was never taken away is a 200, not a 400. Dropping
  // the `if (!enabled)` guard and deleting on every call regardless would pass every test above
  // that disables first, and would still be wrong here: this account was never disabled at all.
  await s.setEnabled('x@example.org', true);
  assert.equal((await s.fromSession(id))?.email, 'x@example.org',
    'enabling an account that was already enabled must not drop a session that never needed dropping');
});

forEachStore('a reset still changes the password when dropping sessions fails, and admits the drop failed', async (s) => {
  const first = await s.create('x@example.org', 'X', 'a-long-enough-password');
  s.deleteSessionsForEmail = async () => { throw new Error('boom'); };

  const reset = await s.resetPassword('x@example.org');
  // The write happens BEFORE the delete that just failed. A caller that let the failure through
  // would answer 500 with no `user_password_reset` line ever written — the credential change
  // happened regardless, and the one record of it would not exist.
  assert.ok(reset.password, 'the credential change must go through even though the cleanup after it failed');
  assert.equal(await s.check('x@example.org', first), null, 'the old password really did stop working');
  // The store no longer decides how this is said out loud — it used to be a `console.error` with
  // the e-mail in it, which was itself the bug (docs/PRIVACY.md: a log names a person by id, never
  // an address). It only has to say, truthfully, that the drop did not happen — the route above
  // turns that into the `ERROR` log line and the `sessionsDropped: false` the caller sees.
  assert.equal(reset.sessionsDropped, false,
    'a delete that fails has to say so, not report a success it did not have');
});

forEachStore('disabling still takes effect when dropping sessions fails, and admits the drop failed', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  s.deleteSessionsForEmail = async () => { throw new Error('boom'); };

  const result = await s.setEnabled('x@example.org', false);
  assert.equal(await s.check('x@example.org', 'a-long-enough-password'), null,
    'the account really is disabled even though the cleanup after it failed');
  assert.equal(result.sessionsDropped, false,
    'a delete that fails has to say so, not report a success it did not have');
});

forEachStore('a disable that works, and the re-enable that follows it, both say so', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');

  // Nothing failed on either call, so both have to say `true` — not merely "not false", and not
  // left for the caller to assume. A disable that flips `sessionsDropped: (await
  // this.#dropSessions(normalized)) && false` here would still delete the sessions correctly and
  // still be wrong to report, which is exactly what a caller reads to decide whether to warn.
  assert.equal((await s.setEnabled('x@example.org', false)).sessionsDropped, true,
    'the delete succeeded, so the answer has to say it worked');
  assert.equal((await s.setEnabled('x@example.org', true)).sessionsDropped, true,
    'giving the access back runs no delete at all, so this is vacuously true — never `false`');
});

forEachStore('an access given back works again, with the same password', async (s) => {
  await s.create('back@example.org', 'Back', 'a-long-enough-password');
  await s.setEnabled('back@example.org', false);
  assert.equal(await s.check('back@example.org', 'a-long-enough-password'), null);

  await s.setEnabled('back@example.org', true);
  assert.ok(await s.check('back@example.org', 'a-long-enough-password'),
    'disabling is reversible — the credential was never touched');
  assert.equal((await s.find('back@example.org')).enabled, true);
});

forEachStore('setEnabled reaches the same row whatever the spelling of the e-mail', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');
  await s.setEnabled('  X@Example.ORG  ', false);
  assert.equal(await s.check('x@example.org', 'a-long-enough-password'), null,
    'a second row created by a different spelling would leave the first one still able to get in');
});

forEachStore('rename changes the name and nothing else', async (s) => {
  const password = await s.create('x@example.org', 'Typo Here', 'a-long-enough-password');
  await s.rename('X@EXAMPLE.org', '  Corrected Name  ');

  const person = await s.find('x@example.org');
  assert.equal(person.name, 'Corrected Name', 'the surrounding spaces are not part of a name');
  assert.equal(person.email, 'x@example.org', 'the e-mail is the identity and does not move');
  assert.ok(await s.check('x@example.org', password), 'a rename must not touch the credential');
  assert.equal((await s.list())[0].name, 'Corrected Name');
});

forEachStore('a reset hands over a new password and demands it be changed', async (s) => {
  const first = await s.create('x@example.org', 'X', 'chosen-by-the-person', false);
  assert.equal((await s.check('x@example.org', first)).mustChangePassword, false);

  const { password: reset, sessionsDropped } = await s.resetPassword('X@Example.ORG');
  assert.notEqual(reset, first, 'a reset that handed back the same secret would reset nothing');
  assert.ok(reset.length >= 12, 'a password nobody chose still has to be hard');
  assert.equal(await s.check('x@example.org', first), null, 'the old password has to stop working');
  assert.equal(sessionsDropped, true, 'nothing failed here, so the drop has to say it worked');

  // ⚠️ The change is demanded because somebody OTHER than the owner of the account has seen this
  // password — whoever ran the reset, and whatever channel carried it over.
  assert.equal((await s.check('x@example.org', reset)).mustChangePassword, true);
});

forEachStore('an empty name is refused, and the old one survives the refusal', async (s) => {
  await s.create('x@example.org', 'Real Name', 'a-long-enough-password');
  await assert.rejects(() => s.rename('x@example.org', '   '), /name cannot be empty/);
  assert.equal((await s.find('x@example.org')).name, 'Real Name',
    'a refused rename must not have half-written the blank');
});

// ===================================================================== Firestore only: pages
//
// Firestore is the one store whose delete cannot be a single query: it reads a page of matching
// documents and deletes them, and a session count past that page's limit needs a second round trip
// to reach at all. Nothing above exercises more than a handful of sessions, so a `.limit(1)` typo or
// a delete that runs once and calls it done would pass the whole suite above and still leave most of
// an account's sessions alive. SQLite and Postgres have no such limit to get wrong, hence no store
// for this test but Firestore's own.
if (process.env.FIRESTORE_EMULATOR_HOST) {
  test('[firestore] deleting sessions reaches past a single page (401 of them, one page over the limit)',
    { timeout: 30_000 }, async () => {
      const { UsersFirestore } = await import('../api/users-firestore.ts');
      const s = new UsersFirestore(freshFirestoreProject('holdrim-conformance'));
      try {
        await s.create('x@example.org', 'X', 'a-long-enough-password');
        const ids = [];
        for (let i = 0; i < 401; i++) ids.push(await s.openSession('x@example.org'));

        // Re-enabled before the check: while the account is still disabled, `fromSession`'s
        // per-request check refuses every one of these regardless of whether its ROW survived the
        // delete — the flag alone would make a loop that stops after the first page pass this test
        // by accident. Only once access is given back does outliving the delete become the one
        // thing left that could make a check here succeed.
        await s.setEnabled('x@example.org', false);
        await s.setEnabled('x@example.org', true);

        const alive = (await Promise.all(ids.map((id) => s.fromSession(id)))).filter(Boolean).length;
        assert.equal(alive, 0,
          'a one-shot delete, or a loop that stops after the first page, would leave the sessions '
          + 'past the 400th one alive');
      } finally {
        await s.close();
      }
    });
} else {
  test('[firestore] deleting sessions reaches past a single page (401 of them, one page over the limit)',
    { skip: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. Start one with: '
      + 'eval "$(bash scripts/firestore-emulator.sh)", then re-run.' }, () => {});
}

// Round 1 review of #115 (MAJOR, proof): the "except" pagination has the same page boundary as
// `deleteSessionsForEmail` above, but nothing exercised it — the "except" tests earlier in this file
// open only a handful of sessions, and the pagination test just above drives `deleteSessionsForEmail`,
// where nothing is ever excluded and `queued` always equals `page.size`. A mutant that reads
// `queued === 400` instead of `page.size === 400` (`#deleteSessionPage`, users-firestore.ts) survived
// every test that existed before this one — this is the test that catches it.
forEachStore('the kept session survives even past a single delete page, and every other one is gone', async (s) => {
  await s.create('x@example.org', 'X', 'a-long-enough-password');

  // Crafted, not random: `!` (0x21) sorts before every character `openSession`'s base64url ids use
  // (`-0-9A-Za-z_`, all 0x2D or higher), and a plain `.where(...).limit(...)` query with no
  // `orderBy` reads Firestore documents back in ascending id order — checked against the real
  // emulator, not merely assumed. That lands this ONE session inside the FIRST page a paginated
  // delete reads, which is the only place `#deleteSessionPage`'s "how many documents did the QUERY
  // return" and "how many did this call actually delete" can ever come apart: with fewer sessions,
  // or the kept one happening to fall on the always-short LAST page, the two numbers are always
  // equal and a bug that confused them would pass unnoticed regardless of how many sessions exist.
  // `insertSession` bypasses `openSession`'s random id on purpose, to CHOOSE where this one lands
  // rather than hope for it; every store implements it, so this same test is portable to all three,
  // even though only Firestore's delete has a page boundary to get wrong.
  const mine = '!!!!!!!!the-kept-session';
  const now = new Date();
  await s.insertSession(mine, 'x@example.org', now.toISOString(),
    new Date(now.getTime() + 12 * 3600_000).toISOString());
  const others = [];
  for (let i = 0; i < 401; i++) others.push(await s.openSession('x@example.org'));

  await s.changePassword('x@example.org', 'a-new-long-password', mine);

  assert.equal((await s.fromSession(mine)).email, 'x@example.org',
    'the one session named to survive has to still be there once the account has more sessions '
    + 'than a single delete page can hold');
  const alive = (await Promise.all(others.map((id) => s.fromSession(id)))).filter(Boolean).length;
  assert.equal(alive, 0,
    'a loop that stops the moment it sees the kept session sitting in a FULL page would leave every '
    + 'session past that page alive — this is the boundary a plain "a handful of sessions" test, or '
    + 'one that never excludes anybody, cannot reach');
});

// ===================================================================== agent tokens (issue #122)
/** The public id and the secret a token carries, as `AGENT_TOKEN_FORMAT` reads them. */
const partsOf = (token) => {
  const m = AGENT_TOKEN_FORMAT.exec(token);
  assert.ok(m, `not a token: ${token}`);
  return { id: m[1], secret: m[2] };
};

forEachStore('an agent token is issued once, and names its agent back with kind agent', async (s) => {
  const { token, agent, tokenId, replaced } = await s.issueAgentToken(' Bot@Example.org ');
  assert.equal(partsOf(token).id, tokenId);
  assert.equal(replaced, null, 'nothing was replaced on a first issue');
  assert.deepEqual(agent, { email: 'bot@example.org', kind: 'agent', issuedAt: agent.issuedAt });
  assert.match(agent.issuedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(await s.fromAgentToken(token), agent);
});

forEachStore('a token that is not the one issued opens nothing: another secret, an unknown id, a malformed one', async (s) => {
  const { token } = await s.issueAgentToken('bot@example.org');
  const { id, secret } = partsOf(token);
  const other = secret.slice(0, -1) + (secret.endsWith('0') ? '1' : '0');
  assert.equal(await s.fromAgentToken(`holdrim_agent_${id}_${other}`), null, 'the right id with another secret');
  assert.equal(await s.fromAgentToken(`holdrim_agent_${'0'.repeat(24)}_${secret}`), null, 'the right secret under another id');
  for (const bad of [undefined, '', token.toUpperCase(), ` ${token}`, `${token}x`, secret, id]) {
    assert.equal(await s.fromAgentToken(bad), null, String(bad));
  }
});

forEachStore('re-issuing revokes the previous token at once, and says which one it replaced', async (s) => {
  // Owner decision 3 (issue #122): one token per agent address.
  const first = await s.issueAgentToken('bot@example.org');
  const second = await s.issueAgentToken('bot@example.org');
  assert.equal(await s.fromAgentToken(first.token), null, 'the old token still opens the door after a re-issue');
  assert.equal((await s.fromAgentToken(second.token))?.email, 'bot@example.org');
  assert.equal(second.replaced, first.tokenId);
  assert.equal((await s.listAgentTokens()).length, 1, 'one address, one token');
});

forEachStore('revoking makes the token fail at once, and a second revoke finds nothing to revoke', async (s) => {
  const { token, tokenId } = await s.issueAgentToken('bot@example.org');
  const kept = await s.issueAgentToken('other@example.org');
  assert.equal(await s.revokeAgentToken('BOT@example.org'), tokenId, 'revoked by its address, normalized');
  assert.equal(await s.fromAgentToken(token), null);
  assert.equal(await s.revokeAgentToken('bot@example.org'), null);
  assert.equal((await s.fromAgentToken(kept.token))?.email, 'other@example.org', 'another agent\'s token is untouched');
  assert.deepEqual((await s.listAgentTokens()).map((a) => a.email), ['other@example.org']);
});

forEachStore('the list of agent tokens carries no secret, no hash and no id, ordered by address', async (s) => {
  const issued = [await s.issueAgentToken('zed@example.org'), await s.issueAgentToken('abe@example.org')];
  const list = await s.listAgentTokens();
  assert.deepEqual(list.map((a) => a.email), ['abe@example.org', 'zed@example.org']);
  for (const a of list) assert.deepEqual(Object.keys(a).sort(), ['email', 'issuedAt', 'kind']);
  const said = JSON.stringify(list);
  for (const { token, tokenId } of issued) {
    assert.ok(!said.includes(partsOf(token).secret) && !said.includes(tokenId), 'a token\'s secret or id is in the list');
  }
});
