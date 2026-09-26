import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SQLITE_BUSY_TIMEOUT_MS } from './store-sqlite.ts';
import { AddressInUse, UserStoreBase, type StoredAgentToken, type StoredSession, type StoredUser } from './users.ts';

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
    // Wait for another connection's write instead of failing at once, as long as the event store
    // does. Without it, the `BEGIN IMMEDIATE` below answers "database is locked" the moment a second
    // process on this file is mid-write, and an issue or an account creation fails for nothing but
    // timing.
    this.#db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
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
      -- One row per agent address (docs/ROLES.md, section 4): the primary key is what makes a second
      -- issue REPLACE the first, so an old token cannot outlive the one that superseded it. No
      -- reference to users: an agent is not a person and needs no password to hold a token.
      CREATE TABLE IF NOT EXISTS agent_tokens (
        email     TEXT PRIMARY KEY,
        kind      TEXT NOT NULL CHECK (kind = 'agent'),
        token_id  TEXT NOT NULL UNIQUE,
        hash      BLOB NOT NULL,
        issued_at TEXT NOT NULL
      );
    `);
  }

  protected async writeAgentToken(row: StoredAgentToken): Promise<string | null> {
    return this.#immediate(() => {
      if (this.#db.prepare('SELECT 1 FROM users WHERE email = ?').get(row.email)) {
        throw new AddressInUse(row.email, 'account');
      }
      const before = this.#db.prepare('SELECT token_id FROM agent_tokens WHERE email = ?').get(row.email) as
        { token_id: string } | undefined;
      this.#db.prepare(
        'INSERT INTO agent_tokens (email, kind, token_id, hash, issued_at) VALUES (?, ?, ?, ?, ?) '
        + 'ON CONFLICT(email) DO UPDATE SET kind = excluded.kind, token_id = excluded.token_id, '
        + 'hash = excluded.hash, issued_at = excluded.issued_at',
      ).run(row.email, row.kind, row.tokenId, row.hash, row.issuedAt);
      return before?.token_id ?? null;
    });
  }

  /**
   * `body` inside `BEGIN IMMEDIATE`, so its reads and its write see the same file: another process on
   * it could otherwise slip an issue or an account in between, and the trail would name the wrong
   * predecessor, or one address would end up both a person and an agent (`writeAgentToken`, users.ts).
   * Within this process nothing interleaves anyway: `body` is synchronous, with no await to yield at.
   */
  #immediate<T>(body: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  protected async readAgentTokenById(tokenId: string): Promise<StoredAgentToken | null> {
    const r = this.#db.prepare('SELECT * FROM agent_tokens WHERE token_id = ?').get(tokenId) as
      Record<string, string | Uint8Array> | undefined;
    return r ? rowToToken(r) : null;
  }

  protected async readAllAgentTokens(): Promise<StoredAgentToken[]> {
    const rows = this.#db.prepare('SELECT * FROM agent_tokens ORDER BY email').all() as
      Record<string, string | Uint8Array>[];
    return rows.map(rowToToken);
  }

  protected async deleteAgentToken(email: string): Promise<string | null> {
    const r = this.#db.prepare('DELETE FROM agent_tokens WHERE email = ? RETURNING token_id').get(email) as
      { token_id: string } | undefined;
    return r?.token_id ?? null;
  }

  protected async insertUser(row: StoredUser): Promise<void> {
    this.#immediate(() => {
      if (this.#db.prepare('SELECT 1 FROM agent_tokens WHERE email = ?').get(row.email)) {
        throw new AddressInUse(row.email, 'agentToken');
      }
      this.#db.prepare(
        'INSERT INTO users (email, name, salt, hash, must_change, created_at, enabled) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(row.email, row.name, row.salt, row.hash, row.mustChangePassword ? 1 : 0, row.createdAt,
        row.enabled ? 1 : 0);
    });
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

/** One row of `agent_tokens`, shaped as `users.ts` expects it, for the single read and the listing. */
function rowToToken(r: Record<string, string | Uint8Array>): StoredAgentToken {
  return {
    email: r.email as string, kind: r.kind as 'agent', tokenId: r.token_id as string,
    hash: Buffer.from(r.hash as Uint8Array), issuedAt: r.issued_at as string,
  };
}
