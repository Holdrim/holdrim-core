import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(id.remainingWait('someone@example.org'), 0, 'five is still free');

  assert.equal(await id.signIn('someone@example.org', 'wrong'), null);
  assert.ok(id.remainingWait('someone@example.org') > 0, 'the sixth buys a wait');
});

test('while the wait is on, even the RIGHT password does not get in', async () => {
  // The part that makes it worth anything. A throttle that lets the right password through on the
  // first try after the lock is a throttle an attacker walks past.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  const right = await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 6; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(id.remainingWait('someone@example.org') > 0);
  assert.equal(await id.signIn('someone@example.org', right), null, 'locked means locked');
});

test('the wait grows, instead of being a fixed pause', async () => {
  const id = new PasswordIdentity(store(), { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 6; i++) await id.signIn('someone@example.org', 'wrong');
  const first = id.remainingWait('someone@example.org');
  for (let i = 0; i < 3; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(id.remainingWait('someone@example.org') > first, 'each failure costs more than the last');
});

test('one e-mail being locked never locks another', async () => {
  // Counting per IP instead would let one person lock out a whole office behind one proxy.
  const users = store();
  const id = new PasswordIdentity(users, { secure: false });
  await id.firstAccess('someone@example.org', 'Someone');
  const other = await users.create('other@example.org', 'Other');

  for (let i = 0; i < 8; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(id.remainingWait('someone@example.org') > 0);
  assert.equal(id.remainingWait('other@example.org'), 0);
  assert.ok(await id.signIn('other@example.org', other), 'the neighbour still gets in');
});

test('a successful login clears the count', async () => {
  const id = new PasswordIdentity(store(), { secure: false });
  const right = await id.firstAccess('someone@example.org', 'Someone');

  for (let i = 0; i < 4; i++) await id.signIn('someone@example.org', 'wrong');
  assert.ok(await id.signIn('someone@example.org', right));
  for (let i = 0; i < 5; i++) assert.equal(await id.signIn('someone@example.org', 'wrong'), null);
  assert.equal(id.remainingWait('someone@example.org'), 0, 'the count restarted from zero');
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
  assert.equal(id.tracked(), 0, 'and neither attempt counted as a try');

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
  assert.ok(id.tracked() <= 50, `stopped growing at 50, got ${id.tracked()}`);
});

test('the current password asked for by change-password counts on the same e-mail as a sign-in', async () => {
  // Same secret, same counter: otherwise guessing it through change-password, with a stolen
  // session, would cost nothing at all — and whatever it found would sign in anywhere later.
  const id = new PasswordIdentity(store(), { secure: false });
  const right = await id.firstAccess('someone@example.org', 'Someone');
  assert.equal((await id.checkCurrent('someone@example.org', right))?.email, 'someone@example.org');

  for (let i = 0; i < 6; i++) assert.equal(await id.checkCurrent('someone@example.org', 'wrong'), null);
  assert.ok(id.remainingWait('someone@example.org') > 0, 'the sixth wrong one buys a wait');
  assert.equal(await id.checkCurrent('someone@example.org', right), null, 'and the right one waits too');
  assert.equal(await id.signIn('someone@example.org', right), null, 'so does signing in');
});
