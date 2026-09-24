/**
 * ONE set of tests, run against EVERY event store — the stores the product's premise lives in.
 *
 * The user stores had this suite from the start; the event stores had SQLite's own tests, and
 * Firestore's was proved by reading the code. Reading it is how three differences went unseen: the
 * same event came back with `data: {}` from Firestore and `data: null` from SQLite, SQLite's answer
 * to an append was not what it listed a moment later (`undefined` where it lists `null`), and two
 * events recorded in the same millisecond came back in no particular order. None of it broke a test,
 * because no test put the stores side by side.
 *
 * ⚠️ What is NOT proved here is said out loud, as in the user stores' suite: **Firestore** needs the
 * emulator. Without `FIRESTORE_EMULATOR_HOST` its tests SKIP, with a message saying so. CI's
 * `stores` job starts it and promises it with HOLDRIM_TEST_REQUIRE — see the test that reads it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore } from '../api/store.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { PERSON_ID } from '../api/people.ts';
import { createRoles } from '../core/roles.js';

const stores = [
  { name: 'memory', open: async () => new MemoryEventStore() },
  { name: 'sqlite', open: async () => new SqliteEventStore(':memory:') },
];
const skipped = [];

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const project = process.env.HOLDRIM_PROJECT ?? 'holdrim-conformance';
  stores.push({
    name: 'firestore',
    // Empty on every open: the emulator keeps what the previous test wrote, and a leftover event
    // would make an ordering or a count pass or fail for the wrong reason.
    open: async () => {
      const { Firestore } = await import('@google-cloud/firestore');
      const db = new Firestore({ projectId: project });
      const docs = await db.collection('events').get();
      await Promise.all(docs.docs.map((d) => d.ref.delete()));
      await db.terminate();
      return new FirestoreEventStore(project);
    },
  });
} else {
  skipped.push({
    name: 'firestore',
    why: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. Start the emulator '
      + 'with: eval "$(bash scripts/firestore-emulator.sh)", then re-run.',
  });
}

/**
 * The stores this run was promised. The variable is shared with the user stores' suite, which
 * also expects `postgres` — there is no Postgres event store, so only names this file knows count.
 */
const KNOWN = ['memory', 'sqlite', 'firestore'];
const required = (process.env.HOLDRIM_TEST_REQUIRE ?? '').split(',').map((s) => s.trim())
  .filter((name) => KNOWN.includes(name));
test('every event store this run was told to expect actually ran', () => {
  const missing = required.filter((name) => !stores.some((s) => s.name === name));
  assert.deepEqual(missing, [], `promised by HOLDRIM_TEST_REQUIRE and not run: ${missing.join(', ')}`);
});

function forEachStore(title, body) {
  for (const store of stores) {
    test(`[${store.name}] ${title}`, async () => {
      const s = await store.open();
      try { await body(s); } finally { await s.close(); }
    });
  }
  for (const s of skipped) test(`[${s.name}] ${title}`, { skip: s.why }, () => {});
}

/** Order within one millisecond is not part of the contract: `when` is kept to the millisecond. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ===================================================================== the conformance suite
forEachStore('what is appended comes back as it went in, with who and when added', async (s) => {
  const sent = { type: 'request_state', page: 'A01', block: 'A01.1.2', fingerprint: 'f1', text: 'why',
    snapshot: 'the text then', data: { request: 'r1', state: 'approved', from: 'open' } };
  const answered = await s.append(sent, 'owner@example.org');
  const [listed] = await s.list('A01');
  assert.deepEqual(listed, answered, 'the answer to an append is what a list says a moment later');
  for (const [field, value] of Object.entries(sent)) assert.deepEqual(listed[field], value, field);
  assert.equal(listed.author, 'owner@example.org');
  assert.match(listed.id, /^\S+$/);
  assert.ok(!Number.isNaN(Date.parse(listed.when)), `when is a date: ${listed.when}`);
});

forEachStore('a field left out comes back as null — not missing, and not empty', async (s) => {
  const answered = await s.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
  const [listed] = await s.list('A01');
  for (const e of [answered, listed]) {
    for (const field of ['block', 'fingerprint', 'snapshot', 'data']) assert.equal(e[field], null, field);
  }
});

forEachStore('the author is the one the server names, never one the event carries', async (s) => {
  await s.append({ type: 'comment', page: 'A01', text: 'x', author: 'forged@example.org' }, 'real@example.org');
  const [listed] = await s.list('A01');
  assert.equal(listed.author, 'real@example.org');
});

forEachStore('a page\'s events, oldest first, and only that page\'s', async (s) => {
  await s.append({ type: 'comment', page: 'A01', text: 'first' }, 'r@example.org'); await tick();
  await s.append({ type: 'comment', page: 'A02', text: 'elsewhere' }, 'r@example.org'); await tick();
  await s.append({ type: 'comment', page: 'A01', text: 'second' }, 'r@example.org');
  assert.deepEqual((await s.list('A01')).map((e) => e.text), ['first', 'second']);
  assert.deepEqual((await s.list(null)).map((e) => e.text), ['first', 'elsewhere', 'second']);
});

forEachStore('two events in the same instant keep the order they were recorded in', async (s) => {
  // A request and its triage can land in one millisecond; the cycle reads them in order.
  // Two pages interleaved, and both reads: a page's list can come back in order off an index on its
  // own, while the whole project's list is sorted, and only the tie-break keeps that sort honest.
  const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  for (const [i, text] of texts.entries()) {
    await s.append({ type: 'comment', page: i % 2 ? 'A02' : 'A01', text }, 'r@example.org');
  }
  assert.deepEqual((await s.list('A01')).map((e) => e.text), ['a', 'c', 'e', 'g']);
  assert.deepEqual((await s.list(null)).map((e) => e.text), texts);
});

forEachStore('appending the same event twice records it twice: nothing is overwritten', async (s) => {
  const e = { type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' };
  const one = await s.append(e, 'owner@example.org');
  const two = await s.append(e, 'owner@example.org');
  assert.notEqual(one.id, two.id);
  assert.equal((await s.list('A01')).length, 2);
});

// ===================================================================== who, as an id
// An event names its author by the person's id, and every reader gets the address back through one
// resolver (docs/PRIVACY.md, section 1). The addresses below are this block's own: the Firestore
// emulator keeps its people between opens, and a person another test forgot must not be met here.

forEachStore('the author is kept as the person\'s id: forgotten, the events name the id and no address', async (s) => {
  await s.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' }, 'kept-as-id@example.org');
  await s.append({ type: 'comment', page: 'A01', text: 'x' }, 'kept-as-id@example.org');
  const id = await s.personFor('kept-as-id@example.org');
  assert.deepEqual((await s.list('A01')).map((e) => e.author), ['kept-as-id@example.org', 'kept-as-id@example.org'],
    'while the person is there, the events read as their address');
  await s.forget(id);
  const after = await s.list('A01');
  assert.deepEqual(after.map((e) => e.author), [id, id], 'an event that held the address would still show it');
  assert.ok(!JSON.stringify(after).includes('kept-as-id@'), 'no copy of the address is left on an event');
});

forEachStore('a forgotten owner\'s ✓ reads as an id, which is nobody\'s address — the owner\'s least of all', async (s) => {
  const owner = 'forgotten-owner@example.org';
  await s.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' }, owner);
  const roles = createRoles(owner, '');
  assert.equal(roles.isOwner((await s.list('A01'))[0].author), true, 'resolved, the owner\'s ✓ is the owner\'s');
  await s.forget(await s.personFor(owner));
  const [read] = await s.list('A01');
  assert.match(read.author, PERSON_ID);
  assert.equal(roles.isOwner(read.author), false);
  assert.equal(roles.isAdmin(read.author), false);
});

forEachStore('the same address, however it is typed, is one author, and reads back as the table writes it', async (s) => {
  await s.append({ type: 'comment', page: 'A01', text: 'one' }, 'Typed-Twice@Example.org');
  await s.append({ type: 'comment', page: 'A01', text: 'two' }, ' typed-twice@example.org ');
  assert.deepEqual((await s.list('A01')).map((e) => e.author), ['typed-twice@example.org', 'typed-twice@example.org']);
});

// ===================================================================== the stored rows, around the code
// Asked with SQL written here, not through the store: the claim is about what the file holds.
test('[sqlite] no e-mail is in the events table, only ids of the people table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-events-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    await s.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' }, 'owner@example.org');
    await s.append({ type: 'comment', page: 'A02', text: 'a remark' }, 'reader@example.org');
    await s.append({ type: 'request', page: 'A02', text: 'please' }, 'agent via ci@example.org');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('SELECT * FROM events').all();
      assert.equal(rows.length, 3);
      assert.ok(!JSON.stringify(rows).includes('@'), `an address in the events table: ${JSON.stringify(rows)}`);
      const people = new Set(db.prepare('SELECT id FROM people').all().map((p) => p.id));
      for (const r of rows) {
        assert.match(r.author, PERSON_ID);
        assert.ok(people.has(r.author), `${r.author} is a row of the people table`);
      }
    } finally { db.close(); }
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('[sqlite] an event written before authors were ids still reads as the address it holds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-events-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO events (id, type, page, author, happened_at) VALUES ('old', 'approval', 'A01', 'owner@example.org', '2026-01-01T00:00:00.000Z')").run();
    db.close();
    await s.append({ type: 'comment', page: 'A01', text: 'new' }, 'owner@example.org');
    assert.deepEqual((await s.list('A01')).map((e) => e.author), ['owner@example.org', 'owner@example.org']);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { Firestore } = await import('@google-cloud/firestore');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const { randomBytes } = await import('node:crypto');

  test('[firestore] no e-mail is in the events collection, only ids of the people collection', async () => {
    const project = `holdrim-authors-${randomBytes(6).toString('hex')}`;
    const s = new FirestoreEventStore(project);
    const db = new Firestore({ projectId: project });
    try {
      await s.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' }, 'owner@example.org');
      await s.append({ type: 'comment', page: 'A02', text: 'a remark' }, 'reader@example.org');
      const docs = (await db.collection('events').get()).docs.map((d) => d.data());
      assert.equal(docs.length, 2);
      assert.ok(!JSON.stringify(docs).includes('@'), `an address in the events collection: ${JSON.stringify(docs)}`);
      for (const d of docs) {
        assert.match(d.author, PERSON_ID);
        assert.equal((await db.collection('people').doc(d.author).get()).exists, true, `${d.author} is a person`);
      }
    } finally { await s.close(); await db.terminate(); }
  });

  test('[firestore] an event written before authors were ids still reads as the address it holds', async () => {
    const project = `holdrim-authors-${randomBytes(6).toString('hex')}`;
    const s = new FirestoreEventStore(project);
    const db = new Firestore({ projectId: project });
    try {
      await db.collection('events').doc('old').create({ type: 'approval', page: 'A01', author: 'owner@example.org',
        when: new Date('2026-01-01T00:00:00Z') });
      assert.deepEqual((await s.list('A01')).map((e) => e.author), ['owner@example.org']);
    } finally { await s.close(); await db.terminate(); }
  });
} else {
  for (const title of ['no e-mail is in the events collection, only ids of the people collection',
    'an event written before authors were ids still reads as the address it holds']) {
    test(`[firestore] ${title}`, { skip: skipped[0].why }, () => {});
  }
}
