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
export const eventsOfPage = (page) => call(`/events?page=${encodeURIComponent(page)}`);
export const record = (event) => call('/events', event);
export const fingerprintsOf = (ids) => call(`/fingerprints?ids=${ids.map(encodeURIComponent).join(',')}`);

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
