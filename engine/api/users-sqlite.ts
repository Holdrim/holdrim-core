import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { UserStoreBase, type StoredSession, type StoredUser } from './users.ts';

/**
 * People and sessions in SQLite, on the built-in `node:sqlite` — **no external dependency**.
 *
 * This is the "start the image and use it" mode: one file on disk, no cloud account, no database
 * to provision. It is the right answer on a laptop, in a container with a real volume, and on any
 * host whose disk survives a restart.
 *
 * ⚠️ It is the WRONG answer on Cloud Run, and silently so: the disk there is ephemeral and lives
 * inside the instance, so an access created today is gone when the platform recycles the instance,
 * with no error anywhere. Use `HOLDRIM_USERS=postgres://…` or `firestore` there. The reasoning is
 * written out in `users.ts`.
 */
export class UsersSqlite extends UserStoreBase {
  #db: DatabaseSync;

  constructor(path: string) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    // WAL: a read does not block a write. Every page load checks a session.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email       TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        salt        BLOB NOT NULL,
        hash        BLOB NOT NULL,
        must_change INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        -- 1: being disabled is an explicit act, never a starting state.
        enabled     INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL REFERENCES users(email),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions (expires_at);
    `);
  }

  protected async insertUser(row: StoredUser): Promise<void> {
    this.#db.prepare(
      'INSERT INTO users (email, name, salt, hash, must_change, created_at, enabled) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(row.email, row.name, row.salt, row.hash, row.mustChangePassword ? 1 : 0, row.createdAt,
      row.enabled ? 1 : 0);
  }

  protected async readUser(email: string): Promise<StoredUser | null> {
    const r = this.#db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      Record<string, string | number | Uint8Array> | undefined;
    return r ? rowToUser(r) : null;
  }

  protected async readAllUsers(): Promise<StoredUser[]> {
    const rows = this.#db.prepare('SELECT * FROM users ORDER BY email').all() as
      Record<string, string | number | Uint8Array>[];
    return rows.map(rowToUser);
  }

  protected async writeEnabled(email: string, enabled: boolean): Promise<void> {
    this.#db.prepare('UPDATE users SET enabled = ? WHERE email = ?').run(enabled ? 1 : 0, email);
  }

  protected async writeName(email: string, name: string): Promise<void> {
    this.#db.prepare('UPDATE users SET name = ? WHERE email = ?').run(name, email);
  }

  protected async writeCredential(
    email: string, salt: Buffer, hash: Buffer, mustChange: boolean): Promise<void> {
    this.#db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = ? WHERE email = ?')
      .run(salt, hash, mustChange ? 1 : 0, email);
  }

  protected async countUsers(): Promise<number> {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  protected async insertSession(id: string, email: string, createdAt: string, expiresAt: string): Promise<void> {
    this.#db.prepare('INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, email, createdAt, expiresAt);
  }

  protected async readSession(id: string): Promise<StoredSession | null> {
    const r = this.#db.prepare('SELECT email, expires_at FROM sessions WHERE id = ?').get(id) as
      { email: string; expires_at: string } | undefined;
    return r ? { email: r.email, expiresAt: r.expires_at } : null;
  }

  protected async deleteSession(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  protected async deleteSessionsExpiredBefore(instant: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(instant);
  }

  protected async deleteSessionsForEmail(email: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
  }

  protected async deleteSessionsForEmailExcept(email: string, keepSessionId: string): Promise<void> {
    // One statement: the caller's own row is excluded by the WHERE clause itself, so there is no
    // moment where it is gone and not yet back (users.ts's comment on the abstract method says why
    // that matters).
    this.#db.prepare('DELETE FROM sessions WHERE email = ? AND id != ?').run(email, keepSessionId);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

/**
 * One row of `users`, as the rest of the code expects it. Shared by the single read and the listing
 * so the two can never drift — a listing that decoded `enabled` differently from the login path is
 * a screen that shows someone as able to get in while the door says otherwise.
 */
function rowToUser(r: Record<string, string | number | Uint8Array>): StoredUser {
  return {
    email: r.email as string, name: r.name as string,
    salt: Buffer.from(r.salt as Uint8Array), hash: Buffer.from(r.hash as Uint8Array),
    mustChangePassword: !!r.must_change, createdAt: r.created_at as string,
    enabled: !!r.enabled,
  };
}
