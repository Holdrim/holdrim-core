import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES, withAuthors } from './people.ts';
import { noText, notBefore, saltFields, textKey, withTexts, reportTampered, TEXT_REMOVED,
  type TextField, type TamperReport } from './texts.ts';
import { log } from './log.ts';

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
 * fresh file with one foreign trigger and none of ours would then report all nine of ours as
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
  // SQLite keeps the text as written, spacing included.
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  const want = new Map(Object.entries(guards).map(([name, body]) => [name, `CREATE TRIGGER ${name} ${body}`]));
  // Table names ignore case in SQLite: a trigger declared `ON EVENTS` is on this table too.
  const held = () => db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) IN ('events', 'people', 'texts')"
  ).all() as { name: string; sql: string }[];
  const inPlace = (rows: { name: string; sql: string }[]) =>
    rows.length === want.size &&
    rows.every((r) => want.has(r.name) && flat(r.sql) === flat(want.get(r.name)!));
  if (inPlace(held())) return;
  // The name comes from the file, so it is quoted: unquoted, a trigger named
  // `x; DROP TRIGGER events_no_delete` would drop a guard and keep itself.
  const drop = (name: string) => db.exec(`DROP TRIGGER IF EXISTS "${name.replace(/"/g, '""')}"`);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read again under the lock: another process may have repaired it while this one waited.
    const rows = held();
    const byName = new Map(rows.map((r) => [r.name, r]));
    // Neither half alone is enough: a fresh file can hold a foreign trigger (still reported below,
    // just not as one of OUR guards missing) before it ever holds a row, and an old, real database
    // can hold rows with none of our guards on it at all — see the long comment above the function.
    const noGuardOfOursHeld = !rows.some((r) => want.has(r.name));
    const holdsNoRow = () =>
      !db.prepare('SELECT 1 FROM events LIMIT 1').get() &&
      !db.prepare('SELECT 1 FROM people LIMIT 1').get() &&
      !db.prepare('SELECT 1 FROM texts LIMIT 1').get();
    const firstInstall = noGuardOfOursHeld && holdsNoRow();
    for (const r of rows) {
      if (want.has(r.name)) continue;
      warn(`holdrim: the database holds a trigger this version does not install, ${r.name}; dropping it`);
      drop(r.name);
    }
    for (const [name, sql] of want) {
      const r = byName.get(name);
      if (r && flat(r.sql) === flat(sql)) continue;
      if (r) {
        warn(`holdrim: the database's guard ${r.name} was not the one this version installs; replacing it`);
        drop(r.name);
      } else if (!firstInstall) {
        // Only the name goes out — never a row's contents — so this line is safe wherever the log
        // ends up, unlike an event's own text or a person's e-mail (docs/PRIVACY.md).
        warn(`holdrim: the database's guard ${name} is missing; installing it`);
        log('WARNING', 'sqlite_guard_missing', { guard: name });
      }
      db.exec(sql);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The earliest `rowid` any event in this table already carries a text or a snapshot hash on — round
 * 1 of the #91 review, finding 1, and the forge-proof line between "genuinely written before text
 * extraction" and "written after, with the hash stripped to look like it".
 *
 * `rowid` only grows: nothing on `events` is ever deleted (the guards above), and a real `append`
 * always takes the NEXT one — SQLite hands out an explicit rowid only when it is not already held, and
 * every one below the current maximum always is, so no write, forged or not, can land BELOW an
 * existing row. Once one hashed row exists, then, every row that sorts after it by rowid was written
 * by a version of `append` that always salts and hashes whatever text or snapshot it is given
 * (`saltFields`) — so a LATER row with no hash at all did not come from before extraction; its hash
 * was taken off. `resolveOne` (engine/api/texts.ts) is the reader that acts on this, through
 * `afterExtraction` on the event it is given.
 *
 * A database with no hashed row at all — a fresh install about to write its first event, or one
 * whose every hashed row an attacker deleted after also dropping `events_no_delete` — answers `null`,
 * and nothing downstream is marked `afterExtraction`: the same already-open gap a dropped-and-restored
 * guard leaves (the long comment on `installGuards` above), not a new one this closes.
 */
export function extractionBoundary(db: DatabaseSync): number | null {
  return (db.prepare(
    'SELECT MIN(rowid) AS boundary FROM events WHERE text_hash IS NOT NULL OR snapshot_hash IS NOT NULL'
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
      throw err;
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
      throw err;
    }
    // A row just written cannot yet be removed or tampered with, so the plain values in hand — not
    // a round trip through `withTexts` — are what the caller of a fresh append gets back.
    return { ...e, text: event.text ?? null, snapshot: event.snapshot ?? null, author: personEmail(author) };
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
      if (del.changes !== 1) throw noText(event, field);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return {
      id, type: TEXT_REMOVED, page: original.page, block: original.block ?? null, fingerprint: null,
      text: null, snapshot: null, textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
      author: personEmail(by), when, data,
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
        // primary key): `extractionBoundary` below is compared against it, per row.
        ? this.#db.prepare('SELECT *, rowid FROM events ORDER BY happened_at, rowid').all()
        : this.#db.prepare('SELECT *, rowid FROM events WHERE page = ? ORDER BY happened_at, rowid').all(page);
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
      this.#db.exec('ROLLBACK');
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
