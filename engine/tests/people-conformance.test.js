/**
 * ONE set of tests for the people table, run against EVERY event store that keeps one.
 *
 * The table is the one place in a store where something is erased on purpose: a row can lose its
 * e-mail. Everything else about it is as fixed as an event — the id never changes, the row is never
 * deleted, and it never gains another address (docs/PRIVACY.md, sections 1 and 5). Each store holds
 * that differently — SQLite by trigger, memory and Firestore by their own code — so the same
 * questions are asked of all three, and SQLite's trigger is also asked directly, around the code.
 *
 * ⚠️ **Firestore** needs the emulator. Without `FIRESTORE_EMULATOR_HOST` its tests SKIP, with a
 * message saying so, as in the events suite next door.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore } from '../api/store.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';

const stores = [
  { name: 'memory', open: async () => new MemoryEventStore() },
  { name: 'sqlite', open: async () => new SqliteEventStore(':memory:') },
];
const skipped = [];

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  // A project of its own on every open: the emulator keeps what earlier runs wrote, and a person
  // left behind by another run — or by a suite running at the same time — would hand this one an
  // id it did not make.
  stores.push({
    name: 'firestore',
    open: async () => new FirestoreEventStore(`holdrim-people-${randomBytes(6).toString('hex')}`),
  });
} else {
  skipped.push({
    name: 'firestore',
    why: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. Start the emulator '
      + 'with: eval "$(bash scripts/firestore-emulator.sh)", then re-run.',
  });
}

const KNOWN = ['memory', 'sqlite', 'firestore'];
const required = (process.env.HOLDRIM_TEST_REQUIRE ?? '').split(',').map((s) => s.trim())
  .filter((name) => KNOWN.includes(name));
test('every people table this run was told to expect actually ran', () => {
  const missing = required.filter((name) => !stores.some((s) => s.name === name));
  assert.deepEqual(missing, [], `promised by HOLDRIM_TEST_REQUIRE and not run: ${missing.join(', ')}`);
});

function forEachStore(title, body) {
  for (const store of stores) {
    test(`[${store.name}] ${title}`, async () => {
      const s = await store.open();
      try { await body(s, store); } finally { await s.close(); }
    });
  }
  for (const s of skipped) test(`[${s.name}] ${title}`, { skip: s.why }, () => {});
}

// ===================================================================== the conformance suite
forEachStore('the same e-mail is the same person, and another e-mail is another', async (s) => {
  const ana = await s.personFor('ana@example.org');
  assert.equal(await s.personFor('ana@example.org'), ana);
  assert.equal(await s.personFor('  Ana@Example.org '), ana, 'the accounts\' rule of the same address');
  assert.notEqual(await s.personFor('bia@example.org'), ana);
});

forEachStore('an id is p_ and 24 lowercase hex characters', async (s) => {
  assert.match(await s.personFor('ana@example.org'), /^p_[0-9a-f]{24}$/);
});

forEachStore('the id is not derived from the e-mail: another store gives the same address another id', async (s, store) => {
  const other = await store.open();
  try {
    assert.notEqual(await s.personFor('ana@example.org'), await other.personFor('ana@example.org'));
  } finally { await other.close(); }
});

forEachStore('an id resolves to its e-mail, and an id nobody was given to nothing', async (s) => {
  const ana = await s.personFor('ana@example.org');
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
  assert.equal(await s.person('p_000000000000000000000000'), null);
});

forEachStore('forgetting empties the e-mail and keeps the row and its id', async (s) => {
  const ana = await s.personFor('ana@example.org');
  await s.forget(ana);
  assert.deepEqual(await s.person(ana), { id: ana, email: null });
  await s.forget(ana);
  assert.deepEqual(await s.person(ana), { id: ana, email: null }, 'forgetting twice is still forgotten');
});

forEachStore('after forgetting, the same e-mail is a new person, and the old row stays empty', async (s) => {
  const before = await s.personFor('ana@example.org');
  await s.forget(before);
  const after = await s.personFor('ana@example.org');
  assert.notEqual(after, before);
  assert.deepEqual(await s.person(before), { id: before, email: null });
  assert.deepEqual(await s.person(after), { id: after, email: 'ana@example.org' });
});

forEachStore('a row is never re-pointed at another e-mail', async (s) => {
  const ana = await s.personFor('ana@example.org');
  await assert.rejects(() => s.setEmail(ana, 'mallory@example.org'));
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
});

forEachStore('a forgotten row never gains an e-mail back', async (s) => {
  const ana = await s.personFor('ana@example.org');
  await s.forget(ana);
  await assert.rejects(() => s.setEmail(ana, 'ana@example.org'));
  assert.deepEqual(await s.person(ana), { id: ana, email: null });
});

forEachStore('forgetting somebody who is not there is an error, not a quiet success', async (s) => {
  await assert.rejects(() => s.forget('p_000000000000000000000000'), /no person/);
});

// ===================================================================== SQLite, around the code
// The trigger is what holds the rule against anyone who opens the file with another program, so
// it is asked with SQL written here, not through the store.
function withSqliteFile(body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdrim-people-'));
    const path = join(dir, 'events.db');
    const s = new SqliteEventStore(path);
    const db = new DatabaseSync(path);
    try { await body(s, db); } finally { db.close(); await s.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test('[sqlite] the database refuses re-pointing a row, written as SQL around the code', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  assert.throws(() => db.prepare('UPDATE people SET email = ? WHERE id = ?').run('mallory@example.org', ana),
    /can only lose their e-mail/);
  assert.throws(() => db.prepare('UPDATE people SET id = ? WHERE id = ?').run('p_111111111111111111111111', ana),
    /can only lose their e-mail/);
  db.prepare('UPDATE people SET email = NULL WHERE id = ?').run(ana);
  assert.throws(() => db.prepare('UPDATE people SET email = ? WHERE id = ?').run('ana@example.org', ana),
    /can only lose their e-mail/, 'an emptied row does not get its address back');
  assert.deepEqual(await s.person(ana), { id: ana, email: null });
}));

test('[sqlite] the database refuses deleting a row, written as SQL around the code', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  assert.throws(() => db.prepare('DELETE FROM people WHERE id = ?').run(ana), /a person is not deleted/);
  await s.forget(ana);
  assert.throws(() => db.prepare('DELETE FROM people').run(), /a person is not deleted/,
    'an emptied row is not deleted either');
  assert.deepEqual(await s.person(ana), { id: ana, email: null });
}));
