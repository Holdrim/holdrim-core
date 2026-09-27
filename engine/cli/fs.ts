import { lstatSync, statSync, realpathSync } from 'node:fs';
import { dirname, relative, join, sep } from 'node:path';
import { insideRoot } from '../core/paths.js';

/**
 * Filesystem guards shared by more than one CLI command, so a rule like "refuse a symlink" is
 * written once and read the same way everywhere it applies — never copied and left to drift the
 * way `saveRegistry` (engine/cli/validation.ts) once carried its own copy of `exportSite`'s check.
 */

/**
 * Refuses `path` when IT ITSELF is a link, wherever it points — `what` names the action for the
 * message (`export into ${out}`, `save ${path}`, `load ${path}`). `lstatSync`, never `existsSync`:
 * `existsSync` follows the link, so a DANGLING one (its target gone — an unmounted shared volume,
 * say) reads as "nothing here" and slips through. Caught here instead of by whichever read or write
 * follows, because none of them treats the link itself as the thing being acted on — a rename
 * replaces it, a write fills whatever it points at, a read returns whatever is at the far end —
 * while the link's own name goes on meaning something else to the next reader.
 *
 * Refuses a WORKING link too, not only a dangling one: `loadRegistry` reading straight through a
 * working link once looked safe, but `sync` writes seals onto pages before it saves the registry,
 * and a `saveRegistry` that refuses the same link in its own `finally` would leave those seals on
 * disk with no registry entry to show for them — exactly the state holdrim#148 and holdrim#151
 * already exist to prevent. One rule, checked the same way by every reader of the path.
 *
 * What this guards is only `path`'s OWN last component — never its ancestors, which is a different
 * failure and `refuseUnreachableFolder`'s job (holdrim#155): a symlinked ANCESTOR folder that
 * resolves is a legitimate way to mount shared content, and refusing it here would break that for a
 * problem this function was never asked about.
 *
 * What it does NOT guard, ancestors or not: a process racing this check with the read or write that
 * follows it — a symlink swapped in, or a volume unmounted, in the gap between the `lstatSync` above
 * and whatever the caller does next. That process is free to edit the file directly regardless of
 * what this call decided a moment earlier, so narrowing that window further here would guard
 * nothing real; nothing short of the filesystem making the check and the use one atomic step would.
 */
export function refuseLink(path: string, what: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing at all there — not a link either
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`refusing to ${what}: it is a link, and a link is not followed`);
}

/**
 * Refuses `path` when an ANCESTOR of it is a symlink that does not resolve — meant for a caller that
 * already found NOTHING under `path`'s own exact name (`lstatSync` on it came back ENOENT) and is
 * about to read that as "never written". That reading is right when the folder simply has not been
 * created yet — a project that has never run sync, say; it is wrong when a folder ABOVE it is a
 * DANGLING symlink (`docs -> /mnt/shared`, unmounted), which gives the very same ENOENT on `path`
 * (holdrim#155, round 2): the two are indistinguishable from `path` alone, and a single
 * `statSync(dirname(path))` cannot tell them apart either — it fails ENOENT on both, which is why the
 * first version of this fix (round 1) refused the "never synced yet" case it was meant to spare.
 *
 * So this walks the ancestors instead of asking one folder, `lstatSync` component by component, from
 * `root` (which resolved already — this is only ever called once `root/holdrim.json` was itself read)
 * down to `dirname(path)`. The first component that is not there AT ALL (`lstatSync` ENOENT, and it
 * is not a symlink either — there is nothing under that name to be one) ends the walk: nothing further
 * down exists yet, so the registry reads as genuinely absent, `{}`. A component that IS a symlink is
 * followed with `statSync`: ENOENT there means DANGLING (the name exists, what it points at does not)
 * and refuses; a plain, resolving folder is neither case, so the walk moves to the next component.
 * Ancestors ABOVE `root` are never walked: they are `root`'s own business, resolved before this ever
 * runs, and re-checking them here would be the same "already proven" work `refuseLink` avoids too.
 *
 * `lstatSync`, not `statSync`, at each step — the same reason `refuseLink` above uses it: `statSync`
 * follows a link before this can ever see that the component WAS one, so a genuinely dangling
 * ancestor would look identical to one plainly missing, and the walk could never refuse it. Only the
 * symlink target itself is read with `statSync`, exactly once it is known to be a link.
 *
 * No check that a non-symlink component is a directory rather than a file: a component that is a
 * plain FILE makes `lstatSync` on `path` ITSELF fail with `ENOTDIR`, not `ENOENT`, in `refuseLink`,
 * two lines above this is ever called — that case never reaches here at all, so adding a check for it
 * here would be a branch nothing can ever drive.
 */
export function refuseUnreachableFolder(root: string, path: string, what: string): void {
  const dir = dirname(path);
  const nested = relative(root, dir);
  let cur = root;
  // A registry at the root gives `nested` as '', one empty part: `cur` stays `root`, which already
  // resolved, so that single step passes. No special case for it: one would change nothing.
  for (const part of nested.split(sep)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // not created yet — genuinely absent
      throw e;
    }
    if (!st.isSymbolicLink()) continue; // an ordinary folder here: keep walking down
    try {
      statSync(cur); // follows the link: ENOENT means its target is gone
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      throw new Error(`refusing to ${what}: its folder, ${cur}, cannot be reached`);
    }
  }
}

/**
 * Where `path` REALLY is, where `root` REALLY is — every symlink between here and the filesystem
 * followed, on both — and whether the first lies strictly inside the second. The one place that
 * question is answered: `refuseEscapedFolder` below turns a "no" into a refusal for the CLI, and
 * `serveStatic` (engine/api/server.ts) into a 403, so the CLI that scans a page and the server that
 * serves it read one answer about where that page is, never two comparisons that drift apart.
 *
 * `path` itself may well not exist yet — the very first `sync` of a project, before its registry has
 * ever been written, or a page nobody has created that a reader asks for anyway — so this walks UP
 * from it, `lstatSync` component by component, to the DEEPEST ancestor that IS there: nothing further
 * down can have been substituted by a link if nothing further down exists yet. That ancestor, and
 * `root`, are each resolved with `realpathSync` — BOTH sides, not only the target: a project checked
 * out through its own symlinked path (`~/work -> /real/project`, say), or a site mounted through
 * one, would otherwise see the target's fully-resolved real path compared against `root` exactly as
 * the caller spelled it, unresolved, and refuse a project that never left itself at all. Whatever of
 * `path` is past the deepest existing ancestor is joined back onto that ancestor's real location
 * before the comparison, so a component that does not exist yet is judged by where its parent really
 * is, never silently accepted for having nothing concrete to check.
 *
 * Only `ENOENT` walks up a level; every other error (`EACCES`, …) propagates, exactly as
 * `refuseLink` and `refuseUnreachableFolder` already treat it — a real failure reading the
 * filesystem is not "not there yet". A `path` that is ITSELF a dangling link propagates too: `lstat`
 * finds the link, and `realpathSync` then fails `ENOENT` on what it points at. Nothing is at the far
 * end to be read, so there is nothing to call inside or outside; the caller answers it as it answers
 * any missing file — the server with a 404, the CLI with the error its own read would have raised.
 *
 * Lexical containment beyond this point is `insideRoot`'s (engine/core/paths.js): once both sides
 * are real paths, a symlink can no longer hide behind either of them, and comparing them is the same
 * string comparison `content.registry`'s own check already makes.
 */
export function realContainment(root: string, path: string): { inside: boolean; realRoot: string; realTarget: string } {
  const realRoot = realpathSync(root);
  let existing = path;
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const up = dirname(existing);
      if (up === existing) break; // reached the filesystem root without finding anything real
      existing = up;
    }
  }
  const realExisting = realpathSync(existing);
  const tail = relative(existing, path);
  const realTarget = tail ? join(realExisting, tail) : realExisting;
  return { inside: insideRoot(realRoot, realTarget), realRoot, realTarget };
}

/**
 * Refuses `path` when its REAL location is not strictly inside the project's REAL root
 * (holdrim#161, round 2) — `realContainment`'s answer above, as the CLI's refusal.
 *
 * `readConfig`'s own check on `content.registry` (engine/core/config.js) is lexical, on the STRING
 * as written, so it cannot see this: `content.registry: "mnt/approvals.json"`, with `mnt` a
 * committed, WORKING symlink to somewhere outside the project, reads as an ordinary nested path —
 * `refuseLink` only ever looks at `path`'s own last component, never an ancestor, and
 * `refuseUnreachableFolder` only ever refuses a DANGLING ancestor, never a working one that resolves
 * outside the root. All three checks pass, and `loadRegistry` and `saveRegistry` would read and
 * WRITE the owner's registry wherever `mnt` actually points.
 *
 * Takes a FOLDER just as well as a file: `sheetFiles` (engine/cli/pages.ts) calls this on each
 * `content.folders` entry before it ever `readdirSync`s one (holdrim#164), for the identical reason —
 * `readConfig`'s own check on that setting is lexical too — and again on each page file inside that
 * folder that is itself a link, which no check on the folder can see through.
 *
 * Called AFTER `refuseUnreachableFolder` wherever both run on the same path (`loadRegistry`): a
 * DANGLING ancestor must still get that check's own, more specific message — `realpathSync` on a
 * dangling symlink fails with a plain `ENOENT` naming the link itself, which would read here as a
 * confusing, unrelated error rather than the "its folder … cannot be reached" a caller already
 * knows to look for.
 */
export function refuseEscapedFolder(root: string, path: string, what: string): void {
  const { inside, realRoot, realTarget } = realContainment(root, path);
  if (!inside) {
    throw new Error(`refusing to ${what}: it resolves to ${realTarget}, outside the project root ${realRoot}`);
  }
}
