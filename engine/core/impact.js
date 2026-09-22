/**
 * Where a change lands: silent, on the agent's desk, or in front of a person.
 *
 * Git merges most branches without asking anybody. Not because it understands the code, but
 * because it has a cheap, sound test for "these two changes cannot touch each other". Documentation
 * has no such test — meaning is not lines — so instead of one test there is a funnel, and this
 * module is the deterministic stage of it: kind against kind, plus what the edit itself says.
 *
 * The measure of success is NOT how much impact it finds. It is how little of it reaches a person,
 * while nothing real gets through. Every flag that turns out to be noise is a step towards somebody
 * switching the whole check off, and then the lock is worth nothing.
 *
 * ⚠️ Nothing here decides whether a block is still TRUE. It decides who has to look. The judgement
 * belongs to the agent (which has to show its reasoning) and to the person (who owns the ✓).
 * @module
 */

import { normalize } from './fingerprint.js';
import { KINDS } from './kinds.js';

/** @typedef {'silent'|'agent'|'person'} Severity */

/**
 * Ordered from quietest to loudest. The order is the point: raising a severity is moving one step
 * to the right in this array, and nothing in this module ever moves left.
 */
export const SEVERITIES = /** @type {Severity[]} */ (['silent', 'agent', 'person']);

/**
 * A kind that nobody declared — a typo in `data-kind`, or a kind from a newer version of the
 * engine — is weighed as the middle of the road: `substantive` on the way out, `normal` on the way
 * in. Treating it as cosmetic would let a real change through in silence; treating it as binding
 * would put every typo in front of a person. Middle is the only honest answer to "we do not know".
 */
const UNKNOWN_GRAVITY = 'substantive';
const UNKNOWN_SENSITIVITY = 'normal';

/**
 * The matrix, from `docs/IMPACT.md`. Row: the gravity of what CHANGED. Column: the sensitivity of
 * what DEPENDS on it.
 * @type {Record<string, Record<string, Severity>>}
 */
const MATRIX = {
  cosmetic: { robust: 'silent', normal: 'silent', brittle: 'agent' },
  substantive: { robust: 'silent', normal: 'agent', brittle: 'person' },
  binding: { robust: 'agent', normal: 'person', brittle: 'person' },
};

/** Every number in the text, as they appear — "24" and "1,5" and "-3". */
const NUMBERS = /-?\d+(?:[.,]\d+)?/g;

/**
 * ⚠️ This list is ENGLISH ONLY, and that is a known limitation, not an oversight. Documentation
 * written in Portuguese, Spanish or German loses this signal entirely: "não", "nunca" and "nicht"
 * are not here. Adding them properly means per-language lists tied to the page's language, and
 * that belongs with `engine/core/i18n.js` — half a list would be worse than none, because it
 * would read as if negation were covered.
 *
 * "no longer" comes first so it matches as one unit instead of being counted twice, once as
 * itself and once as the "no" inside it.
 */
const NEGATIONS = /\b(?:no longer|cannot|without|never|none|not|no)\b/gi;

/**
 * Signals read from the edit itself, not from the kinds. They may only RAISE severity, never lower
 * it — see `severityOf` for the one exception and why it is not one.
 *
 * Kind against kind is not the whole story: the same block can be edited cosmetically or
 * substantively, and these three are cheap, deterministic and worth more than they cost.
 *
 * @param {string} before  the text as it was
 * @param {string} after   the text as it is
 * @returns {{ whitespaceOnly: boolean, numberChanged: boolean, negationChanged: boolean }}
 */
export function signalsOf(before, after) {
  // `normalize` comes from the fingerprint and is NOT reimplemented here. If the two ever disagreed
  // about what counts as a change, a block could be silent to the impact engine and yellow to the
  // traffic light at the same time, and nobody would be able to say which one was lying.
  const whitespaceOnly = normalize(before) === normalize(after);

  return {
    whitespaceOnly,
    numberChanged: !sameMultiset(numbersIn(before), numbersIn(after)),
    negationChanged: count(before, NEGATIONS) !== count(after, NEGATIONS),
  };
}

/**
 * Where a change of `sourceKind` lands when a block of `dependentKind` depends on it.
 *
 * @param {string} sourceKind     the kind of the block that changed
 * @param {string} dependentKind  the kind of the block that leans on it
 * @param {{ whitespaceOnly?: boolean, numberChanged?: boolean, negationChanged?: boolean }} signals
 * @returns {Severity}
 */
export function severityOf(sourceKind, dependentKind, signals = {}) {
  const gravity = KINDS[sourceKind]?.gravity ?? UNKNOWN_GRAVITY;
  const sensitivity = KINDS[dependentKind]?.sensitivity ?? UNKNOWN_SENSITIVITY;
  const base = MATRIX[gravity]?.[sensitivity] ?? MATRIX[UNKNOWN_GRAVITY][UNKNOWN_SENSITIVITY];

  // This is the one thing here that LOWERS, and it contradicts the "only raise" rule on purpose,
  // so read the reason before deleting it: `whitespaceOnly` does not mean "we judged this change
  // to be small". It means the visible text did not change at all — the same normalisation the
  // fingerprint uses says the two strings are the same string. It is a fact about the bytes, not
  // an opinion about the meaning, and an opinion is the only thing that would be dangerous to act
  // on here.
  if (signals.whitespaceOnly) return 'silent';

  // A number moved, or a negation appeared or vanished. Neither is ever cosmetic: "24 hours" →
  // "48 hours" is a rule change in any kind of block, and so is "the alert fires" → "the alert
  // does not fire". One step louder, and never quieter — a deterministic rule that can quieten a
  // flag is a rule that loosens the lock silently, and the day it is wrong nobody finds out.
  if (signals.numberChanged || signals.negationChanged) return raise(base);
  return base;
}

/**
 * One step louder, stopping at `person`. There is nothing above a person looking at it.
 * @param {Severity} severity
 * @returns {Severity}
 */
export function raise(severity) {
  const at = SEVERITIES.indexOf(severity);
  return SEVERITIES[Math.min(at + 1, SEVERITIES.length - 1)];
}

/**
 * The same numbers in a different order are the same numbers: a sentence rewritten as "48 hours,
 * not 24" did not change any value, and flagging it would be exactly the kind of noise that gets
 * the check switched off.
 * @param {string[]} a
 * @param {string[]} b
 */
function sameMultiset(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function numbersIn(text) {
  return String(text ?? '').match(NUMBERS) ?? [];
}

/**
 * @param {string} text
 * @param {RegExp} pattern  global, and therefore stateful — matchAll needs a fresh walk each time
 */
function count(text, pattern) {
  return (String(text ?? '').match(pattern) ?? []).length;
}
