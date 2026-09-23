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

/**
 * A `<script` tag whose one `src` is exactly the panel. Exactly: a suffix would let
 * `/engine/web/panel-react.js/../../x.js` borrow the nonce for a file the site controls. And one:
 * a tag naming the panel AND another file runs the first `src` it was given, which is the other one.
 * A browser that follows the HTML standard refuses a nonce on a tag with a repeated attribute by
 * itself — Chrome does, which is why only the unit test feels this half — and this does not rely on it.
 */
const PANEL_TAG = /<script\b(?![^>]*\ssrc\s*=[^>]*\ssrc\s*=)(?=[^>]*\ssrc\s*=\s*(["'])\/engine\/web\/panel-react\.js\1)/gi;

/** The page, with this response's nonce on the panel's tag. */
export function withPanelNonce(html: string, nonce: string): string {
  return html.replace(PANEL_TAG, `<script nonce="${nonce}"`);
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
