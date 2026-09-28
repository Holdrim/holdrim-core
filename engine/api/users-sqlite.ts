import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SQLITE_BUSY_TIMEOUT_MS } from './store-sqlite.ts';
import {
  AddressInUse, UserStoreBase, type RemovedChange, type SignInFailures, type StoredAgentToken, type StoredSession,
  type StoredUser,
} from './users.ts';

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
      -- \`id\` holds the SHA-256 of the cookie's session id, never the id (users.ts, \`sessionKey\`):
      -- a copy of this file must not be a live session. A row an older version wrote holds the raw
      -- id, is never found by a lookup, and is purged like any expired row by a start after it expires.
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
      -- Wrong passwords per typed address, kept here so a restart does not hand out a fresh set
      -- (identity-password.ts says why, and users.ts why the key is a hash and never the address).
      -- No reference to users: an address nobody has is counted exactly like one somebody has.
      CREATE TABLE IF NOT EXISTS sign_in_failures (
        key       TEXT PRIMARY KEY,
        count     INTEGER NOT NULL CHECK (count > 0),
        last_at   TEXT NOT NULL,
        escalated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sign_in_failures_by_last ON sign_in_failures (last_at);
      -- What a store holds once per deployment, written the first time it is needed and never again
      -- (users.ts, \`readOrWriteValue\`): today, the salt of the sign-in failure keys.
      CREATE TABLE IF NOT EXISTS store_values (
        name  TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );
    `);
    // Added after the table first shipped, so a file an earlier version made is given it here:
    // SQLite has no `ADD COLUMN IF NOT EXISTS`. 1 marks an account closed by a person's removal.
    const columns = this.#db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'removed')) {
      this.#db.exec('ALTER TABLE users ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
    }
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
        'INSERT INTO users (email, name, salt, hash, must_change, created_at, enabled, removed) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(row.email, row.name, row.salt, row.hash, row.mustChangePassword ? 1 : 0, row.createdAt,
        row.enabled ? 1 : 0, row.removed ? 1 : 0);
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

  protected async writeRemoved(email: string, change: RemovedChange): Promise<boolean> {
    return this.#immediate(() => {
      if (change.onlyClosed) {
        const row = this.#db.prepare('SELECT removed FROM users WHERE email = ?').get(email) as { removed: number } | undefined;
        if (!row?.removed) return false;
      }
      this.#db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
      const r = this.#db.prepare(
        'UPDATE users SET email = ?, name = COALESCE(?, name), salt = COALESCE(?, salt), hash = COALESCE(?, hash), '
        + 'enabled = 0, removed = 1 WHERE email = ?',
      ).run(change.key, change.name ?? null, change.salt ?? null, change.hash ?? null, email);
      return r.changes === 1;
    });
  }

  protected async writeCredential(
    email: string, salt: Buffer, hash: Buffer, mustChange: boolean): Promise<void> {
    this.#db.prepare('UPDATE users SET salt = ?, hash = ?, must_change = ? WHERE email = ?')
      .run(salt, hash, mustChange ? 1 : 0, email);
  }

  protected async countUsers(): Promise<number> {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  protected async insertSession(key: string, email: string, createdAt: string, expiresAt: string): Promise<void> {
    this.#db.prepare('INSERT INTO sessions (id, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(key, email, createdAt, expiresAt);
  }

  protected async readSession(key: string): Promise<StoredSession | null> {
    const r = this.#db.prepare('SELECT email, expires_at FROM sessions WHERE id = ?').get(key) as
      { email: string; expires_at: string } | undefined;
    return r ? { email: r.email, expiresAt: r.expires_at } : null;
  }

  protected async deleteSession(key: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(key);
  }

  protected async deleteSessionsExpiredBefore(instant: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(instant);
  }

  protected async deleteSessionsForEmail(email: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE email = ?').run(email);
  }

  protected async deleteSessionsForEmailExcept(email: string, keepKey: string): Promise<void> {
    // One statement: the caller's own row is excluded by the WHERE clause itself, so there is no
    // moment where it is gone and not yet back (users.ts's comment on the abstract method says why
    // that matters).
    this.#db.prepare('DELETE FROM sessions WHERE email = ? AND id != ?').run(email, keepKey);
  }

  protected async readFailure(key: string): Promise<SignInFailures | null> {
    return rowToFailure(this.#db.prepare('SELECT count, last_at, escalated FROM sign_in_failures WHERE key = ?').get(key));
  }

  protected async updateFailure(
    key: string, next: (current: SignInFailures | null) => SignInFailures | null): Promise<void> {
    // In `BEGIN IMMEDIATE`: two instances on one file each reading the same count and each writing
    // it plus one would count two wrong passwords as one.
    this.#immediate(() => {
      const current = rowToFailure(this.#db.prepare('SELECT count, last_at, escalated FROM sign_in_failures WHERE key = ?').get(key));
      const row = next(current);
      if (row === null) {
        this.#db.prepare('DELETE FROM sign_in_failures WHERE key = ?').run(key);
        return;
      }
      this.#db.prepare(
        'INSERT INTO sign_in_failures (key, count, last_at, escalated) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET count = excluded.count, last_at = excluded.last_at, '
        + 'escalated = excluded.escalated',
      ).run(key, row.count, row.lastAt, row.escalated ? 1 : 0);
    });
  }

  protected async pruneFailures(lastBefore: string, keep: number): Promise<void> {
    this.#db.prepare('DELETE FROM sign_in_failures WHERE last_at < ?').run(lastBefore);
    // Ranked by what stays: escalated rows first, then the newest. `LIMIT -1 OFFSET ?` is SQLite's
    // "every row past the first ?", so what goes is every row the first `keep` did not reach — the
    // oldest of those not escalated, and escalated ones only once there are more than `keep` of them.
    this.#db.prepare(
      'DELETE FROM sign_in_failures WHERE key IN (SELECT key FROM sign_in_failures '
      + 'ORDER BY escalated DESC, last_at DESC, key DESC LIMIT -1 OFFSET ?)',
    ).run(keep);
  }

  protected async countFailures(): Promise<number> {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM sign_in_failures').get() as { n: number }).n;
  }

  protected async readOrWriteValue(name: string, fresh: Buffer): Promise<Buffer> {
    // `DO NOTHING`, then read: whichever instance wrote first, every one reads the same value back.
    this.#db.prepare('INSERT INTO store_values (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
      .run(name, fresh);
    const r = this.#db.prepare('SELECT value FROM store_values WHERE name = ?').get(name) as { value: Uint8Array };
    return Buffer.from(r.value);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}

/** One row of `sign_in_failures`, or null for none. */
function rowToFailure(r: unknown): SignInFailures | null {
  if (!r) return null;
  const row = r as { count: number; last_at: string; escalated: number };
  return { count: Number(row.count), lastAt: row.last_at, escalated: !!row.escalated };
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
    enabled: !!r.enabled, removed: !!r.removed,
  };
}

/** One row of `agent_tokens`, shaped as `users.ts` expects it, for the single read and the listing. */
function rowToToken(r: Record<string, string | Uint8Array>): StoredAgentToken {
  return {
    email: r.email as string, kind: r.kind as 'agent', tokenId: r.token_id as string,
    hash: Buffer.from(r.hash as Uint8Array), issuedAt: r.issued_at as string,
  };
}
