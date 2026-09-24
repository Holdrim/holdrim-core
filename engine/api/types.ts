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
}

export type NewEvent = Omit<Event, 'id' | 'author' | 'when'>;

/**
 * The event as every store answers it, to an append and to a list alike: each optional field
 * present, and `null` when it was left out. Stores that each spread what they were given would
 * answer one shape to an append and another to a list a moment later.
 */
export function stored(event: NewEvent, id: string, author: string, when: string): Event {
  return {
    id, type: event.type, page: event.page, block: event.block ?? null, fingerprint: event.fingerprint ?? null,
    text: event.text ?? null, snapshot: event.snapshot ?? null, author, when, data: event.data ?? null,
  };
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
  close(): Promise<void>;
}

export const EVENT_TYPES = new Set([
  'approval', 'request', 'comment', 'decision_reply', 'request_state', 'supplement',
]);
