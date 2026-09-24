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
import { Worker } from 'node:worker_threads';
import { MemoryEventStore } from '../api/store.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { PERSON_ID } from '../api/people.ts';

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
  assert.match(await s.personFor('ana@example.org'), PERSON_ID);
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

forEachStore('asking for an unknown id to hold an e-mail is "no person", as forgetting it is', async (s) => {
  await assert.rejects(() => s.setEmail('p_000000000000000000000000', 'ana@example.org'), /no person/);
});

forEachStore('two first sightings of one address at once are one person', async (s) => {
  const ids = await Promise.all(Array.from({ length: 8 }, () => s.personFor('ana@example.org')));
  assert.equal(new Set(ids).size, 1, `one address became ${new Set(ids).size} people: ${ids.join(', ')}`);
  assert.deepEqual(await s.person(ids[0]), { id: ids[0], email: 'ana@example.org' });
});

forEachStore('changing what person() returned does not change the row', async (s) => {
  const ana = await s.personFor('ana@example.org');
  const row = await s.person(ana);
  row.email = 'mallory@example.org';
  row.id = 'p_111111111111111111111111';
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
});

forEachStore('an empty or blank e-mail makes no person', async (s) => {
  await assert.rejects(() => s.personFor(''), /a person needs an e-mail/);
  await assert.rejects(() => s.personFor('  '), /a person needs an e-mail/);
});

forEachStore('an address with a slash is one person, and a new one once forgotten', async (s) => {
  // Firestore keys the pointer by the address: a raw `/` there would name a sub-collection, and
  // the lookup and the pointer the insert wrote would stop being the same document.
  const odd = await s.personFor('a/b@example.org');
  assert.equal(await s.personFor('a/b@example.org'), odd);
  assert.notEqual(await s.personFor('b@example.org'), odd);
  await s.forget(odd);
  const again = await s.personFor('a/b@example.org');
  assert.notEqual(again, odd);
  assert.deepEqual(await s.person(odd), { id: odd, email: null });
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

test('[sqlite] the database refuses a second row for an address still held, written as SQL around the code', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  assert.throws(() => db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('p_111111111111111111111111', 'ana@example.org'),
    /UNIQUE|can only lose their e-mail/);
  await s.forget(ana);
  db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('p_111111111111111111111111', 'ana@example.org');
  assert.equal(await s.personFor('ana@example.org'), 'p_111111111111111111111111',
    'a forgotten row holds no address, so the same address inserts again');
}));

test('[sqlite] the unique index holds an address by itself, with the insert trigger gone', withSqliteFile(async (s, db) => {
  // The insert trigger answers first, so the test above passes with or without the index. Dropped
  // here, on this file only, so the index is asked on its own: it is what still stands if the
  // trigger is ever loosened.
  const ana = await s.personFor('ana@example.org');
  db.exec('DROP TRIGGER people_no_replace');
  assert.throws(() => db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('p_111111111111111111111111', 'ana@example.org'),
    /UNIQUE/);
  await s.forget(ana);
  db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('p_222222222222222222222222', 'ana@example.org');
  db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('p_333333333333333333333333', null);
  assert.equal(await s.personFor('ana@example.org'), 'p_222222222222222222222222');
}));

test('[sqlite] REPLACE cannot re-point a row, written as SQL around the code', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO people (id, email) VALUES (?, ?)').run(ana, 'mallory@example.org'),
    /can only lose their e-mail/);
  assert.throws(() => db.prepare('REPLACE INTO people (id, email) VALUES (?, ?)').run(ana, 'mallory@example.org'),
    /can only lose their e-mail/);
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
}));

test('[sqlite] REPLACE cannot erase a row by its rowid under a new id and address, written as SQL around the code', withSqliteFile(async (s, db) => {
  // `people` is a rowid table: a REPLACE that names a held rowid conflicts on it, and drops that row
  // without the delete trigger, whatever id and address it brings.
  const ana = await s.personFor('ana@example.org');
  const { rowid } = db.prepare('SELECT rowid FROM people WHERE id = ?').get(ana);
  for (const verb of ['INSERT OR REPLACE', 'REPLACE']) {
    assert.throws(() => db.prepare(`${verb} INTO people (rowid, id, email) VALUES (?, ?, ?)`).run(rowid, 'p_111111111111111111111111', 'mallory@example.org'),
      /can only lose their e-mail/, `${verb} with a held rowid has to be refused`);
  }
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
}));

test('[sqlite] UPDATE OR REPLACE cannot move a row onto another person\'s rowid, written as SQL around the code', withSqliteFile(async (s, db) => {
  // Emptying the address is the one change allowed, so the move rides on it: the id stays, the
  // e-mail goes to NULL, and the rowid conflict drops the other row with no delete trigger.
  const ana = await s.personFor('ana@example.org');
  const bia = await s.personFor('bia@example.org');
  assert.throws(() => db.prepare('UPDATE OR REPLACE people SET rowid = (SELECT rowid FROM people WHERE id = ?), email = NULL WHERE id = ?').run(bia, ana),
    /can only lose their e-mail/);
  assert.deepEqual(await s.person(bia), { id: bia, email: 'bia@example.org' });
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
}));

test('[sqlite] REPLACE cannot take another person\'s address and drop their row, written as SQL around the code', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  assert.throws(() => db.prepare('INSERT OR REPLACE INTO people (id, email) VALUES (?, ?)').run('p_111111111111111111111111', 'ana@example.org'),
    /can only lose their e-mail/);
  assert.throws(() => db.prepare('REPLACE INTO people (id, email) VALUES (?, ?)').run('p_111111111111111111111111', 'ana@example.org'),
    /can only lose their e-mail/);
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
  assert.equal(await s.person('p_111111111111111111111111'), null);
}));

test('[sqlite] two connections finding-or-creating one address at once agree on one person', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-people-'));
  const path = join(dir, 'events.db');
  // Many addresses, so the two writers meet on some of them however the threads are scheduled.
  const emails = Array.from({ length: 60 }, (_, i) => `person${i}@example.org`);
  const threads = 4;
  const gate = new SharedArrayBuffer(4);
  // Made once before the threads start, so what they race on is the people, not the schema.
  await new SqliteEventStore(path).close();
  try {
    const workers = Array.from({ length: threads }, () =>
      new Worker(new URL('./helpers/sqlite-person-worker.js', import.meta.url), { workerData: { path, emails, gate } }));
    let ready = 0;
    const results = await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      w.on('error', reject);
      w.on('message', (m) => {
        if (m.ready) {
          if (++ready === threads) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); }
          return;
        }
        resolve(m);
      });
    })));
    await Promise.all(workers.map((w) => w.terminate()));
    const errors = results.filter((r) => r.error).map((r) => r.error);
    assert.deepEqual(errors, [], 'a connection that lost the race got an error instead of the winner\'s id');
    for (let i = 0; i < emails.length; i++) {
      const ids = new Set(results.map((r) => r.ids[i]));
      assert.equal(ids.size, 1, `${emails[i]} became ${ids.size} people`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
