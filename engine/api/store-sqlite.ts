import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES, withAuthors } from './people.ts';
import { noText, notBefore, saltFields, textKey, withTexts, reportTampered, TEXT_REMOVED,
  type TextField, type TamperReport } from './texts.ts';
import { log, jsonForTerminal } from './log.ts';

/**
 * SQLite persistence on the built-in `node:sqlite` — **no external dependency**.
 *
 * It is what lets someone start Holdrim and use it with no database, no cloud, no account anywhere:
 * one file on disk. For a team, swap in Postgres or Firestore by implementing the same `EventStore`
 * interface.
 *
 * INSERT ONLY, as the method demands: there is no DELETE in this file, and the one UPDATE empties a
 * person's e-mail — the only change the people table takes, and the triggers refuse any other. The
 * trail is the product.
 */
/**
 * Attempts a ROLLBACK, swallowing only ITS OWN failure — the caller still throws whatever error
 * sent it here. Round 3 of the #91 review, MINOR: a bare `db.exec('ROLLBACK')` in a catch block, on
 * a connection already gone or a WAL past saving, can fail on its own, and an unguarded call there
 * replaces the read's or write's real reason for failing with a complaint about undoing a failure
 * that already happened — strictly worse than a ROLLBACK that quietly does nothing because there
 * was nothing left to undo.
 *
 * Returns instead of also rethrowing `err` itself, so every call site keeps its own `throw err;` —
 * a version that swallowed and rethrew here once left `rows`/`people`/`texts` in `Source#fromFile`
 * (engine/cli/remote.ts) "used before being assigned" to `tsc`: that file imports this one
 * dynamically (the same reason it already does for `extractionBoundary`), and a `never`-returning
 * function reached through a destructured dynamic import does not narrow control flow the way a
 * literal `throw` does, so `tsc` could no longer see that the lines after the catch are unreachable
 * without it. One helper either way, not a `try { db.exec('ROLLBACK') } catch {}` repeated at every
 * site: `list` and `installGuards` below use it, and so does `Source#fromFile`. `append` and
 * `removeText` keep their own inline `db.exec('ROLLBACK')` for now: nothing has flagged those two,
 * and folding them in without a finding behind it is scope this round of review did not ask for.
 */
export function rollbackQuietly(db: DatabaseSync): void {
  try { db.exec('ROLLBACK'); } catch { /* the caller's own error is the one that matters */ }
}
/**
 * The triggers "Nothing is erased" rests on, by name. The database refuses, even for someone opening
 * the file with another program, so the rule stops depending on this code never calling UPDATE.
 */
export const GUARDS: Record<string, string> = {
  events_no_update: `BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'an event is not altered: the trail is the product'); END`,
  events_no_delete: `BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'an event is not deleted: the trail is the product'); END`,
  // The two above do not see REPLACE. `INSERT OR REPLACE` and `REPLACE INTO` delete the row they
  // conflict with and insert the new one without firing the delete trigger, because
  // recursive_triggers is off and a program opening the file never turns it on. The conflict can be
  // on the id or on the rowid — `events` is a rowid table, and naming a held rowid under a new id
  // erases that row just the same. So an insert that holds either is refused before REPLACE reaches
  // its delete step: without this, any event, a ✓ included, could be rewritten from outside.
  events_no_replace: `BEFORE INSERT ON events
    WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id OR rowid = NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'an event is not replaced: the trail is the product'); END`,
  // Round 3 of the #91 review, MAJOR: `events_no_replace` above only refuses a rowid that is
  // ALREADY held — nothing stopped an explicit `INSERT INTO events (rowid, ...) VALUES (-7, ...)`,
  // since a negative rowid (or 0) is always free; SQLite's rowid space runs from -2^63 to 2^63-1,
  // and a real `append` never asks for anything but the next positive one. A row forged that way
  // sorts BELOW `extractionBoundary` by rowid, and stripped of its hash it reads as a genuine
  // pre-extraction row with no alert at all — the very forgery `extractionBoundary` exists to name,
  // walked around with a plain INSERT and no trigger dropped. This closes that: an insert may only
  // ever become the new highest rowid, so `extractionBoundary`'s own claim that rowid only grows
  // is enforced here, not merely assumed of every past and future write to this table.
  //
  // AFTER, not BEFORE: in a BEFORE INSERT trigger, `NEW.rowid` is still -1 for an ordinary insert
  // that leaves SQLite to pick the rowid itself — the real value is not assigned until the row is
  // actually written — so a BEFORE trigger comparing NEW.rowid here would reject every normal
  // insert, not only a forged one. By the time an AFTER trigger runs, NEW.rowid is the row's real,
  // final one, and the row is already IN the table `MAX(rowid)` reads: a genuine append always
  // becomes the new highest rowid, so it compares equal to that MAX (not less than it) and passes;
  // only a row that landed BELOW one already there trips this — verified directly against
  // `node:sqlite`, not assumed from SQLite's own docs, in users.test.js ("the database REFUSES an
  // insert whose rowid lands below one already held, even when the rowid itself is free").
  events_no_low_rowid: `AFTER INSERT ON events
    WHEN NEW.rowid < (SELECT MAX(rowid) FROM events)
    BEGIN SELECT RAISE(ABORT, 'an event is not inserted below one already held: the trail is the product'); END`,
  // holdrim#109: `events_no_low_rowid` above lets an insert land anywhere ABOVE the highest rowid
  // held, and one place up there is a trap. A rowid tops out at 9223372036854775807, and once a row
  // holds that, SQLite picks a random free rowid for every later insert that names none — always
  // below that row — so `events_no_low_rowid` refuses every append after it, the owner's ✓ included,
  // and tells the operator each genuine write is a forgery. The row cannot be deleted, so the only
  // way out would be dropping a guard. So an insert may name no rowid above the one SQLite would
  // have picked itself, MAX(rowid) + 1: with `events_no_low_rowid` beside it, every insert into a
  // table that holds a row takes exactly that one. Like every guard, it binds only a connection
  // that runs triggers and a file that still holds it: `guardMismatches` below names a table parked
  // at the ceiling however it got there, and `append` says so when that is why it was refused.
  //
  // AFTER, not BEFORE, although today the two behave alike: SQLite documents NEW.rowid in a BEFORE
  // INSERT trigger as undefined when the insert leaves the rowid to SQLite. node:sqlite gives -1
  // there, which is never above MAX + 1, so a BEFORE version passes every normal append too — but
  // only because of a placeholder nobody promises. After the insert, NEW.rowid is the rowid the row
  // really got, and it is the same shape as `events_no_low_rowid`. The price of AFTER is that the
  // row is already in the table: compared with a MAX that counted it, NEW.rowid is never above
  // MAX + 1 and this guard would never fire. `rowid <> NEW.rowid` leaves it out, so the comparison
  // is with the maximum before this insert — which also means an insert BELOW that maximum trips
  // `events_no_low_rowid` alone, never this one as well. SQLite still reads it as one step in from
  // the end of the rowid tree, not a scan of the table.
  //
  // On an empty table the bound is 1, not none: 1 is the rowid SQLite gives the first insert that
  // names none, so a genuine first append always passes, and an empty `events` is not a fresh file
  // — `people` can already hold rows, and one event parked at the ceiling before the first real one
  // traps every append after it just the same. Below 1 is `events_no_first_rowid_below_one`'s,
  // next: this guard only bounds from above.
  //
  // MAX + 1 on a table already parked at the ceiling is a REAL in SQLite, not an overflow error, so
  // this guard neither refuses nor excuses anything there: a file parked before it existed still
  // refuses every append, through `events_no_low_rowid`, and is named for it (`parked`, below).
  events_no_high_rowid: `AFTER INSERT ON events
    WHEN NEW.rowid > IFNULL((SELECT MAX(rowid) FROM events WHERE rowid <> NEW.rowid), 0) + 1
    BEGIN SELECT RAISE(ABORT, 'an event is not inserted past the next rowid: the trail is the product'); END`,
  // holdrim#109, the other end: a row held at rowid -1 traps every append after it. In a BEFORE
  // INSERT trigger, NEW.rowid is -1 for an insert that leaves the rowid to SQLite (the placeholder
  // the AFTER comments above name), so `events_no_replace`, which is BEFORE and asks
  // `rowid = NEW.rowid`, reads every genuine append as replacing the row at -1 and refuses it as a
  // forgery. Any row below 1 leads there: SQLite gives the next insert MAX + 1, so a table topped
  // by -5 counts up to -1. A genuine insert takes a rowid below 1 only once a row below 1 is
  // already there — 1 on an empty table, MAX + 1 after, which is below 1 only when MAX is — so
  // refusing one refuses a rowid someone named, or a genuine insert that such a row sent below 1,
  // and `guardMismatches` names that row as the cause (`sunk`).
  // `events_no_low_rowid` already refuses it on a table that holds a row above it; this one is the
  // empty table, where that guard has no maximum to compare with. Only there, so that the two never
  // both fire and a low insert into a table that holds rows keeps that guard's words. A new trigger,
  // not a narrower `events_no_low_rowid`: a changed text would read, on every existing file, as
  // "not the one this version installs". AFTER, for the same placeholder: a BEFORE version would
  // see -1 on every genuine first append and refuse it. `people_no_rowid_below_one` and
  // `texts_no_rowid_below_one` below are the same guard for the two tables with no
  // `events_no_low_rowid` of their own.
  events_no_first_rowid_below_one: `AFTER INSERT ON events
    WHEN NEW.rowid < 1 AND NOT EXISTS (SELECT 1 FROM events WHERE rowid <> NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'an event is not inserted below rowid 1: the trail is the product'); END`,
  // A row may only lose its e-mail, as an event may not change at all: an UPDATE that does anything
  // but empty the address is refused, and so is every DELETE. A re-pointed row would hand every
  // event behind its id to somebody else (docs/PRIVACY.md, sections 1 and 3). The rowid may not move
  // either: `UPDATE OR REPLACE` onto another person's rowid drops that person's row, and REPLACE
  // fires no delete trigger.
  people_only_lose_email: `BEFORE UPDATE ON people
    WHEN NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.email IS NOT NULL
    BEGIN SELECT RAISE(ABORT, '${ONLY_LOSES}'); END`,
  people_no_delete: `BEFORE DELETE ON people
    BEGIN SELECT RAISE(ABORT, 'a person is not deleted: forgetting empties the e-mail and keeps the id'); END`,
  // REPLACE again: with a held id or rowid it re-points or erases that row, and with a new id and a
  // held address the unique index makes it drop the other person's row. So an insert may only add a
  // row whose id, rowid and address are all unheld; a forgotten row's empty address holds nothing.
  people_no_replace: `BEFORE INSERT ON people
    WHEN EXISTS (SELECT 1 FROM people WHERE id = NEW.id OR rowid = NEW.rowid
                 OR (NEW.email IS NOT NULL AND email = NEW.email))
    BEGIN SELECT RAISE(ABORT, '${ONLY_LOSES}'); END`,
  // The -1 trap `events_no_first_rowid_below_one` explains, on people: one row at -1 and
  // `people_no_replace` refuses every new person after it — a new reviewer, or a new owner after a
  // handover — and that row can neither be deleted nor moved. With no `events_no_low_rowid` here
  // whose words to keep, it refuses below 1 whatever the table holds; on a table already topped by
  // such a row, where SQLite's own next pick is below 1 too, the refused write names that row
  // (`sunk`, below) as its cause.
  people_no_rowid_below_one: `AFTER INSERT ON people
    WHEN NEW.rowid < 1
    BEGIN SELECT RAISE(ABORT, 'a person is not inserted below rowid 1: an insert after it would read as a replace'); END`,
  // A text is written once, by `append`, and afterwards only removed, by `removeText` — never
  // edited in place. Without this, a value could be swapped for another while keeping the same
  // salt, and unless the two happened to hash alike (infeasible) `withTexts` would call it
  // tampered — which is the right answer for an edit made straight in the database, but a trigger
  // that refuses the edit outright is one less way for that to depend on the hash comparing right.
  texts_no_update: `BEFORE UPDATE ON texts
    BEGIN SELECT RAISE(ABORT, 'a text is not edited: removeText deletes it, and records why'); END`,
  // REPLACE again, the same hole the events and people guards close: `INSERT OR REPLACE` deletes
  // the row it conflicts with and inserts the new one WITHOUT firing a delete trigger, so a value —
  // salt included — could be swapped this way even with texts_no_delete below in place.
  texts_no_replace: `BEFORE INSERT ON texts
    WHEN EXISTS (SELECT 1 FROM texts WHERE (event = NEW.event AND field = NEW.field) OR rowid = NEW.rowid)
    BEGIN SELECT RAISE(ABORT, 'a text is not replaced: removeText deletes it, and records why'); END`,
  // The same trap on texts, for the same reason as `people_no_rowid_below_one`: one row at -1 and
  // `texts_no_replace` refuses every text after it, so every ✓ and every comment the panel sends,
  // each of which carries one.
  texts_no_rowid_below_one: `AFTER INSERT ON texts
    WHEN NEW.rowid < 1
    BEGIN SELECT RAISE(ABORT, 'a text is not inserted below rowid 1: an insert after it would read as a replace'); END`,
  // A row goes only when a text_removed event already names it: `removeText` writes that event
  // BEFORE the DELETE, in the same transaction, precisely so this WHEN clause — run inside that same
  // transaction — already sees it. Without this, a bare DELETE FROM texts (from outside this code,
  // or another program with the file open) would leave the row gone and no event to say why: exactly
  // the shape withTexts calls tampering, but reached by deleting the proof instead of forging it.
  //
  // ⚠️ This clause has no way to refuse an INSERT — none of the guards here do — so a direct writer
  // can still insert a text_removed event of their own and then satisfy this WHEN clause with a
  // forgery; the same writer could also just `DROP TRIGGER texts_no_delete` first and skip the
  // forgery entirely. A dropped trigger is reinstalled on the next boot, and that boot now names it
  // in a warning (holdrim#89) — that catches a guard left dropped, not a person who puts it back:
  // dropping this guard, deleting the row and recreating the trigger by its exact text leaves
  // nothing this check can see, and neither does emptying every table. `removalsOf` (engine/api/texts.ts)
  // refuses a forged event dated, or placed, no later than the event it names, which closes the
  // easy version of the forgery path; one dated and ordered correctly, or a trigger dropped
  // outright, is not caught here and needs signed events (docs/PRIVACY.md, phase E) to close for
  // good.
  texts_no_delete: `BEFORE DELETE ON texts
    WHEN NOT EXISTS (
      SELECT 1 FROM events WHERE type = '${TEXT_REMOVED}'
        AND json_extract(data, '$.event') = OLD.event AND json_extract(data, '$.field') = OLD.field
    )
    BEGIN SELECT RAISE(ABORT, 'a text is not deleted without a text_removed event naming it'); END`,
};

/**
 * Puts the guards in place, exactly as written in `guards`, and nothing else on the two tables.
 * `CREATE TRIGGER IF NOT EXISTS` alone looks only at the name: a guard swapped for a same-named one
 * that does nothing, or a second trigger that answers RAISE(IGNORE) to every ✓, would stay in place
 * on every boot and the lock would be off without a word. So every trigger on `events` and `people`
 * is compared with this list: one that differs is replaced, one that is not on it is dropped, and
 * both are said out loud. The same path carries a guard whose text changed between versions onto a
 * database an older version made.
 *
 * A guard from `guards` that is not held at all is put back the same way — but only said out loud
 * once the database is not a first install. That is NOT "at least one guard is already held": a
 * fresh file with one foreign trigger and none of ours would then report every one of ours as
 * missing on its very first boot, and — the sharper failure — someone who drops every guard of a
 * database that already holds an approval, deletes it, and reopens would read as a first install
 * too, since zero of our guards being held is exactly what a first install also looks like. So
 * "first install" here means BOTH: none of `guards`' own names are held, AND the tables hold no row
 * at all — no event, no person, no text. A file with data in it, whatever the reason, is not being
 * installed for the first time, and a guard missing from it is said, naming it, whether that is
 * `DROP TRIGGER events_no_delete` from outside this process (holdrim#89) or an old database that
 * never had this guard to begin with. That catches a guard left dropped, not a person who puts it
 * back: dropping a guard, changing the rows it protected and recreating the trigger by its exact
 * text leaves nothing this check can see, and neither does emptying every table in the same
 * sitting — both leave a file indistinguishable from a real first install. Only signed events
 * (docs/PRIVACY.md, phase E) close that.
 *
 * The repair runs in one IMMEDIATE transaction: between a DROP and its CREATE the table would have
 * no guard, and another process with the file open could REPLACE a ✓ in that gap. A failure halfway
 * rolls everything back rather than leave a guard dropped. When nothing needs repair — every boot
 * but the first after an upgrade or a tampering — no write lock is taken at all.
 */
export function installGuards(db: DatabaseSync, guards: Record<string, string> = GUARDS,
                              warn: (line: string) => void = console.warn): void {
  const all = guardMismatches(db, guards);
  // Said on every boot for as long as it is so, and never with the write lock taken: nothing a
  // boot can do repairs a column that hides the rowid, a row below rowid 1 or a row parked at the
  // ceiling (the comment on `rowidMismatches`), so taking the lock for them would only make each
  // boot wait behind a writer.
  for (const m of all.filter((x) => !repairable(x))) {
    warn(`holdrim: ${guardMismatchSaid(m)}; nothing a boot does repairs this`);
    log('WARNING', 'sqlite_guard_missing', { guard: m.name, kind: m.kind });
  }
  if (!all.some(repairable)) return;
  // The name comes from the file, so it is quoted: unquoted, a trigger named
  // `x; DROP TRIGGER events_no_delete` would drop a guard and keep itself.
  const drop = (name: string) => db.exec(`DROP TRIGGER IF EXISTS "${name.replace(/"/g, '""')}"`);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again under the lock: another process may have repaired it while this one waited.
    const found = guardMismatches(db, guards).filter(repairable);
    // Neither half alone is enough: a fresh file can hold a foreign trigger (still reported below,
    // just not as one of OUR guards missing) before it ever holds a row, and an old, real database
    // can hold rows with none of our guards on it at all — see the long comment above the function.
    const noGuardOfOursHeld = found.filter((m) => m.kind === 'missing').length === Object.keys(guards).length;
    const holdsNoRow = () =>
      !db.prepare('SELECT 1 FROM events LIMIT 1').get() &&
      !db.prepare('SELECT 1 FROM people LIMIT 1').get() &&
      !db.prepare('SELECT 1 FROM texts LIMIT 1').get();
    const firstInstall = noGuardOfOursHeld && holdsNoRow();
    // `guardMismatches` names the foreign triggers first, so they are gone before any guard goes in.
    for (const m of found) {
      if (m.kind === 'foreign') {
        warn(`holdrim: ${guardMismatchSaid(m)}; dropping it`);
        drop(m.name);
        continue;
      }
      if (m.kind === 'changed') {
        warn(`holdrim: ${guardMismatchSaid(m)}; replacing it`);
        drop(m.name);
      } else if (!firstInstall) {
        // Only the name goes out — never a row's contents — so this line is safe wherever the log
        // ends up, unlike an event's own text or a person's e-mail (docs/PRIVACY.md).
        warn(`holdrim: ${guardMismatchSaid(m)}; installing it`);
        log('WARNING', 'sqlite_guard_missing', { guard: m.name });
      }
      db.exec(`CREATE TRIGGER ${m.name} ${guards[m.name]}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/**
 * One way a file's `events`, `people` and `texts` are not what `guards` promise: a guard not held at
 * all, one held under its name with a different text, or a trigger that is not a guard — `name` is
 * the trigger's — or, beyond the triggers, a column that hides the rowid from them (`shadowed`,
 * named `table.column`), a table holding a row below rowid 1 (`sunk`, named by the table) or an
 * `events` table parked at the ceiling (`parked`, named `events`). The first three a boot repairs;
 * the last three nothing repairs (`repairable`).
 */
export type GuardMismatch = { name: string; kind: 'missing' | 'changed' | 'foreign' | 'shadowed' | 'sunk' | 'parked' };

/** Whether a boot can put this right: a trigger it can drop or create, not a column or a row. */
export const repairable = (m: GuardMismatch): boolean => m.kind === 'missing' || m.kind === 'changed' || m.kind === 'foreign';

/** The largest rowid SQLite has, as SQL: a JavaScript number cannot hold it exactly. */
export const ROWID_CEILING = '9223372036854775807';

/**
 * What the triggers cannot see about the rows they guard, since every guard reads `rowid`.
 *
 * A column named `rowid`, `oid` or `_rowid_`, in any case, takes that name from the real rowid for
 * every statement that says it, the guards' own included, and `ALTER TABLE ... ADD COLUMN` makes
 * one with every trigger's text left exactly as it was. While it is there, `events_no_replace`,
 * `events_no_low_rowid` and `events_no_high_rowid` compare the column, not the rowid: a row goes in
 * at any rowid through `_rowid_`, a DEFAULT makes every append collide, and on `people` an
 * `UPDATE OR REPLACE` onto another person's rowid erases that person's row. `pragma_table_xinfo`,
 * not `table_info`: a generated column named `rowid` hides it just the same, and only xinfo lists it.
 * Rejected: comparing each table's `CREATE` text with this version's, which would also catch a
 * `writable_schema` edit — `ensureColumn` rewrites that text on every file an older version made,
 * so it would either call every upgraded file tampered or need every shape any version ever wrote.
 * Nothing repairs it: dropping the column undoes nothing it let through, and could drop data.
 *
 * Once the column is dropped again, the row it let in is all that is left, and two kinds of row can
 * still be named, however they got there — that column, triggers turned off on a connection
 * (`SQLITE_DBCONFIG_ENABLE_TRIGGER`), or a guard dropped and put back by its exact text:
 * - a row below rowid 1 in any of the three tables (`sunk`). No genuine insert takes one while
 *   none is there (after one, SQLite's MAX + 1 can be below 1 too), and one at -1 makes every
 *   insert after it read as a replace (the comment on `events_no_first_rowid_below_one`); on
 *   `events` it also sorts below `extractionBoundary`, the forgery that boundary exists to name.
 * - an `events` table whose highest rowid is the ceiling (`parked`). Exactly the ceiling, not "near"
 *   it: that row is what sends SQLite to random rowids below it, so every append after it is
 *   refused as a forgery, and a row one short of it traps nothing until a genuine append takes the
 *   ceiling — at which point this names it.
 * Both are compared in SQL, through a name no column on that table hides: the ceiling read into
 * JavaScript throws. What a dropped column let through otherwise — a row between 1 and
 * `extractionBoundary`, a person's row erased — leaves nothing here to find (SECURITY.md).
 */
function rowidMismatches(db: DatabaseSync): GuardMismatch[] {
  const out: GuardMismatch[] = [];
  const aliases = ['rowid', '_rowid_', 'oid'];
  for (const table of ['events', 'people', 'texts']) {
    const hiding = (db.prepare(`SELECT name FROM pragma_table_xinfo('${table}')`).all() as { name: string }[])
      .map((c) => c.name).filter((n) => aliases.includes(n.toLowerCase()));
    for (const column of hiding) out.push({ name: `${table}.${column}`, kind: 'shadowed' });
    // A file an older version made has no `people` or `texts` at all, and the CLI still reads it.
    // NOCASE, as SQLite itself resolves a table name: `texts` renamed through a temporary name to
    // `TEXTS` is still the table every guard's `ON texts` binds to and every write goes into, and a
    // case-sensitive lookup here would skip it, so a sunk or parked row there goes unnamed.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE").get(table)) continue;
    const hidden = new Set(hiding.map((n) => n.toLowerCase()));
    const rowid = aliases.find((a) => !hidden.has(a));
    // All three names hidden leaves no way to ask for the rowid at all, and each is named above.
    if (rowid === undefined) continue;
    if (db.prepare(`SELECT 1 FROM ${table} WHERE ${rowid} < 1 LIMIT 1`).get()) out.push({ name: table, kind: 'sunk' });
    if (table === 'events' && db.prepare(`SELECT 1 FROM events WHERE ${rowid} = ${ROWID_CEILING}`).get()) {
      out.push({ name: 'events', kind: 'parked' });
    }
  }
  return out;
}

/**
 * The comparison `installGuards` repairs from, and the only one: the CLI's `--db` reader
 * (`Source#fromFile`, engine/cli/remote.ts) asks it too, on a file it opens read-only (holdrim#108).
 * Before, only the server compared, and only on its next boot, so for anyone reading the file with
 * the CLI a guard dropped was a guard gone — nobody had to put it back to go unseen. Two copies of
 * this comparison would drift the day a guard's text or the set of tables changes, and the reader
 * whose copy fell behind would call a sound file tampered, or a tampered one sound.
 *
 * Reads `sqlite_master`, each table's columns and one rowid lookup, and writes nothing: the CLI's
 * connection is read-only, and a comparison that repaired as it went could not run there. Foreign
 * triggers come first, then the guards in `guards`' own order — the order `installGuards` repairs
 * in — then what `rowidMismatches` finds, which no boot repairs.
 *
 * A foreign trigger counts: one that answers `RAISE(IGNORE)` to every ✓, or inserts a forged one
 * after each real event, leaves every guard intact and the lock off all the same.
 */
export function guardMismatches(db: DatabaseSync, guards: Record<string, string> = GUARDS): GuardMismatch[] {
  // SQLite keeps the text as written, spacing included, so a run of spacing is read as one space —
  // but only the five characters SQLite's own tokenizer skips between tokens. JavaScript's `\s`
  // (and `.trim()`) also take U+00A0 and the other Unicode spaces, which SQLite reads as part of an
  // identifier: `rowid\u00A0= NEW.rowid`, beside an added column named `"rowid\u00A0"` that is
  // always NULL, is a guard that compares nothing, and `\s` would have called it the same text as
  // the real one. No trim either: both sides start at `CREATE` and end at `END`, as SQLite stores them.
  const flat = (sql: string) => sql.replace(/[ \t\n\f\r]+/g, ' ');
  // A Map, not `name in guards`: a trigger named `constructor` would be "in" any plain object.
  const want = new Map(Object.entries(guards).map(([name, body]) => [name, `CREATE TRIGGER ${name} ${body}`]));
  // Table names ignore case in SQLite: a trigger declared `ON EVENTS` is on this table too.
  const rows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) IN ('events', 'people', 'texts')"
  ).all() as { name: string; sql: string }[];
  const held = new Map(rows.map((r) => [r.name, r.sql]));
  const out: GuardMismatch[] = rows.filter((r) => !want.has(r.name)).map((r) => ({ name: r.name, kind: 'foreign' }));
  for (const [name, sql] of want) {
    const found = held.get(name);
    if (found === undefined) out.push({ name, kind: 'missing' });
    else if (flat(found) !== flat(sql)) out.push({ name, kind: 'changed' });
  }
  // Here and not beside it: every reader that asks whether the guards hold asks this too, so a
  // guard blinded by a column is never read as a guard in place.
  return [...out, ...rowidMismatches(db)];
}

/**
 * What a mismatch is, in the words both readers say it in — the server before "installing it",
 * "replacing it" or "dropping it", the CLI before saying it repairs nothing. One sentence per kind,
 * so whoever greps a server log for a guard's name finds the CLI's line with the same words.
 *
 * The name is quoted, through `jsonForTerminal` (engine/api/log.ts, which says exactly what it
 * escapes), because a foreign trigger's name is whatever whoever wrote the file chose: raw, an
 * escape sequence in it reaches the terminal and can clear the very warning it sits in, and a
 * bidirectional override can make it read as another name — and `show`, `impact` and `summary` exit
 * 0, so that warning is all a person gets. The structured line goes through the same function, in
 * `log()`, so neither of the two lines a mismatch prints can carry the name raw.
 */
export function guardMismatchSaid(m: GuardMismatch): string {
  const name = jsonForTerminal(m.name);
  switch (m.kind) {
    case 'missing': return `the database's guard ${name} is missing`;
    case 'changed': return `the database's guard ${name} was not the one this version installs`;
    case 'foreign': return `the database holds a trigger this version does not install, ${name}`;
    case 'shadowed': return `the database has a column ${name} that hides the real rowid from every guard`;
    case 'sunk': return `the database's ${m.name} table holds a row below rowid 1, which no genuine insert takes, `
      + 'and one at -1 makes every insert after it read as a replace, refused as a forgery, which it is not';
    case 'parked': return `the database's events table holds a row at the largest rowid, ${ROWID_CEILING}, `
      + 'so every append after it lands below that row and is refused as a forgery, which it is not';
  }
}

/**
 * The earliest `rowid` any event in this table already carries a text or a snapshot hash on — round
 * 1 of the #91 review, finding 1, and the forge-proof line between "genuinely written before text
 * extraction" and "written after, with the hash stripped to look like it".
 *
 * `rowid` only grows: nothing on `events` is ever deleted (the guards above), a real `append` always
 * takes the next one, and `events_no_low_rowid` (round 3 of the #91 review) now refuses an explicit
 * INSERT that lands below one already held — round 1 of this same review shipped this function
 * trusting that no write, forged or not, ever could, which was true of every rowid `events_no_replace`
 * already refused to reuse but left every UNHELD low one, negative and 0 included, free for a plain
 * INSERT to claim. Once one hashed row exists, then, every row that sorts after it by rowid was
 * written by a version of `append` that always salts and hashes whatever text or snapshot it is given
 * (`saltFields`) — so a LATER row with no hash at all did not come from before extraction; its hash
 * was taken off. `resolveOne` (engine/api/texts.ts) is the reader that acts on this, through
 * `afterExtraction` on the event it is given.
 *
 * `events` has no INTEGER PRIMARY KEY (its primary key is the TEXT `id`), so it is a plain rowid
 * table, and SQLite's own docs allow `VACUUM` to renumber rowids on one of those — the promise here
 * is only that today's SQLite keeps them in their RELATIVE order when it does, which every test that
 * runs `VACUUM` between writes and a `list()` rests on same as this comment does; it is not a promise
 * a future SQLite version owes this file. Newly appended rows land above whatever `VACUUM` leaves
 * behind either way, since `events_no_low_rowid` refuses anything that would not.
 *
 * A database with no hashed row at all — a fresh install about to write its first event, or one
 * whose every hashed row an attacker deleted after also dropping `events_no_delete` — answers `null`,
 * and nothing downstream is marked `afterExtraction`: the same already-open gap a dropped-and-restored
 * guard leaves (the long comment on `installGuards` above), not a new one this closes.
 */
export function extractionBoundary(db: DatabaseSync): number | null {
  // REAL, as every reader of the rowid takes it (`list`, `Source#fromFile`): a row parked at the
  // ceiling read as an integer throws in JavaScript, and a reader that throws names nothing.
  return (db.prepare(
    'SELECT CAST(MIN(rowid) AS REAL) AS boundary FROM events WHERE text_hash IS NOT NULL OR snapshot_hash IS NOT NULL'
  ).get() as { boundary: number | null }).boundary;
}

/**
 * Adds a column to a table that does not already have it — the migration path for a database a
 * version before this one made. `CREATE TABLE IF NOT EXISTS` only decides whether to create the
 * table; it does not add a column to one that already exists, so a database made before
 * `text_hash`/`snapshot_hash` existed would otherwise open with the old, narrower `events` and every
 * read of the new columns would fail. `type` is never a caller's value — always one of the two
 * literals below — so building the statement from it is safe.
 */
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * The error a write that failed is reported with. On a table parked at the ceiling, holding a row
 * below rowid 1, or with a column hiding the rowid, the guard that refused speaks of a forgery —
 * "inserted below one already held", "not replaced" — about the operator's own genuine write, and
 * the cause is somewhere else entirely: so the cause is what is said, and the guard's words go along
 * as `cause`. Only what is wrong with a table whose guards could have refused the write is said: a
 * column on `people` does not explain an event refused, and naming it would send the operator to
 * the wrong table.
 */
function refusedBecause(db: DatabaseSync, err: unknown, what: 'event' | 'person', touched: string[]): unknown {
  let found: GuardMismatch[];
  try {
    found = rowidMismatches(db).filter((m) => touched.includes(m.name.split('.')[0]));
  } catch {
    return err; // the original failure is the one to report, not a failure to explain it
  }
  if (found.length === 0) return err;
  return new Error(`the ${what} was not recorded: ${found.map(guardMismatchSaid).join('; and ')}. `
    + 'This is how the file was left, not what this write did: see SECURITY.md', { cause: err });
}

export class SqliteEventStore implements EventStore {
  #db: DatabaseSync;

  constructor(path: string) {
    try {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.#db = new DatabaseSync(path);
    } catch (e) {
      // The raw SQLite error is "unable to open database file", which says neither where nor why.
      // In a container it is almost always permission: the process runs as `node`, and a volume
      // mounted from the host arrives owned by the host user — the image chown never reaches a
      // bind mount.
      const cause = (e as NodeJS.ErrnoException).code === 'EACCES' || /unable to open/i.test(String(e))
        ? `no write permission in ${dirname(path)}`
        : String((e as Error).message ?? e);
      throw new Error(
        `could not open the database at ${path}: ${cause}.\n` +
        '  In a container, prefer a named volume (-v data:/data), which inherits the image owner.\n' +
        '  With a host folder, hand it to the user that runs:  mkdir -p data && sudo chown 1000:1000 data');
    }

    // Before anything else writes: two processes on one file (the server and the CLI) otherwise
    // get "database is locked" the instant their writes meet, instead of one waiting for the other.
    this.#db.exec('PRAGMA busy_timeout = 5000');
    // WAL: a read does not block a write. In a review tool, several tabs read at the same time.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        page         TEXT NOT NULL,
        block        TEXT,
        fingerprint  TEXT,
        text         TEXT,
        snapshot     TEXT,
        author       TEXT NOT NULL,
        happened_at  TEXT NOT NULL,
        data         TEXT
      );
      CREATE INDEX IF NOT EXISTS events_by_page ON events (page, happened_at);

      -- The documentation INDEX (blocks, dependencies, issues) does NOT live here: it is derived
      -- and rebuilt on every "holdrim index", while this table is fact and the database refuses
      -- to erase it. See engine/api/index-store.ts — one definition, and the difference explicit.
    `);
    // A database from before texts were extracted has `events` with no such columns at all — the
    // one column `ensureColumn` cannot add by `CREATE TABLE IF NOT EXISTS` alone. Its `text` and
    // `snapshot` columns stay exactly as that version wrote them, plain, and read as such: no hash,
    // so `withTexts` returns a pre-extraction row's own value unchanged (docs/PRIVACY.md, section 4).
    ensureColumn(this.#db, 'events', 'text_hash', 'TEXT');
    ensureColumn(this.#db, 'events', 'snapshot_hash', 'TEXT');

    // The people table: an id and an e-mail, next to the events that will name the id
    // (docs/PRIVACY.md, section 1). The unique index covers only rows that still hold an address,
    // so a forgotten row never stands in the way of the new person the same address becomes.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id     TEXT PRIMARY KEY,
        email  TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS people_by_email ON people (email) WHERE email IS NOT NULL;
    `);

    // The texts table: one row per event and field, holding what `events.text_hash` and
    // `events.snapshot_hash` are a hash OF (docs/PRIVACY.md, section 4). `removeText` is the only
    // code that deletes a row — the trigger only refuses UPDATE — and it always deletes exactly one
    // together with recording why, never on its own.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS texts (
        event  TEXT NOT NULL REFERENCES events (id),
        field  TEXT NOT NULL CHECK (field IN ('text', 'snapshot')),
        value  TEXT NOT NULL,
        salt   TEXT NOT NULL,
        PRIMARY KEY (event, field)
      );
    `);

    installGuards(this.#db);
  }

  async personFor(email: string): Promise<string> {
    const e = personEmail(email);
    // `node:sqlite` is synchronous, so nothing in this process runs between the read and the
    // insert — but another process on the same file can. Its row then refuses ours (the trigger,
    // or the unique index behind it), and the address is that process's person: read it back
    // rather than hand the caller an error for a question that has an answer.
    const found = this.#heldBy(e);
    if (found) return found;
    const id = newPersonId();
    try {
      const r = this.#db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run(id, e);
      if (r.changes !== 1) throw new Error('the person was not recorded: the database dropped the insert');
    } catch (err) {
      const winner = this.#heldBy(e);
      if (winner) return winner;
      throw refusedBecause(this.#db, err, 'person', ['people']);
    }
    return id;
  }

  async personOf(email: string): Promise<string | null> {
    return this.#heldBy(personEmail(email)) ?? null;
  }

  #heldBy(email: string): string | undefined {
    return (this.#db.prepare('SELECT id FROM people WHERE email = ?').get(email) as { id: string } | undefined)?.id;
  }

  async person(id: string): Promise<Person | null> {
    const r = this.#db.prepare('SELECT id, email FROM people WHERE id = ?').get(id) as Person | undefined;
    return r ? { id: r.id, email: r.email ?? null } : null;
  }

  async setEmail(id: string, email: string | null): Promise<void> {
    // No check in code: the trigger is the guard, so a test that drops it sees this go through.
    const r = this.#db.prepare('UPDATE people SET email = ? WHERE id = ?').run(email, id);
    if (r.changes === 0) throw noPerson(id);
  }

  async forget(id: string): Promise<void> { await this.setEmail(id, null); }

  // The column holds the person's id, never the address: the address lives in `people` alone, where
  // forgetting can empty it (docs/PRIVACY.md, section 1). The answer names the address, as a list
  // a moment later does.
  //
  // `text` and `snapshot` are written NULL: their values move to `texts`, and the columns keep only
  // the two's hash. Both the event row and its texts rows land in one transaction — an event with a
  // hash and no row to match, from a crash between the two, is exactly what `withTexts` cannot tell
  // from tampering (docs/PRIVACY.md, section 4).
  async append(event: NewEvent, author: string): Promise<Event> {
    const personId = await this.personFor(author);
    const id = crypto.randomUUID().replace(/-/g, '');
    const when = new Date().toISOString();
    const { hashes, rows } = saltFields(event);
    const e = stored({ ...event, text: null, snapshot: null }, id, personId, when);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.#db.prepare(
        `INSERT INTO events (id, type, page, block, fingerprint, text, snapshot, text_hash, snapshot_hash, author, happened_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(e.id, e.type, e.page, e.block ?? null, e.fingerprint ?? null, null, null,
            hashes.text, hashes.snapshot, e.author, e.when, e.data ? JSON.stringify(e.data) : null);
      // A trigger that answers RAISE(IGNORE) drops the row and reports no error: without this, an
      // approval that was never written would be handed back as recorded.
      if (r.changes !== 1) throw new Error('the event was not recorded: the database dropped the insert');
      for (const t of rows) {
        this.#db.prepare('INSERT INTO texts (event, field, value, salt) VALUES (?, ?, ?, ?)').run(id, t.field, t.value, t.salt);
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw refusedBecause(this.#db, err, 'event', ['events', 'texts']);
    }
    // A row just written cannot yet be removed or tampered with, so the plain values in hand — not
    // a round trip through `withTexts` — are what the caller of a fresh append gets back.
    // `authorId: personId`, the same value `withAuthors` would capture off this row a moment later,
    // so a fresh append and the list right after it answer it identically (events-conformance.test.js,
    // "the answer to an append is what a list says a moment later").
    return { ...e, text: event.text ?? null, snapshot: event.snapshot ?? null, author: personEmail(author), authorId: personId };
  }

  async removeText(event: string, field: TextField, by: string): Promise<Event> {
    const original = this.#db.prepare('SELECT page, block, happened_at FROM events WHERE id = ?').get(event) as
      { page: string; block: string | null; happened_at: string } | undefined;
    if (!original) throw new Error(`no event ${event}`);
    const personId = await this.personFor(by);
    const id = crypto.randomUUID().replace(/-/g, '');
    // Never before the text it removes (round 3, finding 3): a wall clock that steps back between
    // the append and this removeText would otherwise date — and so, by removalsOf's own ordering
    // check, permanently misfile — a genuine removal as tampering. A tie still sorts after its
    // target: `list` orders by `(happened_at, rowid)`, and this row's rowid is always the later one.
    const when = notBefore(new Date().toISOString(), original.happened_at);
    const data = { event, field };
    let absent: Error | undefined;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // The removal event before the delete, in the same transaction: `texts_no_delete` only lets
      // a row go once an event naming it already exists, and writing the event first is what lets
      // that guard, run inside this same transaction, already see it. The one transaction also
      // closes the crash gap `append`'s own comment explains — a hash with no row and no event
      // naming why is exactly what `withTexts` cannot tell from tampering.
      const r = this.#db.prepare(
        `INSERT INTO events (id, type, page, block, fingerprint, text, snapshot, text_hash, snapshot_hash, author, happened_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, TEXT_REMOVED, original.page, original.block ?? null, null, null, null, null, null, personId, when, JSON.stringify(data));
      if (r.changes !== 1) throw new Error('the event was not recorded: the database dropped the insert');
      const del = this.#db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(event, field);
      if (del.changes !== 1) throw (absent = noText(event, field));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      // A text that is not there is its own answer, whatever else is wrong with the file: wrapped,
      // "no text to remove" would read as the file's fault.
      // `events` alone, not `texts` too: this writes `texts` only by a DELETE, which fires only
      // `texts_no_delete`, and that reads OLD.event, OLD.field and `events`, never a rowid. So a
      // row below 1 or a column hiding the rowid on `texts` cannot refuse a removal, and naming one
      // would send the operator to a table that did not cause it.
      throw err === absent ? err : refusedBecause(this.#db, err, 'event', ['events']);
    }
    return {
      id, type: TEXT_REMOVED, page: original.page, block: original.block ?? null, fingerprint: null,
      text: null, snapshot: null, textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
      author: personEmail(by), authorId: personId, when, data,
    };
  }

  /**
   * The three SELECTs — events, people, texts — inside one read transaction, so a write from
   * ANOTHER connection on this file (a second process; `append` and `removeText` on this one never
   * interleave with `list`, since `node:sqlite` is synchronous) cannot land between them. Without
   * it, another process's `removeText` landing between the events SELECT and the texts SELECT is
   * not what either alone shows — the same torn read `FirestoreEventStore.list` closes with a
   * transaction of its own — and a legitimate removal would read back as tampering.
   */
  async list(page?: string | null): Promise<Event[]> {
    this.#db.exec('BEGIN DEFERRED');
    let rows: unknown[];
    let people: Map<string, string | null>;
    let texts: Map<string, { value: string; salt: string }>;
    let boundary: number | null;
    try {
      rows = page == null
        // `rowid` breaks a tie inside one millisecond: recorded order, not whatever the planner
        // picks. Today's SQLite already hands ties back in rowid order, so dropping it changes
        // nothing a test can see; naming it turns that accident into a promise. `rowid DESC` fails
        // the suite. Selected explicitly (not `SELECT *`, which hides it on a table with a non-integer
        // primary key): `extractionBoundary` below is compared against it, per row. As a REAL: an
        // integer above 2^53 throws on its way into JavaScript, so one row parked at the ceiling
        // would make every read of its page fail instead of reading; exact below 2^53, where every
        // genuine append is.
        ? this.#db.prepare('SELECT *, CAST(rowid AS REAL) AS rowid FROM events ORDER BY happened_at, rowid').all()
        : this.#db.prepare('SELECT *, CAST(rowid AS REAL) AS rowid FROM events WHERE page = ? ORDER BY happened_at, rowid').all(page);
      people = new Map((this.#db.prepare('SELECT id, email FROM people').all() as { id: string; email: string | null }[])
        .map((p) => [p.id, p.email]));
      texts = new Map((this.#db.prepare('SELECT event, field, value, salt FROM texts').all() as
        { event: string; field: TextField; value: string; salt: string }[])
        .map((t) => [textKey(t.event, t.field), { value: t.value, salt: t.salt }]));
      // Read over the WHOLE table, `page` filter or not: the boundary is a fact about this database,
      // not about one page of it, and a page that happens to hold none of the earliest hashed rows
      // must still judge ITS OWN rows against the database's real cutover.
      boundary = extractionBoundary(this.#db);
      this.#db.exec('COMMIT');
    } catch (err) {
      rollbackQuietly(this.#db);
      throw err;
    }
    const events = withAuthors((rows as Record<string, any>[]).map((r) => ({
      id: r.id as string, type: r.type as string, page: r.page as string, block: r.block as string | null,
      fingerprint: r.fingerprint as string | null, text: r.text as string | null, snapshot: r.snapshot as string | null,
      textHash: r.text_hash as string | null, snapshotHash: r.snapshot_hash as string | null,
      author: r.author as string, when: r.happened_at as string, data: r.data ? JSON.parse(r.data as string) : null,
      textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
      afterExtraction: boundary != null && (r.rowid as number) >= boundary,
    })), people);
    // Reported here, not left to whoever reads `list`'s answer next: issue #91 wants every read that
    // resolves a field to tampered to raise the alert, not only the one a person happens to be
    // looking at.
    const reports: TamperReport[] = [];
    const out = withTexts(events, texts, reports);
    for (const r of reports) reportTampered(r);
    return out;
  }

  async close(): Promise<void> { this.#db.close(); }
}
