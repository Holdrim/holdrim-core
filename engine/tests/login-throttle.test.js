import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PasswordIdentity } from '../api/identity-password.ts';
import { UsersSqlite } from '../api/users-sqlite.ts';

/**
 * Online brute force, and why the counter is per e-mail.
 *
 * Behind an identity proxy, nobody reaches the login form without being let in first. Answering
 * on the open internet with only a password changes that: the form
 * is found by a scanner within hours, and an unthrottled form is an invitation to try passwords
 * for as long as anyone feels like it.
 */
const store = () => new UsersSqlite(':memory:');

test('five wrong passwords cost nothing; the sixth starts costing', async () => {
  const id = new PasswordIdentity(store(), { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 5; i++) assert.equal(await id.signIn('someone@example.org', 'wrong'), null);
  assert.equal(await id.remainingWait('someone@example.org'), 0, 'five is still free');

  assert.equal(await id.signIn('someone@example.org', 'wrong'), null);
  assert.ok(await id.remainingWait('someone@example.org') > 0, 'the sixth buys a wait');
});

test('while the wait is on, even the RIGHT password does not get in', async () => {
  // The part that makes it worth anything. A throttle that lets the right password through on the
  // first try after the lock is a throttle an attacker walks past.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  const right = await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 6; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(await id.remainingWait('someone@example.org') > 0);
  assert.equal(await id.signIn('someone@example.org', right), null, 'locked means locked');
});

test('the wait grows, instead of being a fixed pause', async () => {
  const id = new PasswordIdentity(store(), { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 6; i++) await id.signIn('someone@example.org', 'wrong');
  const first = await id.remainingWait('someone@example.org');
  for (let i = 0; i < 3; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(await id.remainingWait('someone@example.org') > first, 'each failure costs more than the last');
});

test('one e-mail being locked never locks another', async () => {
  // Counting per IP instead would let one person lock out a whole office behind one proxy.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');
  const other = await users.create('other@example.org', 'Other');

  for (let i = 0; i < 8; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(await id.remainingWait('someone@example.org') > 0);
  assert.equal(await id.remainingWait('other@example.org'), 0);
  assert.ok(await id.signIn('other@example.org', other), 'the neighbour still gets in');
});

test('a successful login clears the count', async () => {
  const id = new PasswordIdentity(store(), { secure: false });
  const right = await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 4; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(await id.signIn('someone@example.org', right));
  for (let i = 0; i < 5; i++) assert.equal(await id.signIn('someone@example.org', 'wrong'), null);
  assert.equal(await id.remainingWait('someone@example.org'), 0, 'the count restarted from zero');
});

test('an oversized e-mail or password is refused before it costs anything', async () => {
  // `/api/sign-in` is the one route that answers without a session, so its cost is the cost anyone
  // can impose. scrypt on a megabyte of text is a CPU bill, not a login.
  // Both attempts would be refused anyway — no such account, wrong password — so a `null` says
  // nothing about the guard, and a test that looked only at it would pass with the guard deleted.
  // What only the guard produces is a store that was never asked: no scrypt, no place taken in the
  // counter.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');
  const check = users.check.bind(users);
  let asked = 0;
  users.check = (email, password) => { asked++; return check(email, password); };

  // The limits written out (RFC 5321's 320, and 256), not read from the class: a limit quietly
  // raised is exactly what this has to notice.
  const address = (length) => 'x'.repeat(length - '@example.org'.length) + '@example.org';
  assert.equal(await id.signIn(address(321), 'whatever'), null);
  assert.equal(await id.signIn('someone@example.org', 'y'.repeat(257)), null);
  assert.equal(asked, 0, 'the store was never asked, so scrypt never ran');
  assert.equal((await id.tracked()), 0, 'and neither attempt counted as a try');

  // One under each limit is a real attempt: the line is where it says it is, not somewhere lower.
  await id.signIn(address(320), 'whatever');
  await id.signIn('someone@example.org', 'y'.repeat(256));
  assert.equal(asked, 2, 'at the limit, the password is checked');
});

test('invented e-mails cannot grow the counter without bound', async () => {
  // The attack this closes: POST a different invented address in a loop, with no credential, and
  // add one permanent entry per request until the process runs out of memory. Entries removed only
  // on a SUCCESSFUL login of that same key would never go — an attacker never performs one.
  const id = new PasswordIdentity(store(), { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');
  // The real ceiling is 10.000, and proving it at that size costs ten minutes of scrypt. The
  // ceiling is the same code either way, so the test lowers it and runs in a second.
  id.maxTracked = 50;

  for (let i = 0; i < 200; i++) await id.signIn(`invented-${i}@example.org`, 'wrong');
  const tracked = await id.tracked();
  assert.ok(tracked <= 50, `stopped growing at 50, got ${tracked}`);
});

test('the current password asked for by change-password counts on the same e-mail as a sign-in', async () => {
  // Same secret, same counter: otherwise guessing it through change-password, with a stolen
  // session, would cost nothing at all — and whatever it found would sign in anywhere later.
  const id = new PasswordIdentity(store(), { secure: false });
  const right = await id.firstAccess('someone@example.org', 'Someone');
  assert.equal((await id.checkCurrent('someone@example.org', right))?.email, 'someone@example.org');

  for (let i = 0; i < 6; i++) assert.equal(await id.checkCurrent('someone@example.org', 'wrong'), null);
  assert.ok(await id.remainingWait('someone@example.org') > 0, 'the sixth wrong one buys a wait');
  assert.equal(await id.checkCurrent('someone@example.org', right), null, 'and the right one waits too');
  assert.equal(await id.signIn('someone@example.org', right), null, 'so does signing in');
});

/** A users file of its own, removed after `body`, so a test can close its store and open it again. */
async function withUsersFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-throttle-'));
  try {
    await body(join(dir, 'users.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a restart forgets nothing: the wait survives the store being closed and opened again', async () => {
  // The restart is real: the first store is CLOSED, and a second one opens the same file with no
  // object shared between them. A counter that merely lived longer, in the process or on one
  // connection, passes every test above and fails this one.
  await withUsersFile(async (path) => {
    const before = new UsersSqlite(path);
    const right = await new PasswordIdentity(before, { secure: false }).firstAccess('someone@example.org', 'Someone');
    const first = new PasswordIdentity(before, { secure: false });
    for (let i = 0; i < 6; i++) await first.signIn('someone@example.org', 'wrong');
    assert.ok(await first.remainingWait('someone@example.org') > 0);
    await before.close();

    const after = new UsersSqlite(path);
    try {
      const second = new PasswordIdentity(after, { secure: false });
      assert.ok(await second.remainingWait('someone@example.org') > 0, 'the wait came back with the file');
      assert.equal(await second.signIn('someone@example.org', right), null, 'and the right password still waits');
      assert.equal((await after.readSignInFailures('someone@example.org'))?.count, 7,
        'the count went on from where it was, not from zero');
    } finally {
      await after.close();
    }
  });
});

test('the file keeps a hash of the typed address, never the address', async () => {
  // Most of what is typed at a sign-in form names nobody here — a typo of a colleague's private
  // address, an attacker's list — and no removal procedure would ever find it in this table.
  await withUsersFile(async (path) => {
    const users = new UsersSqlite(path);
    const id = new PasswordIdentity(users, { secure: false });
    await id.signIn(' Typo@Example.ORG ', 'wrong');
    await users.close();

    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare('SELECT * FROM sign_in_failures').all();
      assert.equal(rows.length, 1);
      assert.equal(JSON.stringify(rows).toLowerCase().includes('typo'), false, 'the address is in the file');
      assert.equal(rows[0].key, createHash('sha256').update('typo@example.org').digest('hex'),
        'the key is the address normalised and hashed, the same on every instance');
    } finally {
      db.close();
    }
  });
});

test('an address with no account is counted exactly like one with an account', async () => {
  // Counting only real accounts would put a write on one path and not the other, and the time a
  // wrong password takes would say who has an account.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');
  for (let i = 0; i < 6; i++) {
    await id.signIn('someone@example.org', 'wrong');
    await id.signIn('nobody@example.org', 'wrong');
  }
  assert.deepEqual(
    [(await users.readSignInFailures('someone@example.org'))?.count, (await users.readSignInFailures('nobody@example.org'))?.count],
    [6, 6]);
  assert.equal(await id.remainingWait('nobody@example.org'), await id.remainingWait('someone@example.org'),
    'and the one nobody has waits the same');
});

test('a clock stepped back never stretches a wait past what the count allows', async () => {
  // A row whose last failure reads a day AHEAD: the clock was stepped back after it was written, or
  // another instance's clock runs fast. Read as a deadline, the address would wait a day.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  await users.updateSignInFailures('someone@example.org',
    () => ({ count: 6, lastAt: new Date(Date.now() + 86_400_000).toISOString() }));
  const wait = await id.remainingWait('someone@example.org');
  assert.ok(wait > 0 && wait <= 5, `six failures buy five seconds at most, got ${wait}`);
});

test('a count is forgotten an hour after its wait ends, and starts again from one', async () => {
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  // Twenty failures, the last one two hours ago: its fifteen-minute wait ended an hour and three
  // quarters ago.
  await users.updateSignInFailures('someone@example.org',
    () => ({ count: 20, lastAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }));
  assert.equal(await id.remainingWait('someone@example.org'), 0, 'nothing left to wait');
  await id.signIn('someone@example.org', 'wrong');
  assert.equal((await users.readSignInFailures('someone@example.org'))?.count, 1, 'counting restarted');
});

test('a row past remembering is removed from the store, and one that may still count is not', async () => {
  // Forgetting on reading is not enough: a row nothing reads again would stay in the file for good.
  // The prune's cutoff is the oldest a row can be and still count — seventy-five minutes, for a
  // fifteen-minute wait and the hour after it — so it has to take the first row and leave the second.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  await users.updateSignInFailures('old@example.org', () => ({ count: 20, lastAt: ago(80) }));
  await users.updateSignInFailures('recent@example.org', () => ({ count: 20, lastAt: ago(70) }));
  await id.signIn('someone@example.org', 'wrong');
  assert.equal(await users.readSignInFailures('old@example.org'), null, 'the stale row is still there');
  assert.equal((await users.readSignInFailures('recent@example.org'))?.count, 20,
    'a row whose wait ended under an hour ago went too early');
});
