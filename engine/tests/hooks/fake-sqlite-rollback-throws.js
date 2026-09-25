/**
 * Loaded with `node --import`: every `node:sqlite` import gets a `DatabaseSync` whose own
 * `exec('ROLLBACK')` throws — standing in for a ROLLBACK that itself fails (the connection already
 * gone, a corrupt WAL) instead of the ordinary case, where undoing an empty, read-only transaction
 * never fails.
 *
 * Proof for round 3 of the #91 review, MAJOR: `Source#fromFile` (engine/cli/remote.ts) calls
 * `rollbackQuietly` (engine/api/store-sqlite.ts), which swallows only the ROLLBACK's own failure,
 * before rethrowing the ORIGINAL error itself — never whatever a failing ROLLBACK throws instead. A
 * real SQLite file has no way to make ROLLBACK itself fail on purpose, so this hook is the only way
 * to exercise that path at all (engine/tests/texts.test.js, the test next to the one for round 1's
 * finding 2 on this same method).
 *
 * A `data:` URL substitute, not a plain subclass exported from a second file: the substitute still
 * needs the REAL `node:sqlite` to extend, and if the redirect below caught that import too it would
 * recurse into itself forever. The marker comment is how the hook tells its own re-entry apart from
 * `#fromFile`'s.
 */
import { register } from 'node:module';

const FAKE = `
  // __FAKE_SQLITE_ROLLBACK_THROWS__
  import * as real from 'node:sqlite';
  export class DatabaseSync extends real.DatabaseSync {
    exec(sql) {
      if (sql === 'ROLLBACK') throw new Error('rollback failed: no transaction is active');
      return super.exec(sql);
    }
  }
  export const { StatementSync } = real;
`;

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'node:sqlite' && !context.parentURL?.includes('__FAKE_SQLITE_ROLLBACK_THROWS__')) {
      return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(FAKE))}, shortCircuit: true };
    }
    return next(specifier, context);
  }
`));
