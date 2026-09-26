/**
 * Agent tokens (issue #122, docs/ROLES.md section 4): what the conformance suite cannot see.
 *
 * Every store's behaviour — issue, resolve, re-issue, revoke, list — is proved once for all three in
 * users-conformance.test.js. What stays here is what only one place can prove: the bytes SQLite
 * writes to disk, and the comparison `fromAgentToken` makes, which no behaviour reveals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { UsersSqlite } from '../api/users-sqlite.ts';
import { AGENT_TOKEN_FORMAT } from '../api/users.ts';

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
 * A second connection mid-write — another process on the same file, as two instances or a CLI next
 * to the server make it — has to be waited for, not answered with "database is locked": the store's
 * `BEGIN IMMEDIATE` fails at once otherwise. The lock is held from a worker thread, since
 * `node:sqlite` waits synchronously and a lock held on this thread could never be released meanwhile.
 */
test('an issue waits for another connection\'s write on the same SQLite file instead of failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-tokens-'));
  const path = join(dir, 'users.db');
  const store = new UsersSqlite(path);
  const holder = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec('COMMIT');
    db.close();`, { eval: true, workerData: path });
  try {
    await once(holder, 'message');
    const { agent } = await store.issueAgentToken('bot@example.org');
    assert.equal(agent.email, 'bot@example.org');
  } finally {
    await once(holder, 'exit');
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
