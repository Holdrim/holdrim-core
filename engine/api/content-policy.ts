/**
 * What a file from the documentation may run in the reader's browser: the panel, and nothing else.
 *
 * The documentation is served from the same origin as the API, so a script in a page runs with the
 * reader's session and passes every check a write goes through — the origin is this server's, the
 * body is JSON. For the owner, that is an approval in their name, which `holdrim sync` turns into a
 * lock. And content is written by people and by agents: an agent can be steered by text hidden in
 * the very documents it edits, so whatever a page may run is whatever that text can make it run.
 *
 * So every page gets a nonce, new on every response, and the server writes it into the panel's own
 * tag and no other. An inline script, an `onerror=`, a `javascript:` link or a script FILE somebody
 * added to the site carry no nonce, and the browser refuses them. A file that is not a page gets no
 * script at all: an SVG opened on its own is a document too, and would otherwise be the way in.
 *
 * The price is that a page cannot bring scripts of its own. That is the trade: a page that could
 * would be a page that could approve.
 *
 * @module
 */

const PANEL = '/engine/web/panel-react.js';
const SCRIPT_TAG = /<script\b([^>]*)>/gi;
/** One attribute of a tag: its name, and its value however it is quoted. */
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/**
 * Whether a `<script>` tag's attributes name exactly one `src`, and it is exactly the panel.
 *
 * Exactly the panel: a suffix would let `/engine/web/panel-react.js/../../x.js` borrow the nonce
 * for a file the site controls. Exactly one: a tag naming the panel AND another file runs the first
 * `src` it was given, which is the other one — a browser that follows the HTML standard refuses a
 * nonce on a tag with a repeated attribute by itself, Chrome among them, and this does not rely on
 * it. Attributes are read as attributes, so ` src=` inside another attribute's value is text.
 */
function isPanelTag(attributes: string): boolean {
  const sources = [...attributes.matchAll(ATTRIBUTE)]
    .filter(([, name]) => name!.toLowerCase() === 'src')
    .map(([, , double, single, bare]) => double ?? single ?? bare);
  return sources.length === 1 && sources[0] === PANEL;
}

/**
 * The page, with this response's nonce on the panel's tag and not a byte changed elsewhere.
 *
 * Read as latin1, which maps each byte to one character and back: a page in any encoding — UTF-8,
 * or the Windows-1252 of a document pasted from a word processor — comes out as it went in. Read
 * as UTF-8, every byte that is not valid UTF-8 would be replaced, and the text silently mangled.
 */
export function withPanelNonce(page: Buffer, nonce: string): Buffer {
  const text = page.toString('latin1').replace(SCRIPT_TAG, (tag, attributes: string) =>
    isPanelTag(attributes) ? `<script nonce="${nonce}"${attributes}>` : tag);
  return Buffer.from(text, 'latin1');
}

/**
 * The policy of a page. `base-uri 'none'`, because a `<base>` pointing elsewhere would move the
 * panel's own tag — nonce and all — to a script on another host. No `object-src`: embedding a file
 * of this site is already refused by its `frame-ancestors`, and a plugin from another origin runs
 * there, without this site's session.
 */
export function pagePolicy(nonce: string): string {
  return [`script-src 'nonce-${nonce}'`, "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
}

/** The policy of every other file of the site: nothing runs. */
export const FILE_POLICY = "script-src 'none'; frame-ancestors 'none'";
