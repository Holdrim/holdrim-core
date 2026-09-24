// The guards "Nothing is erased" rests on in SQLite, as a program opening the file sees them: every
// test here writes SQL around the store, the way anyone with the file could, and then opens it
// again with the store to see what the next boot makes of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore, installGuards, GUARDS } from '../api/store-sqlite.ts';
import { ONLY_LOSES } from '../api/people.ts';

const approval = { type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'abc', text: null, snapshot: null, data: null };

// A file of its own, and the warnings the store says while the test runs; both undone afterwards.
function withFile(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdrim-guards-'));
    const said = [];
    const warn = console.warn;
    console.warn = (line) => said.push(line);
    try {
      await fn(join(dir, 'events.db'), said);
    } finally {
      console.warn = warn;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const outside = (path, sql) => { const db = new DatabaseSync(path); db.exec(sql); db.close(); };
const reopen = async (path) => { const s = new SqliteEventStore(path); await s.close(); };

test('a guard swapped for a same-named one that does nothing is put back on the next open, out loud', withFile(async (path, said) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  // The name stays, the refusal goes: CREATE TRIGGER IF NOT EXISTS alone would keep it.
  outside(path, 'DROP TRIGGER events_no_delete; CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT 1; END;');
  await reopen(path);
  assert.ok(said.some((line) => /events_no_delete/.test(line)), 'the swap has to be said, not repaired in silence');
  const db = new DatabaseSync(path);
  assert.throws(() => db.exec('DELETE FROM events'), /not deleted/, 'the real guard has to be back');
  db.close();
}));

test('the same swap under the name in capitals is caught too', withFile(async (path, said) => {
  await reopen(path);
  outside(path, 'DROP TRIGGER events_no_update; CREATE TRIGGER EVENTS_NO_UPDATE BEFORE UPDATE ON events BEGIN SELECT 1; END;');
  await reopen(path);
  assert.ok(said.some((line) => /EVENTS_NO_UPDATE/.test(line)), 'the swap has to be said');
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  assert.throws(() => db.exec("UPDATE events SET author = 'intruder@example.org'"), /not altered/);
  db.close();
}));

test('a trigger on the tables that this version does not install is dropped on the next open, out loud', withFile(async (path, said) => {
  await reopen(path);
  // RAISE(IGNORE) drops the row and reports no error: every ✓ would vanish without a word.
  outside(path, "CREATE TRIGGER x_ignore BEFORE INSERT ON events WHEN NEW.type = 'approval' BEGIN SELECT RAISE(IGNORE); END;");
  await reopen(path);
  assert.ok(said.some((line) => /x_ignore/.test(line)), 'the foreign trigger has to be said');
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  assert.equal((await store.list('A01')).length, 1, 'the approval has to be recorded once the trigger is gone');
  await store.close();
}));

test('an insert the database drops in silence is an error, never an event handed back as recorded', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  // Created while the store is open, so the check on open has not seen it.
  outside(path, "CREATE TRIGGER x_ignore BEFORE INSERT ON events BEGIN SELECT RAISE(IGNORE); END;");
  await assert.rejects(store.append(approval, 'owner@example.org'), /not recorded/);
  outside(path, "CREATE TRIGGER y_ignore BEFORE INSERT ON people BEGIN SELECT RAISE(IGNORE); END;");
  await assert.rejects(store.personFor('ana@example.org'), /not recorded/);
  await store.close();
}));

test('append is one transaction: a texts INSERT that fails leaves no hash-only event behind', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  // From a second connection, so the check on open has not seen it — a texts INSERT that always
  // aborts, standing in for a real failure (a full disk, a constraint this version does not know
  // about yet) between the event's own row landing and its texts row landing.
  outside(path, "CREATE TRIGGER fail_text BEFORE INSERT ON texts BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  await assert.rejects(store.append({ ...approval, text: 'a comment', snapshot: null }, 'owner@example.org'), /disk full/);
  // Not rolling back here is exactly what would leave an event with a hash and no row behind —
  // the one shape `withTexts` cannot tell from tampering, and the reason `append` is one
  // transaction at all.
  assert.deepEqual(await store.list('A01'), [], 'the event never landed either: one transaction, or none of it');
  await store.close();
}));

test('removeText is one transaction: a removal event that fails to record leaves the text untouched', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const written = await store.append({ ...approval, text: 'a comment', snapshot: null }, 'owner@example.org');
  // From a second connection, opened AFTER the store's own boot has already installed its guards
  // (`installGuards` only inspects triggers on open, so one made afterwards is invisible to it) —
  // a trigger that drops a text_removed insert in silence, standing in for a real failure between
  // recording why a text goes and actually deleting it.
  outside(path, "CREATE TRIGGER drop_removal BEFORE INSERT ON events WHEN NEW.type = 'text_removed' BEGIN SELECT RAISE(IGNORE); END;");
  await assert.rejects(store.removeText(written.id, 'text', 'owner@example.org'), /not recorded/);
  // Not rolling back here is exactly what would leave the row deleted with no event to say why —
  // the one shape `withTexts` reads as tampering, reached by a failure instead of an attacker.
  const [read] = await store.list('A01');
  assert.equal(read.text, 'a comment', 'the text is exactly as it was: the delete never ran either');
  assert.equal(read.textTampered, false);
  assert.equal((await store.list('A01')).filter((e) => e.type === 'text_removed').length, 0,
    'no removal event either: dropped in silence is still a failure, and this store does not hand one back as recorded');
  await store.close();
}));

test('a database whose guards are already right opens without a word', withFile(async (path, said) => {
  await reopen(path);
  await reopen(path);
  assert.deepEqual(said, [], 'a guard as installed is not replaced, and nothing is said');
}));

test('a database the previous version made: the changed guards are replaced once, the rest left alone', withFile(async (path, said) => {
  // The schema and the triggers exactly as the version before this one wrote them, spacing
  // included: SQLite keeps the text as written, so a comparison that minds spacing would replace
  // all five, and one that ignores the text would replace none.
  outside(path, `
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, page TEXT NOT NULL, block TEXT, fingerprint TEXT,
        text TEXT, snapshot TEXT, author TEXT NOT NULL, happened_at TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, email TEXT);
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'an event is not altered: the trail is the product'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'an event is not deleted: the trail is the product'); END;
      CREATE TRIGGER IF NOT EXISTS people_only_lose_email BEFORE UPDATE ON people
        WHEN NEW.id IS NOT OLD.id OR NEW.email IS NOT NULL
        BEGIN SELECT RAISE(ABORT, '${ONLY_LOSES}'); END;
      CREATE TRIGGER IF NOT EXISTS people_no_delete BEFORE DELETE ON people
        BEGIN SELECT RAISE(ABORT, 'a person is not deleted: forgetting empties the e-mail and keeps the id'); END;
      CREATE TRIGGER IF NOT EXISTS people_no_replace BEFORE INSERT ON people
        WHEN EXISTS (SELECT 1 FROM people WHERE id = NEW.id OR (NEW.email IS NOT NULL AND email = NEW.email))
        BEGIN SELECT RAISE(ABORT, '${ONLY_LOSES}'); END;
  `);
  await reopen(path);
  const named = (line) => line.match(/guard (\w+)/)?.[1];
  assert.deepEqual(said.map(named).sort(), ['people_no_replace', 'people_only_lose_email'],
    'only the guards whose text changed are replaced, and each is said once');
  const store = new SqliteEventStore(path);
  const ana = await store.personFor('ana@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  const { rowid } = db.prepare('SELECT rowid FROM people WHERE id = ?').get(ana);
  assert.throws(() => db.prepare('REPLACE INTO people (rowid, id, email) VALUES (?, ?, ?)').run(rowid, 'p_111111111111111111111111', 'm@example.org'),
    /can only lose their e-mail/, 'the new guard has to be the one in force');
  db.close();
  said.length = 0;
  await reopen(path);
  assert.deepEqual(said, [], 'and the next open says nothing');
}));

test('a text row can only ever name the field text or snapshot', withFile(async (path) => {
  await reopen(path);
  const db = new DatabaseSync(path);
  assert.throws(() => db.prepare("INSERT INTO texts (event, field, value, salt) VALUES ('e1', 'author', 'x', 'y')").run(),
    /CHECK constraint failed/, 'a text row for any other field is nonsense: there are only two');
  db.close();
}));

test('a database from before texts were extracted gains the columns it needs and keeps its rows', withFile(async (path, said) => {
  // The schema exactly as the version before this one wrote it: `events` with no `text_hash` or
  // `snapshot_hash`, and no `texts` table at all.
  outside(path, `
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, page TEXT NOT NULL, block TEXT, fingerprint TEXT,
        text TEXT, snapshot TEXT, author TEXT NOT NULL, happened_at TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, email TEXT);
      INSERT INTO events (id, type, page, author, happened_at, text)
        VALUES ('old', 'comment', 'A01', 'owner@example.org', '2026-01-01T00:00:00.000Z', 'a plain remark');
  `);
  const store = new SqliteEventStore(path);
  try {
    const [before] = await store.list('A01');
    assert.equal(before.text, 'a plain remark', 'a row from before the migration keeps its own plain text');
    const after = await store.append({ type: 'comment', page: 'A01', text: 'a new one', snapshot: null, data: null }, 'owner@example.org');
    assert.equal(after.text, 'a new one', 'a fresh append works on a database ALTER just widened');
  } finally { await store.close(); }
  assert.deepEqual(said, [], 'widening the schema is not a guard repair, and says nothing');
}));

test('a text is written once: no UPDATE on the texts table goes through, from outside or in', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const written = await store.append({ ...approval, text: 'first', snapshot: null }, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  assert.throws(() => db.prepare('UPDATE texts SET value = ? WHERE event = ? AND field = ?').run('forged', written.id, 'text'),
    /not edited/, 'the guard has to refuse an edit in place, salt and all');
  db.close();
}));

test('a text is not replaced: INSERT OR REPLACE for the same event and field goes through no more than a plain UPDATE would', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const written = await store.append({ ...approval, text: 'first', snapshot: null }, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  // REPLACE deletes the row it conflicts with and inserts the new one WITHOUT firing a delete
  // trigger (the same hole events_no_replace and people_no_replace already close) — so texts_no_delete
  // alone, which only guards a plain DELETE, would not have stopped this.
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO texts (event, field, value, salt) VALUES (?, 'text', 'forged', 'saltsaltsaltsalt')").run(written.id),
    /not replaced/, 'REPLACE is refused the same as an UPDATE would be');
  db.close();
}));

test('a text is not deleted without a text_removed event naming it, whatever deletes it', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const written = await store.append({ ...approval, text: 'first', snapshot: null }, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  assert.throws(() => db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(written.id, 'text'),
    /not deleted without a text_removed event/, 'a bare DELETE, with nothing to account for it, is refused');
  // The legitimate path: a text_removed event naming this event and field, in the same transaction,
  // before the DELETE — exactly the order removeText itself now writes in.
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO events (id, type, page, author, happened_at, data) VALUES ('rm1', 'text_removed', 'A01', 'p_000000000000000000000000', '2026-01-01T00:00:00.000Z', ?)")
    .run(JSON.stringify({ event: written.id, field: 'text' }));
  assert.doesNotThrow(() => db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(written.id, 'text'),
    'once the removal event is there — even uncommitted, in the same transaction — the delete is legitimate');
  db.exec('COMMIT');
  db.close();
}));

test('list reads events, people and texts from one snapshot: a removal mid-read never looks like tampering', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const written = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
  const ownerId = await store.personFor('owner@example.org');

  // Between list()'s own SELECTs, remove the text for real, through a second connection to the same
  // file — the exact interleaving a read transaction closes off (round 1, finding 7; the same gap
  // as FirestoreEventStore.list, finding 6). `DatabaseSync.prototype.prepare` is shared by every
  // connection, list's own included, so patching it here reaches its calls with no need to touch the
  // store's private connection — the same technique the "two boots" test below uses for a write race.
  const originalPrepare = DatabaseSync.prototype.prepare;
  let calls = 0;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    calls++;
    if (calls === 2) { // right after list()'s events SELECT, before its people and texts SELECTs
      const other = new DatabaseSync(path);
      other.exec('BEGIN IMMEDIATE');
      other.prepare("INSERT INTO events (id, type, page, block, author, happened_at, data) VALUES ('rm1', 'text_removed', 'A01', NULL, ?, ?, ?)")
        .run(ownerId, new Date().toISOString(), JSON.stringify({ event: written.id, field: 'text' }));
      other.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(written.id, 'text');
      other.exec('COMMIT');
      other.close();
    }
    return originalPrepare.call(this, sql, ...rest);
  };
  try {
    const [read] = await store.list('A01');
    // The removal committed strictly after list's own read transaction opened (on its first
    // SELECT), so WAL's snapshot — pinned right there — still shows the text exactly as it was:
    // stale by the wall clock, but never a torn mix of an old events row and a new, row-less texts
    // table, which is what would read back as tampered.
    assert.equal(read.text, 'a remark', 'the read transaction\'s own snapshot, taken before the removal, still holds');
    assert.equal(read.textRemoved, null);
    assert.equal(read.textTampered, false, 'a removal mid-read must never look like tampering');
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await store.close();
  }
}));

test('a repair that fails halfway leaves the database as it found it, never with a guard dropped', withFile(async (path) => {
  await reopen(path);
  outside(path, 'DROP TRIGGER events_no_delete; CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT 1; END;');
  const before = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
  const db = new DatabaseSync(path);
  const was = before(db);
  // The broken guard comes last, after events_no_delete has already been replaced: without one
  // transaction around the repair, that replacement would stay while the rest failed.
  assert.throws(() => installGuards(db, { ...GUARDS, zz_broken: 'BEFORE INSERT ON events BEGIN SELEC 1; END' }, () => {}));
  assert.deepEqual(before(db), was, 'nothing of the repair may stay behind');
  db.close();
}));

test('a boot while another process holds the write lock does not wait on it when nothing needs repair', withFile(async (path) => {
  await reopen(path);
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');
  try {
    // Every boot but the first after an upgrade finds the guards in place: taking the write lock
    // anyway would make each one wait out the busy timeout behind any writer, and then fail.
    const started = Date.now();
    await reopen(path);
    assert.ok(Date.now() - started < 2000, 'the open has to go through without waiting for the lock');
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
}));

test('a foreign trigger is found under any spelling of the table, and its name cannot drop a guard', withFile(async (path, said) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  // An AFTER INSERT that adds rows changes nothing the insert itself reports, so only the check on
  // open can catch it; `ON EVENTS` is the same table, spelled otherwise.
  outside(path, `
    CREATE TRIGGER x_forge AFTER INSERT ON EVENTS BEGIN SELECT 1; END;
    CREATE TRIGGER "x; DROP TRIGGER events_no_delete" BEFORE INSERT ON events BEGIN SELECT 1; END;
    CREATE TRIGGER "a""b" BEFORE INSERT ON people BEGIN SELECT 1; END;
  `);
  await reopen(path);
  const db = new DatabaseSync(path);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, Object.keys(GUARDS).sort(), 'exactly the guards remain');
  assert.throws(() => db.exec('DELETE FROM events'), /not deleted/, 'no name may drop a guard on its way out');
  db.close();
  for (const name of ['x_forge', 'x; DROP TRIGGER events_no_delete', 'a"b']) {
    assert.ok(said.some((line) => line.includes(name)), `${name} has to be said`);
  }
}));

test('two boots repairing one file at once: the second waits for the first and then finds nothing to do', withFile(async (path) => {
  await reopen(path);
  outside(path, 'DROP TRIGGER events_no_delete; CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT 1; END;');
  // The first boot, in a thread of its own: it takes the write lock, repairs, and holds on a moment
  // before it commits, so the second boot is certain to read the file while it is still wrong.
  const { Worker } = await import('node:worker_threads');
  const committed = new Int32Array(new SharedArrayBuffer(4));
  const first = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { workerData, parentPort } = require('node:worker_threads');
    const db = new DatabaseSync(workerData.path);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec('DROP TRIGGER events_no_delete');
    db.exec(workerData.create);
    Atomics.store(workerData.committed, 0, 1);
    db.exec('COMMIT');
    db.close();
  `, { eval: true, workerData: { path, committed, create: `CREATE TRIGGER events_no_delete ${GUARDS.events_no_delete}` } });
  await new Promise((resolve) => first.once('message', resolve));
  const said = [];
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  // The test means something only if this boot reads the file before the first one commits; on a
  // machine slow enough to miss that, it has to fail rather than pass having tested nothing.
  const prepare = db.prepare.bind(db);
  let readBeforeCommit;
  db.prepare = (sql) => { readBeforeCommit ??= Atomics.load(committed, 0) === 0; return prepare(sql); };
  try {
    // Without IMMEDIATE, this boot's read runs ahead and its write collides with the first one's;
    // without the read again under the lock, it repairs from the stale view and says so.
    assert.doesNotThrow(() => installGuards(db, GUARDS, (line) => said.push(line)));
    assert.deepEqual(said, [], 'the first boot already repaired it: the second has nothing to replace');
    assert.equal(readBeforeCommit, true, 'the second boot has to read the file before the first one commits');
  } finally {
    db.close();
    await new Promise((resolve) => first.once('exit', resolve));
  }
}));
