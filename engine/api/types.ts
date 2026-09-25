import type { Removed, TextField } from './texts.ts';

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
 * A boolean the server wrote into an event's `data` at record time, or `undefined` for an event from
 * before that field existed — every caller falls back to asking today's roles for one of those,
 * exactly as every reader did before this existed: there is no rewrite of history, so an old event
 * still reads (docs/ROLES.md §3).
 *
 * Written and read as the STRINGS `'true'`/`'false'`, never a JS `boolean`: every other value already
 * inside `data` (`state`, `category`, `commit`, `from`, …) is a string, and a bare boolean would
 * round-trip fine through SQLite and the in-memory store but come back `undefined` from the CLI's own
 * Firestore reader (`engine/cli/remote.ts`, `#fromFirestore`, which reads only `.stringValue`) —
 * silently falling back to the very recompute this field exists to stop, and nothing would say so.
 */
export function writtenBoolean(data: Event['data'], key: string): boolean | undefined {
  const v = (data as Record<string, unknown> | null | undefined)?.[key];
  return v === 'true' ? true : v === 'false' ? false : undefined;
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
