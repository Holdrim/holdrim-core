import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stored, type Event, type NewEvent, type EventStore } from './types.ts';

/**
 * SQLite persistence on the built-in `node:sqlite` — **no external dependency**.
 *
 * It is what lets someone start Holdrim and use it with no database, no cloud, no account anywhere:
 * one file on disk. For a team, swap in Postgres or Firestore by implementing the same `EventStore`
 * interface — three methods.
 *
 * INSERT ONLY, as the method demands: there is no UPDATE and no DELETE in this file. The trail is
 * the product.
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
  }

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
