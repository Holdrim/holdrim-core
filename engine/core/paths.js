import { normalize, relative, sep } from 'node:path';

/**
 * Whether `target` lies STRICTLY inside directory `root` — the root itself does not count as
 * inside it, only something under it.
 *
 * Shared by every place that takes a path from configuration and has to keep it under a project's
 * own folder, so the rule is written once and read the same way everywhere it applies, rather than
 * as three hand-rolled comparisons that drift the day one of them is fixed and the others are not:
 * `readConfig`'s own `content.registry` and `content.folders` (engine/core/config.js), the theme's
 * logo (`loadLogo`, engine/api/theme.ts), and the REAL, symlink-resolved location of a registry, a
 * configured page folder, a page file, or a file the server serves from the site (`realContainment`,
 * engine/cli/fs.ts, holdrim#161 and holdrim#164).
 *
 * Checked by RESOLUTION, with `path.relative`, never by a raw `startsWith` on the two strings:
 * `relative` folds `a/../../x` and a leading `./` down to what they actually resolve to, where a
 * string search would have to reinvent that folding to catch the first and would wrongly flag the
 * second; and `startsWith(root)` alone waves a SIBLING folder through as if it were inside —
 * `/proj-other` passes a raw `"/proj"` prefix check the way `/proj/…` does, the classic bug this
 * function exists not to repeat.
 *
 * Lexical only: neither path is resolved through the filesystem here — a symlink along the way is
 * invisible to a string comparison either way. A caller that cares whether a component is a link
 * resolves what it needs to first (`fs.realpathSync`) and passes the two REAL paths in; that is the
 * same lexical comparison, on values a link can no longer hide behind.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function insideRoot(root, target) {
  const rel = relative(normalize(root), normalize(target));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`);
}
