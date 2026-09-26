import { cpSync, mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

/**
 * The documentation as plain static files, for publishing it read-only: `holdrim export <folder>`.
 *
 * Reviewing needs the engine — a session, the events, the panel. Reading does not, and some
 * documentation is meant to be read by anyone: an open-source project's own site, a public API's
 * contract. Serving that from the engine would mean opening the session guard, and a guard with an
 * exception is a guard someone widens later. So publishing is a copy, made on purpose, of what the
 * reader needs and nothing else.
 *
 * ## What goes out
 *
 * Only files a browser renders, by extension (`PUBLISHED`), walked from the project root. Anything
 * else stays home, whatever it is called: `holdrim.json` and the approvals registry are JSON, a
 * `.env` has no extension on the list, a database is a `.db`. An allow-list and not a deny-list,
 * because a deny-list is complete only until someone adds a file nobody thought of — and on a
 * public host that someone finds out last.
 *
 * ## What changes on the way
 *
 * The panel's tags come out of every page: on a static host nothing answers at `/engine/`, and a
 * page that asks for it would fill every reader's console with errors about a tool they will never
 * use. Nothing else is touched — the text a reader sees is the text that was approved.
 */

/** What a browser renders. Scripts are not on it: a published page runs nothing of ours. */
export const PUBLISHED = new Set(['.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.ico', '.woff', '.woff2']);

/** Folders never walked: they hold tooling or data, never something a reader opens. */
const SKIPPED = new Set(['node_modules', '.git', 'data']);

/**
 * Refuses `path` when it is a link, wherever it points — `what` names the action for the message
 * (`export into ${out}`, `save ${path}`). `lstatSync`, never `existsSync`: `existsSync` follows the
 * link, so a DANGLING one (its target gone — an unmounted shared volume, say) reads as "nothing
 * here" and slips through. Caught here instead of by whichever write follows, because a rename or a
 * write through a link never touches the link itself — it replaces or fills whatever the link points
 * at, silently, while the link's own name goes on meaning something else to the next reader. Shared
 * with `saveRegistry` (engine/cli/validation.ts), which used to carry its own copy of exactly this
 * check, gated on `existsSync` and so blind to the same dangling case.
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

/** A page without the engine's tags: the panel's scripts and stylesheet, and only those. */
export function withoutPanel(html: string): string {
  return html
    .replace(/[ \t]*<script\b[^>]*\bsrc="\/engine\/[^"]*"[^>]*><\/script>[ \t]*\r?\n?/g, '')
    .replace(/[ \t]*<link\b[^>]*\bhref="\/engine\/[^"]*"[^>]*>[ \t]*\r?\n?/g, '');
}

/**
 * Copies what a reader needs into `out`, which has to be new or empty. Nothing is ever deleted to
 * make room: a mistyped path must cost a refusal, not somebody's folder.
 *
 * @returns how many pages and other files were written, for the command to report
 */
export function exportSite(root: string, out: string): { pages: number; files: number } {
  // A link where the output goes would take every file somewhere else, wherever it points; the
  // emptiness check below reads through it and would pass. Refused like a link inside the project.
  refuseLink(out, `export into ${out}`);
  if (existsSync(out) && readdirSync(out).length) {
    throw new Error(`refusing to export into ${out}: it is not empty, and nothing is deleted to make room`);
  }
  mkdirSync(out, { recursive: true });
  let pages = 0, files = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || SKIPPED.has(name)) continue;
      const path = join(dir, name);
      // The export itself, when it was written inside the project: never copied into itself.
      if (resolve(path) === resolve(out)) continue;
      // `lstat`, not `stat`: a link is not followed. One pointing out of the project — at a home
      // folder, at `/etc` — would otherwise publish whatever it reaches that has a page's extension.
      const kind = lstatSync(path);
      if (kind.isSymbolicLink()) continue;
      if (kind.isDirectory()) { walk(path); continue; }
      const ext = extname(name).toLowerCase();
      if (!PUBLISHED.has(ext)) continue;
      const target = join(out, relative(root, path));
      mkdirSync(join(target, '..'), { recursive: true });
      if (ext === '.html') {
        writeFileSync(target, withoutPanel(readFileSync(path, 'utf8')));
        pages++;
      } else {
        cpSync(path, target);
        files++;
      }
    }
  };
  walk(root);
  return { pages, files };
}
