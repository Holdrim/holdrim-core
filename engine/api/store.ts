import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES } from './people.ts';

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

  // The people table. No database to hold the rule here, so `setEmail` is the only code that
  // changes a row and it refuses everything but emptying it (docs/PRIVACY.md, sections 1 and 3).
  #people = new Map<string, Person>();

  async personFor(email: string): Promise<string> {
    const e = personEmail(email);
    for (const p of this.#people.values()) if (p.email === e) return p.id;
    const id = newPersonId();
    this.#people.set(id, { id, email: e });
    return id;
  }

  async person(id: string): Promise<Person | null> {
    const p = this.#people.get(id);
    return p ? { ...p } : null;
  }

  async setEmail(id: string, email: string | null): Promise<void> {
    const p = this.#people.get(id);
    if (!p) throw noPerson(id);
    if (email !== null) throw new Error(ONLY_LOSES);
    p.email = null;
  }

  async forget(id: string): Promise<void> { await this.setEmail(id, null); }

  async close(): Promise<void> {}
}
