/**
 * The fingerprint of a block: SHA-256 of the visible text, 16 characters.
 *
 * THIS IS THE ONLY IMPLEMENTATION. It runs in the browser and on the server, with no build step.
 *
 * Why that matters more than it looks: the fingerprint decides whether a human approval still
 * holds. Until 2026-09-18 it existed THREE times, in three languages, and the three only agreed by
 * luck — one of them did not strip the review UI, so merely saving a marker into the HTML would
 * have turned every approval into "an earlier version of the text", silently, with nobody able to
 * say why.
 *
 * A rule like this is not kept identical in three places by discipline. It is kept by being one.
 *
 * @module
 */

/** How many characters of the hash make up the fingerprint. Short enough to fit on screen, long
 *  enough not to collide by accident across a few hundred blocks. */
export const SIZE = 16;

/**
 * Normalises text the way the fingerprint expects: whitespace collapsed, ends trimmed.
 *
 * Reformatting a paragraph — rewrapping lines, indenting differently — must NOT invalidate a human
 * approval. Only the words count.
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * Fingerprint of already-extracted text.
 * @param {string} text  the visible text of the block
 * @returns {Promise<string>} 16 hexadecimal characters
 */
export async function fingerprintOfText(text) {
  const bytes = new TextEncoder().encode(normalize(text));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, SIZE);
}

/**
 * Fingerprint of a DOM element. Browser only — the server uses `fingerprintOfText`.
 *
 * The review UI (buttons, panel) is marked with `data-review-ui` and does NOT count: it is drawn
 * on top of the document, and would change the fingerprint of every block on every release of the
 * site.
 *
 * @param {Element} el
 * @returns {Promise<string>}
 */
export async function fingerprintOfElement(el) {
  return fingerprintOfText(textOfElement(el));
}

/**
 * The visible text of an element, exactly as the fingerprint sees it.
 *
 * Also used for the "snapshot" — the block's text at the instant someone approved it or asked for
 * a change. The snapshot has to be the SAME text the fingerprint considered, otherwise the history
 * shows one thing while the fingerprint talks about another.
 *
 * @param {Element} el
 * @returns {string}
 */
export function textOfElement(el) {
  const copy = /** @type {Element} */ (el.cloneNode(true));
  copy.querySelectorAll('[data-review-ui]').forEach((x) => x.remove());
  return copy.textContent || '';
}
