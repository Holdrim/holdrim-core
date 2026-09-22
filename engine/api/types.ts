/** A fact from the review. Only created — never altered, never deleted. */
export interface Event {
  id: string;
  type: string;                // approval · request · comment · decision_reply · request_state · supplement
  page: string;                // D01, T07, UC-01…
  block?: string | null;       // D01.1.4 (null when the event belongs to the page or to a decision)
  fingerprint?: string | null; // of the text at that moment: the approval holds for THIS text
  text?: string | null;
  snapshot?: string | null;    // the text of the block at that instant
  author: string;              // e-mail, verified by whichever identity is in charge
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

/** Persistence. The in-memory store, SQLite and Firestore implement the same contract. */
export interface EventStore {
  append(event: NewEvent, author: string): Promise<Event>;
  list(page?: string | null): Promise<Event[]>;
  close(): Promise<void>;
}

export const EVENT_TYPES = new Set([
  'approval', 'request', 'comment', 'decision_reply', 'request_state', 'supplement',
]);
