import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES, withAuthors } from './people.ts';
import { noText, notBefore, saltFields, textKey, withTexts, TEXT_REMOVED,
  type RawEvent, type TextField, type TextRow } from './texts.ts';

/*
 * The Firestore store lives in store-firestore.ts, loaded only when HOLDRIM_EVENTS=firestore.
 * Here, behind a top-level import, it would make every server load Google's client and its whole
 * dependency tree at start — the SQLite one on a laptop included — and every advisory against that
 * tree would be an advisory against every install. Code that is never run should not be loaded,
 * and an optional dependency should stay optional.
 */

/** Only for running and testing on the machine. Persists nothing. */
export class MemoryEventStore implements EventStore {
  #events: RawEvent<Event>[] = [];

  // The text table beside the events, as docs/PRIVACY.md, section 4 asks: value and salt, keyed by
  // event and field. What the event itself keeps is the hash alone, on `#events` — never here.
  #texts = new Map<string, TextRow>();

  // The author goes in as the person's id and comes out as their address, as in every store:
  // what is kept names nobody once the person is forgotten (docs/PRIVACY.md, section 1).
  async append(event: NewEvent, author: string): Promise<Event> {
    return this.#record(event, author, new Date().toISOString());
  }

  /**
   * `append`'s own body, with `when` taken from the caller rather than always the wall clock now —
   * `removeText` needs to clamp its own event's `when` (round 3, finding 3, `notBefore` in
   * engine/api/texts.ts), and a second copy of this logic would be one more place for the hash on
   * an event and its row in `#texts` to stop agreeing with each other.
   */
  async #record(event: NewEvent, author: string, when: string): Promise<Event> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const { hashes, rows } = saltFields(event);
    for (const r of rows) this.#texts.set(textKey(id, r.field), { value: r.value, salt: r.salt });
    const e = stored({ ...event, text: null, snapshot: null }, id, await this.personFor(author), when);
    this.#events.push({ ...e, textHash: hashes.text, snapshotHash: hashes.snapshot });
    // A row just written cannot yet be removed or tampered with, so the plain values in hand — not
    // a round trip through `withTexts` — are what the caller of a fresh append gets back.
    return { ...e, text: event.text ?? null, snapshot: event.snapshot ?? null, author: personEmail(author) };
  }

  async list(page?: string | null): Promise<Event[]> {
    const people = new Map([...this.#people.values()].map((p) => [p.id, p.email]));
    const events = withAuthors(this.#events
      .filter((e) => page == null || e.page === page)
      .sort((a, b) => a.when.localeCompare(b.when)), people);
    return withTexts(events, this.#texts);
  }

  async removeText(event: string, field: TextField, by: string): Promise<Event> {
    // The event before the row, as the other two stores answer it: an unknown event is "no event",
    // not the same "nothing to remove" a real field already gone would give.
    const original = this.#events.find((e) => e.id === event);
    if (!original) throw new Error(`no event ${event}`);
    const key = textKey(event, field);
    if (!this.#texts.has(key)) throw noText(event, field);
    // Deleted before the removal is recorded. Nothing here persists past the process, so there is
    // no crash for the two to disagree across — the gap a real database closes with a transaction
    // (store-sqlite.ts, store-firestore.ts) is one this store cannot have in the first place.
    this.#texts.delete(key);
    const when = notBefore(new Date().toISOString(), original.when);
    return this.#record({ type: TEXT_REMOVED, page: original.page, block: original.block ?? null,
      data: { event, field } }, by, when);
  }

  // The people table. No database to hold the rule here, so `setEmail` is the only code that
  // changes a row and it refuses everything but emptying it (docs/PRIVACY.md, sections 1 and 3).
  #people = new Map<string, Person>();

  // Synchronous, and called from both methods below without an `await` in front of it: an `await`
  // always yields at least one microtask, even over a body with no I/O, and two `personFor` calls
  // for the same brand-new address, kicked off together (`Promise.all`), would both see "not found"
  // before either got to insert — two people for one first sighting. Keeping the find itself
  // synchronous is what makes one of two racing calls observe the other's insert.
  #findByEmail(e: string): string | null {
    for (const p of this.#people.values()) if (p.email === e) return p.id;
    return null;
  }

  async personFor(email: string): Promise<string> {
    const e = personEmail(email);
    const found = this.#findByEmail(e);
    if (found) return found;
    const id = newPersonId();
    this.#people.set(id, { id, email: e });
    return id;
  }

  async personOf(email: string): Promise<string | null> {
    return this.#findByEmail(personEmail(email));
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
