import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES, withAuthors } from './people.ts';
import { hashText, newSalt, noText, textKey, withTexts, TEXT_FIELDS, TEXT_REMOVED, type TextField } from './texts.ts';

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
    const hashes: Record<TextField, string | null> = { text: null, snapshot: null };
    const rows: { field: TextField; value: string; salt: string }[] = [];
    for (const field of TEXT_FIELDS) {
      const value = event[field];
      if (value == null) continue;
      const salt = newSalt();
      hashes[field] = hashText(value, salt);
      rows.push({ field, value, salt });
    }
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
    const original = this.#db.prepare('SELECT page, block FROM events WHERE id = ?').get(event) as
      { page: string; block: string | null } | undefined;
    if (!original) throw new Error(`no event ${event}`);
    const personId = await this.personFor(by);
    const id = crypto.randomUUID().replace(/-/g, '');
    const when = new Date().toISOString();
    const data = { event, field };
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      // The delete and the removal event in one transaction, for the reason `append` gives: a crash
      // between the two must not leave one without the other.
      const del = this.#db.prepare('DELETE FROM texts WHERE event = ? AND field = ?').run(event, field);
      if (del.changes !== 1) throw noText(event, field);
      const r = this.#db.prepare(
        `INSERT INTO events (id, type, page, block, fingerprint, text, snapshot, text_hash, snapshot_hash, author, happened_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, TEXT_REMOVED, original.page, original.block ?? null, null, null, null, null, null, personId, when, JSON.stringify(data));
      if (r.changes !== 1) throw new Error('the event was not recorded: the database dropped the insert');
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

  async list(page?: string | null): Promise<Event[]> {
    const rows = page == null
      // `rowid` breaks a tie inside one millisecond: recorded order, not whatever the planner picks.
      // Today's SQLite already hands ties back in rowid order, so dropping it changes nothing a
      // test can see; naming it turns that accident into a promise. `rowid DESC` fails the suite.
      ? this.#db.prepare('SELECT * FROM events ORDER BY happened_at, rowid').all()
      : this.#db.prepare('SELECT * FROM events WHERE page = ? ORDER BY happened_at, rowid').all(page);
    // After the events, as the Firestore store explains: every author those rows name was made
    // before its event was written, so a read of the people that starts now holds it.
    const people = new Map((this.#db.prepare('SELECT id, email FROM people').all() as { id: string; email: string | null }[])
      .map((p) => [p.id, p.email]));
    const events = withAuthors((rows as Record<string, string | null>[]).map((r) => ({
      id: r.id!, type: r.type!, page: r.page!, block: r.block, fingerprint: r.fingerprint,
      text: r.text, snapshot: r.snapshot, textHash: r.text_hash, snapshotHash: r.snapshot_hash,
      author: r.author!, when: r.happened_at!, data: r.data ? JSON.parse(r.data) : null,
      textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
    })), people);
    // The texts after the events, for the same reason the people are: `append` writes an event's
    // texts rows in the same transaction as the event itself, so every hash a read of the events
    // can see already has its row in a read of the texts that starts after it.
    const texts = new Map((this.#db.prepare('SELECT event, field, value, salt FROM texts').all() as
      { event: string; field: TextField; value: string; salt: string }[])
      .map((t) => [textKey(t.event, t.field), { value: t.value, salt: t.salt }]));
    return withTexts(events, texts);
  }

  async close(): Promise<void> { this.#db.close(); }
}
