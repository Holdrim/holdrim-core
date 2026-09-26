/**
 * The review API client. The only part of the panel that knows HTTP.
 *
 * Everything here belongs to the ENGINE: the routes do not change from project to project. What
 * changes is the content the pages carry, and the panel knows nothing about that.
 */

const API = '/api';

async function call(path, body) {
  const r = await fetch(API + path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!r.ok) {
    // The server explains a refusal in `error`, in the reader's language. Throwing only the status
    // and the path would show the person "403" where the server had said why.
    const said = await r.json().then((b) => b?.error, () => null);
    throw new Error(said || `${r.status} on ${path}`);
  }
  return r.json();
}

export const whoAmI = () => call('/me');

/**
 * What the reader may do on `page` and on each block in `ids` — the server answers per page and per
 * block, since a grant may be limited to some (docs/ROLES.md, section 2). The panel names the blocks
 * it draws, because the page in the browser is what the buttons go on: the server's own reading of
 * the site need not include it. In a body, never a query string: a long page's ids would pass the
 * header limit, and a refused answer switches the whole panel off.
 */
export const hereOn = (page, ids) => call('/here', { page, blocks: ids });
export const eventsOfPage = (page) => call(`/events?page=${encodeURIComponent(page)}`);
export const record = (event) => call('/events', event);
export const fingerprintsOf = (ids) => call(`/fingerprints?ids=${ids.map(encodeURIComponent).join(',')}`);

/**
 * The tampered texts nobody has acknowledged yet, and whether this reader may acknowledge one —
 * both decided by the server (issue #107); the panel only draws them.
 */
export const tamperedFindings = () => call('/tampered');
export const acknowledgeFinding = (finding) => call('/tampered/acknowledge', { finding });

/**
 * Every block that depends on this one, directly or through another — the panel's "impact radius"
 * (docs/IMPACT.md). Asked of the server, not computed here: the browser only has the DOM of the
 * page it is on, and a dependent three pages away is invisible to it otherwise.
 */
export const impactRadiusOf = (id) => call(`/impact-radius?id=${encodeURIComponent(id)}`).then((r) => r.ids);

/**
 * The documentation graph (#38): every block as a node, every `data-depends` as an edge — the same
 * `graphOf` `holdrim graph` prints (engine/cli/graph.ts), read from the server rather than
 * recomputed here. The home screen has no DOM of the blocks it did not render — unlike a doc page,
 * it lists pages, not their content — so there is nothing on the page for a browser-side walk to
 * start from even if one were wanted.
 */
export const fetchGraph = () => call('/graph');

/**
 * The core, loaded once.
 *
 * ABSOLUTE path, not relative: this import stays out of the bundle (it is the core, which the
 * server serves), and the browser resolves it against the bundle's URL — not against this file's
 * folder. With a relative path the browser would ask for /core/fingerprint.js and get a silent 404.
 */
let core = null;
const theCore = () => (core ??= import('/engine/core/fingerprint.js'));

/**
 * The block's fingerprint, computed by the SAME code the server uses — not by a copy.
 *
 * This is what makes an approval mean anything: the text the browser saw and the text the server
 * stored are the same, because the function is the same one.
 */
export async function fingerprintOf(el) {
  return (await theCore()).fingerprintOfElement(el);
}

/**
 * The text the fingerprint looks at, for the snapshot that travels with each event. From the core
 * as well, and not a copy of "strip the review UI, collapse the spaces" kept here: that is the one
 * rule that must never have two implementations.
 */
export async function textOf(el) {
  return (await theCore()).textOfElement(el);
}
