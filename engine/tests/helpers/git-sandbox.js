/**
 * A throwaway git repository for a test, cut off from the machine it runs on.
 *
 * Shared because more than one test needs one, and the rules below were each paid for: AGENTS.md
 * tells of the `git init` that inherited GIT_DIR inside a hook and wrote `bare = true` into the
 * main repository. A second, improvised copy of this is how that happens again.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A temporary directory that git will not consider part of any repository above it.
 *
 * ⚠️ GIT_CEILING_DIRECTORIES is what makes the negative test honest. Without it the answer would
 * depend on whether the machine happens to have a repository somewhere above the temporary
 * directory — the test would pass here and fail on somebody else's laptop for a reason that has
 * nothing to do with the code.
 */
export const loneDirectory = () => {
  const parent = realpathSync(tmpdir());
  process.env.GIT_CEILING_DIRECTORIES = parent;
  return mkdtempSync(join(parent, 'holdrim-git-'));
};

/**
 * A repository built from nothing, for the test to look at.
 *
 * ⚠️ The configuration of the machine is cut out, not inherited. A developer with commit signing
 * on, a template directory or a hooks path would otherwise fail this test for reasons that have
 * nothing to do with the code being tested — and the failure would read as if the helper were
 * broken.
 */
export const run = (dir, ...args) => {
  const env = isolatedEnv();
  return execFileSync('git', ['-C', dir, '-c', 'user.email=test@example.org', '-c', 'user.name=Test',
    '-c', 'commit.gpgsign=false', '-c', 'init.templateDir=', '-c', 'core.hooksPath=', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  }).trim();
};

/**
 * The environment `run` uses, also for a test that runs a script which calls git itself.
 *
 * ⚠️ GIT_DIR out of the way before anything writes. These tests run inside the pre-commit hook,
 * where git exports it — and `git init` with GIT_DIR set does not create a repository in `dir`,
 * it reinitialises the one the hook is committing to.
 */
export function isolatedEnv(extra = {}) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...extra };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) {
    delete env[name];
  }
  return env;
}
