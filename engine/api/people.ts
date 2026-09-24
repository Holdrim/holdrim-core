import { randomBytes } from 'node:crypto';
import { normalizeEmail } from './users.ts';

/**
 * What every store's people table agrees on: the shape of an id, how one is made, and what "the
 * same e-mail" means. The table itself lives in each event store, next to the events — why there,
 * and why an id and an e-mail and nothing else, is docs/PRIVACY.md, section 1.
 */

/** `p_` and 24 lowercase hex characters: 96 random bits, no collision in any real deployment. */
export const PERSON_ID = /^p_[0-9a-f]{24}$/;

/**
 * Random, from the operating system's generator — never derived from the e-mail. A hash of the
 * address could be recomputed from a guess after the row was emptied, and the person would be back;
 * docs/PRIVACY.md, "Why random, and not a hash of the e-mail".
 */
export function newPersonId(): string {
  return `p_${randomBytes(12).toString('hex')}`;
}

/**
 * The e-mail as the people table keys it — the same rule the accounts use, so a person who signs in
 * as `Ana@Example.org` and one approved as `ana@example.org` are one person.
 */
export function personEmail(email: string): string {
  const e = normalizeEmail(String(email ?? ''));
  if (!e) throw new Error('a person needs an e-mail');
  return e;
}

/** The message every store refuses a re-pointed row with, so a caller sees one reason. */
export const ONLY_LOSES = 'a person keeps their id and can only lose their e-mail: a new address is a new person';
