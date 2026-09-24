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

/**
 * The one error every store gives for an id with no row, so a caller — and a test — matches one
 * text whichever store answered.
 */
export function noPerson(id: string): Error {
  return new Error(`no person ${id}`);
}

/**
 * What an event's `author` means, for every reader of events: the two server stores and the CLI's
 * two readers of the cloud and of the events file (docs/PRIVACY.md, section 1). Each of them hands
 * over the people table as a map of id to e-mail, and this is the one place the rule is written:
 *
 * - an id whose row still holds an address reads as that address, so every comparison with a
 *   person downstream — the owner's ✓, an admin's request, "your own request" — is the comparison
 *   it was when the event held the address itself;
 * - an id whose row was emptied reads as the id: stable, and never an address, so a forgotten
 *   person's ✓ can match nobody's e-mail — the owner's least of all;
 * - anything with no row is returned as it is, which is how an event written before authors were
 *   ids goes on reading as the e-mail it holds.
 *
 * Resolved when the events are read, and not at the API's edge: the server's own readers of the
 * list (the lock on a ✓, a request's starting state, the home, the "own request" check) and the
 * CLI's (`sync`, `list`, `apply`) all compare authors with addresses, and a raw id reaching any of
 * them would fail every comparison quietly — no ✓ would lock, no admin's request would start
 * triaged. Read here, no reader ever sees an id unless the person behind it is gone.
 */
export function authorOf(author: string, people: ReadonlyMap<string, string | null>): string {
  return people.get(author) ?? author;
}

/** `authorOf` over a list, for the readers that hold a list. */
export function withAuthors<E extends { author: string }>(events: E[], people: ReadonlyMap<string, string | null>): E[] {
  return events.map((e) => ({ ...e, author: authorOf(e.author, people) }));
}
