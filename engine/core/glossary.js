/**
 * The method's own vocabulary — the concepts `docs/GLOSSARY.md` names, never a project's own
 * domain terms, which nothing here reads or could: the engine ships to any documentation, and does
 * not know what any of it is about.
 *
 * `holdrim propose-deps` (`engine/cli/propose.ts`) uses this list to find two blocks that talk
 * about the same concept without naming each other as a `data-depends` — the shape a missing
 * dependency takes before anybody notices it.
 *
 * Hand-copied from the glossary's "Concept" columns, not read off the file at run time: the
 * Dockerfile copies `engine`, `examples` and `holdrim.json` into the image, and nothing else — a
 * server or a CLI running from that image would find no `docs/` folder to read. `docs.test.js`
 * parses `docs/GLOSSARY.md` itself and fails the moment this list and the doc disagree, which is
 * the one place the two are compared, so nobody has to remember to keep them equal by hand every
 * time a term is added there.
 * @module
 */

/**
 * Every concept `docs/GLOSSARY.md` names in its tables, sorted so a diff adding one term touches
 * one line, never a reordering of the rest.
 * @type {readonly string[]}
 */
export const GLOSSARY_TERMS = [
  'admin', 'agent queue', 'agent token', 'block', 'brief', 'capability', 'config', 'demand',
  'dependency', 'disabled', 'doubt', 'event', 'feature toggle', 'fingerprint', 'founder', 'grant',
  'i18n', 'index', 'kind', 'limits', 'lock', 'lock-holder', 'member', 'normalize', 'owner',
  'project role', 'proof', 'registry', 'request', 'sheet', 'snapshot', 'source', 'store',
  'supplement', 'theme', 'triage', 'user store', 'validation',
];

/**
 * The terms from `GLOSSARY_TERMS` that show up as a whole word, or a whole phrase for the
 * multi-word ones, in `text` — case-insensitively, so "Approval" and "approval" both count, but
 * "unblock" does not count for "block". Returned in `GLOSSARY_TERMS`' own order, which is already
 * sorted, so two blocks that share more than one term always compare their shared terms the same
 * way regardless of which one text happened to be scanned first.
 *
 * No stemming, no plural handling: a match that guessed past the literal word would stop being
 * something a reader could predict from the term list alone, and this feeds a PROPOSAL, not a rule
 * — a term that only shows up as a plural is one `holdrim propose-deps` simply misses, the same way
 * any literal search draws its line at the word as written.
 * @param {string} text
 * @returns {string[]}
 */
export function termsIn(text) {
  return GLOSSARY_TERMS.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  });
}
