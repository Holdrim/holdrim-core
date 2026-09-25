/**
 * SQL run on an events file from outside the store, the way anyone holding the file could.
 *
 * Shared because the guard tests of the server (store-sqlite-guards.test.js) and of the CLI's
 * `--db` reader (cli-commands.test.js) have to tamper with the file the same way: two copies drift,
 * and the two suites stop meaning the same thing by "from outside". The `finally` is why a copy
 * would matter: without it, SQL that throws leaves its connection open on a file the next step of
 * the test opens again.
 */
import { DatabaseSync } from 'node:sqlite';

/** Opens `path` on its own connection, runs `sql`, and closes it. */
export function outside(path, sql) {
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
}
