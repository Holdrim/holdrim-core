import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { severityOf } from '../core/impact.js';

/**
 * The documentation index: which blocks exist, what kind they are, what they depend on, and what
 * each one is still missing.
 *
 * ⚠️ This is NOT the truth. The truth is the file, versioned in git — that is what has diffs,
 * history and authorship, and that is where people write. This is a snapshot, rebuilt by
 * `holdrim index`, and it can be deleted without loss.
 *
 * The distinction matters, and the database itself enforces it: `events` is fact, and triggers
 * refuse UPDATE and DELETE; `blocks` is derived, and the whole index is wiped on every rebuild.
 * If both were truth, one day they would disagree — and there would be no way to know which to
 * believe.
 *
 * It exists because files answer some questions badly: "every suspect diagram in the project",
 * "every decision with no owner", "what breaks if I touch this". Those are database questions.
 */

export interface IndexedBlock {
  id: string; page: string; kind: string; file: string;
  code: string | null; numbered: boolean; fingerprint: string; text: string | null;
  dependsOn: string[]; missing: string[];
}

export class Index {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY, page TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL,
        code TEXT, numbered INTEGER NOT NULL, fingerprint TEXT NOT NULL, text TEXT,
        position INTEGER NOT NULL, indexed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS blocks_by_page ON blocks (page, position);
      CREATE INDEX IF NOT EXISTS blocks_by_kind ON blocks (kind);

      -- Its own table, not a comma-separated column: the question people ask most is the REVERSE
      -- one — "if I change this, what breaks?" — and that needs an index on both sides.
      --
      -- severity is where the pair lands: silent, agent or person. It is stored rather than
      -- computed on read because the kind of a block is a property of the index it was built
      -- from — recomputing it later against a newer catalogue of kinds would silently reinterpret
      -- an old snapshot, and nobody would see it happen.
      CREATE TABLE IF NOT EXISTS dependencies (
        block TEXT NOT NULL, depends_on TEXT NOT NULL, severity TEXT NOT NULL,
        PRIMARY KEY (block, depends_on));
      CREATE INDEX IF NOT EXISTS dependencies_reverse ON dependencies (depends_on);
      CREATE INDEX IF NOT EXISTS dependencies_by_severity ON dependencies (severity);

      CREATE TABLE IF NOT EXISTS issues (block TEXT NOT NULL, missing TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS issues_by_block ON issues (block);

      -- ONE row, enforced by the CHECK: the commit and the instant belong to the index as a whole,
      -- not to any block in it. Stamping them on every block, which is what indexed_at does,
      -- invites the reader to believe two rows could disagree, and to write a query that groups by
      -- them. They cannot disagree: a rebuild is all-or-nothing.
      --
      -- Why the commit and not only the hour: an hour cannot name a tree. Knowing the index was
      -- built at commit <sha> lets a later run ask git which FILES changed since then and reparse
      -- only those. Knowing it was built at 14:02 leaves no honest answer but "reparse everything".
      --
      -- commit_sha is nullable on purpose. The reason is in the doc comment of rebuild.
      CREATE TABLE IF NOT EXISTS index_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        commit_sha TEXT,
        built_at TEXT NOT NULL);
    `);
  }

  /**
   * Rebuilds the whole index. Wipes and rewrites inside a transaction: a half-written index would
   * lie worse than a stale one — anyone reading mid-rebuild would see documentation that never
   * existed.
   *
   * `commit` is the commit the content was sitting on. ⚠️ null is a legitimate value, not an
   * error: the documentation may live in a plain folder nobody ever ran `git init` in, and the
   * tool has to keep working there. An index with no commit is a LESS USEFUL index — the git layer
   * has nothing to diff against, so the next run reparses everything — but it is not a broken one,
   * and refusing to index would trade a real loss for an imaginary one.
   */
  rebuild(blocks: IndexedBlock[], commit: string | null = null) {
    const now = new Date().toISOString();
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM issues; DELETE FROM dependencies; DELETE FROM blocks');
      // Rewritten, never accumulated: the metadata describes THIS index, and the previous one is
      // gone by the line above. Inside the transaction with everything else, so a rollback cannot
      // leave a commit pointing at blocks that were never written.
      this.#db.exec('DELETE FROM index_meta');
      this.#db.prepare('INSERT INTO index_meta (id, commit_sha, built_at) VALUES (1, ?, ?)')
        .run(commit, now);
      const b = this.#db.prepare(
        `INSERT INTO blocks (id, page, kind, file, code, numbered, fingerprint, text, position, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const d = this.#db.prepare(
        'INSERT OR IGNORE INTO dependencies (block, depends_on, severity) VALUES (?, ?, ?)');
      const i = this.#db.prepare('INSERT INTO issues (block, missing) VALUES (?, ?)');

      // The kind of the block being depended ON, which the pair needs and the pair does not carry.
      // A dependency pointing at a block that is not here — a broken one — finds nothing and is
      // weighed as an unknown kind, which `severityOf` puts in the middle of the road on purpose.
      const kinds = new Map(blocks.map((x) => [x.id, x.kind]));

      blocks.forEach((x, position) => {
        b.run(x.id, x.page, x.kind, x.file, x.code, x.numbered ? 1 : 0,
              x.fingerprint, x.text, position, now);
        // ⚠️ The severity stored here is the MATRIX ALONE: kind against kind, with no signals from
        // the edit. `signalsOf` compares the text BEFORE a change with the text after, and an
        // index built from the files on disk only ever has the "after". Inventing a "before" would
        // put a made-up reading into a column people are meant to trust, which is worse than
        // recording less. The signals join in when a real earlier text exists — that is what the
        // git layer brings, and until then this number is the floor, never the final word.
        for (const dep of x.dependsOn) d.run(x.id, dep, severityOf(kinds.get(dep) ?? '', x.kind));
        for (const missing of x.missing) i.run(x.id, missing);
      });
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return blocks.length;
  }

  /** How many blocks of each kind — the "what is this documentation made of?" question. */
  byKind(): { kind: string; count: number }[] {
    return this.#db.prepare(
      'SELECT kind, COUNT(*) AS count FROM blocks GROUP BY kind ORDER BY count DESC',
    ).all() as never;
  }

  /** What is missing, optionally per kind. The queue for whoever is writing. */
  issues(kind?: string): { id: string; kind: string; missing: string }[] {
    const sql = `SELECT b.id, b.kind, i.missing FROM issues i
                 JOIN blocks b ON b.id = i.block
                 ${kind ? 'WHERE b.kind = ?' : ''} ORDER BY b.page, b.position`;
    return (kind ? this.#db.prepare(sql).all(kind) : this.#db.prepare(sql).all()) as never;
  }

  /** What depends on this block. The question you ask BEFORE editing. */
  dependentsOf(id: string): string[] {
    return (this.#db.prepare('SELECT block FROM dependencies WHERE depends_on = ? ORDER BY block')
      .all(id) as { block: string }[]).map((r) => r.block);
  }

  /**
   * How many dependency pairs landed at each level. Loudest first, and levels with nothing in them
   * are absent — the funnel is measured by how little reaches a person, so the interesting number
   * is the one at the top.
   */
  bySeverity(): { severity: string; count: number }[] {
    return this.#db.prepare(
      `SELECT severity, COUNT(*) AS count FROM dependencies GROUP BY severity
       ORDER BY CASE severity WHEN 'person' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END`,
    ).all() as never;
  }

  /**
   * The pairs that fell on a person: "what is going to need MY attention?". The one question the
   * other queries cannot answer, because it is not about a block — it is about a relation between
   * two of them.
   *
   * `dependsOnKind` is null when the dependency is broken, and that is worth seeing next to the
   * severity: the level was decided without knowing what the other side was.
   */
  needsAPerson(): { block: string; dependsOn: string; kind: string; dependsOnKind: string | null }[] {
    return this.#db.prepare(
      `SELECT d.block, d.depends_on AS dependsOn, b.kind, g.kind AS dependsOnKind
       FROM dependencies d
       JOIN blocks b ON b.id = d.block
       LEFT JOIN blocks g ON g.id = d.depends_on
       WHERE d.severity = 'person' ORDER BY b.page, b.position`,
    ).all() as never;
  }

  /** A dependency pointing at a block that no longer exists. Silent break: invisible when reading. */
  brokenDependencies(): { block: string; dependsOn: string }[] {
    return this.#db.prepare(
      `SELECT d.block, d.depends_on AS dependsOn FROM dependencies d
       LEFT JOIN blocks b ON b.id = d.depends_on
       WHERE b.id IS NULL ORDER BY d.block`,
    ).all() as never;
  }

  /** Blocks of a given kind. For "show me every diagram". */
  ofKind(kind: string): { id: string; page: string; text: string }[] {
    return this.#db.prepare(
      'SELECT id, page, text FROM blocks WHERE kind = ? ORDER BY page, position',
    ).all(kind) as never;
  }

  indexedAt(): string | null {
    const r = this.#db.prepare('SELECT MAX(indexed_at) AS at FROM blocks').get() as { at: string | null };
    return r?.at ?? null;
  }

  /**
   * Where this index came from: the commit of the content and the instant it was built.
   *
   * Two absences that mean different things, and the return type keeps them apart. `null` is
   * "never built" — there is nothing to compare against at all. `{ commit: null }` is "built from
   * content that is not in a repository", which is a perfectly usable index; it just cannot tell
   * the git layer where to start, so a reindex costs a full parse.
   */
  builtFrom(): { commit: string | null; at: string } | null {
    // Not aliased to `commit` in SQL: COMMIT is a keyword, and SQLite fails on the bare word with
    // a message that names the column and not the reason. The rename happens in TypeScript.
    const r = this.#db.prepare('SELECT commit_sha, built_at FROM index_meta WHERE id = 1')
      .get() as { commit_sha: string | null; built_at: string } | undefined;
    return r ? { commit: r.commit_sha, at: r.built_at } : null;
  }

  close() { this.#db.close(); }
}
