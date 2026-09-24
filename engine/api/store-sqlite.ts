import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES } from './people.ts';

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

    // Triggers that REFUSE to alter and to delete. "Nothing is erased" stops depending on the code
    // never calling UPDATE: the database refuses, even for someone opening the file with another
    // program.
    this.#db.exec(`
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'an event is not altered: the trail is the product'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'an event is not deleted: the trail is the product'); END;
    `);

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

    // A row may only lose its e-mail, and the database says so, as it does for events: an UPDATE
    // that does anything but empty the address is refused, and so is every DELETE. A re-pointed
    // row would hand every event behind its id to somebody else (docs/PRIVACY.md, sections 1 and 3).
    this.#db.exec(`
      CREATE TRIGGER IF NOT EXISTS people_only_lose_email BEFORE UPDATE ON people
        WHEN NEW.id IS NOT OLD.id OR NEW.email IS NOT NULL
        BEGIN SELECT RAISE(ABORT, '${ONLY_LOSES}'); END;
      CREATE TRIGGER IF NOT EXISTS people_no_delete BEFORE DELETE ON people
        BEGIN SELECT RAISE(ABORT, 'a person is not deleted: forgetting empties the e-mail and keeps the id'); END;
    `);

    // REPLACE is a delete in disguise, and it fires no delete trigger (recursive_triggers is off):
    // `INSERT OR REPLACE` with a held id re-points that row, and with a new id and a held address
    // the unique index makes it drop the other person's row. So an insert may only add a row whose
    // id and address are both unheld; a forgotten row's empty address holds nothing.
    this.#db.exec(`
      CREATE TRIGGER IF NOT EXISTS people_no_replace BEFORE INSERT ON people
        WHEN EXISTS (SELECT 1 FROM people WHERE id = NEW.id OR (NEW.email IS NOT NULL AND email = NEW.email))
        BEGIN SELECT RAISE(ABORT, '${ONLY_LOSES}'); END;
    `);
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
      this.#db.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run(id, e);
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

  async append(event: NewEvent, author: string): Promise<Event> {
    const e = stored(event, crypto.randomUUID().replace(/-/g, ''), author, new Date().toISOString());
    this.#db.prepare(
      `INSERT INTO events (id, type, page, block, fingerprint, text, snapshot, author, happened_at, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(e.id, e.type, e.page, e.block ?? null, e.fingerprint ?? null, e.text ?? null,
          e.snapshot ?? null, e.author, e.when, e.data ? JSON.stringify(e.data) : null);
    return e;
  }

  async list(page?: string | null): Promise<Event[]> {
    const rows = page == null
      // `rowid` breaks a tie inside one millisecond: recorded order, not whatever the planner picks.
      // Today's SQLite already hands ties back in rowid order, so dropping it changes nothing a
      // test can see; naming it turns that accident into a promise. `rowid DESC` fails the suite.
      ? this.#db.prepare('SELECT * FROM events ORDER BY happened_at, rowid').all()
      : this.#db.prepare('SELECT * FROM events WHERE page = ? ORDER BY happened_at, rowid').all(page);
    return (rows as Record<string, string | null>[]).map((r) => ({
      id: r.id!, type: r.type!, page: r.page!, block: r.block, fingerprint: r.fingerprint,
      text: r.text, snapshot: r.snapshot, author: r.author!, when: r.happened_at!,
      data: r.data ? JSON.parse(r.data) : null,
    }));
  }

  async close(): Promise<void> { this.#db.close(); }
}
