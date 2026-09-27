/**
 * The first-access password goes to a file, never to the log (#53).
 *
 * What each test here holds is the whole promise, one piece each: the password is nowhere in what
 * the process writes; the file holds it, and only its owner reads it; an existing file is never
 * written over; the account is never created without the file; and the file goes once the owner
 * picks a password of their own. The contract test boots the real server and proves the same
 * promise end to end; these prove each branch, which a single boot cannot reach.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { PasswordIdentity } from '../api/identity-password.ts';
import {
  FIRST_ACCESS_FILE, FirstAccessFileExists, firstAccessPath, firstAccessRefusal, provisionFirstAccess,
  retireFirstAccessFile,
} from '../api/first-access.ts';

const OWNER = 'owner@example.org';

/** A scratch directory, the environment pointing the file into it, and a fresh identity. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-first-access-'));
  const env = { HOLDRIM_USERS_PATH: join(dir, 'users.db') };
  const identity = new PasswordIdentity(new UsersSqlite(':memory:'), { secure: false });
  const file = join(dir, FIRST_ACCESS_FILE);
  return { dir, env, identity, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Everything the process writes while `run` runs: stdout, stderr, and the banner's own channel.
 * The streams themselves are captured, not only `console`, so a line written any other way — a
 * `process.stdout.write`, a `log()` with its own writer — is caught too.
 */
async function captured(run) {
  const out = [];
  const original = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return original.stdout.call(process.stdout, '', ...rest); };
  process.stderr.write = (chunk, ...rest) => { out.push(String(chunk)); return original.stderr.call(process.stderr, '', ...rest); };
  try {
    const result = await run();
    return { result, text: out.join('') };
  } finally {
    process.stdout.write = original.stdout;
    process.stderr.write = original.stderr;
  }
}

test('the first access writes the password nowhere in the log, and says where the file is', async () => {
  const t = setup();
  try {
    const { result, text } = await captured(() => provisionFirstAccess(t.identity, OWNER, 'Owner', { env: t.env }));
    assert.equal(result, 'created');
    const password = readFileSync(t.file, 'utf8');
    assert.ok(password.length >= 12, 'there has to be a password to look for');
    assert.equal(text.includes(password), false, 'the first-access password reached stdout or stderr');
    // Not even partly: any eight characters of it would be a head start on the rest.
    for (let i = 0; i + 8 <= password.length; i++) {
      assert.equal(text.includes(password.slice(i, i + 8)), false, `a piece of the password reached the log: ${i}`);
    }
    assert.ok(text.includes('FIRST ACCESS'), 'the banner must still be there, or nobody knows to look');
    assert.ok(text.includes(resolve(t.file)), 'the log has to say where the file is');
    assert.ok(text.includes(OWNER), 'and which address signs in with it');
  } finally { t.done(); }
});

// Two umasks, because each catches a different mistake: 000 lets a wider mode through if the file
// is opened with one, and 277 takes the owner's own read bit away if nothing sets the mode after the
// umask has had its say. The mode is READ, never inferred from a refused open: CI runs as a normal
// user and a developer may run as root, and only the number means the same on both.
for (const umask of [0o000, 0o277]) {
  test(`the file holds exactly the password, readable by its owner alone (mode 0600, umask ${umask.toString(8).padStart(3, '0')})`, async () => {
    const t = setup();
    try {
      const previous = process.umask(umask);
      try {
        await provisionFirstAccess(t.identity, OWNER, 'Owner', { env: t.env, say: () => {} });
      } finally { process.umask(previous); }
      assert.equal((statSync(t.file).mode & 0o777).toString(8), '600', 'the file must be mode 0600, whatever the umask');
      const password = readFileSync(t.file, 'utf8');
      assert.match(password, /^[A-Za-z0-9_-]{16}$/, 'the password and nothing else: no newline, no label');
      const user = await t.identity.users.check(OWNER, password);
      assert.equal(user?.email, OWNER, 'what the file holds is what signs the owner in');
      assert.equal(user.mustChangePassword, true, 'and it still has to be changed at the first sign-in');
    } finally { t.done(); }
  });
}

test('an existing file is never overwritten, and no account is created without a file', async () => {
  const t = setup();
  try {
    writeFileSync(t.file, 'left-by-an-earlier-first-access');
    await assert.rejects(
      provisionFirstAccess(t.identity, OWNER, 'Owner', { env: t.env, say: () => {} }),
      (error) => error instanceof FirstAccessFileExists && error.message.includes(resolve(t.file)));
    assert.equal(readFileSync(t.file, 'utf8'), 'left-by-an-earlier-first-access', 'the file was written over');
    assert.equal(await t.identity.users.isEmpty(), true,
      'an account was created whose password is in no file: nobody could ever sign in with it');
  } finally { t.done(); }
});

test('a restart with somebody in the store touches no file', async () => {
  const t = setup();
  try {
    await t.identity.users.create(OWNER, 'Owner', 'a-password-already-chosen', false);
    writeFileSync(t.file, 'whatever-is-there');
    assert.equal(await provisionFirstAccess(t.identity, OWNER, 'Owner', { env: t.env, say: () => {} }), 'none');
    assert.equal(readFileSync(t.file, 'utf8'), 'whatever-is-there');
    rmSync(t.file);
    assert.equal(await provisionFirstAccess(t.identity, OWNER, 'Owner', { env: t.env, say: () => {} }), 'none');
    assert.equal(existsSync(t.file), false, 'an ordinary restart must not create the file');
  } finally { t.done(); }
});

test('losing the race to another instance leaves no file behind', async () => {
  const t = setup();
  try {
    // Empty when asked, and already taken by the time the account is created: the other instance won.
    const racing = { users: { isEmpty: async () => true }, firstAccess: async () => null };
    assert.equal(await provisionFirstAccess(racing, OWNER, 'Owner', { env: t.env, say: () => {} }), 'none');
    assert.equal(existsSync(t.file), false, 'a password that opens nothing was left on the disk');
  } finally { t.done(); }
});

test('an account that fails to be created leaves no file behind', async () => {
  const t = setup();
  try {
    const failing = { users: { isEmpty: async () => true }, firstAccess: async () => { throw new Error('store down'); } };
    await assert.rejects(provisionFirstAccess(failing, OWNER, 'Owner', { env: t.env, say: () => {} }), /store down/);
    assert.equal(existsSync(t.file), false, 'the next start would refuse over a password that never worked');
  } finally { t.done(); }
});

test('the file goes beside the store, or where HOLDRIM_FIRST_ACCESS_PATH says', () => {
  assert.equal(firstAccessPath({}), join('data', FIRST_ACCESS_FILE), 'beside ./data/users.db by default');
  assert.equal(firstAccessPath({ HOLDRIM_USERS_PATH: '/data/users.db' }), `/data/${FIRST_ACCESS_FILE}`, 'the image');
  assert.equal(firstAccessPath({ HOLDRIM_USERS: 'sqlite:/var/lib/h/users.db', HOLDRIM_USERS_PATH: '/data/users.db' }),
    `/var/lib/h/${FIRST_ACCESS_FILE}`, 'beside the file sqlite:<path> names');
  assert.equal(firstAccessPath({ HOLDRIM_USERS: 'postgres://u:p@h/db', HOLDRIM_USERS_PATH: '/data/users.db' }),
    `/data/${FIRST_ACCESS_FILE}`, 'a store with no file of its own: the data directory all the same');
  assert.equal(firstAccessPath({ HOLDRIM_USERS: 'firestore' }), join('data', FIRST_ACCESS_FILE));
  assert.equal(firstAccessPath({ HOLDRIM_FIRST_ACCESS_PATH: '/mnt/secret/first', HOLDRIM_USERS_PATH: '/data/users.db' }),
    '/mnt/secret/first');
});

test('on a disk nobody can read from outside, the first access waits for a path somebody can', async () => {
  const t = setup();
  try {
    const env = { ...t.env, K_SERVICE: 'holdrim' };
    assert.match(firstAccessRefusal(env), /HOLDRIM_FIRST_ACCESS_PATH/);
    const { result } = await captured(() => provisionFirstAccess(t.identity, OWNER, 'Owner', { env, say: () => {} }));
    assert.equal(result, 'refused');
    assert.equal(await t.identity.users.isEmpty(), true, 'an account whose password nobody can read was created');
    assert.equal(existsSync(t.file), false);
    // Named explicitly, the path is taken at its word.
    assert.equal(firstAccessRefusal({ ...env, HOLDRIM_FIRST_ACCESS_PATH: t.file }), null);
    assert.equal(firstAccessRefusal(t.env), null, 'and a laptop is never refused');
  } finally { t.done(); }
});

test('the file is removed once the owner changes the password, and a missing one is no failure', async () => {
  const t = setup();
  try {
    await provisionFirstAccess(t.identity, OWNER, 'Owner', { env: t.env, say: () => {} });
    assert.equal(existsSync(t.file), true);
    const { result, text } = await captured(() => retireFirstAccessFile(t.env));
    assert.equal(result, 'removed');
    assert.equal(existsSync(t.file), false, 'the first-access file outlived the password it held');
    assert.ok(text.includes('first_access_file_removed'), 'and the log says it went');
    assert.equal(await retireFirstAccessFile(t.env), 'absent', 'a later change finds nothing to remove');
  } finally { t.done(); }
});
