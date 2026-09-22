/**
 * What git can tell the engine about the content it just indexed.
 *
 * It exists for one reason: an index that knows WHICH COMMIT it was built at can later ask git
 * which files changed since then, and reparse only those. A timestamp cannot do that — "built at
 * 14:02" does not name a tree, so the only honest answer from a timestamp is "reparse everything".
 *
 * ⚠️ Reading is all that happens here. Nothing in this module writes to a repository.
 * @module
 */

import { execFileSync } from 'node:child_process';

/**
 * The environment, minus the variables that would answer about SOME OTHER repository.
 *
 * ⚠️ This is not defensive decoration — it was a real wrong answer. A process started from a git
 * hook has GIT_DIR exported, and `git -C <root> rev-parse HEAD` then reports the HOOK'S repository
 * and ignores `-C` entirely. The tool would stamp the index with a commit belonging somewhere
 * else, which is worse than stamping none: a later diff would compare against a tree that has
 * nothing to do with the content, and conclude almost nothing needs reparsing.
 *
 * GIT_CEILING_DIRECTORIES stays: it only limits how far the search climbs, so it can make the
 * answer null but never make it wrong.
 */
const environmentWithoutAnInheritedRepository = () => {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) {
    delete env[name];
  }
  return env;
};

/**
 * The commit the content is sitting on right now, or null.
 *
 * ⚠️ null is a legitimate answer, not a failure. The documentation can perfectly well live in a
 * plain folder that nobody ever ran `git init` in, and the engine has to keep working there: an
 * index with no commit is a LESS USEFUL index — the git layer has no starting point and whoever
 * reindexes pays for a full parse — but it is not a broken one. Every other reason git stays quiet
 * (no commit yet on a fresh repository, git not installed, no permission to read the directory)
 * lands in the same place on purpose: the caller has one case to handle instead of five, and none
 * of them is worth interrupting an index over.
 *
 * @param {string} root  the directory the content was read from
 * @returns {string | null}  the full SHA, or null when there is no commit to name
 */
export function currentCommit(root) {
  try {
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: environmentWithoutAnInheritedRepository(),
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
