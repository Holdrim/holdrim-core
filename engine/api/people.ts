import { randomBytes } from 'node:crypto';
import { normalizeEmail } from './users.ts';
import { log } from './log.ts';
import type { EventStore, Event, NewEvent, PeopleTable } from './types.ts';

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

/**
 * How the people table is laid out in Firestore, for the two writers that reach it: the server's
 * store (engine/api/store-firestore.ts) and the CLI's direct path over REST (engine/cli/remote.ts).
 * `rows/{id}` holds `{ email }`, and `pointers/{pointerId(email)}` holds `{ id }` for an address still
 * held. Written once because the two must agree to the character: a person the CLI made under a
 * pointer the server spells another way is a second person for one address.
 */
export const FIRESTORE_PEOPLE = {
  rows: 'people',
  pointers: 'people_by_email',
  email: 'email',
  id: 'id',
  /** The pointer's document id. Encoded, since a raw `/` in an address would name a sub-collection. */
  pointerId: (email: string): string => encodeURIComponent(email),
} as const;

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

/**
 * `authorOf` over a list, for the readers that hold a list — and the one place `authorId`
 * (engine/api/types.ts) is set: the value `.author` held before this function resolved it, which is
 * exactly what `people.show: "id"` (docs/ROLES.md, "How a person appears") needs to show a person
 * without ever reading the address the setting was asked to hide. Captured before the overwrite,
 * never after: reading `e.author` back off the RETURNED object would already be the resolved address.
 */
export function withAuthors<E extends { author: string }>(
  events: E[], people: ReadonlyMap<string, string | null>,
): (E & { authorId: string })[] {
  return events.map((e) => ({ ...e, authorId: e.author, author: authorOf(e.author, people) }));
}

/**
 * An id for a log line about an account action, and only for that: read-only, and unable to fail
 * the response it logs. By the time any of these log lines runs, the real work already happened —
 * the account was created or changed, the one-time password already handed back in the body — so
 * a lookup failing here must lose nothing but the id in the log, never that response. `personOf`
 * (never `personFor`) is why: an address with no row yet, true of a brand-new account, answers
 * null rather than minting one, and an address just forgotten (docs/PRIVACY.md, section 5) answers
 * null too, rather than silently re-inserting the very row the owner asked emptied — which is
 * exactly what the very next admin action naming that address would otherwise do.
 *
 * Takes the store as a parameter, rather than reading a module-level one, so this can be tested
 * against a lookup that throws without booting a server.
 */
export async function idForLog(people: Pick<PeopleTable, 'personOf'>, email: string): Promise<string | null> {
  try {
    return await people.personOf(email);
  } catch {
    // No e-mail here — that is the point of this function — but an empty catch would make a real
    // outage indistinguishable from the ordinary "nobody yet" that `personOf` itself answers with
    // null, and an operator watching the log has no other way to tell the two apart.
    log('WARNING', 'person_lookup_failed');
    return null;
  }
}

/** The `{person, by}` pair every account-management log line needs, resolved the same safe way. */
export async function actedOn(people: Pick<PeopleTable, 'personOf'>, subject: string, actor: string):
  Promise<{ person: string | null; by: string | null }> {
  return { person: await idForLog(people, subject), by: await idForLog(people, actor) };
}

/**
 * Resolves an event's author, then writes the event — in that order, never the other way round. An
 * author that cannot be resolved must produce no event: every event's author is meant to be a real
 * person id, never null (docs/PRIVACY.md, section 1), so writing first and resolving after would let
 * a resolution failure follow a committed write — an event nobody can credit — and, with no
 * idempotency key tying a retry to this call, a second attempt would write it twice. Takes the store
 * as a parameter, like `idForLog` above, so the order can be proven against a stub whose `personFor`
 * rejects, without booting a server.
 */
export async function recordAuthored(
  store: Pick<EventStore, 'personFor' | 'append'>, incoming: NewEvent, email: string,
): Promise<{ author: string; event: Event }> {
  const author = await store.personFor(email);
  const event = await store.append(incoming, email);
  return { author, event };
}
