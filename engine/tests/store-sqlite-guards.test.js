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

test('the same swap under the name in capitals is caught too: SQLite names ignore case', withFile(async (path, said) => {
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
