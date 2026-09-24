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
