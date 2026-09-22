import { Firestore, FieldValue } from '@google-cloud/firestore';
import { stored, type Event, type NewEvent, type EventStore } from './types.ts';

/**
 * Firestore, `events` collection. INSERT ONLY: `create` fails if the document already exists, so
 * no code path overwrites a fact. Here the "nothing is erased" guarantee comes from the code — the
 * project IAM still allows delete. Logged as a known gap in docs/METHOD.md, "Not built yet".
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

  async close(): Promise<void> {
    await this.#db.terminate();
  }

  #fromFirestore(id: string, d: FirebaseFirestore.DocumentData): Event {
    return stored(d as NewEvent, id, d.author, d.when?.toDate?.().toISOString() ?? new Date(0).toISOString());
  }
}
