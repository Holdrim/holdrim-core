import { UserStoreBase, type StoredSession, type StoredUser } from './users.ts';

/**
 * People and sessions in Postgres: tables `users` and `sessions`.
 *
 * This is the answer for a deployment whose instances come and go — Cloud Run above all, where the
 * local disk is ephemeral and per instance, so an access created today vanishes when the platform
 * recycles it, with no error and no log. See `users.ts` for the full reasoning.
 *
 * ## Why `pg` is imported the awkward way
 *
 * `pg` is an **optional** dependency. Whoever runs Holdrim on SQLite — which is most people, and
 * the whole "start the image and use it" promise — should not download a Postgres driver, and
 * should not see the install fail if that driver cannot be built. So the import happens at
 * connection time, inside this file, and nowhere else.
 *
 * The module specifier is a constant rather than a literal on purpose: with a literal, the type
 * checker resolves `import('pg')` eagerly and demands the package be installed for everyone,
 * including the people this arrangement exists to spare. The cost is that `pg`'s own types do not
 * reach us, so the shape we use is declared below — six lines, and the compiler still checks every
 * call against them.
 */
const PG_MODULE = 'pg';

/** The slice of `pg` this file touches. Everything else about the driver is none of our business. */
interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}

export class UsersPostgres extends UserStoreBase {
  #pool: PgPool | null = null;
  #ready: Promise<PgPool>;

  constructor(connectionString: string) {
    super();
    // Started in the constructor, awaited in every method. A constructor cannot await, and the
    // alternative — an `init()` the caller must remember to call — is a bug waiting for the one
    // code path that forgets.
    this.#ready = this.#connect(connectionString);
    // Nobody may be listening yet if the first query comes later; without this, a bad URL becomes
    // an unhandled rejection that kills the process with no context.
    this.#ready.catch(() => {});
  }

  async #connect(connectionString: string): Promise<PgPool> {
    const loaded = await import(PG_MODULE) as PgModule & { default?: PgModule };
    // `pg` is CommonJS. Depending on how the lexer reads it, `Pool` arrives either as a named
    // export or hanging off `default` — accept both rather than betting on one.
    const { Pool } = loaded.default ?? loaded;
    const pool = new Pool({ connectionString });

    // `created_at` is TEXT, not `timestamptz`, and that is deliberate: it is an ISO string in every
    // store, so the value a person sees does not change with the database, and expiry comparisons
    // are the same string comparison everywhere.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        email       TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        salt        BYTEA NOT NULL,
        hash        BYTEA NOT NULL,
        must_change BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TEXT NOT NULL,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        email      TEXT NOT NULL REFERENCES users(email),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions (expires_at)');

    this.#pool = pool;
    return pool;
  }

  async #query(text: string, values?: unknown[]): Promise<Record<string, unknown>[]> {
    const pool = this.#pool ?? await this.#ready;
    return (await pool.query(text, values)).rows;
  }

  protected async insertUser(row: StoredUser): Promise<void> {
    await this.#query(
      'INSERT INTO users (email, name, salt, hash, must_change, created_at, enabled) '
      + 'VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [row.email, row.name, row.salt, row.hash, row.mustChangePassword, row.createdAt, row.enabled]);
  }

  protected async readUser(email: string): Promise<StoredUser | null> {
    const [r] = await this.#query('SELECT * FROM users WHERE email = $1', [email]);
    return r ? rowToUser(r) : null;
  }

  protected async readAllUsers(): Promise<StoredUser[]> {
    // ⚠️ `ORDER BY email` and not the database's own idea of order: Postgres sorts by the server's
    // collation, which differs between installations, so the ordering has to be asked for out
    // loud or the same team gets a different list depending on where the service was deployed.
    return (await this.#query('SELECT * FROM users ORDER BY email')).map(rowToUser);
  }

  protected async writeEnabled(email: string, enabled: boolean): Promise<void> {
    await this.#query('UPDATE users SET enabled = $1 WHERE email = $2', [enabled, email]);
  }

  protected async writeName(email: string, name: string): Promise<void> {
    await this.#query('UPDATE users SET name = $1 WHERE email = $2', [name, email]);
  }

  protected async writeCredential(
    email: string, salt: Buffer, hash: Buffer, mustChange: boolean): Promise<void> {
    await this.#query(
      'UPDATE users SET salt = $1, hash = $2, must_change = $3 WHERE email = $4',
      [salt, hash, mustChange, email]);
  }

  protected async countUsers(): Promise<number> {
    const [r] = await this.#query('SELECT COUNT(*) AS n FROM users');
    // `count()` is bigint, and the driver hands bigint over as a string so it cannot lose
    // precision. `Number(undefined)` would be NaN, which compares false against 0 and would report
    // a populated database as empty — hence the fallback.
    return Number(r?.n ?? 0);
  }

  protected async insertSession(id: string, email: string, createdAt: string, expiresAt: string): Promise<void> {
    await this.#query(
      'INSERT INTO sessions (id, email, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [id, email, createdAt, expiresAt]);
  }

  protected async readSession(id: string): Promise<StoredSession | null> {
    const [r] = await this.#query('SELECT email, expires_at FROM sessions WHERE id = $1', [id]);
    return r ? { email: r.email as string, expiresAt: r.expires_at as string } : null;
  }

  protected async deleteSession(id: string): Promise<void> {
    await this.#query('DELETE FROM sessions WHERE id = $1', [id]);
  }

  protected async deleteSessionsExpiredBefore(instant: string): Promise<void> {
    await this.#query('DELETE FROM sessions WHERE expires_at < $1', [instant]);
  }

  protected async deleteSessionsForEmail(email: string): Promise<void> {
    await this.#query('DELETE FROM sessions WHERE email = $1', [email]);
  }

  async close(): Promise<void> {
    // Awaiting the connection first: closing a store whose pool is still being built would leave
    // the pool open behind us and hold the process alive.
    const pool = this.#pool ?? await this.#ready.catch(() => null);
    await pool?.end();
  }
}

/**
 * One row of `users`, as the rest of the code expects it. Shared by the single read and the listing
 * so the two can never drift — a listing that decoded `enabled` differently from the login path is
 * a screen that shows someone as able to get in while the door says otherwise.
 */
function rowToUser(r: Record<string, unknown>): StoredUser {
  return {
    email: r.email as string, name: r.name as string,
    salt: Buffer.from(r.salt as Uint8Array), hash: Buffer.from(r.hash as Uint8Array),
    mustChangePassword: !!r.must_change, createdAt: r.created_at as string,
    enabled: !!r.enabled,
  };
}
