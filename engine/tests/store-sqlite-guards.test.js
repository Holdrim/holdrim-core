// The guards "Nothing is erased" rests on in SQLite, as a program opening the file sees them: every
// test here writes SQL around the store, the way anyone with the file could, and then opens it
// again with the store to see what the next boot makes of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore, installGuards, guardMismatches, GUARDS, ROWID_CEILING as CEILING } from '../api/store-sqlite.ts';
import { ONLY_LOSES } from '../api/people.ts';
import { outside } from './helpers/sqlite.js';
import { Source } from '../cli/remote.ts';

const approval = { type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'abc', text: null, snapshot: null, data: null };

// A file of its own, the plain warnings AND the structured log() lines the store says while the
// test runs; all three undone afterwards. `log()` (engine/api/log.ts) writes one JSON line per call
// through `console.log`, which nothing else in this suite calls with a JSON string, so a line that
// parses and carries a `severity` is one of ours; anything else is passed on to the real console.log
// untouched, so the test runner's own output is not swallowed.
function withFile(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holdrim-guards-'));
    const said = [];
    const logged = [];
    const warn = console.warn;
    const info = console.log;
    console.warn = (line) => said.push(line);
    console.log = (line) => {
      const parsed = typeof line === 'string' ? tryParse(line) : undefined;
      if (parsed && typeof parsed.severity === 'string') logged.push(parsed);
      else info(line);
    };
    try {
      await fn(join(dir, 'events.db'), said, logged);
    } finally {
      console.warn = warn;
      console.log = info;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const tryParse = (line) => { try { return JSON.parse(line); } catch { return undefined; } };

const reopen = async (path) => { const s = new SqliteEventStore(path); await s.close(); };

// Which guard a warn() line names, and which of the three things installGuards says it for — a
// guard present but different ('replaced'), one not held at all ('missing'), or a trigger on these
// tables that is not one of ours ('foreign'). Kept apart from the plain `line.match(/guard "(\w+)"/)`
// used elsewhere in this file because a test asserting "these guards were said" must also be able to
// tell a genuine repair from the exact wrong wording — reporting a missing guard with the "replacing
// it" text would pass a name-only check and still be the wrong claim about what happened.
function classify(line) {
  let m = line.match(/guard ("\S+") is missing/);
  if (m) return { name: JSON.parse(m[1]), kind: 'missing' };
  m = line.match(/guard ("\S+") was not the one/);
  if (m) return { name: JSON.parse(m[1]), kind: 'replaced' };
  m = line.match(/trigger this version does not install, ("\S+");/);
  if (m) return { name: JSON.parse(m[1]), kind: 'foreign' };
  return undefined;
}
const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const byGuard = (a, b) => a.guard < b.guard ? -1 : a.guard > b.guard ? 1 : 0;

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

test('a brand-new database installs every guard on its first boot without a word', withFile(async (path, said, logged) => {
  // Isolated from the "already right" test above on purpose: that one only proves the SECOND open
  // of an already-guarded file is quiet. This is the first open of a file that has never held a
  // guard at all — the one case installGuards must not mistake for a guard gone missing, or the
  // very first boot anyone ever runs would open with a wall of "missing" warnings about guards that
  // were simply never installed yet (holdrim#89's fix, read backwards).
  await reopen(path);
  assert.deepEqual(said, [], 'installing a guard for the first time is not the same as one going missing');
  assert.deepEqual(logged, [], 'and no structured sqlite_guard_missing line either');
}));

test('a fresh file with a foreign trigger already on it is still a first install for our own guards', withFile(async (path, said) => {
  // Round 1, finding 1(b): a database can hold a trigger that is not one of GUARDS before this
  // store ever opens it — nothing stops a name colliding by accident, or another tool writing to
  // the same file first. Counting every held trigger, ours or not, as evidence this is not a first
  // install would report every one of ours "missing" on a boot that never installed anything yet;
  // only a trigger BY ONE OF OUR NAMES may say that. The schema here is exactly what the real
  // constructor would create — `CREATE TABLE IF NOT EXISTS` is a no-op on it — so the only thing
  // this file has that a truly brand-new one would not is the one foreign trigger.
  outside(path, `
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, page TEXT NOT NULL, block TEXT, fingerprint TEXT,
        text TEXT, snapshot TEXT, text_hash TEXT, snapshot_hash TEXT, author TEXT NOT NULL,
        happened_at TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, email TEXT);
      CREATE TRIGGER x_ignore BEFORE INSERT ON events WHEN NEW.type = 'approval'
        BEGIN SELECT RAISE(IGNORE); END;
  `);
  await reopen(path);
  const seen = said.map(classify).filter(Boolean);
  assert.deepEqual(seen.filter((c) => c.kind === 'missing'), [],
    'a first install with a foreign trigger on it must not report any of our own guards missing');
  assert.deepEqual(seen.filter((c) => c.kind === 'foreign').map((c) => c.name), ['x_ignore'],
    'the foreign trigger keeps its own, unrelated warning');
}));

test('every guard dropped from a database that still holds an approval is named, not read as a first install', withFile(async (path, said, logged) => {
  // Round 1, finding 1(a), the CRITICAL one: the locks lens's own reproduction. `rows.length === 0`
  // after every guard is dropped looks exactly like a brand-new file — the fix in this commit is
  // that "no guard of ours is held" is necessary but not sufficient; the tables have to be empty
  // too, and this database still holds the person row `personFor` made for the approval's author.
  const store = new SqliteEventStore(path);
  const written = await store.append(approval, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
  for (const n of names) db.exec(`DROP TRIGGER "${n}"`);
  db.prepare('DELETE FROM events WHERE id = ?').run(written.id); // the approval itself, gone too
  db.close();
  await reopen(path);
  const missing = said.map(classify).filter((c) => c?.kind === 'missing').sort(byName);
  assert.deepEqual(missing.map((c) => c.name), Object.keys(GUARDS).sort(),
    'a database with data in it and none of its guards is not a first install, whatever emptied the guards');
  assert.deepEqual(logged.map((l) => l.guard).sort(), Object.keys(GUARDS).sort(),
    'and each is a structured WARNING too, one line per guard');
  for (const l of logged) assert.deepEqual(l, { severity: 'WARNING', event: 'sqlite_guard_missing', time: l.time, guard: l.guard });
}));

test('events and people emptied but a text left behind is not a first install either: every guard is named', withFile(async (path, said, logged) => {
  // holdsNoRow checks all three tables, and this fixture is built to make the texts check the ONLY
  // one still true: events and people are wiped below, so if that third check were `true` instead
  // of a real SELECT, this database — one row in texts, nothing else — would pass as a first
  // install and every guard would go back in silence, the exact failure holdrim#89 exists to name.
  const store = new SqliteEventStore(path);
  await store.append({ ...approval, text: 'a comment', snapshot: null }, 'owner@example.org');
  await store.close();
  // Foreign keys off on this connection (the store's own constructor is what turns them ON;
  // node:sqlite otherwise enables them itself, so the plain `outside()` helper cannot be reused
  // here), so the events row can be deleted below while a texts row still names it — leaving
  // exactly one table, texts, non-empty.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name);
  for (const n of names) db.exec(`DROP TRIGGER "${n}"`);
  db.exec('DELETE FROM events; DELETE FROM people;');
  db.close();
  await reopen(path);
  const missing = said.map(classify).filter((c) => c?.kind === 'missing').sort(byName);
  assert.deepEqual(missing.map((c) => c.name), Object.keys(GUARDS).sort(),
    'a text row alone, with no guard on any of the three tables, is not a first install: every guard is named missing');
  assert.deepEqual(logged.map((l) => l.guard).sort(), Object.keys(GUARDS).sort(),
    'and each is a structured WARNING too, one line per guard');
}));

test('all but one guard dropped: every other one is named, the one left alone is not', withFile(async (path, said) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  outside(path, `DROP TRIGGER ${Object.keys(GUARDS).filter((n) => n !== 'events_no_update').join('; DROP TRIGGER ')};`);
  await reopen(path);
  const missing = said.map(classify).filter((c) => c?.kind === 'missing').map((c) => c.name).sort();
  assert.deepEqual(missing, Object.keys(GUARDS).filter((n) => n !== 'events_no_update').sort(),
    'every guard but the one left standing is named as missing');
}));

test('a guard dropped from outside the store is put back on the next open, naming each one that was gone', withFile(async (path, said, logged) => {
  const store = new SqliteEventStore(path); // first boot: installs every current guard
  const written = await store.append({ ...approval, text: 'a comment', snapshot: null }, 'owner@example.org');
  await store.close();
  // From a second connection, the way anyone holding the file could: drop the guard "nothing is
  // erased" rests on, and the one that keeps a text's removal honest — leaving the rest in place,
  // so this is a guard gone missing, not a fresh database.
  outside(path, 'DROP TRIGGER events_no_delete; DROP TRIGGER texts_no_delete;');
  await reopen(path);
  const seen = said.map(classify).filter(Boolean).sort(byName);
  assert.deepEqual(seen, [{ name: 'events_no_delete', kind: 'missing' }, { name: 'texts_no_delete', kind: 'missing' }],
    'each dropped guard has to be named as missing, not recreated in silence — holdrim#89 — and not worded as a replacement');
  assert.deepEqual(logged.map((l) => ({ severity: l.severity, event: l.event, guard: l.guard })).sort(byGuard),
    [{ severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'events_no_delete' },
     { severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'texts_no_delete' }],
    'and each is also said through log(), at WARNING, once per dropped guard');
  const db = new DatabaseSync(path);
  assert.throws(() => db.exec('DELETE FROM events'), /not deleted/, 'the real guard has to be back');
  assert.throws(() => db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(written.id, 'text'),
    /not deleted without a text_removed event/, 'the text guard has to be back too');
  db.close();
}));

test('a database the previous version made: the changed guards are replaced, the missing ones installed, the rest left alone', withFile(async (path, said) => {
  // The schema and the triggers exactly as the version before this one wrote them, spacing
  // included: SQLite keeps the text as written, so a comparison that minds spacing would replace
  // all five, and one that ignores the text would replace none. This fixture also predates
  // events_no_replace, events_no_low_rowid, events_no_high_rowid, events_no_first_rowid_below_one,
  // people_no_rowid_below_one and the whole texts table — the guard set an older release shipped
  // with, not tampering — so those nine are said as missing,
  // the same as any other guard this open does not find, rather than staying the silent case
  // (holdrim#89).
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
  const named = (line) => line.match(/guard "(\w+)"/)?.[1];
  assert.deepEqual(said.map(named).sort(),
    ['events_no_first_rowid_below_one', 'events_no_high_rowid', 'events_no_low_rowid', 'events_no_replace', 'people_no_replace',
      'people_no_rowid_below_one', 'people_only_lose_email', 'texts_no_delete', 'texts_no_replace', 'texts_no_rowid_below_one', 'texts_no_update'],
    'the guards whose text changed are replaced, the ones this fixture never had are installed, and each is said once');
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

test('a database from before texts were extracted gains the columns it needs, keeps its rows, and gets every guard, named', withFile(async (path, said) => {
  // The schema exactly as the version before this one wrote it: `events` with no `text_hash` or
  // `snapshot_hash`, no `texts` table at all, and — because this fixture already holds a real row —
  // no guard either, which is a database this check must NOT read as a first install: it already
  // has something in it for a guard to protect (the sharper half of holdrim#89's fix).
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
  const named = (line) => line.match(/guard "(\w+)"/)?.[1];
  assert.deepEqual(said.map(named).sort(), Object.keys(GUARDS).sort(),
    'widening the schema says nothing on its own, but a real row with no guard on it is not a first install: every guard is named as missing');
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

test("a text is not replaced by rowid either: freeing one row's slot cannot be used to swap another out from under it", withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const a = await store.append({ ...approval, block: 'A01.1.1', text: 'first', snapshot: null }, 'owner@example.org');
  const b = await store.append({ ...approval, block: 'A01.1.2', text: 'second', snapshot: null }, 'owner@example.org');
  await store.removeText(a.id, 'text', 'owner@example.org'); // frees a's (event, field), not any rowid
  await store.close();
  const db = new DatabaseSync(path);
  const bRow = db.prepare('SELECT rowid FROM texts WHERE event = ? AND field = ?').get(b.id, 'text');
  // Round 2, finding E: the (event, field) half of the WHEN clause alone would not catch this — the
  // key here, ('forged-event', 'text'), collides with no EXISTING row. Only reusing b's own rowid
  // does, which is exactly what a REPLACE conflicting on rowid, rather than on the declared key,
  // does under the hood: it would delete b's row and insert this one in its place, no delete trigger
  // fired, the same hole `texts_no_replace`'s first half exists to close for the declared key.
  assert.throws(() => db.prepare(
    "INSERT OR REPLACE INTO texts (rowid, event, field, value, salt) VALUES (?, 'forged-event', 'text', 'forged', 'saltsaltsaltsalt')"
  ).run(bRow.rowid), /not replaced/, "reusing another row's rowid under an unrelated key is refused the same as reusing its own key");
  const stillB = db.prepare('SELECT value FROM texts WHERE event = ? AND field = ?').get(b.id, 'text');
  assert.equal(stillB?.value, 'second', "b's own text is exactly as it was — never deleted to make room");
  db.close();
}));

test('a text is not deleted without a text_removed event naming THIS exact event and field, whatever deletes it', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const first = await store.append({ ...approval, text: 'first', snapshot: 'snap-first' }, 'owner@example.org');
  const second = await store.append({ ...approval, block: 'A01.1.2', text: 'second', snapshot: null }, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  const insertEvent = (id, type, data) => db.prepare(
    'INSERT INTO events (id, type, page, author, happened_at, data) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, type, 'A01', 'p_000000000000000000000000', '2026-01-01T00:00:00.000Z', JSON.stringify(data));
  const refused = (event, field, why) => assert.throws(
    () => db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(event, field),
    /not deleted without a text_removed event/, why);

  refused(first.id, 'text', 'a bare DELETE, with nothing to account for it, is refused');

  // Round 2, finding B: the WHEN clause has three conditions, and each has to be its own proof —
  // a removal naming ALMOST this row, in one way or another, is not a removal of this row.
  db.exec('BEGIN IMMEDIATE');
  insertEvent('rm-snap', 'text_removed', { event: first.id, field: 'snapshot' }); // (1) right event, wrong field
  db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(first.id, 'snapshot'); // its own delete is legitimate
  db.exec('COMMIT');
  refused(first.id, 'text', "(1) a removal naming this event's OTHER field does not excuse this one — the $.field half");

  db.exec('BEGIN IMMEDIATE');
  insertEvent('rm-second', 'text_removed', { event: second.id, field: 'text' }); // (2) right field, wrong event
  db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(second.id, 'text'); // its own delete is legitimate
  db.exec('COMMIT');
  refused(first.id, 'text', "(2) a removal naming a DIFFERENT event does not excuse this one — the $.event half");

  insertEvent('c1', 'comment', { event: first.id, field: 'text' }); // (3) right event and field, wrong type
  refused(first.id, 'text', "(3) naming this row from an event that is not itself a removal does not excuse it — the type = 'text_removed' half");

  // The legitimate path still works: a text_removed event naming THIS event and field, in the same
  // transaction, before the DELETE — exactly the order removeText itself now writes in.
  db.exec('BEGIN IMMEDIATE');
  insertEvent('rm-first', 'text_removed', { event: first.id, field: 'text' });
  assert.doesNotThrow(() => db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(first.id, 'text'),
    'once the removal event is there — even uncommitted, in the same transaction — the delete is legitimate');
  db.exec('COMMIT');
  db.close();
}));

test('a forged text_removed dated before its target reads as tampered, not as the removal it claims', withFile(async (path) => {
  // Round 2, finding F(c): the SQL guards refuse UPDATE, REPLACE and a bare DELETE, but nothing
  // here can refuse an INSERT — a direct writer can forge a text_removed event and then delete the
  // real row it names. Dated BEFORE the event it claims to remove text from, `removalsOf` (finding
  // F(a)) will not credit it: the field reads as tampered, exactly as a text erased with no
  // accounting for it at all would.
  const store = new SqliteEventStore(path);
  const early = await store.append({ ...approval, text: 'a real comment' }, 'r@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO events (id, type, page, author, happened_at, data) VALUES ('forged-early', 'text_removed', 'A01', 'p_000000000000000000000000', '2000-01-01T00:00:00.000Z', ?)")
    .run(JSON.stringify({ event: early.id, field: 'text' }));
  db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(early.id, 'text');
  db.exec('COMMIT');
  db.close();

  const s = new SqliteEventStore(path);
  const read = (await s.list('A01')).find((e) => e.id === early.id);
  assert.equal(read.textRemoved, null, 'a removal dated before its target is not credited');
  assert.equal(read.textTampered, true,
    'a real text erased behind a backdated forgery still reads as tampering, not as a clean removal');
  await s.close();
}));

test('a forged text_removed dated and ordered after its target is not caught: the gap that remains until events are signed', withFile(async (path) => {
  // The other half of finding F(c), documented rather than fixed: a forgery dated and ordered
  // correctly — after the event it names, exactly as a genuine removal would be — passes as one.
  // Closing this needs the events themselves signed (docs/PRIVACY.md, "not built", phase E), so a
  // reader can tell the server wrote an event from one anybody holding the file could insert.
  const store = new SqliteEventStore(path);
  const late = await store.append({ ...approval, text: 'another real comment' }, 'r@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  db.exec('BEGIN IMMEDIATE');
  db.prepare("INSERT INTO events (id, type, page, author, happened_at, data) VALUES ('forged-late', 'text_removed', 'A01', 'p_000000000000000000000000', '2099-01-01T00:00:00.000Z', ?)")
    .run(JSON.stringify({ event: late.id, field: 'text' }));
  db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(late.id, 'text');
  db.exec('COMMIT');
  db.close();

  const s = new SqliteEventStore(path);
  const read = (await s.list('A01')).find((e) => e.id === late.id);
  assert.equal(read.textTampered, false, 'a correctly dated and ordered forgery is NOT caught by this check — the documented gap');
  assert.ok(read.textRemoved, 'it reads as a legitimate removal, by whoever the forger named as the remover');
  await s.close();
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
    // Quoted as JSON (`guardMismatchSaid`), so `a"b` is said as `"a\"b"`.
    assert.ok(said.some((line) => line.includes(JSON.stringify(name))), `${name} has to be said`);
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

test('guardMismatches names what installGuards would repair, foreign first, on a read-only connection', withFile(async (path) => {
  // The CLI's `--db` reader (holdrim#108) asks the same question on a connection that cannot write,
  // so the comparison must not: a version that repaired as it compared would throw here.
  await reopen(path);
  outside(path, `DROP TRIGGER events_no_delete;
    DROP TRIGGER texts_no_update; CREATE TRIGGER texts_no_update BEFORE UPDATE ON texts BEGIN SELECT 1; END;
    CREATE TRIGGER x_ignore BEFORE INSERT ON events BEGIN SELECT RAISE(IGNORE); END;`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(guardMismatches(db), [
      { name: 'x_ignore', kind: 'foreign' },
      { name: 'events_no_delete', kind: 'missing' },
      { name: 'texts_no_update', kind: 'changed' },
    ]);
  } finally {
    db.close();
  }
  await reopen(path);
  const repaired = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(guardMismatches(repaired), [], 'and once the server repaired it, nothing is left to name');
  } finally {
    repaired.close();
  }
}));

/**
 * `events_no_replace` recreated as `inert`, next to whatever `decoy` SQL makes that text parse, and
 * then: the bypass is real — REPLACE onto the last approval's rowid, under a new id, erases it, which
 * the real guard refuses — and all three readers of the comparison still catch it: `guardMismatches`
 * calls it changed, the CLI's `--db` reader flags it, and the server replaces it, saying so. Each
 * caller's `inert` is a text a wrong `flat()` would call the same as the real guard.
 */
async function assertNeuteredReplaceCaught(path, said, decoy, inert) {
  assert.notEqual(inert, GUARDS.events_no_replace, 'the substitute has to differ for this to prove anything');
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  const last = await store.append({ ...approval, block: 'A01.1.2' }, 'owner@example.org');
  await store.close();
  outside(path, `${decoy}; DROP TRIGGER events_no_replace; CREATE TRIGGER events_no_replace ${inert};`);
  const raw = new DatabaseSync(path);
  try {
    const { rowid } = raw.prepare('SELECT rowid FROM events WHERE id = ?').get(last.id);
    raw.prepare(`INSERT OR REPLACE INTO events (rowid, id, type, page, author, happened_at)
      VALUES (?, 'overwritten', 'comment', 'A01', 'x', '2026-01-01T00:00:00.000Z')`).run(rowid);
    assert.equal(raw.prepare('SELECT 1 FROM events WHERE id = ?').get(last.id), undefined, 'the approval is gone');
  } finally {
    raw.close();
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(guardMismatches(db), [{ name: 'events_no_replace', kind: 'changed' }]);
  } finally {
    db.close();
  }
  const source = new Source({ db: path });
  await source.events();
  assert.equal(source.guardsTampered, true, 'the CLI reader flags it');
  await reopen(path);
  assert.deepEqual(said.map(classify).filter(Boolean), [{ name: 'events_no_replace', kind: 'replaced' }],
    'and the server replaces it, saying so');
}

test('a guard rewritten with U+00A0 for one space is changed, not the same text: named by guardMismatches, replaced by installGuards, flagged by the --db reader',
  withFile(async (path, said) => {
    // SQLite reads U+00A0 as part of an identifier, so `rowid\u00A0` is a column — added, and
    // always NULL — and the rowid half of the guard compares NULL with everything: it holds nothing.
    // A `flat()` built on `\s` reads the U+00A0 as a space.
    const nbsp = '\u00A0';
    await assertNeuteredReplaceCaught(path, said, `ALTER TABLE events ADD COLUMN "rowid${nbsp}"`,
      GUARDS.events_no_replace.replace('OR rowid = NEW.rowid', `OR rowid${nbsp}= NEW.rowid`));
  }));

test('a guard rewritten to read an empty decoy table, `FROM event s`, is changed, not the same text: named by guardMismatches, replaced by installGuards, flagged by the --db reader',
  withFile(async (path, said) => {
    // `event s` is the empty table `event` under the alias `s`: the guard's EXISTS asks a table
    // that holds nothing, and refuses nothing. A `flat()` that dropped spacing instead of
    // collapsing it to one space would read `event s` and `events` as the same word.
    await assertNeuteredReplaceCaught(path, said, 'CREATE TABLE event (id TEXT)',
      GUARDS.events_no_replace.replace('FROM events WHERE', 'FROM event s WHERE'));
  }));

test('[sqlite] the --db reader compares the guards in the snapshot it reads the rows from', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
  await store.close();
  // A second connection drops `events_no_low_rowid` and forges an approval below every real row the
  // moment the reader asks for the event rows — after the comparison, before the rows. Both orders
  // the reader could get wrong are caught: a comparison made BEFORE the read transaction opens
  // passes the guards and then reads the forgery (the row, unflagged); one made AFTER it closes
  // flags the drop, but the forgery is in hand too — the prepare hook fires before the rows
  // statement's first step, so a snapshot opened only for the rows already starts past the forgery.
  // In one snapshot, neither: the forgery is not read, and the guards it was compared against were
  // there.
  const original = DatabaseSync.prototype.prepare;
  let forged = 0;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (!forged && sql.includes('FROM events ORDER BY happened_at')) {
      forged++;
      outside(path, `DROP TRIGGER events_no_low_rowid;
        INSERT INTO events (rowid, id, type, page, block, fingerprint, author, happened_at)
          VALUES (-7, 'forged', 'approval', 'A01', 'A01.1.1', 'abc', 'owner@example.org', '2020-01-01T00:00:00.000Z');`);
    }
    return original.call(this, sql, ...rest);
  };
  const source = new Source({ db: path });
  let events;
  try {
    events = await source.events();
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
  assert.equal(forged, 1, 'the forgery has to have landed during the read for this to prove anything');
  const after = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(guardMismatches(after), [{ name: 'events_no_low_rowid', kind: 'missing' }, { name: 'events', kind: 'sunk' }],
      'the guard really is gone now, and the row it let in below 1 is named too');
    assert.ok(after.prepare("SELECT 1 FROM events WHERE id = 'forged'").get(), 'and the forged row really is in the file');
  } finally {
    after.close();
  }
  const forgedRead = events.some((e) => e.id === 'forged');
  assert.ok(!forgedRead || source.guardsTampered, 'a row written past a dropped guard is never read as guarded');
  assert.equal(forgedRead, false, 'the rows are from the snapshot the guards were compared in, not a later one');
  assert.equal(source.guardsTampered, false, 'and the guards are from the snapshot the rows were read in');
}));

// ===================================================================== holdrim#109: the rowid ceiling
// One event at the largest rowid SQLite has, accepted, sends every later append to a random rowid
// below it, where `events_no_low_rowid` refuses each one — the owner's ✓ included — as a forgery,
// and the row cannot be deleted. `events_no_high_rowid` holds every insert to MAX(rowid) + 1.

const PAST_NEXT = /not inserted past the next rowid/;
/** An insert naming its own rowid, the way anyone holding the file could write one. */
const insertAt = (rowid, id, verb = 'INSERT') => `${verb} INTO events (rowid, id, type, page, author, happened_at)
  VALUES (${rowid}, '${id}', 'approval', 'A01', 'p_000000000000000000000000', '2026-01-01T00:00:00.000Z')`;
const rowids = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT rowid FROM events ORDER BY rowid').all().map((r) => Number(r.rowid)); } finally { db.close(); }
};

test('an event parked at the largest rowid is refused however it is inserted, and the appends after it still go through', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  try {
    // REPLACE conflicts with nothing here — the id and the rowid are both free, so
    // `events_no_replace` lets it through — and OR IGNORE does not swallow a trigger's RAISE(ABORT):
    // every spelling of the insert reaches this guard, and each is refused by it, by name.
    for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE']) {
      assert.throws(() => db.exec(insertAt(CEILING, 'parked', verb)), PAST_NEXT, `${verb} at the largest rowid is refused`);
    }
    assert.equal(db.prepare("SELECT 1 FROM events WHERE id = 'parked'").get(), undefined, 'and nothing of it stays');
  } finally {
    db.close();
  }
  const again = new SqliteEventStore(path);
  try {
    await again.append({ ...approval, block: 'A01.1.2' }, 'owner@example.org');
    await again.append({ ...approval, block: 'A01.1.3' }, 'owner@example.org');
  } finally {
    await again.close();
  }
  assert.deepEqual(rowids(path), [1, 2, 3], 'every append takes the next rowid, none a random one below a parked row');
}));

test('an explicit rowid of MAX + 2 is refused, MAX + 1 goes through, and a normal append takes the one after', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.append({ ...approval, block: 'A01.1.2' }, 'owner@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => db.exec(insertAt(4, 'skips-one')), PAST_NEXT, 'one free rowid skipped is already past the next one');
    assert.doesNotThrow(() => db.exec(insertAt(3, 'next')), 'MAX + 1 is exactly the rowid an append would have taken');
  } finally {
    db.close();
  }
  const again = new SqliteEventStore(path);
  try {
    await assert.doesNotReject(again.append({ ...approval, block: 'A01.1.3' }, 'owner@example.org'), 'a normal append still goes through');
  } finally {
    await again.close();
  }
  assert.deepEqual(rowids(path), [1, 2, 3, 4]);
}));

test('on an empty events table the bound is 1: rowid 2 and the ceiling are refused, rowid 1 goes through', withFile(async (path) => {
  // No event yet, but not a fresh file: a person row is already there. An empty `events` is no
  // reason to leave the ceiling open — one event parked there first traps every append after it.
  const store = new SqliteEventStore(path);
  await store.personFor('ana@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => db.exec(insertAt(CEILING, 'parked-first')), PAST_NEXT, 'the ceiling is refused on an empty table too');
    assert.throws(() => db.exec(insertAt(2, 'skips-one')), PAST_NEXT, 'rowid 2 skips the 1 SQLite itself would give');
    assert.doesNotThrow(() => db.exec(insertAt(1, 'first')), 'rowid 1 is the one a first append takes');
  } finally {
    db.close();
  }
}));

test('events_no_high_rowid missing from a file, as an older version left it or as someone dropped it: named by guardMismatches and the --db reader, then put back by the next boot, out loud once', withFile(async (path, said, logged) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  // A file a version before this guard made, holding events, looks exactly like this one: every
  // other guard in place and this one not. Neither reader can tell the two apart from the file.
  outside(path, 'DROP TRIGGER events_no_high_rowid');
  const ro = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(guardMismatches(ro), [{ name: 'events_no_high_rowid', kind: 'missing' }]);
  } finally {
    ro.close();
  }
  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(line);
  try {
    const source = new Source({ db: path });
    await source.events();
    assert.equal(source.guardsTampered, true, 'the CLI flags it until a server of this version has opened the file');
    assert.ok(errors.some((l) => /the database's guard "events_no_high_rowid" is missing; read as it is, nothing repaired/.test(l)),
      'in the words an operator who upgraded reads first');
  } finally {
    console.error = error;
  }
  await reopen(path);
  assert.deepEqual(said.map(classify).filter(Boolean), [{ name: 'events_no_high_rowid', kind: 'missing' }],
    'the next boot names it as missing, the one guard it installs');
  assert.deepEqual(logged.map((l) => ({ severity: l.severity, event: l.event, guard: l.guard })),
    [{ severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'events_no_high_rowid' }]);
  const db = new DatabaseSync(path);
  try {
    assert.throws(() => db.exec(insertAt(CEILING, 'parked')), PAST_NEXT, 'and it is back in force');
  } finally {
    db.close();
  }
  said.length = 0;
  await reopen(path);
  assert.deepEqual(said, [], 'said once: the boot after that finds it in place');
  const after = new Source({ db: path });
  await after.events();
  assert.equal(after.guardsTampered, false, 'and the CLI reads the file as guarded again');
}));

// ============================================== holdrim#109, round 2: what the guards cannot see
// Every rowid guard reads `rowid`, and a column by that name — or `oid`, or `_rowid_` — takes the
// name from the real one with every trigger's text left as it was. And a row parked at the ceiling
// outlives however it got there. Neither is a trigger a boot can put back, so both are named, by
// the server on every boot and by the CLI on every read, and never repaired.

/** The CLI's `--db` reader over `path`: whether it flagged the file, and what it said on stderr. */
async function readWithCli(path) {
  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    const source = new Source({ db: path });
    const events = await source.events();
    return { tampered: source.guardsTampered, errors, events };
  } finally {
    console.error = error;
  }
}

const mismatchesOf = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return guardMismatches(db); } finally { db.close(); }
};

test('a column that hides the rowid is named on each of the three tables, in any spelling, a generated one too', withFile(async (path) => {
  await reopen(path);
  for (const table of ['events', 'people', 'texts']) {
    for (const column of ['rowid', 'OID', '_RowId_']) {
      outside(path, `ALTER TABLE ${table} ADD COLUMN ${column} INTEGER`);
      assert.deepEqual(mismatchesOf(path), [{ name: `${table}.${column}`, kind: 'shadowed' }], `${table}.${column}`);
      outside(path, `ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    // A generated column is left out of `table_info` and hides the rowid all the same.
    outside(path, `ALTER TABLE ${table} ADD COLUMN RowID AS (7)`);
    assert.deepEqual(mismatchesOf(path), [{ name: `${table}.RowID`, kind: 'shadowed' }], `${table}.RowID, generated`);
    outside(path, `ALTER TABLE ${table} DROP COLUMN RowID`);
  }
  outside(path, 'ALTER TABLE events ADD COLUMN rowids INTEGER');
  assert.deepEqual(mismatchesOf(path), [], 'a name that only starts like one hides nothing');
}));

// Two of the ways a row reaches the ceiling with every guard in place by the time anyone looks. The
// third, a connection that turns triggers off for itself (SQLITE_DBCONFIG_ENABLE_TRIGGER), leaves
// the same file behind, and node:sqlite offers no switch for it here.
const PARKINGS = {
  'through a rowid column added and dropped again': `ALTER TABLE events ADD COLUMN rowid INTEGER;
    ${insertAt(CEILING, 'parked', 'INSERT').replace('(rowid,', '(_rowid_,')};
    ALTER TABLE events DROP COLUMN rowid;`,
  'with events_no_high_rowid dropped and put back by its exact text': `DROP TRIGGER events_no_high_rowid;
    ${insertAt(CEILING, 'parked')};
    CREATE TRIGGER events_no_high_rowid ${GUARDS.events_no_high_rowid};`,
};

for (const [how, sql] of Object.entries(PARKINGS)) {
  test(`an event parked at the ceiling ${how} is named by guardMismatches, the --db reader and every boot, and the refused append says why`, withFile(async (path, said, logged) => {
    const store = new SqliteEventStore(path);
    await store.append(approval, 'owner@example.org');
    await store.close();
    outside(path, sql);
    assert.deepEqual(mismatchesOf(path), [{ name: 'events', kind: 'parked' }], 'every guard is in place: only the row is left to name');

    const cli = await readWithCli(path);
    assert.equal(cli.tampered, true, 'so sync, apply and state refuse');
    assert.ok(cli.errors.some((l) => /events table holds a row at the largest rowid, 9223372036854775807/.test(l) && /no boot repairs this/.test(l)),
      'in words that say what is wrong, and that starting the server will not fix it');
    assert.ok(cli.events.some((e) => e.id === 'parked'), 'and the file is still read, the parked row included, instead of throwing on it');

    for (const boot of [1, 2]) {
      said.length = 0;
      logged.length = 0;
      await reopen(path);
      assert.deepEqual(said, [`holdrim: the database's events table holds a row at the largest rowid, ${CEILING}, `
        + 'so every append after it lands below that row and is refused as a forgery, which it is not; nothing a boot does repairs this'],
        `boot ${boot}: said on every boot, since nothing repairs it`);
      assert.deepEqual(logged.map((l) => ({ severity: l.severity, event: l.event, guard: l.guard, kind: l.kind })),
        [{ severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'events', kind: 'parked' }]);
    }

    const again = new SqliteEventStore(path);
    try {
      assert.equal((await again.list('A01')).length, 2, 'the page still reads');
      const err = await again.append({ ...approval, block: 'A01.1.2' }, 'owner@example.org').then(() => null, (e) => e);
      assert.ok(err, 'the append is still refused: nothing here unparks the table');
      assert.match(err.message, /not recorded: the database's events table holds a row at the largest rowid/,
        'and says the cause, not that the owner forged their own write');
      assert.match(err.cause.message, /not inserted below one already held/, "the guard's own words go along as the cause");
    } finally {
      await again.close();
    }
  }));
}

test("a rowid column on events lets #91's forgery below every row through: named while it is there, by guardMismatches, the --db reader and the boot, and the row stays named once it is gone", withFile(async (path, said) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  outside(path, `ALTER TABLE events ADD COLUMN rowid INTEGER;
    ${insertAt(-7, 'forged-low').replace('(rowid,', '(_rowid_,')};`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT 1 FROM events WHERE id = 'forged-low' AND _rowid_ = -7").get(),
      'the guard that refuses a row below the others let this one in: it compared the column');
  } finally {
    db.close();
  }
  assert.deepEqual(mismatchesOf(path), [{ name: 'events.rowid', kind: 'shadowed' }, { name: 'events', kind: 'sunk' }]);
  assert.equal((await readWithCli(path)).tampered, true);
  await reopen(path);
  assert.ok(said.some((l) => l.includes('the database has a column "events.rowid" that hides the real rowid from every guard')), said.join('\n'));
  // Below 1 is where no genuine insert lands, so the forgery outlives the column that let it in.
  outside(path, 'ALTER TABLE events DROP COLUMN rowid');
  assert.deepEqual(mismatchesOf(path), [{ name: 'events', kind: 'sunk' }]);
}));

test('a rowid column with a DEFAULT makes every append collide: the append says the column is why', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  outside(path, 'ALTER TABLE events ADD COLUMN rowid INTEGER DEFAULT 7');
  const again = new SqliteEventStore(path);
  try {
    const err = await again.append({ ...approval, block: 'A01.1.2' }, 'owner@example.org').then(() => null, (e) => e);
    assert.ok(err, 'events_no_replace reads the column, and every row holds the same 7');
    assert.match(err.message, /not recorded: the database has a column "events\.rowid" that hides the real rowid/);
    assert.match(err.cause.message, /not replaced/);
  } finally {
    await again.close();
  }
}));

test("a rowid column on people lets UPDATE OR REPLACE erase another person's row: named while it is there", withFile(async (path, said) => {
  const store = new SqliteEventStore(path);
  const ana = await store.personFor('ana@example.org');
  const bruno = await store.personFor('bruno@example.org');
  await store.close();
  const db = new DatabaseSync(path);
  try {
    const { rowid } = db.prepare('SELECT rowid FROM people WHERE id = ?').get(ana);
    db.exec('ALTER TABLE people ADD COLUMN rowid INTEGER');
    // `people_only_lose_email` compares NEW.rowid with OLD.rowid, and both are the column now.
    db.prepare('UPDATE OR REPLACE people SET _rowid_ = ?, email = NULL WHERE id = ?').run(rowid, bruno);
    assert.equal(db.prepare('SELECT 1 FROM people WHERE id = ?').get(ana), undefined,
      "ana's row is gone, with every guard in place: the attack is real");
  } finally {
    db.close();
  }
  assert.deepEqual(mismatchesOf(path), [{ name: 'people.rowid', kind: 'shadowed' }]);
  assert.equal((await readWithCli(path)).tampered, true, 'so sync, apply and state refuse');
  await reopen(path);
  assert.ok(said.some((l) => l.includes('"people.rowid" that hides the real rowid')), said.join('\n'));
}));

// ================================================ holdrim#109, round 3: below rowid 1, and the proofs
// In a BEFORE INSERT trigger, NEW.rowid is -1 for an insert that leaves the rowid to SQLite, so one
// row held at -1 makes `events_no_replace`, `people_no_replace` and `texts_no_replace` read every
// genuine insert after it as replacing that row. A genuine insert takes a rowid below 1 only once
// a row below 1 is already there.

const BELOW_ONE = { events: /an event is not inserted below rowid 1/, people: /a person is not inserted below rowid 1/,
  texts: /a text is not inserted below rowid 1/ };
const personAt = (rowid, id) => `INSERT INTO people (rowid, id, email) VALUES (${rowid}, '${id}', NULL)`;
const textAt = (rowid, event) => `INSERT INTO texts (rowid, event, field, value, salt) VALUES (${rowid}, '${event}', 'snapshot', 'x', 'y')`;
/** `sql` run with `guard` lifted and put back by its exact text, as a file made before it can hold what it leaves. */
const without = (guard, sql) => `DROP TRIGGER ${guard}; ${sql}; CREATE TRIGGER ${guard} ${GUARDS[guard]};`;

test('a row below rowid 1 is refused on people and texts whatever they hold, and on events while it is empty; genuine inserts still start at 1', withFile(async (path) => {
  await reopen(path);
  const db = new DatabaseSync(path);
  try {
    for (const rowid of [-1, 0]) {
      for (const verb of ['INSERT', 'REPLACE']) {
        assert.throws(() => db.exec(insertAt(rowid, `sunk${rowid}`, verb)), BELOW_ONE.events, `events, empty: ${verb} at ${rowid}`);
      }
      assert.throws(() => db.exec(personAt(rowid, `p_sunk${rowid}`)), BELOW_ONE.people, `people, empty: ${rowid}`);
    }
    db.exec(insertAt(1, 'first'));
    db.exec(personAt(1, 'p_first'));
    // Held rows change nothing for people and texts; for events, `events_no_low_rowid` answers
    // instead, in its own words, and this guard stays silent.
    assert.throws(() => db.exec(insertAt(-7, 'forged')), /not inserted below one already held/, 'events, holding a row: the low guard, alone');
    assert.throws(() => db.exec(personAt(-1, 'p_sunk')), BELOW_ONE.people, 'people, holding a row');
    for (const rowid of [-1, 0]) assert.throws(() => db.exec(textAt(rowid, 'first')), BELOW_ONE.texts, `texts: ${rowid}`);
    assert.deepEqual({ ...db.prepare('SELECT (SELECT COUNT(*) FROM events) e, (SELECT COUNT(*) FROM people) p, (SELECT COUNT(*) FROM texts) t').get() },
      { e: 1, p: 1, t: 0 }, 'nothing refused stays');
  } finally {
    db.close();
  }
  const store = new SqliteEventStore(path);
  let remark;
  try {
    remark = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'ana@example.org');
  } finally {
    await store.close();
  }
  const rw = new DatabaseSync(path);
  try {
    assert.deepEqual(['events', 'people', 'texts'].map((t) => Number(rw.prepare(`SELECT MIN(rowid) m FROM ${t}`).get().m)), [1, 1, 1],
      'and a genuine insert into each table, texts included, went through at 1 or above');
    // texts again, now that it holds a row: above, it was tried only while empty.
    for (const rowid of [-1, 0]) assert.throws(() => rw.exec(textAt(rowid, remark.id)), BELOW_ONE.texts, `texts, holding a row: ${rowid}`);
  } finally {
    rw.close();
  }
}));

// Each way a row already held below 1 traps the next genuine write, with every guard in place by
// the time anyone looks. Each is set up the way a file made before its guard could hold it.
const SUNK = {
  people: {
    setup: async (store) => { await store.personFor('ana@example.org'); },
    sql: without('people_no_rowid_below_one', personAt(-1, 'p_trap')),
    // A new person: a new reviewer, or the owner after a handover.
    write: (store) => store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'new@example.org'),
    what: 'person', guard: /can only lose their e-mail/,
  },
  texts: {
    setup: async (store) => { await store.append({ type: 'comment', page: 'A01', text: 'first' }, 'ana@example.org'); },
    sql: without('texts_no_rowid_below_one', textAt(-1, '__EVENT__')),
    write: (store) => store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'ana@example.org'),
    what: 'event', guard: /a text is not replaced/,
  },
  events: {
    // Not a fresh file: a person is there, and no event yet.
    setup: async (store) => { await store.personFor('ana@example.org'); },
    sql: without('events_no_first_rowid_below_one', insertAt(-1, 'sunk')),
    write: (store) => store.append(approval, 'ana@example.org'),
    what: 'event', guard: /an event is not replaced/,
  },
};

// Shared by the plain SUNK case below and the renamed-table case further down: plant the row,
// then check every reader names it the same way and the genuine write is refused for the same
// reason. `beforeMismatch`, when given, runs the renamed case's extra step — the table rename
// itself — before anything is asserted, so the two cases end up checking exactly the same things
// instead of one silently dropping an assertion the other still makes.
async function expectSunkRefused(path, said, logged, table, how, beforeMismatch) {
  const store = new SqliteEventStore(path);
  await how.setup(store);
  await store.close();
  const event = new DatabaseSync(path, { readOnly: true });
  const firstEvent = event.prepare('SELECT id FROM events LIMIT 1').get()?.id;
  event.close();
  outside(path, how.sql.replace('__EVENT__', firstEvent));
  if (beforeMismatch) beforeMismatch();
  assert.deepEqual(mismatchesOf(path), [{ name: table, kind: 'sunk' }], 'every guard is in place: only the row is left to name');

  const cli = await readWithCli(path);
  assert.equal(cli.tampered, true, 'so sync, apply and state refuse');
  assert.ok(cli.errors.some((l) => l.includes(`the database's ${table} table holds a row below rowid 1`) && /no boot repairs this/.test(l)),
    cli.errors.join('\n'));

  for (const boot of [1, 2]) {
    said.length = 0;
    logged.length = 0;
    await reopen(path);
    assert.deepEqual(said, [`holdrim: the database's ${table} table holds a row below rowid 1, which only a write that named it, `
      + 'or one sent below 1 by such a row, puts there, and one at -1 makes every insert after it read as a replace, '
      + 'refused as a forgery, which it is not; nothing a boot does repairs this'],
      `boot ${boot}: said on every boot, since nothing repairs it`);
    assert.deepEqual(logged.map((l) => ({ event: l.event, guard: l.guard, kind: l.kind })),
      [{ event: 'sqlite_guard_missing', guard: table, kind: 'sunk' }]);
  }

  const again = new SqliteEventStore(path);
  try {
    const err = await how.write(again).then(() => null, (e) => e);
    assert.ok(err, 'the genuine write is refused: the row at -1 is still there');
    assert.match(err.message, new RegExp(`^the ${how.what} was not recorded: the database's ${table} table holds a row below rowid 1`),
      'and says the cause, not that the operator forged their own write');
    assert.match(err.cause.message, how.guard, "the guard's own words go along as the cause");
  } finally {
    await again.close();
  }
}

for (const [table, how] of Object.entries(SUNK)) {
  test(`a row held at rowid -1 on ${table} is named by guardMismatches, the --db reader and every boot, and the refused write says why`,
    withFile((path, said, logged) => expectSunkRefused(path, said, logged, table, how)));
}

// Below 1, not below 0: a row at 0 traps nothing by itself, but no genuine insert takes it either.
const AT_ZERO = {
  events: without('events_no_first_rowid_below_one', insertAt(0, 'zero')),
  people: without('people_no_rowid_below_one', personAt(0, 'p_zero')),
  texts: without('texts_no_rowid_below_one', `${insertAt(1, 'first')}; ${textAt(0, 'first')}`),
};

for (const [table, sql] of Object.entries(AT_ZERO)) {
  test(`a row at rowid 0 on ${table} is named sunk too`, withFile(async (path) => {
    await reopen(path);
    outside(path, sql);
    assert.deepEqual(mismatchesOf(path), [{ name: table, kind: 'sunk' }]);
  }));
}

// SQLite resolves a table name in any case, so a table renamed through a temporary name to upper
// case (a rename that changes only the case is refused, one through another name is not) is still
// the one every guard's `ON texts` binds to and every write goes into — with every guard dropped
// first and put back by its exact text, nothing about the triggers shows it.
const everyGuardAround = (sql) => `${Object.keys(GUARDS).map((g) => `DROP TRIGGER ${g};`).join(' ')} ${sql};
  ${Object.entries(GUARDS).map(([g, body]) => `CREATE TRIGGER ${g} ${body};`).join(' ')}`;
const toUpper = (table) => `ALTER TABLE ${table} RENAME TO ${table}_aside; ALTER TABLE ${table}_aside RENAME TO ${table.toUpperCase()}`;

for (const [table, how] of Object.entries(SUNK)) {
  test(`${table} renamed to ${table.toUpperCase()} with a row at rowid -1: still named, and the refused write still says why`,
    withFile((path, said, logged) => expectSunkRefused(path, said, logged, table, how, () => outside(path, everyGuardAround(toUpper(table))))));
}

test('events renamed to EVENTS with a row parked at the ceiling: still named', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  await store.append(approval, 'owner@example.org');
  await store.close();
  outside(path, everyGuardAround(`${insertAt(CEILING, 'parked')}; ${toUpper('events')}`));
  assert.deepEqual(mismatchesOf(path), [{ name: 'events', kind: 'parked' }]);
}));

test('the --db reader reads people and texts renamed to upper case as the server does: the author resolved, the text not tampered', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'ana@example.org');
  await store.close();
  outside(path, everyGuardAround(`${toUpper('people')}; ${toUpper('texts')}`));
  const read = (e) => ({ author: e.author, text: e.text, textTampered: e.textTampered });
  const cli = await readWithCli(path);
  assert.equal(cli.tampered, false, 'nothing is wrong with this file: the names are only in another case');
  assert.deepEqual(cli.events.map(read), [{ author: 'ana@example.org', text: 'a remark', textTampered: false }]);
  const server = new SqliteEventStore(path);
  try {
    assert.deepEqual((await server.list()).map(read), cli.events.map(read), 'and the server reads the same');
  } finally {
    await server.close();
  }
}));

test('a refused write names only what is wrong with the tables it wrote to, on the person path and the event path alike', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const first = await store.append({ type: 'comment', page: 'A01', text: 'first' }, 'ana@example.org');
  await store.close();
  outside(path, without('people_no_rowid_below_one', personAt(-1, 'p_trap'))
    + without('texts_no_rowid_below_one', textAt(-1, first.id)));
  const again = new SqliteEventStore(path);
  try {
    // A person already held: `people` is not written, so what is wrong there did not refuse this.
    const byAna = await again.append({ type: 'comment', page: 'A01', text: 'again' }, 'ana@example.org').then(() => null, (e) => e);
    assert.match(byAna.message, /^the event was not recorded: the database's texts table holds a row below rowid 1[^;]*\. This is how/);
    // A new person is refused at `people`, before any event or text is written.
    const byNew = await again.personFor('new@example.org').then(() => null, (e) => e);
    assert.match(byNew.message, /^the person was not recorded: the database's people table holds a row below rowid 1[^;]*\. This is how/);
  } finally {
    await again.close();
  }
}));

test('removeText on a parked file says the row is why', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const e = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'owner@example.org');
  await store.close();
  outside(path, without('events_no_high_rowid', insertAt(CEILING, 'parked')));
  const again = new SqliteEventStore(path);
  try {
    const err = await again.removeText(e.id, 'text', 'owner@example.org').then(() => null, (x) => x);
    assert.match(err.message, /^the event was not recorded: the database's events table holds a row at the largest rowid/);
    assert.match(err.cause.message, /not inserted below one already held/);
  } finally {
    await again.close();
  }
}));

test('removeText refused on a parked file names events only: a row below 1 on people or texts cannot refuse a removal', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const e = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'owner@example.org');
  await store.close();
  outside(path, without('events_no_high_rowid', insertAt(CEILING, 'parked'))
    + without('people_no_rowid_below_one', personAt(-1, 'p_trap'))
    + without('texts_no_rowid_below_one', textAt(-1, e.id)));
  const again = new SqliteEventStore(path);
  try {
    const err = await again.removeText(e.id, 'text', 'owner@example.org').then(() => null, (x) => x);
    // One cause, then the closing sentence: a second table named would come after a ';'.
    assert.match(err.message, /^the event was not recorded: the database's events table holds a row at the largest rowid[^;]*\. This is how/);
  } finally {
    await again.close();
  }
}));

test('removeText of a text that is not there says so even on a file with a row below 1: that answer is not the file\'s fault', withFile(async (path) => {
  const store = new SqliteEventStore(path);
  const e = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'owner@example.org');
  await store.close();
  outside(path, without('texts_no_rowid_below_one', textAt(-1, e.id)));
  const again = new SqliteEventStore(path);
  try {
    // The first removal writes an event and deletes a row, and inserts no text: it goes through.
    await again.removeText(e.id, 'text', 'owner@example.org');
    const err = await again.removeText(e.id, 'text', 'owner@example.org').then(() => null, (x) => x);
    assert.match(err.message, /^no text to remove on event /);
    assert.equal(err.cause, undefined);
  } finally {
    await again.close();
  }
}));

// The proof lens's round 2 cases: each is here because a mutation of the code it names survived
// the suite without it.

test('a row parked at the ceiling that is the only hashed row: list with and without a page, and the --db reader, still read it', withFile(async (path) => {
  await reopen(path);
  // The only hashed row, so `extractionBoundary` is its rowid: read as an integer, that throws.
  outside(path, without('events_no_high_rowid', `INSERT INTO events (rowid, id, type, page, author, happened_at, text_hash)
    VALUES (${CEILING}, 'parked', 'comment', 'A01', 'p_000000000000000000000000', '2026-01-01T00:00:00.000Z', 'h')`));
  const cli = await readWithCli(path);
  assert.deepEqual(cli.events.map((x) => x.id), ['parked'], 'the --db reader');
  assert.equal(cli.tampered, true);
  const store = new SqliteEventStore(path);
  try {
    assert.deepEqual((await store.list()).map((x) => x.id), ['parked'], 'list, every page');
    assert.deepEqual((await store.list('A01')).map((x) => x.id), ['parked'], 'list, one page');
    assert.equal((await store.list())[0].textTampered, true, 'read after the boundary, so its missing text is named, not trusted');
  } finally {
    await store.close();
  }
}));

test('a ROWID column and a row parked at the ceiling: both named, the rowid read through a name the column does not hide in any case', withFile(async (path) => {
  await reopen(path);
  outside(path, `ALTER TABLE events ADD COLUMN ROWID INTEGER; ${insertAt(CEILING, 'parked').replace('(rowid,', '(_rowid_,')};`);
  assert.deepEqual(mismatchesOf(path), [{ name: 'events.ROWID', kind: 'shadowed' }, { name: 'events', kind: 'parked' }]);
}));

test('all three rowid names hidden on events: each is named, and nothing throws for want of a name to ask with', withFile(async (path) => {
  await reopen(path);
  outside(path, 'ALTER TABLE events ADD COLUMN rowid INTEGER; ALTER TABLE events ADD COLUMN oid INTEGER; ALTER TABLE events ADD COLUMN _rowid_ INTEGER;');
  assert.deepEqual(mismatchesOf(path).map((m) => m.name).sort(), ['events._rowid_', 'events.oid', 'events.rowid']);
}));

test('a row one short of the ceiling is not named, until a genuine append takes the ceiling', withFile(async (path) => {
  await reopen(path);
  outside(path, without('events_no_high_rowid', insertAt('9223372036854775806', 'near')));
  assert.deepEqual(mismatchesOf(path), [], 'one short traps nothing: the next append still gets the next rowid');
  const store = new SqliteEventStore(path);
  try {
    await store.append(approval, 'owner@example.org');
  } finally {
    await store.close();
  }
  assert.deepEqual(mismatchesOf(path), [{ name: 'events', kind: 'parked' }], 'that append took the ceiling: from here on, every one is refused');
}));

test('a file parked before events_no_high_rowid existed: the boot installs the guard, names the row, and comes up', withFile(async (path, said) => {
  await reopen(path);
  outside(path, `DROP TRIGGER events_no_high_rowid; ${insertAt(CEILING, 'parked')};`);
  await reopen(path);
  assert.deepEqual(said, [
    `holdrim: the database's events table holds a row at the largest rowid, ${CEILING}, `
      + 'so every append after it lands below that row and is refused as a forgery, which it is not; nothing a boot does repairs this',
    'holdrim: the database\'s guard "events_no_high_rowid" is missing; installing it',
  ]);
  assert.deepEqual(mismatchesOf(path), [{ name: 'events', kind: 'parked' }], 'the guard is back; only the row is left');
}));

test('a boot on a parked file with every guard in place does not wait on another writer', withFile(async (path) => {
  await reopen(path);
  outside(path, without('events_no_high_rowid', insertAt(CEILING, 'parked')));
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');
  try {
    // Nothing a boot can repair: taking the write lock would wait out the busy timeout, and fail.
    const started = Date.now();
    await reopen(path);
    assert.ok(Date.now() - started < 2000, 'the open has to go through without waiting for the lock');
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
  }
}));
