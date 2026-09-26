import { lstatSync } from 'node:fs';

/**
 * Filesystem guards shared by more than one CLI command, so a rule like "refuse a symlink" is
 * written once and read the same way everywhere it applies — never copied and left to drift the
 * way `saveRegistry` (engine/cli/validation.ts) once carried its own copy of `exportSite`'s check.
 */

/**
 * Refuses `path` when it is a link, wherever it points — `what` names the action for the message
 * (`export into ${out}`, `save ${path}`, `load ${path}`). `lstatSync`, never `existsSync`:
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
