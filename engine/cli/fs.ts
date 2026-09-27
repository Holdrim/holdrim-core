import { lstatSync, statSync, realpathSync } from 'node:fs';
import { dirname, relative, join, resolve, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
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
 * A component that is a plain FILE, not a folder, makes the NEXT `lstatSync` in this walk fail with
 * `ENOTDIR`, not `ENOENT` — caught below and refused with the same "cannot be reached" message a
 * dangling symlink gets, because to whoever configured the folder the two look identical: nothing
 * usable sits where they pointed it. This used to be true only by accident, never by a check: a
 * plain file directly behind `path` itself made `refuseLink`, which every caller ran before this,
 * fail first with the same code — so this walk never saw one. That held for `loadRegistry`, which
 * still runs `refuseLink` on the registry's own path first and so still never reaches this case. It
 * stopped holding once `sheetFiles` (holdrim#164, engine/cli/pages.ts) started calling this function
 * directly, on a probe path inside each configured folder, without ever calling `refuseLink` on the
 * folder itself: a `content.folders` entry sitting behind an ordinary file (`docs` a file, `docs/
 * sheets` configured) reached `lstatSync` here first, and its raw `ENOTDIR` went straight to whoever
 * ran `holdrim sync`, unrefused and unexplained.
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
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // not created yet — genuinely absent
      if (code === 'ENOTDIR') throw new Error(`refusing to ${what}: its folder, ${cur}, cannot be reached`);
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
 * question is answered: `refuseEscapedFolder` below turns a "no" into a refusal for the CLI,
 * `serveStatic` (engine/api/server.ts) into the 404 of a file that is not there, `loadLogo`
 * (engine/api/theme.ts) into a logo ignored with a warning, and `refuseServedStore` below into a
 * server that does not start, so the CLI that scans a page, the server that serves it, the theme
 * that embeds a logo and the check on where a store lives read one answer about where a file is,
 * never comparisons that drift apart.
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
 * Called AFTER `refuseUnreachableFolder` wherever both run on the same path (`loadRegistry`, and
 * `sheetFiles` on each configured folder): a DANGLING ancestor must still get that check's own, more
 * specific message — `realpathSync` on a dangling symlink fails with a plain `ENOENT` naming the link
 * itself, which would read here as a confusing, unrelated error rather than the "its folder … cannot
 * be reached" a caller already knows to look for.
 */
export function refuseEscapedFolder(root: string, path: string, what: string): void {
  const { inside, realRoot, realTarget } = realContainment(root, path);
  if (!inside) {
    throw new Error(`refusing to ${what}: it resolves to ${realTarget}, outside the project root ${realRoot}`);
  }
}

/**
 * Refuses a store the server writes — a SQLite `file`, named by `what` in the message — when the
 * site would serve it: when the REAL location of the FOLDER the file sits in is inside the site's
 * REAL root, or is that root itself, or when the file is a link whose real location is. Every file
 * whose real location is inside the site is served to whoever is signed in (`serveStatic`,
 * engine/api/server.ts), so a store there is served along with the pages.
 *
 * The folder, not only the file: SQLite keeps `-wal` and `-shm` files beside the database, and
 * creates them after this check runs, so a check on the database's own name alone would pass a
 * store whose siblings the site then serves. "Or is that root": `realContainment`'s answer is
 * STRICTLY inside, which is right for a page and wrong here — a folder equal to the site root holds
 * the store's files directly under the site. The file too, by where it REALLY is: a database file
 * that is a link is written wherever the link leads, whatever folder the link itself sits in.
 *
 * `realContainment` answers where each side REALLY is — a store folder reached through a link that
 * lands inside the site is refused, and one that does not exist yet is judged by its deepest existing
 * ancestor — so this and `serveStatic` read one answer about what the site contains, never two
 * comparisons that drift apart. A relative `file` is resolved against the working directory, as
 * SQLite resolves it. A site that cannot be resolved — one that does not exist yet, say — is refused
 * too, never waved through: nothing can say whether the store is inside it, and the store's own
 * folder, created first, could become part of it.
 */
export function refuseServedStore(site: string, file: string, what: string): void {
  const absolute = resolve(file);
  for (const path of [dirname(absolute), absolute]) {
    let where;
    try {
      where = realContainment(site, path);
    } catch (e) {
      throw new Error(`${what}, ${file}, cannot be checked against the site, ${site}: ${(e as Error).message}`);
    }
    const { inside, realRoot, realTarget } = where;
    if (inside || relative(realRoot, realTarget) === '') {
      throw new Error(`${what}, ${file}, would be served by the site: ${realTarget} is in the site, ${realRoot}`);
    }
  }
}

/**
 * The folder a SQLite store's files REALLY live in: the real location of the database file's own
 * folder, every link followed. SQLite follows a database file that is a link and keeps its `-wal`
 * and `-shm` beside the real file, so this one folder holds all three. Read by the server once, at
 * boot, after the store is opened — the file exists by then — and handed to `insideStoreFolder` on
 * every request.
 */
export function realStoreFolder(file: string): string {
  return dirname(realpathSync(file));
}

/**
 * Whether `realTarget`, a path already resolved to its real location, lies inside one of the
 * `storeFolders` (`realStoreFolder`'s answers). `serveStatic` (engine/api/server.ts) answers "not
 * there" for such a file, so the server never serves a store it writes — whatever the site's root
 * points at by then. `refuseServedStore` holds the same guarantee once, at boot; the site root is
 * resolved again on every request, so this holds it on every request too. A comparison against at
 * most one folder per file-backed store, with `insideRoot`, the same rule as everywhere else.
 */
export function insideStoreFolder(storeFolders: readonly string[], realTarget: string): boolean {
  return storeFolders.some((folder) => insideRoot(folder, realTarget));
}

/**
 * Where `holdrim index` (`rebuildIndex`, engine/cli/validation.ts) keeps its SQLite database when
 * neither `--db` nor `HOLDRIM_EVENTS_PATH` names one: a per-user cache, never inside the project.
 *
 * It used to default to `<root>/data/events.db` — generated, and sitting inside the very folder a
 * documentation project usually serves and commits (holdrim#170 already refuses to let the SERVER
 * serve its own stores; the index is not a server store, but the same reasoning applies: a rebuilt
 * snapshot has no business inside content people commit and a site publishes). One default,
 * defined here and nowhere else, so the CLI's `--help` text, `rebuildIndex` and anything that
 * later needs to find the same file all agree without a second copy of this rule to drift from it.
 *
 * `XDG_CACHE_HOME`, falling back to `~/.cache` — this is a rebuildable cache, exactly what that
 * variable is for, never `~/.local/share` or a dotfile at the project root, which would put a
 * generated file back where a project's tooling (`.gitignore`, a linter, a backup job) has to know
 * to skip it.
 *
 * The folder name mixes the project's own basename in for a human skimming the cache directory —
 * `~/.cache/holdrim/` otherwise fills with nothing but hashes — with the first 12 hex characters of
 * a sha256 of the project's REAL, symlink-resolved path, so that two projects that happen to share
 * a folder name (two clones both called `docs`) never share an index, and one project reached
 * through more than one symlink still lands on the same cache entry instead of a fresh, empty one
 * each time. `realpathSync`, not the path as given: a lexical hash would let `~/work/docs` and its
 * real target `/srv/docs` collide with an unrelated `~/other/docs -> /srv/other-docs` only by
 * coincidence of spelling, and would treat the same project as two different ones the moment it is
 * reached through a different link.
 *
 * ⚠️ `HOLDRIM_EVENTS_PATH` is also what the SERVER reads for its own, unrelated events store
 * (`engine/api/store-sqlite.ts`) — one variable naming two different files for two different
 * commands is confusing enough to be worth a report, but changing it is its own decision, not a
 * side effect of moving this default; `rebuildIndex` keeps reading it exactly as before.
 */
export function defaultIndexPath(root: string): string {
  const real = realpathSync(root);
  const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 12);
  return join(cacheHome, 'holdrim', `${basename(real)}-${hash}`, 'index.db');
}
