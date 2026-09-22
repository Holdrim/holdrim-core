/**
 * Firestore and Postgres stay optional: nothing on the SQLite or memory path loads them.
 *
 * Loaded by every server at start, through a top-level import in the event store, they would make
 * an advisory against Google's client an advisory against every laptop running SQLite.
 * The proof runs in a child process with engine/tests/hooks/forbid-optional.js, which fails any
 * attempt to resolve either package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const HOOK = join(ROOT, 'engine', 'tests', 'hooks', 'forbid-optional.js');

/** Imports modules in a fresh process under the hook, and returns how it ended. */
function load(code) {
  const r = spawnSync(process.execPath, ['--import', HOOK, '--input-type=module', '-e', code],
    { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

test('the hook itself bites: loading the Firestore store under it fails, naming the package', () => {
  const r = load("await import('./engine/api/store-firestore.ts')");
  assert.notEqual(r.code, 0, 'a hook that never fails would prove nothing below');
  assert.match(r.err, /optional package was loaded.*@google-cloud\/firestore/);
});

test('the event and user stores a laptop uses load without either optional package', () => {
  const r = load(`
    const { MemoryEventStore } = await import('./engine/api/store.ts');
    const { SqliteEventStore } = await import('./engine/api/store-sqlite.ts');
    await import('./engine/api/users.ts');
    new MemoryEventStore();
    const s = new SqliteEventStore(':memory:'); await s.close();
  `);
  assert.equal(r.code, 0, r.err);
});
