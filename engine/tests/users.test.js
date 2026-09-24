/**
 * Own authentication and storage with no cloud — what lets Holdrim be used the way Keycloak is:
 * bring it up, log in, work.
 *
 * Behaviour every store has to share is NOT here: it lives in users-conformance.test.js, which
 * runs one suite against all of them. What stays here is what is specific — the bytes SQLite
 * writes to disk, the event store's refusal to erase, and the cookie the identity layer hands out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { ephemeralUserStoreWarning, looksEphemeral, isEmailAddress, maskCredentials } from '../api/users.ts';
import { PasswordIdentity, SESSION_COOKIE } from '../api/identity-password.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'holdrim-users-'));

test('the password is never stored as text', async () => {
  const dir = scratch();
  const path = join(dir, 'users.db');
  try {
    const store = new UsersSqlite(path);
    const password = await store.create('x@example.org', 'X', 'secret-test-password');
    await store.close();
    // Read the raw file: the password cannot be anywhere in it.
    const raw = readFileSync(path).toString('latin1');
    assert.equal(raw.includes('secret-test-password'), false, 'the password showed up in the database file');
    assert.ok(password);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session: it opens, it holds, and it stops holding on logout', async () => {
  const store = new UsersSqlite(':memory:');
  const password = await store.create('x@example.org', 'X');
  const id = new PasswordIdentity(store, { secure: false });
  const r = await id.signIn('x@example.org', password);
  assert.ok(r);
  assert.equal((await id.fromRequest({ cookie: `${SESSION_COOKIE}=${r.session}` }))?.email, 'x@example.org');
  assert.equal(await id.fromRequest({ cookie: `${SESSION_COOKIE}=made-up` }), null);
  assert.equal(await id.fromRequest({}), null);
  await store.closeSession(r.session);
  assert.equal(await id.fromRequest({ cookie: `${SESSION_COOKIE}=${r.session}` }), null, 'a closed session is worth nothing');
});

test('the session cookie is not readable by JavaScript and does not travel to another site', () => {
  const id = new PasswordIdentity(new UsersSqlite(':memory:'), { secure: true });
  const header = id.sessionCookie('abc');
  assert.match(header, /^holdrim_session=abc;/, 'the cookie carries the engine\'s own name');
  assert.match(header, /HttpOnly/, 'without HttpOnly, an XSS steals the session');
  assert.match(header, /SameSite=Strict/, 'without SameSite, navigation brings CSRF');
  assert.match(header, /Secure/, 'outside development the session cannot travel in the clear');
  // Development serves over plain HTTP, where a Secure cookie is a cookie the browser drops.
  assert.doesNotMatch(new PasswordIdentity(new UsersSqlite(':memory:'), { secure: false }).sessionCookie('abc'), /Secure/);
  assert.match(id.signOutCookie(), /Max-Age=0/, 'signing out has to kill the cookie, not only the row');
});

test('the first access is created only once', async () => {
  const id = new PasswordIdentity(new UsersSqlite(':memory:'), { secure: false });
  assert.ok(await id.firstAccess('owner@example.org'));
  assert.equal(await id.firstAccess('other@example.org'), null, 'it does not recreate when someone is already there');
});

test('the database REFUSES to alter and to delete an event', async () => {
  const dir = scratch();
  const path = join(dir, 'events.db');
  try {
    const store = new SqliteEventStore(path);
    await store.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'abc', text: null, snapshot: null, data: null }, 'owner@example.org');
    await store.close();
    // Open it from outside, the way anyone with access to the disk would.
    const db = new DatabaseSync(path);
    assert.throws(() => db.exec('DELETE FROM events'), /trail/, 'deleting has to be refused');
    assert.throws(() => db.exec("UPDATE events SET author='other@x'"), /trail/, 'altering has to be refused');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the database REFUSES to replace an event, in both REPLACE forms', async () => {
  const dir = scratch();
  const path = join(dir, 'events.db');
  try {
    const store = new SqliteEventStore(path);
    const e = await store.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'abc', text: null, snapshot: null, data: null }, 'owner@example.org');
    // The column holds the owner's person id, not the address (docs/PRIVACY.md, section 1).
    const owner = await store.personFor('owner@example.org');
    await store.close();
    // From outside, as for the test above: REPLACE deletes and re-inserts, and no delete trigger
    // fires for it, so only a guard on the insert itself stands in its way.
    const db = new DatabaseSync(path);
    const forged = `(id, type, page, block, fingerprint, author, happened_at)
      VALUES ('${e.id}', 'approval', 'A01', 'A01.1.1', 'forged', 'intruder@example.org', '${e.when}')`;
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO events ${forged}`), /not replaced/, 'INSERT OR REPLACE has to be refused');
    assert.throws(() => db.exec(`REPLACE INTO events ${forged}`), /not replaced/, 'REPLACE INTO has to be refused');
    // `events` is a rowid table: a held rowid under a new id is a conflict too, and REPLACE would
    // drop the ✓ on it just the same, leaving its id free to be inserted again with forged content.
    const { rowid } = db.prepare('SELECT rowid FROM events WHERE id = ?').get(e.id);
    const byRowid = `(rowid, id, type, page, block, fingerprint, author, happened_at)
      VALUES (${rowid}, 'forged', 'approval', 'A01', 'A01.1.1', 'forged', 'intruder@example.org', '${e.when}')`;
    assert.throws(() => db.exec(`INSERT OR REPLACE INTO events ${byRowid}`), /not replaced/, 'INSERT OR REPLACE on a held rowid has to be refused');
    assert.throws(() => db.exec(`REPLACE INTO events ${byRowid}`), /not replaced/, 'REPLACE INTO on a held rowid has to be refused');
    const row = db.prepare('SELECT fingerprint, author FROM events WHERE id = ?').get(e.id);
    assert.deepEqual({ ...row }, { fingerprint: 'abc', author: owner }, 'the original event stays as it was');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sqlite store keeps and gives back the whole event', async () => {
  const store = new SqliteEventStore(':memory:');
  const e = await store.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'x',
    text: 'swap the term', snapshot: 'the text as it was then', data: { category: 'term' } }, 'reviewer@example.org');
  const [read] = await store.list('A01');
  assert.deepEqual({ ...read }, { ...e }, 'what comes out has to be what went in');
  assert.deepEqual(read.data, { category: 'term' }, 'data comes back as an object, not as text');
  assert.equal((await store.list('A02')).length, 0, 'the filter by page works');
  assert.equal(read.author, 'reviewer@example.org');
  assert.match(read.when, /^\d{4}-\d{2}-\d{2}T/, 'the server clock stamps the event');
});

test('a folder that cannot be written is explained, not just refused', () => {
  // The raw SQLite error says "unable to open database file", which names neither where nor why.
  // A path under a FILE (not a folder) is the cheapest way to make the open fail on any machine.
  const dir = scratch();
  try {
    const notAFolder = join(dir, 'file');
    writeFileSync(notAFolder, '');
    assert.throws(() => new SqliteEventStore(join(notAFolder, 'events.db')), /could not open the database at/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The combination that loses people: a file, on a disk that does not survive the instance.
 *
 * The false positive is tested as hard as the true one. A warning that fires on a laptop, where a
 * file is the right answer, is a warning everybody learns to scroll past — and then it says
 * nothing on the day it is true.
 */
test('it warns when people are kept in a file on a runtime that looks ephemeral', () => {
  const warning = ephemeralUserStoreWarning('sqlite:/data/users.db', { K_SERVICE: 'holdrim' });
  assert.ok(warning, 'a file plus an ephemeral runtime is exactly the case that has to be announced');
  assert.match(warning, /recycles/, 'it has to say what will happen, not only that something is wrong');
  assert.match(warning, /HOLDRIM_USERS=firestore/, 'it has to say what to do instead');
  assert.match(warning, /postgres/, 'the other way out belongs in the same line');
});

test('the default store warns too: not configuring it is how people get there', () => {
  assert.ok(ephemeralUserStoreWarning(undefined, { K_SERVICE: 'holdrim' }));
  assert.ok(ephemeralUserStoreWarning('sqlite', { K_SERVICE: 'holdrim' }));
});

test('it stays quiet when nothing is at stake', () => {
  const ephemeral = { K_SERVICE: 'holdrim' };
  assert.equal(ephemeralUserStoreWarning('sqlite::memory:', ephemeral), null, 'memory is already understood to be thrown away');
  assert.equal(ephemeralUserStoreWarning('sqlite://:memory:', ephemeral), null, 'the // form names the same store');
  assert.equal(ephemeralUserStoreWarning('firestore', ephemeral), null, 'firestore survives the instance');
  assert.equal(ephemeralUserStoreWarning('postgres://u:p@host/db', ephemeral), null, 'and so does postgres');
  assert.equal(ephemeralUserStoreWarning('sqlite:/data/users.db', {}), null, 'on a laptop a file is the right answer');
});

test('K_SERVICE is a signal, and an empty one is no signal at all', () => {
  assert.equal(looksEphemeral({}), false);
  assert.equal(looksEphemeral({ K_SERVICE: '' }), false, 'an empty variable is evidence of nothing');
  assert.equal(looksEphemeral({ K_SERVICE: 'holdrim' }), true);
});

test('a connection string is quoted with its credentials hidden', () => {
  // The message reaches console.error, which on a hosted runtime is the log collector.
  assert.equal(maskCredentials('postgres://user:secret@host/db'), 'postgres://***@host/db');
  assert.equal(maskCredentials('sqlite:./data/users.db'), 'sqlite:./data/users.db', 'nothing to hide, nothing changed');
});

/**
 * The check on the way in is deliberately shallow, and these are the cases it has to get right.
 *
 * It exists for one failure: somebody types a NAME into the e-mail box, an access is created that
 * nobody can ever sign in to, and it cannot be taken back afterwards because nothing here is
 * deleted. What it must NOT do is turn into an RFC 5322 parser — those are famous for rejecting
 * addresses that work, and a door that refuses a real person is worse than one that admits a typo.
 */
test('an address is told apart from a name, without pretending to parse RFC 5322', () => {
  assert.equal(isEmailAddress('someone@example.org'), true);
  assert.equal(isEmailAddress('  Someone@Example.ORG  '), true, 'it is checked after trimming');
  assert.equal(isEmailAddress('root@localhost'), true,
    'no dot is demanded: single-label hosts are real, and this is not the place to decide what '
    + "somebody else's network looks like");
  assert.equal(isEmailAddress('first+tag@example.co.uk'), true);

  assert.equal(isEmailAddress(''), false, 'an empty field is the commonest way to get here');
  assert.equal(isEmailAddress('   '), false);
  assert.equal(isEmailAddress('A Member'), false, 'the name typed into the e-mail box');
  assert.equal(isEmailAddress('@example.org'), false, 'nothing before the @');
  assert.equal(isEmailAddress('someone@'), false, 'nothing after it');
  assert.equal(isEmailAddress('a@b@c'), false, 'two of them is not an address');
  assert.equal(isEmailAddress('a'.repeat(320) + '@example.org'), false,
    'past the longest address RFC 5321 allows it is not a typo, it is a payload');
});
