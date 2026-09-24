/**
 * A command replaced by a script, for the tests that run a shell script with stubs on the PATH.
 *
 * Shared because the scripts under test install, download or rewrite git config when their commands
 * are real, and two copies of this would drift: one changes its shebang, the other goes on staging
 * commands the old way, and the two suites stop meaning the same thing by "stubbed".
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Writes `dir/name`, executable, running `body` under bash. */
export function stub(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}
