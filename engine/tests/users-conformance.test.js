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
      await admin.query('TRUNCATE sessions, users');
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
  const project = process.env.HOLDRIM_PROJECT ?? 'holdrim-conformance';
  stores.push({
    name: 'firestore',
    open: async () => {
      const store = new UsersFirestore(project);
      const { Firestore } = await import('@google-cloud/firestore');
      const db = new Firestore({ projectId: project });
      for (const collection of ['users', 'sessions']) {
        const docs = await db.collection(collection).get();
        await Promise.all(docs.docs.map((d) => d.ref.delete()));
      }
      await db.terminate();
      return store;
    },
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
    test(`[${store.name}] ${title}`, async () => {
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

  const reset = await s.resetPassword('X@Example.ORG');
  assert.notEqual(reset, first, 'a reset that handed back the same secret would reset nothing');
  assert.ok(reset.length >= 12, 'a password nobody chose still has to be hard');
  assert.equal(await s.check('x@example.org', first), null, 'the old password has to stop working');

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
