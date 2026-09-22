/**
 * Loaded with `node --import`: any attempt to load an OPTIONAL package makes the process fail.
 *
 * Firestore and Postgres are optional dependencies, imported only when configured. Nothing but a
 * process that actually boots can prove that — a static `import` added one day to a file on the
 * startup path would load them for every install, SQLite laptops included, and no unit test that
 * mocks the store would notice. The contract test boots its server with this hook; the unit test
 * uses it on the modules themselves.
 */
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (/^(@google-cloud\\/firestore|pg)(\\/|$)/.test(specifier)) {
      throw new Error('an optional package was loaded on a path that never needs it: ' + specifier);
    }
    return next(specifier, context);
  }
`));
