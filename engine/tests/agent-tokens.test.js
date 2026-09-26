/**
 * Agent tokens (issue #122, docs/ROLES.md section 4): what the conformance suite cannot see.
 *
 * Every store's behaviour — issue, resolve, re-issue, revoke, list — is proved once for all three in
 * users-conformance.test.js. What stays here is what only one place can prove: the bytes SQLite
 * writes to disk, what a second connection on the same SQLite file sees mid-write, and the comparison
 * `fromAgentToken` makes, which no behaviour reveals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { AGENT_TOKEN_FORMAT, AddressInUse } from '../api/users.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

test('an agent token\'s secret is never stored, only its hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-tokens-'));
  try {
    const path = join(dir, 'users.db');
    const store = new UsersSqlite(path);
    const { token } = await store.issueAgentToken('bot@example.org');
    await store.close();
    const secret = AGENT_TOKEN_FORMAT.exec(token)[2];
    // Read the raw file, the WAL beside it included: a copy of the database must hand over no token
    // anybody could present.
    const raw = [path, `${path}-wal`].map((p) => { try { return readFileSync(p).toString('latin1'); } catch { return ''; } }).join('');
    assert.ok(raw.includes('bot@example.org'), 'the file read is not the one the store wrote');
    assert.equal(raw.includes(secret), false, 'the token\'s secret is in the database file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * No behaviour tells `timingSafeEqual` from `Buffer.equals` or `===` on a hex string: both answer
 * true and false in the same places, and the timing they differ by is below anything a unit test
 * can measure without flaking. So the line is held on the code itself, the way roles-boundary.test.js
 * holds `can` on its callers: the hash `fromAgentToken` computes is compared with `timingSafeEqual`,
 * and with nothing that returns early on the first byte that differs.
 */
test('an agent token\'s hash is compared in constant time, never with equals or ===', () => {
  const source = readFileSync(join(ROOT, 'engine/api/users.ts'), 'utf8');
  const start = source.indexOf('async fromAgentToken(');
  assert.ok(start > 0, 'fromAgentToken moved or was renamed: this test no longer reads it');
  const body = source.slice(start, source.indexOf('\n  }\n', start));
  assert.match(body, /timingSafeEqual\(presented, row\.hash\)/, 'the hash is not compared with timingSafeEqual');
  assert.doesNotMatch(body, /\.equals\(|===\s*row\.hash|row\.hash\s*===|\.compare\(/,
    'the hash is compared by something that stops at the first byte that differs');
});

/**
 * Another connection to the SQLite file at `path` — another process, as two instances or a CLI next
 * to the server make it — opens `BEGIN IMMEDIATE`, runs `sql` in it, and holds it for 300 ms before
 * committing. Resolves once the lock is held, with `exited` for the moment the worker is done. The
 * lock is held from a worker thread: `node:sqlite` waits synchronously, so a lock held on this
 * thread could never be released while the store waits for it.
 */
async function anotherConnectionWriting(path, sql = '') {
  const holder = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    if (workerData.sql) db.exec(workerData.sql);
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec('COMMIT');
    db.close();`, { eval: true, workerData: { path, sql } });
  const exited = once(holder, 'exit');
  await once(holder, 'message');
  return { exited };
}

/** A store on a file of its own, handed to `body`, and the file gone afterwards whatever happens. */
async function onAFile(body) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-tokens-'));
  const path = join(dir, 'users.db');
  const store = new UsersSqlite(path);
  try {
    await body(store, path);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an issue waits for another connection\'s write on the same SQLite file instead of failing', () =>
  onAFile(async (store, path) => {
    // Without busy_timeout, the store's `BEGIN IMMEDIATE` answers "database is locked" at once.
    const { exited } = await anotherConnectionWriting(path);
    const { agent } = await store.issueAgentToken('bot@example.org');
    assert.equal(agent.email, 'bot@example.org');
    await exited;
  }));

// The three below are what `BEGIN IMMEDIATE` in users-sqlite.ts is for. Inside one process nothing
// interleaves (the store's bodies are synchronous), so the conformance suite's races cannot tell a
// transaction from none on SQLite; another connection writing mid-call can. Each one's write is not
// yet committed when the store is called: a store that reads outside its own write's turn reads
// before that commit, and writes after it.

test('an account another connection commits mid-issue refuses the issue', () =>
  onAFile(async (store, path) => {
    const { exited } = await anotherConnectionWriting(path,
      "INSERT INTO users (email, name, salt, hash, must_change, created_at, enabled) "
      + "VALUES ('bot@example.org', 'A Person', x'00', x'00', 0, '2026-01-01T00:00:00.000Z', 1)");
    await assert.rejects(store.issueAgentToken('bot@example.org'),
      (e) => e instanceof AddressInUse && e.heldBy === 'account');
    assert.deepEqual(await store.listAgentTokens(), [], 'a token was written for an address with an account');
    await exited;
  }));

test('a token another connection commits mid-creation refuses the account', () =>
  onAFile(async (store, path) => {
    const { exited } = await anotherConnectionWriting(path,
      "INSERT INTO agent_tokens (email, kind, token_id, hash, issued_at) "
      + `VALUES ('bot@example.org', 'agent', '${'a'.repeat(24)}', x'00', '2026-01-01T00:00:00.000Z')`);
    // The row write, not `create`: `create` spends a password hash first, and one slower than the
    // 300 ms the other connection holds would reach the store after the commit, where even a store
    // with no transaction sees the token.
    const row = {
      email: 'bot@example.org', name: 'A Person', salt: Buffer.alloc(16, 1), hash: Buffer.alloc(64, 2),
      mustChangePassword: true, createdAt: new Date().toISOString(), enabled: true,
    };
    await assert.rejects(store.insertUser(row), (e) => e instanceof AddressInUse && e.heldBy === 'agentToken');
    assert.equal(await store.find('bot@example.org'), null, 'an account was written for an address holding a token');
    await exited;
  }));

test('a token another connection commits mid-issue is the one the issue names as replaced', () =>
  onAFile(async (store, path) => {
    const theirs = 'b'.repeat(24);
    const { exited } = await anotherConnectionWriting(path,
      "INSERT INTO agent_tokens (email, kind, token_id, hash, issued_at) "
      + `VALUES ('bot@example.org', 'agent', '${theirs}', x'00', '2026-01-01T00:00:00.000Z')`);
    const { replaced } = await store.issueAgentToken('bot@example.org');
    assert.equal(replaced, theirs, 'the trail does not name the token this issue stopped');
    assert.equal((await store.listAgentTokens()).length, 1);
    await exited;
  }));
