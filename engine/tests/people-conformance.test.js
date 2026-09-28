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
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { MemoryEventStore } from '../api/store.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { PERSON_ID } from '../api/people.ts';
import { freshFirestoreProject } from './helpers/firestore.js';
import { signing, other } from './helpers/signing.js';
import { loadKeyring } from '../api/signing.ts';

const stores = [
  { name: 'memory', open: async () => new MemoryEventStore(signing) },
  { name: 'sqlite', open: async () => new SqliteEventStore(':memory:', signing) },
];
const skipped = [];

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  // A project of its own on every open: the emulator keeps what earlier runs wrote, and a person
  // left behind by another run — or by a suite running at the same time — would hand this one an
  // id it did not make.
  stores.push({
    name: 'firestore',
    open: async () => new FirestoreEventStore(freshFirestoreProject('holdrim-people'), signing),
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

forEachStore('personOf never creates: an address nobody has yet stays nobody\'s', async (s) => {
  assert.equal(await s.personOf('ana@example.org'), null);
  assert.equal(await s.personOf('ana@example.org'), null, 'asking twice made no row either');
  const ana = await s.personFor('ana@example.org');
  assert.deepEqual(await s.person(ana), { id: ana, email: 'ana@example.org' });
});

forEachStore('personOf finds exactly what personFor already made, and makes nothing of its own',
  async (s) => {
    const ana = await s.personFor('ana@example.org');
    assert.equal(await s.personOf('ana@example.org'), ana);
    assert.equal(await s.personOf('  Ana@Example.org '), ana, 'the accounts\' rule of the same address');
  });

forEachStore('once forgotten, personOf answers null again — it never re-inserts the erased row',
  async (s) => {
    const ana = await s.personFor('ana@example.org');
    await s.forget(ana);
    assert.equal(await s.personOf('ana@example.org'), null);
    // Asked TWICE, as "personOf never creates" above asks a never-seen address twice: a lookup that
    // quietly re-inserted the pointer on its first call would still answer null on THAT call, and
    // only a second ask would find the row it had just made and answer something other than null.
    assert.equal(await s.personOf('ana@example.org'), null, 'asking twice made no row either');
    // The forgotten row itself is untouched by asking: still there, still empty, same id — a
    // read-only lookup must not hand a freshly-forgotten address a person of its own again, which
    // is exactly what the very next admin action on that address needs (docs/PRIVACY.md, section 5).
    assert.deepEqual(await s.person(ana), { id: ana, email: null });
  });

// ===================================================================== SQLite, around the code
// The trigger is what holds the rule against anyone who opens the file with another program, so
// it is asked with SQL written here, not through the store.
function withSqliteFile(body) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdrim-people-'));
    const path = join(dir, 'events.db');
    const s = new SqliteEventStore(path, signing);
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
  await new SqliteEventStore(path, signing).close();
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

// ===================================================================== the seal on each row
// Events and grants name a person by id, and the people table says which address an id is. A row
// changed or inserted without the key reads as nobody (`trustedEmail`, engine/api/people.ts): no
// grant, no "own request", no author. Asked around the code, of each store that can be written so.

/** Captures the structured lines a read writes to stdout, where `log` puts them. */
async function linesOf(body) {
  const lines = [];
  const out = console.log;
  console.log = (line) => lines.push(String(line));
  try { await body(); } finally { console.log = out; }
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

test('[sqlite] a row is sealed when made, and forgetting empties the seal with the address', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  const { seal } = db.prepare('SELECT seal FROM people WHERE id = ?').get(ana);
  assert.match(seal, new RegExp(`^${signing.signer.kid}\\.`), 'sealed by this server\'s key');
  assert.equal(await s.personOf('ana@example.org'), ana);
  await s.forget(ana);
  assert.equal(db.prepare('SELECT seal FROM people WHERE id = ?').get(ana).seal, null);
}));

test('[sqlite] a seal is never written onto a row already there, written as SQL around the code', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  const { seal } = db.prepare('SELECT seal FROM people WHERE id = ?').get(ana);
  db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('p_' + 'ab'.repeat(12), 'bia@example.org');
  assert.throws(() => db.prepare('UPDATE people SET seal = ? WHERE id = ?').run(seal, 'p_' + 'ab'.repeat(12)),
    /a seal is never written onto a person already there/);
  assert.throws(() => db.prepare('UPDATE people SET email = NULL, seal = ? WHERE id = ?').run('x.y', ana),
    /a seal is never written onto a person already there/, 'not even beside an emptied address');
}));

test('[sqlite] a row inserted without the key is nobody: no id for its address, no author, and said once', withSqliteFile(async (s, db) => {
  const bia = 'p_' + 'ab'.repeat(12);
  db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run(bia, 'bia@example.org');
  db.prepare("INSERT INTO events (id, type, page, author, happened_at) VALUES ('e1', 'comment', 'A01', ?, '2026-01-01T00:00:00.000Z')").run(bia);
  const said = await linesOf(async () => {
    assert.equal(await s.personOf('bia@example.org'), null, 'no grant can find it');
    assert.deepEqual(await s.person(bia), { id: bia, email: null });
    assert.equal(await s.heldBy('bia@example.org'), bia, 'it still holds the address, to be forgotten');
    assert.equal(await s.personFor('bia@example.org'), bia, 'and no second person is made for it');
    assert.deepEqual((await s.list(null)).map((e) => e.author), [bia], 'its event reads as the id');
  });
  const unsealed = said.filter((l) => l.event === 'person_unsealed');
  assert.deepEqual(unsealed.map((l) => [l.severity, l.people]), [['WARNING', [bia]]], 'said once, by id');
  assert.ok(!JSON.stringify(said).includes('bia@example.org'), 'never naming the address');
  await s.forget(bia);
  const fresh = await s.personFor('bia@example.org');
  assert.notEqual(fresh, bia, 'forgotten, the address is a new person');
  assert.equal(await s.personOf('bia@example.org'), fresh, 'and a sealed one');
}));

test('[sqlite] a row pointed at another address is nobody, under either address, and raised as CRITICAL', withSqliteFile(async (s, db) => {
  const ana = await s.personFor('ana@example.org');
  db.exec('DROP TRIGGER people_only_lose_email');
  db.prepare('UPDATE people SET email = ? WHERE id = ?').run('mallory@example.org', ana);
  const said = await linesOf(async () => {
    assert.equal(await s.personOf('mallory@example.org'), null);
    assert.equal(await s.personOf('ana@example.org'), null);
    assert.deepEqual(await s.person(ana), { id: ana, email: null });
  });
  assert.deepEqual(said.filter((l) => l.event === 'person_forged').map((l) => [l.severity, l.people]), [['CRITICAL', [ana]]]);
}));

test('[sqlite] a row sealed by a key the reader was not given is nobody to that reader, and said so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-people-'));
  const path = join(dir, 'events.db');
  try {
    const first = new SqliteEventStore(path, signing);
    const ana = await first.personFor('ana@example.org');
    await first.close();
    const elsewhere = new SqliteEventStore(path, { signer: other, keyring: loadKeyring({}, other) });
    const said = await linesOf(async () => {
      assert.equal(await elsewhere.personOf('ana@example.org'), null);
      assert.deepEqual(await elsewhere.person(ana), { id: ana, email: null });
    });
    await elsewhere.close();
    assert.deepEqual(said.filter((l) => l.event === 'person_unverified').map((l) => [l.severity, l.people]), [['WARNING', [ana]]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const { Firestore } = await import('@google-cloud/firestore');
  const withFirestore = (body) => async () => {
    const project = freshFirestoreProject('holdrim-people-seal');
    const s = new FirestoreEventStore(project, signing);
    const db = new Firestore({ projectId: project });
    try { await body(s, db); } finally { await s.close(); await db.terminate(); }
  };

  test('[firestore] a row and its pointer are sealed alike, and forgetting empties the seal with the address', withFirestore(async (s, db) => {
    const ana = await s.personFor('ana@example.org');
    const row = (await db.collection('people').doc(ana).get()).data();
    const pointer = (await db.collection('people_by_email').doc(encodeURIComponent('ana@example.org')).get()).data();
    assert.match(row.seal, new RegExp(`^${signing.signer.kid}\\.`));
    assert.equal(pointer.seal, row.seal);
    await s.forget(ana);
    assert.deepEqual((await db.collection('people').doc(ana).get()).data(), { email: null, seal: null });
  }));

  test('[firestore] a row and pointer written without the key are nobody, and said once', withFirestore(async (s, db) => {
    // Its own id: each row is said once per process, and the SQLite test above already said `ab…`.
    const bia = 'p_' + 'cd'.repeat(12);
    await db.collection('people').doc(bia).create({ email: 'bia@example.org' });
    await db.collection('people_by_email').doc(encodeURIComponent('bia@example.org')).create({ id: bia });
    const said = await linesOf(async () => {
      assert.equal(await s.personOf('bia@example.org'), null);
      assert.deepEqual(await s.person(bia), { id: bia, email: null });
      assert.equal(await s.heldBy('bia@example.org'), bia);
      assert.equal(await s.personFor('bia@example.org'), bia, 'no second person for it');
    });
    assert.deepEqual(said.filter((l) => l.event === 'person_unsealed').map((l) => l.people), [[bia]]);
  }));

  test('[firestore] a pointer moved to another id, seal and all, is nobody, and raised as CRITICAL', withFirestore(async (s, db) => {
    const ana = await s.personFor('ana@example.org');
    const mallory = await s.personFor('mallory@example.org');
    const pointers = db.collection('people_by_email');
    const anas = (await pointers.doc(encodeURIComponent('ana@example.org')).get()).data();
    // Mallory's address pointed at Ana's id, carrying Ana's genuine seal, and Ana's row given Mallory's address.
    await pointers.doc(encodeURIComponent('mallory@example.org')).set({ id: ana, seal: anas.seal });
    await db.collection('people').doc(ana).set({ email: 'mallory@example.org', seal: anas.seal });
    const said = await linesOf(async () => {
      assert.equal(await s.personOf('mallory@example.org'), null);
      assert.deepEqual(await s.person(ana), { id: ana, email: null });
      const authors = new Map((await s.list(null)).map((e) => [e.authorId, e.author]));
      assert.equal(authors.size, 0, 'setup: no events');
    });
    assert.ok(said.some((l) => l.event === 'person_forged' && l.severity === 'CRITICAL' && l.people.includes(ana)));
    assert.notEqual(mallory, ana);
  }));
}
