import { lstatSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * Refuses `path` when the folder that would hold it cannot be reached — meant for a caller that
 * already found NOTHING under `path`'s own exact name (`lstatSync` on it came back ENOENT) and is
 * about to read that as "never written". That reading is right when the folder is genuinely there,
 * empty of this name; it is wrong when the folder itself does not resolve, which gives the very same
 * ENOENT on `path` — a parent that is a DANGLING symlink (`docs -> /mnt/shared`, unmounted) looks,
 * from `path` alone, exactly like a project that has simply never run sync (holdrim#155).
 *
 * `statSync`, not `lstatSync`: it follows links, so a WORKING symlinked folder — content mounted in
 * from elsewhere, a legitimate deployment shape — passes here, where `refuseLink` above would refuse
 * it for a different reason entirely if pointed at it. And because resolving a path walks every one
 * of its components, `statSync(dirname(path))` already fails on an unreachable ANCESTOR two levels
 * up exactly as it would on one immediately above `path` — there is no need to walk the ancestors one
 * at a time to cover them.
 *
 * A project that has genuinely never run sync keeps working: every registry in this engine sits at
 * its OWN project root (`content.registry` in `holdrim.json`, e.g. `approvals.json`, never nested
 * under a content folder that might not exist yet), and that root already resolved — it is where
 * `holdrim.json` itself was just read from — before this is ever called.
 *
 * No check that `dir` actually IS a directory once `statSync` succeeds: a caller that reaches this
 * already called `lstatSync` on the full `path` and got exactly `ENOENT` (that is the contract —
 * `loadRegistry` runs this only once `existsSync(path)` came back false) — and an ancestor that is a
 * plain FILE, not a folder, makes THAT lstat fail with `ENOTDIR`, not `ENOENT`, so it is caught and
 * propagated by `refuseLink` two lines above this call, never reaching here at all. Adding a second
 * check for a case the caller's own error already rules out would be a branch nothing can ever drive.
 */
export function refuseUnreachableFolder(path: string, what: string): void {
  const dir = dirname(path);
  try {
    statSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    throw new Error(`refusing to ${what}: its folder, ${dir}, cannot be reached`);
  }
}
