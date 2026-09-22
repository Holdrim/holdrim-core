import { stored, type Event, type NewEvent, type EventStore } from './types.ts';

/*
 * The Firestore store lives in store-firestore.ts, loaded only when HOLDRIM_EVENTS=firestore.
 * Here, behind a top-level import, it would make every server load Google's client and its whole
 * dependency tree at start — the SQLite one on a laptop included — and every advisory against that
 * tree would be an advisory against every install. Code that is never run should not be loaded,
 * and an optional dependency should stay optional.
 */

/** Only for running and testing on the machine. Persists nothing. */
export class MemoryEventStore implements EventStore {
  #events: Event[] = [];

  async append(event: NewEvent, author: string): Promise<Event> {
    const e = stored(event, crypto.randomUUID().replace(/-/g, ''), author, new Date().toISOString());
    this.#events.push(e);
    return e;
  }

  async list(page?: string | null): Promise<Event[]> {
    return this.#events
      .filter((e) => page == null || e.page === page)
      .sort((a, b) => a.when.localeCompare(b.when));
  }

  async close(): Promise<void> {}
}
