import type { Removed, TextField } from './texts.ts';
import { normalizeEmail } from './users.ts';

/** A fact from the review. Only created — never altered, never deleted. */
export interface Event {
  id: string;
  type: string;                // approval · request · comment · decision_reply · request_state · supplement
  page: string;                // D01, T07, UC-01…
  block?: string | null;       // D01.1.4 (null when the event belongs to the page or to a decision)
  fingerprint?: string | null; // of the text at that moment: the approval holds for THIS text
  text?: string | null;
  snapshot?: string | null;    // the text of the block at that instant
  // Stored as the person's id (`p_…`, engine/api/people.ts) and read back as their e-mail, through
  // the one resolver every reader uses; an id once the person is forgotten, and an e-mail as written
  // on an event from before ids. The e-mail was verified by whichever identity is in charge.
  author: string;
  when: string;                // ISO, server clock
  // The same shape the core reads (engine/core/cycle.js, typedef EventData): `request` and
  // `state` on request_state, `commit` on the applied one, `category` on the request. `unknown`
  // forces the reader to check the type — `string` would lie, because `related` already holds an
  // object.
  data?: { request?: string; state?: string; from?: string; [k: string]: unknown } | null;
  // `text` and `snapshot` live outside the event, in a table of texts, one row per event and field
  // (docs/PRIVACY.md, section 4; engine/api/texts.ts, `withTexts`). These four say what became of a
  // field once its row is gone: `null` while the field is untouched — never given, still there, or
  // from before texts were extracted. `<field>Removed` names who and when, for a field let go on
  // purpose through `EventStore.removeText`. `<field>Tampered` is `true` for a field whose hash no
  // longer matches any row and no such removal accounts for it — missing with nothing to say why,
  // which reads as tampering, not as absence.
  textRemoved?: Removed | null;
  snapshotRemoved?: Removed | null;
  textTampered?: boolean;
  snapshotTampered?: boolean;
}

export type NewEvent = Omit<Event, 'id' | 'author' | 'when' | 'textRemoved' | 'snapshotRemoved' | 'textTampered' | 'snapshotTampered'>;

/**
 * The event as every store answers it, to an append and to a list alike: each optional field
 * present, and `null` when it was left out. Stores that each spread what they were given would
 * answer one shape to an append and another to a list a moment later.
 *
 * The four fields `withTexts` decides — `textRemoved`, `snapshotRemoved`, `textTampered`,
 * `snapshotTampered` — start at "nothing to say" here, the same as every other optional field.
 * `append` returns this shape untouched (a text just written cannot yet be removed or tampered
 * with); `list` runs the whole page through `withTexts` afterwards, which sets them where a hash
 * says there is something to say.
 */
export function stored(event: NewEvent, id: string, author: string, when: string): Event {
  return {
    id, type: event.type, page: event.page, block: event.block ?? null, fingerprint: event.fingerprint ?? null,
    text: event.text ?? null, snapshot: event.snapshot ?? null, author, when, data: event.data ?? null,
    textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
  };
}

// ---------------------------------------------------------------- authority, written at record time
//
// docs/ROLES.md §3, "written at the moment, read forever after": what an event's author was allowed
// to do is a fact about the INSTANT the server recorded it, so it is written onto `data` then, by
// `recordEvent` (server.ts) — never recomputed later from whoever holds a grant NOW, which is what
// let a revoked admin's request quietly read as pre-approved, and an owner's handover quietly un-lock
// their past ✓s. The two names below are shared so `server.ts`, `validation.ts` (`holdrim sync`) and
// `requests.ts` (the agent's CLI) write and read the exact same keys, never three that merely look
// alike.

/** On an `approval` event: whether it was a lock at the moment it was given. */
export const LOCKS_FIELD = 'locks';
/** On a `request` event: whether its author could already triage it at the moment it was filed —
 *  the fact `cycle.currentState`'s `authorIsAdmin` parameter needs, named for the CAPABILITY it asks
 *  about (docs/ROLES.md, "the engine asks about capabilities, never about names"), not for a role. */
export const AUTHOR_COULD_TRIAGE_FIELD = 'authorCouldTriage';

/**
 * A boolean the server wrote into an event's `data` at record time. Three answers, not two:
 *
 *   - `undefined` — the key is ABSENT. An event from before this field existed (there is no rewrite
 *     of history), so the caller falls back to its own legacy rule for that field.
 *   - `true`      — the key holds exactly the string `'true'`.
 *   - `false`     — the key holds exactly the string `'false'`, OR holds anything else at all.
 *
 * The third case is decision C of round 1's review: a field that is PRESENT but malformed — `'TRUE'`,
 * the JS boolean `true` (a client that sends a real boolean, not a string, past the `String(...)` the
 * server always writes), `1`, `' true'` — fails closed. It never falls through to the legacy rule,
 * which is for a field that was never written at all; a malformed value is not that, and treating it
 * as if it were would let whoever can shape `data` (a forged POST, or a bug elsewhere) pick the more
 * favourable of "what I wrote" and "what the legacy rule would have said" by writing garbage.
 *
 * Written and read as the STRINGS `'true'`/`'false'`, never a JS `boolean`: every other value already
 * inside `data` (`state`, `category`, `commit`, `from`, …) is a string, and a bare boolean would
 * round-trip fine through SQLite and the in-memory store but come back `undefined` from the CLI's own
 * Firestore reader (`engine/cli/remote.ts`, `#fromFirestore`, which reads only `.stringValue`) —
 * silently falling back to the very recompute this field exists to stop, and nothing would say so.
 */
export function writtenBoolean(data: Event['data'], key: string): boolean | undefined {
  const v = (data as Record<string, unknown> | null | undefined)?.[key];
  if (v === undefined || v === null) return undefined;
  return v === 'true';
}

/** A row of the people table. `email` is null once the person was forgotten; the id stays. */
export interface Person {
  id: string;
  email: string | null;
}

/**
 * The people table, kept by every event store next to its events (docs/PRIVACY.md, section 1).
 * A row is created, and afterwards it can only lose its e-mail: never re-pointed, never deleted.
 */
export interface PeopleTable {
  /** The id of the person with this e-mail, made on first sight. The same e-mail, the same id. */
  personFor(email: string): Promise<string>;
  /**
   * The id already on record for this e-mail, or null when there is none — never `personFor`'s
   * find-OR-CREATE. For a log line, which only ever reports what already happened and must never
   * itself be the reason a request that already committed its real work fails: a lookup made
   * after the fact must not conjure a row into existence, and must especially never conjure one
   * back for an address a person was just forgotten from (docs/PRIVACY.md, section 5) — the very
   * next admin action naming that address would otherwise silently undo the forgetting.
   */
  personOf(email: string): Promise<string | null>;
  /** The row behind an id; null when no row has that id. */
  person(id: string): Promise<Person | null>;
  /**
   * The one change a row takes after it is made. Only `null` gets through; anything else is
   * refused with the row untouched. A method and not only `forget`, so the refusal is reachable
   * and a test can prove it holds in each store.
   */
  setEmail(id: string, email: string | null): Promise<void>;
  /** Empties the row's e-mail and keeps its id. The same e-mail, seen again, is a new person. */
  forget(id: string): Promise<void>;
}

/** Persistence. The in-memory store, SQLite and Firestore implement the same contract. */
export interface EventStore extends PeopleTable {
  append(event: NewEvent, author: string): Promise<Event>;
  list(page?: string | null): Promise<Event[]>;
  /**
   * Removes one field's text — the row in the texts table, and only that — and records the removal
   * as a new event of type `text_removed` (engine/api/texts.ts, `TEXT_REMOVED`), `by` as its author.
   * The two happen together, or neither does: a text gone with no removal event, or a removal event
   * with the text still there, is exactly the inconsistency `withTexts` cannot tell from tampering.
   * Refuses with `noText` when the field was never given, or was already removed.
   */
  removeText(event: string, field: TextField, by: string): Promise<Event>;
  close(): Promise<void>;
}

export const EVENT_TYPES = new Set([
  'approval', 'request', 'comment', 'decision_reply', 'request_state', 'supplement',
]);

// ---------------------------------------------------------------- the lock baseline (decision B)
//
// A REQUEST with no written `authorCouldTriage` fails closed to `false` (decision A): the worst it
// can do is send an old request back to triage, which the owner can approve again in a click. A ✓
// with no written `locks` cannot fail closed the same way — that would silently un-lock every
// ✓ every existing adopter's database already holds the moment this version starts, which is a much
// larger and quieter loss than one request needing a second look. It also cannot fall back to
// TODAY's HOLDRIM_OWNER: that is the exact bug this whole change closes, moved one step earlier, and
// a handover would still re-lock an old admin's ✓s or un-lock the old owner's.
//
// So an unwritten ✓ is measured against a FROZEN fact instead: who HOLDRIM_OWNER was the moment this
// version first read the store. That fact is itself one event — `lock_baseline` — written once, by
// the server, and never by a client: it is not in `EVENT_TYPES` above, so `POST /events` refuses it
// as an unknown type before anything else runs, the same guard `text_removed` relies on (server.ts,
// `refusalOf`).
//
// The baseline is also what decides whether a WRITTEN field is trusted at all (round 2's review,
// CRITICAL "fields written before this version are trusted"): before this version existed,
// `recordEvent` stored whatever `data` a client sent, so an old store can already hold a client-forged
// `locks:"true"` or `authorCouldTriage:"true"`. `isLocked` and `authorCouldTriage` below trust a
// written field only on an event dated AFTER the baseline — one this version itself recorded, and so
// itself wrote the field onto. An event that predates the baseline gets `legacyLock`'s answer (a ✓) or
// `false` (a request) instead, whatever `data` on it claims; a store with no baseline at all trusts
// nothing written on anything, for the same reason `legacyLock` itself returns `false` with none.

/** The one event kind this module writes on its own, never in answer to a client's POST. */
export const LOCK_BASELINE_TYPE = 'lock_baseline';

/** Where the baseline event lives. Never a real content page — no kind numbers a page `_…` — so it
 *  can never collide with one a project adds later, and it never shows up inside a page's own event
 *  list; only something that asks for it by this name finds it. */
export const LOCK_BASELINE_PAGE = '_lock_baseline';

/**
 * The earliest `lock_baseline` event in a list, or `null` when there is none. More than one can exist
 * — two servers starting at once against an empty store could each append one, since the store is
 * insert-only and nothing here takes a lock on "is there a baseline yet?" across processes — and
 * every reader, `ensureLockBaseline` included, resolves the race the same way: the EARLIEST one, by
 * `when`, is the one everybody trusts. A duplicate left over from a lost race is harmless once every
 * reader agrees which one that is.
 */
export function earliestLockBaseline(events: Pick<Event, 'type' | 'when'>[]): Event | null {
  const found = events.filter((e) => e.type === LOCK_BASELINE_TYPE) as Event[];
  return found.length ? found.reduce((a, b) => (a.when <= b.when ? a : b)) : null;
}

/**
 * Makes sure this store holds a baseline event, appending one — its author `ownerEmail`, HOLDRIM_OWNER
 * right now — only if it does not already. Called once, at boot, before the server answers anything
 * (server.ts): "on the first start of this version" is decided here, by what the store already holds,
 * never by a flag that could be reset.
 *
 * `store` is typed as the two methods this needs, not the whole `EventStore`, so a test can hand it a
 * stub without building a full store.
 */
export async function ensureLockBaseline(
  store: Pick<EventStore, 'list' | 'append'>, ownerEmail: string,
): Promise<Event> {
  const already = earliestLockBaseline(await store.list(LOCK_BASELINE_PAGE));
  if (already) return already;
  await store.append({ type: LOCK_BASELINE_TYPE, page: LOCK_BASELINE_PAGE, data: null }, ownerEmail);
  // Read back rather than trust what was just appended: another process may have won the race above,
  // and the EARLIEST of however many now exist is the one every reader — this one included — has to
  // agree on.
  return earliestLockBaseline(await store.list(LOCK_BASELINE_PAGE))!;
}

/**
 * Whether an unwritten ✓ counts as a lock (decision B): its author must be the baseline's own author
 * — HOLDRIM_OWNER at the moment this version first started against this store — and the ✓ itself must
 * predate the baseline. Every ✓ recorded since carries its own written `locks`; one that does not,
 * dated AFTER the baseline, is either a bug or a forgery, and is trusted no more than a stranger's.
 * No baseline at all — a store this version has never started against, read straight from a file or
 * the cloud (`holdrim sync --db`, or the CLI reading Firestore directly) — fails closed: not a lock.
 *
 * Authors are compared through `normalizeEmail` (round 2's review, finding M-2), the same function
 * every store uses to decide "the same address": an author recorded with different case or
 * surrounding space than `HOLDRIM_OWNER` was typed in — the identity layer's job, not this file's —
 * must not read as a stranger to the baseline it actually is.
 */
export function legacyLock(approval: Pick<Event, 'author' | 'when'>, baseline: Event | null): boolean {
  if (!baseline) return false;
  return approval.when < baseline.when && normalizeEmail(approval.author) === normalizeEmail(baseline.author);
}

/**
 * Whether an approval is a lock: what was written on it, but ONLY for a ✓ dated AFTER the baseline —
 * never `legacyLock`'s fallback for one of those, since it carries its own answer. A ✓ that PREDATES
 * the baseline, or one read against no baseline at all, is answered by `legacyLock` alone, which never
 * looks at `data` (round 2's review, CRITICAL "fields written before this version are trusted"):
 * before this version, `recordEvent` stored whatever `data` a client sent, so an old store can hold a
 * client-forged `locks:"true"` on an admin's own ✓. Trusting a written field on an event this version
 * never wrote would let that forgery through the moment the store gains a baseline — precisely the
 * upgrade this field exists to protect. The one implementation server.ts and validation.ts (`holdrim
 * sync`) both call, so the fallback is not three slightly different copies of the same rule (round 1's
 * review, finding 2).
 *
 * One exception, ahead of all of the above: a written `'false'` is trusted EVEN before the baseline
 * (round 4's review, MINOR "clock stepped back"). If a server's clock ever runs behind — a bad NTP
 * sync, a container that boots with the wrong time — a former owner's ✓, correctly written
 * `locks:"false"` by this very version, can land dated BEFORE the baseline it itself sits after in
 * real time. `legacyLock` would then read it as a lock (same author as the baseline, and the `when`
 * comparison alone cannot tell a clock error from a genuinely old event). A forged field only ever
 * helps an attacker by claiming `'true'` — a lock nobody gave — never by claiming `'false'`, since
 * that is already `legacyLock`'s worst case for a stranger to the baseline. Trusting `'false'`
 * unconditionally therefore fails closed either way: it can only ever turn a would-be lock into no
 * lock, never the other way round. `authorCouldTriage` has no matching exception — there, a written
 * `'false'` already equals its own fail-closed answer, so there is nothing to protect.
 */
export function isLocked(approval: Pick<Event, 'data' | 'author' | 'when'>, baseline: Event | null): boolean {
  if (writtenBoolean(approval.data, LOCKS_FIELD) === false) return false;
  if (baseline && approval.when > baseline.when) return writtenBoolean(approval.data, LOCKS_FIELD) ?? false;
  return legacyLock(approval, baseline);
}

/**
 * Whether a request's author could already triage it: what was written on it, but ONLY for a request
 * dated AFTER the baseline — the same forgery as `isLocked`'s, on a request: before this version, a
 * client could send `authorCouldTriage:"true"` on their own request, and `recordEvent` stored it
 * verbatim (round 2's review, CRITICAL "fields written before this version are trusted"). A request
 * that PREDATES the baseline, or one read with no baseline in the store at all, is `false` — at
 * triage — unconditionally: there is no legacy rule for this field the way `legacyLock` is one for a
 * ✓, so ignoring what was written leaves nothing else to fall back to (decision A: a request fails
 * closed to "at triage", never to a live recompute of who holds `triage` today). The one
 * implementation server.ts and requests.ts (the agent's CLI) both call (round 1's review, finding 2).
 */
export function authorCouldTriage(request: Pick<Event, 'data' | 'when'>, baseline: Event | null): boolean {
  if (baseline && request.when > baseline.when) return writtenBoolean(request.data, AUTHOR_COULD_TRIAGE_FIELD) ?? false;
  return false;
}
