import type { Removed, TextField, TamperReport } from './texts.ts';

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
  // The value `author` held BEFORE it was resolved to an address: the person's row id (`p_…`) for
  // anyone the people table knows, or the address itself for an event written before authors were
  // ids. Optional because `stored()` alone, with no store around it, has nothing to resolve — every
  // reader that lists events sets it (`withAuthors`, engine/api/people.ts), and it is what lets
  // `people.show: "id"` (docs/ROLES.md, "How a person appears") show a person without ever reading
  // an address the setting was asked to hide.
  authorId?: string;
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
  // Whether this server signed it (engine/api/signing.ts): its seal verifies against a key this
  // reader trusts, and every column agrees with what was signed. Required, so no code that builds an
  // event can leave it out and have it read as either answer by accident; an event that is not
  // signed is shown, marked, and counts for nothing (`isLocked`, `authorCouldTriage` below).
  signed: boolean;
}

export type NewEvent = Omit<Event, 'id' | 'author' | 'authorId' | 'when' | 'textRemoved' | 'snapshotRemoved' | 'textTampered' | 'snapshotTampered' | 'signed'>;

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
 *
 * `signed` starts `false`, the answer that grants nothing: a store sets it `true` only on what it
 * just sealed itself, and a reader only through `withSignatures` (engine/api/signing.ts).
 */
export function stored(event: NewEvent, id: string, author: string, when: string): Event {
  return {
    id, type: event.type, page: event.page, block: event.block ?? null, fingerprint: event.fingerprint ?? null,
    text: event.text ?? null, snapshot: event.snapshot ?? null, author, when, data: event.data ?? null,
    textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false, signed: false,
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
/** On EVERY event the server records: whether its author was an agent (`HOLDRIM_AGENTS`) when it was
 *  recorded — docs/ROLES.md §4. Written as `'false'` too, not only `'true'`, so a client's own
 *  `data.asAgent` never survives either way, and a missing key means only "from before this field". */
export const AS_AGENT_FIELD = 'asAgent';

/**
 * A boolean the server wrote into an event's `data` at record time. Three answers, not two:
 *
 *   - `undefined` — the key is ABSENT.
 *   - `true`      — the key holds exactly the string `'true'`.
 *   - `false`     — the key holds exactly the string `'false'`, OR holds anything else at all.
 *
 * A field that is PRESENT but malformed — `'TRUE'`, the JS boolean `true` (a client that sends a real
 * boolean, not a string, past the `String(...)` the server always writes), `1`, `' true'` — fails
 * closed. `isLocked` and `authorCouldTriage` below grant only on `true`, so absent and malformed
 * alike grant nothing.
 *
 * Written and read as the STRINGS `'true'`/`'false'`, never a JS `boolean`: every other value already
 * inside `data` (`state`, `category`, `commit`, `from`, …) is a string, and the signed envelope
 * (engine/api/signing.ts) carries `data` exactly as written, so the one type is the one every store
 * and reader agrees on without asking.
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

/**
 * Persistence. The in-memory store, SQLite and Firestore implement the same contract.
 *
 * Every store is built with a `Signing` (engine/api/signing.ts) and has no default: `append` and
 * `removeText` seal each event they write, and `list` and `listBare` verify each one they read, so
 * a store that writes unsigned events cannot be built by accident — `tsc` holds every construction
 * to it.
 */
export interface EventStore extends PeopleTable {
  append(event: NewEvent, author: string): Promise<Event>;
  /**
   * `found`, given, is appended to with every field this read resolved to tampered — the very reports
   * the store already raises through `reportTampered`, handed on so the server can say which findings
   * are open (engine/api/tamper.ts, issue #107) without a second, different detection of its own.
   */
  list(page?: string | null, found?: TamperReport[]): Promise<Event[]>;
  /**
   * One page's events and nothing joined to them, in the order they were recorded, as `list` orders
   * them: `author` (and `authorId`) is what the row holds — the person's id, never resolved to an
   * address — and `text` and `snapshot` are null, since the texts table is not read and nothing is
   * checked for tampering. `list` reads the whole people and texts tables on every call; this reads
   * the one page. For a page whose events carry no text and whose readers match people by id, such
   * as `_roles` (role-grants.ts), which the server reads on every request.
   */
  listBare(page: string): Promise<Event[]>;
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

// ---------------------------------------------------------------- authority rests on a signature
//
// Every event that carries authority — a ✓ that is a lock, a request its author could triage, a
// request's state, a supplement, a text removal, a tamper acknowledgement, a role defined, granted
// or revoked, a person removed — counts only when this server signed it (engine/api/signing.ts; owner
// decision 3 on #50). The written fields above are the server's answer at the moment it recorded the
// event, and the signature is what says the server gave it: before signing, anybody who could write
// the store could write `locks:"true"` beside the owner's id and have `holdrim sync` lock it.
//
// There is no fallback for an event with no signature, and no date before which one is trusted
// (owner decision 4): the lock baseline that used to trust old unwritten ✓s by date is gone, because
// whoever writes the store also writes the date. An event not signed is still shown — hiding it would
// hide the evidence — and is raised as CRITICAL where it is read; it decides nothing.

/**
 * The events a decision may rest on: the signed ones. One filter, so the cycle, the removals and the
 * roles cannot each come to mean something slightly different by "counts".
 */
export function authoritative<E extends Pick<Event, 'signed'>>(events: readonly E[]): E[] {
  return events.filter((e) => e.signed === true);
}

/**
 * Whether an approval is a lock: signed by this server, and written `locks:"true"` by it when the ✓
 * was given (`recordEvent`, server.ts) — never recomputed from who holds `lock` now. The one
 * implementation server.ts (the panel, the home) and validation.ts (`holdrim sync`) both call.
 */
export function isLocked(approval: Pick<Event, 'data' | 'signed'>): boolean {
  return approval.signed === true && writtenBoolean(approval.data, LOCKS_FIELD) === true;
}

/**
 * Whether a request's author could already triage it when it was filed: signed, and written
 * `authorCouldTriage:"true"`. Anything else starts at triage — the safe direction, since the owner
 * triages it once more. The one implementation server.ts and requests.ts (the agent's CLI) call.
 */
export function authorCouldTriage(request: Pick<Event, 'data' | 'signed'>): boolean {
  return request.signed === true && writtenBoolean(request.data, AUTHOR_COULD_TRIAGE_FIELD) === true;
}
