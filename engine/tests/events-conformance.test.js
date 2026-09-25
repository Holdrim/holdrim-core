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
import { freshFirestoreProject } from './helpers/firestore.js';
import { MemoryEventStore } from '../api/store.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { PERSON_ID } from '../api/people.ts';
import { createRoles } from '../core/roles.js';
import { hashText, newSalt, TEXT_REMOVED } from '../api/texts.ts';

const stores = [
  { name: 'memory', open: async () => new MemoryEventStore() },
  { name: 'sqlite', open: async () => new SqliteEventStore(':memory:') },
];
const skipped = [];

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  stores.push({
    name: 'firestore',
    // A project of its own on every open: the emulator keeps what earlier tests and runs wrote, and
    // a leftover event — or one written by another run against the same emulator at the same
    // time — would make an ordering or a count pass or fail for the wrong reason.
    open: async () => new FirestoreEventStore(freshFirestoreProject('holdrim-conformance')),
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
// resolver (docs/PRIVACY.md, section 1).

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
  assert.equal(roles.can('triage', read.author), false);
});

forEachStore('the same address, however it is typed, is one author, and reads back as the table writes it', async (s) => {
  const answered = await s.append({ type: 'comment', page: 'A01', text: 'one' }, 'Typed-Twice@Example.org');
  assert.equal(answered.author, 'typed-twice@example.org', 'the answer to an append names the author as a list will');
  await s.append({ type: 'comment', page: 'A01', text: 'two' }, ' typed-twice@example.org ');
  assert.deepEqual((await s.list('A01')).map((e) => e.author), ['typed-twice@example.org', 'typed-twice@example.org']);
});

// ===================================================================== text and snapshot, out of the event
// docs/PRIVACY.md, section 4: the event carries a salted hash, the text lives in its own table, and
// removing it is itself an event. The same three outcomes — present, removed on purpose, and
// missing with no such event — have to read the same way whichever store answers.

forEachStore('text and snapshot come back exactly as given, and removeText refuses a field never given', async (s) => {
  const answered = await s.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'f',
    text: 'change this' }, 'r@example.org'); // no snapshot on this one
  const [listed] = await s.list('A01');
  assert.equal(listed.text, 'change this');
  assert.equal(listed.snapshot, null);
  assert.equal(listed.textRemoved, null);
  assert.equal(listed.textTampered, false);
  await assert.rejects(s.removeText(answered.id, 'snapshot', 'r@example.org'), /no snapshot to remove/, 'nothing to remove for a field that was never given');
  await assert.rejects(s.removeText('no-such-event', 'text', 'r@example.org'), /no event/,
    'an unknown event is its own refusal, not the same one a real event with nothing to remove gets');
});

forEachStore('removeText deletes the row and records who and when, as an event beside the others', async (s) => {
  const answered = await s.append({ type: 'comment', page: 'A01', block: 'A01.1.2', text: 'a remark to redact' }, 'r@example.org');
  await tick();
  const removal = await s.removeText(answered.id, 'text', 'owner@example.org');
  assert.equal(removal.type, TEXT_REMOVED);
  assert.deepEqual(removal.data, { event: answered.id, field: 'text' });
  assert.equal(removal.author, 'owner@example.org');
  // The removal names the same block as the text it removed: a reader filtering one block's events
  // (the panel does) has to see why its text went missing, not just that some text somewhere did.
  assert.equal(removal.block, 'A01.1.2', 'the removal event carries the block it removed a text from');

  const all = await s.list('A01');
  assert.equal(all.length, 2, 'the removal is a new event, not a rewrite of the first');
  const [original, removedEvent] = all;
  assert.equal(original.id, answered.id);
  assert.equal(original.text, null, 'the text itself is gone');
  assert.deepEqual(original.textRemoved, { by: 'owner@example.org', when: removal.when });
  assert.equal(original.textTampered, false, 'removed on purpose is not tampering');
  assert.equal(removedEvent.id, removal.id);
  assert.equal(removedEvent.block, 'A01.1.2', 'and the same block still reads back from the store, not only from removeText\'s own answer');
});

forEachStore('removeText refuses a field already removed: nothing to remove twice', async (s) => {
  const answered = await s.append({ type: 'comment', page: 'A01', text: 'once' }, 'r@example.org');
  await s.removeText(answered.id, 'text', 'owner@example.org');
  await assert.rejects(s.removeText(answered.id, 'text', 'owner@example.org'), /no text to remove/);
  // The refusal has to mean it: a second, silently recorded removal would be a duplicate fact for
  // one field let go once. `removeText` writes the removal event BEFORE the delete (so the SQLite
  // guard that requires one already sees it — store-sqlite.ts, `texts_no_delete`), so this second
  // call's own event INSERT genuinely lands before its DELETE finds nothing and throws — a real
  // write for the transaction's ROLLBACK to undo, which is what this assertion actually proves
  // (store-sqlite-guards.test.js has the other half: an INSERT that fails first, with nothing
  // written yet, leaves the same nothing behind either way).
  assert.equal((await s.list('A01')).filter((e) => e.type === TEXT_REMOVED).length, 1,
    'a refused removal writes no event of its own');
});

forEachStore('removing the text leaves the snapshot untouched, and the other way round', async (s) => {
  const answered = await s.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'f',
    text: 'please change it', snapshot: 'the block today' }, 'r@example.org');
  await s.removeText(answered.id, 'snapshot', 'owner@example.org');
  const [listed] = await s.list('A01');
  assert.equal(listed.text, 'please change it', 'untouched: only the named field was asked for');
  assert.equal(listed.snapshot, null);
  assert.equal(listed.snapshotRemoved.by, 'owner@example.org');
  assert.equal(listed.textRemoved, null);
});

// ===================================================================== a clock that steps back
// Round 3, finding 3: SQLite and Memory stamp `when` from the process wall clock. A clock that
// steps back between an append and the removeText that follows it (NTP, a VM resuming from an
// earlier snapshot) would otherwise date the removal before its own target, and removalsOf's
// ordering check (round 2, finding F, which has to stay exactly as strict as it is) would then
// refuse a genuine removal forever — events are immutable, so there is no later moment to fix it
// in. Firestore needs none of this: FieldValue.serverTimestamp() is the server's own clock, already
// monotonic regardless of clock skew on any one caller's machine.

/** Runs `fn` with `Date` patched so `new Date()` (no arguments) always answers `iso`. */
async function withClockAt(iso, fn) {
  const RealDate = Date;
  class SteppedBack extends RealDate {
    constructor(...args) { super(...(args.length ? args : [iso])); }
    static now() { return new RealDate(iso).getTime(); }
  }
  globalThis.Date = SteppedBack;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

for (const store of stores.filter((s) => s.name !== 'firestore')) {
  test(`[${store.name}] removeText never dates a removal before the text it removes, even if the clock steps back`, async () => {
    const s = await store.open();
    try {
      const written = await s.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
      const removal = await withClockAt('2000-01-01T00:00:00.000Z',
        () => s.removeText(written.id, 'text', 'owner@example.org'));
      assert.ok(removal.when >= written.when, 'the removal is never dated before its target');
      const [read] = await s.list('A01');
      assert.equal(read.textRemoved?.by, 'owner@example.org',
        'it still reads as the removal it was, not as tampering, however far back the clock had stepped');
      assert.equal(read.textTampered, false);
    } finally { await s.close(); }
  });
}

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

test('[sqlite] no text or snapshot is in the events table, only the hash of each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-events-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    await s.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'f',
      text: 'a CPF: 123.456.789-00', snapshot: 'the block as it was' }, 'r@example.org');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const [row] = db.prepare('SELECT * FROM events').all();
      assert.equal(row.text, null, 'the plain text is not a column of the event');
      assert.equal(row.snapshot, null);
      assert.match(row.text_hash, /^[0-9a-f]{64}$/);
      assert.match(row.snapshot_hash, /^[0-9a-f]{64}$/);
      const [text] = db.prepare("SELECT * FROM texts WHERE event = ? AND field = 'text'").all(row.id);
      assert.equal(text.value, 'a CPF: 123.456.789-00');
      assert.match(text.salt, /^[0-9a-f]{32}$/);
    } finally { db.close(); }
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('[sqlite] an event whose texts row was never written, with a hash but no removal event, reads as tampered — not as absence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-events-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    const db = new DatabaseSync(path);
    // `texts_no_delete` (round 1, finding 5) now refuses a plain DELETE with nothing to account for
    // it, so this can no longer be reached by appending for real and then deleting the row — the
    // one shape left for "an attacker with the file, not this code" (docs/PRIVACY.md, section 3) is
    // an event inserted directly, hash and all, whose texts row was never written in the first place.
    const hash = hashText('a comment that never made it into texts', newSalt());
    db.prepare("INSERT INTO events (id, type, page, author, happened_at, text_hash) VALUES " +
      "('e1', 'comment', 'A01', 'r@example.org', '2026-01-01T00:00:00.000Z', ?)").run(hash);
    db.close();
    const [read] = await s.list('A01');
    assert.equal(read.text, null, 'the value cannot be shown: there is no row for it');
    assert.equal(read.textRemoved, null, 'no event says it was let go on purpose');
    assert.equal(read.textTampered, true, 'so it reads as tampering, exactly what issue #28 asks for');
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('[sqlite] an event and a texts row crafted directly, whose hash does not match, reads as tampered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-events-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    const db = new DatabaseSync(path);
    // Both rows inserted fresh, never through `append` or `removeText`: `texts_no_update` refuses
    // an edit to an existing row, and `texts_no_replace`/`texts_no_delete` (round 1, finding 5)
    // refuse a swap or a bare delete of one — so this is the one shape a direct writer still has,
    // an event whose hash is of a text its own texts row does not hold.
    const hash = hashText('the real text', newSalt());
    db.prepare("INSERT INTO events (id, type, page, author, happened_at, text_hash) VALUES " +
      "('e1', 'comment', 'A01', 'r@example.org', '2026-01-01T00:00:00.000Z', ?)").run(hash);
    db.prepare("INSERT INTO texts (event, field, value, salt) VALUES ('e1', 'text', 'a forged text', ?)").run(newSalt());
    db.close();
    const [read] = await s.list('A01');
    assert.equal(read.text, null, 'a value that does not match its own hash is not handed out as the text');
    assert.equal(read.textTampered, true);
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('[sqlite] an event written before texts were extracted still reads its own plain text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-events-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO events (id, type, page, author, happened_at, text) VALUES " +
      "('old', 'comment', 'A01', 'owner@example.org', '2026-01-01T00:00:00.000Z', 'from before extraction')").run();
    db.close();
    const [read] = await s.list('A01');
    assert.equal(read.text, 'from before extraction');
    assert.equal(read.textRemoved, null);
    assert.equal(read.textTampered, false, 'no hash was ever given for this row, so there is nothing to fail to verify');
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});

if (process.env.FIRESTORE_EMULATOR_HOST) {
  const { Firestore } = await import('@google-cloud/firestore');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');

  test('[firestore] no e-mail is in the events collection, only ids of the people collection', async () => {
    const project = freshFirestoreProject('holdrim-authors');
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
    const project = freshFirestoreProject('holdrim-authors');
    const s = new FirestoreEventStore(project);
    const db = new Firestore({ projectId: project });
    try {
      await db.collection('events').doc('old').create({ type: 'approval', page: 'A01', author: 'owner@example.org',
        when: new Date('2026-01-01T00:00:00Z') });
      assert.deepEqual((await s.list('A01')).map((e) => e.author), ['owner@example.org']);
    } finally { await s.close(); await db.terminate(); }
  });

  test('[firestore] no text or snapshot is in the events collection, only the hash of each', async () => {
    const project = freshFirestoreProject('holdrim-texts');
    const s = new FirestoreEventStore(project);
    const db = new Firestore({ projectId: project });
    try {
      const written = await s.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'f',
        text: 'a CPF: 123.456.789-00', snapshot: 'the block as it was' }, 'r@example.org');
      const doc = (await db.collection('events').doc(written.id).get()).data();
      assert.equal(doc.text, null, 'the plain text is not a field of the event document');
      assert.equal(doc.snapshot, null);
      assert.match(doc.textHash, /^[0-9a-f]{64}$/);
      assert.match(doc.snapshotHash, /^[0-9a-f]{64}$/);
      const row = (await db.collection('texts').doc(`${written.id}:text`).get()).data();
      assert.equal(row.value, 'a CPF: 123.456.789-00');
      assert.match(row.salt, /^[0-9a-f]{32}$/);
    } finally { await s.close(); await db.terminate(); }
  });

  test('[firestore] a text deleted straight in the store, with no removal event, reads as tampered — not as absence', async () => {
    const project = freshFirestoreProject('holdrim-texts');
    const s = new FirestoreEventStore(project);
    const db = new Firestore({ projectId: project });
    try {
      const written = await s.append({ type: 'comment', page: 'A01', text: 'a comment' }, 'r@example.org');
      await db.collection('texts').doc(`${written.id}:text`).delete(); // straight in the store, no event
      const [read] = await s.list('A01');
      assert.equal(read.text, null, 'the value cannot be shown: it is gone');
      assert.equal(read.textRemoved, null, 'no event says it was let go on purpose');
      assert.equal(read.textTampered, true, 'so it reads as tampering, exactly what issue #28 asks for');
    } finally { await s.close(); await db.terminate(); }
  });

  test('[firestore] an event written before texts were extracted still reads its own plain text', async () => {
    const project = freshFirestoreProject('holdrim-texts');
    const s = new FirestoreEventStore(project);
    const db = new Firestore({ projectId: project });
    try {
      await db.collection('events').doc('old').create({ type: 'comment', page: 'A01', author: 'owner@example.org',
        text: 'from before extraction', when: new Date('2026-01-01T00:00:00Z') });
      const [read] = await s.list('A01');
      assert.equal(read.text, 'from before extraction');
      assert.equal(read.textTampered, false, 'no hash was ever given for this document, so there is nothing to fail to verify');
    } finally { await s.close(); await db.terminate(); }
  });
} else {
  for (const title of ['no e-mail is in the events collection, only ids of the people collection',
    'an event written before authors were ids still reads as the address it holds',
    'no text or snapshot is in the events collection, only the hash of each',
    'a text deleted straight in the store, with no removal event, reads as tampered — not as absence',
    'an event written before texts were extracted still reads its own plain text']) {
    test(`[firestore] ${title}`, { skip: skipped[0].why }, () => {});
  }
}
