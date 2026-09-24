import { Firestore, FieldValue } from '@google-cloud/firestore';
import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES } from './people.ts';

/**
 * Firestore, `events` collection. INSERT ONLY: `create` fails if the document already exists, so
 * no code path overwrites a fact. Here the "nothing is erased" guarantee comes from the code — the
 * project IAM still allows delete. Logged as a known gap in docs/METHOD.md, "Not built yet".
 * The people table beside it, at the end of the class, takes one update: emptying an e-mail.
 */
export class FirestoreEventStore implements EventStore {
  #db: Firestore;
  constructor(projectId: string) {
    this.#db = new Firestore({ projectId });
  }

  async append(event: NewEvent, author: string): Promise<Event> {
    const doc = this.#db.collection('events').doc();
    // The shape every store answers, from the one function that decides it; the id is the
    // document's own and the time is the server's, so neither is written as a field.
    const { id: _id, when: _when, ...fields } = stored(event, doc.id, author, '');
    await doc.create({ ...fields, when: FieldValue.serverTimestamp() });
    const read = await doc.get();
    return this.#fromFirestore(read.id, read.data()!);
  }

  async list(page?: string | null): Promise<Event[]> {
    let q: FirebaseFirestore.Query = this.#db.collection('events');
    if (page != null) q = q.where('page', '==', page);
    const r = await q.get();
    // By the server's timestamp itself, to the nanosecond: `when` is kept to the millisecond, and
    // two events inside one would otherwise come back in document-id order, which is random.
    const at = (d: FirebaseFirestore.QueryDocumentSnapshot) => d.data().when as FirebaseFirestore.Timestamp | undefined;
    return [...r.docs]
      .sort((a, b) => (at(a)?.seconds ?? 0) - (at(b)?.seconds ?? 0) || (at(a)?.nanoseconds ?? 0) - (at(b)?.nanoseconds ?? 0))
      .map((d) => this.#fromFirestore(d.id, d.data()));
  }

  // The people table: `people/{id}` holds the row, and `people_by_email/{address}` points an
  // address that is still held at its row. The pointer is what makes find-or-create safe: `create`
  // fails when the document exists, so two first sightings of one address inside a transaction
  // cannot both make a person — a query for the address could not promise that. Forgetting deletes
  // the pointer, the one copy of the address outside the row; the row itself is never deleted.
  // Nothing here stops a direct writer: in Firestore this rule holds by this code alone
  // (docs/PRIVACY.md, section 3).

  async personFor(email: string): Promise<string> {
    const e = personEmail(email);
    const pointer = this.#db.collection('people_by_email').doc(encodeURIComponent(e));
    return this.#db.runTransaction(async (tx) => {
      const found = await tx.get(pointer);
      if (found.exists) return found.data()!.id as string;
      const id = newPersonId();
      tx.create(this.#db.collection('people').doc(id), { email: e });
      tx.create(pointer, { id });
      return id;
    });
  }

  async person(id: string): Promise<Person | null> {
    const doc = await this.#db.collection('people').doc(id).get();
    return doc.exists ? { id: doc.id, email: doc.data()!.email ?? null } : null;
  }

  async setEmail(id: string, email: string | null): Promise<void> {
    const row = this.#db.collection('people').doc(id);
    await this.#db.runTransaction(async (tx) => {
      const current = await tx.get(row);
      // Existence first, as the other stores answer: an unknown id is "no person" whatever it
      // was asked to hold, not a lecture about e-mails for a row that is not there.
      if (!current.exists) throw noPerson(id);
      if (email !== null) throw new Error(ONLY_LOSES);
      const held = current.data()!.email as string | null;
      if (held != null) tx.delete(this.#db.collection('people_by_email').doc(encodeURIComponent(held)));
      tx.update(row, { email: null });
    });
  }

  async forget(id: string): Promise<void> { await this.setEmail(id, null); }

  async close(): Promise<void> {
    await this.#db.terminate();
  }

  #fromFirestore(id: string, d: FirebaseFirestore.DocumentData): Event {
    return stored(d as NewEvent, id, d.author, d.when?.toDate?.().toISOString() ?? new Date(0).toISOString());
  }
}
