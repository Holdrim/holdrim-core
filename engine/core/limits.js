/**
 * Everything crossing the boundary has a size and a shape.
 *
 * Why it exists: limits on text and snapshot alone leave block, fingerprint and data open. A POST
 * with 500 KB in each of those would be accepted and then served back to everyone, on every page
 * load — into a collection that, by design, nobody can delete from.
 * @module
 */

export const LIMITS = {
  text: 4000, snapshot: 20000, block: 64, fingerprint: 64,
  dataKeys: 12, dataKey: 40, dataValue: 200,
};

// Deliberately loose: it stops junk, it does not impose a taxonomy. Real page codes look like
// D01, T03a, C02, UC-01 and DNN — a "letter + two digits" regex would reject half of them.
//
// Exported so `engine/core/roles.js` can validate a grant's scope (docs/ROLES.md, "A grant can be
// limited to pages or to blocks") against the SAME shape an event's own `page` and `block` fields
// answer to — one grammar for "what is a page code", not two that could quietly drift apart.
export const PAGE_FORMAT = /^[A-Za-z][A-Za-z0-9-]{0,7}$/;
export const ID_FORMAT = /^[A-Za-z0-9._:-]+$/;
const COMMIT_FORMAT = /^[0-9a-f]{7,40}$/;

// Exported: `server.ts`'s `refusalOf` echoes a caller-controlled category back in a 400 body, and
// that value is not yet bounded by anything below when it gets there — an unbounded echo is how a
// 200 KB category once became a 200 KB error body. Truncating it here, the one place this codebase
// already truncates an unbounded value for an error message, keeps the two truncations from silently
// drifting to different lengths.
export const short = (v) => (String(v ?? '').length <= 20 ? String(v ?? '') : String(v).slice(0, 20) + '…');
const longerThan = (v, max) => String(v ?? '').length > max;

/**
 * The event arrives with the CORE's field names (`page`, `block`), which are the API's too.
 *
 * It returns a KEY and its parameters, never a sentence. The sentence is built at the edge, in the
 * language of whoever is reading — see `engine/core/i18n.js`. Returning prose in one language
 * would make "the code is English only" and "the reviewer reads in their own language" look like
 * contradictory rules. They are not: the sentence just has to live somewhere else.
 *
 * @param {{page?:string, text?:string|null, snapshot?:string|null, block?:string|null,
 *          fingerprint?:string|null, data?:Record<string,unknown>|null}} e
 * @param {string} examples  page codes to show in the error, from the project's config
 * @returns {{key: string, params?: Record<string, string|number>}|null} the first limit broken
 */
export function overLimit(e, examples = '') {
  if (!PAGE_FORMAT.test(e.page ?? '')) {
    // The examples come from the project (`content.pageExamples`), not hard-coded as one
    // project's taxonomy inside an engine message.
    // Two keys instead of stitching a word into a parameter. Building ` like ${examples}` here
    // would hard-code an English word in the engine, and it would show up in the middle of a
    // sentence in any other language.
    return examples
      ? { key: 'limits.page.invalid', params: { examples, got: short(e.page) } }
      : { key: 'limits.page.invalidNoExamples', params: { got: short(e.page) } };
  }
  if (longerThan(e.text, LIMITS.text)) return { key: 'limits.text.tooLong', params: { max: LIMITS.text } };
  if (longerThan(e.snapshot, LIMITS.snapshot)) return { key: 'limits.snapshot.tooLong', params: { max: LIMITS.snapshot } };
  if (longerThan(e.block, LIMITS.block)) return { key: 'limits.block.tooLong', params: { max: LIMITS.block } };
  if (longerThan(e.fingerprint, LIMITS.fingerprint)) return { key: 'limits.fingerprint.tooLong', params: { max: LIMITS.fingerprint } };
  if (e.block && !ID_FORMAT.test(e.block)) return { key: 'limits.block.badChars' };
  if (!e.data) return null;
  const keys = Object.keys(e.data);
  if (keys.length > LIMITS.dataKeys) return { key: 'limits.data.tooManyKeys', params: { max: LIMITS.dataKeys } };
  for (const k of keys) {
    if (longerThan(k, LIMITS.dataKey)) return { key: 'limits.data.keyTooLong', params: { key: short(k), max: LIMITS.dataKey } };
    // Scalars only. An object or array here becomes "[object Object]" — 15 characters — and slips
    // THROUGH the size limit carrying megabytes with it, which is exactly the giant POST this
    // module exists to stop. Nothing in the project writes anything else into `data`.
    const v = e.data[k];
    if (v !== null && typeof v === 'object') return { key: 'limits.data.notScalar', params: { key: short(k) } };
    if (longerThan(v, LIMITS.dataValue)) return { key: 'limits.data.valueTooLong', params: { key: short(k), max: LIMITS.dataValue } };
  }
  return null;
}

/** `applied` without a real commit records a hollow trail — and the trail is the whole point. */
export const validCommit = (data) => COMMIT_FORMAT.test(data?.commit ?? '');
