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
import { MemoryEventStore } from '../api/store.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';

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
      + '(firebase emulators:start --only firestore) and set FIRESTORE_EMULATOR_HOST=127.0.0.1:8433.',
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
