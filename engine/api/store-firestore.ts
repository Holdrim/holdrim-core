import { Firestore, FieldValue } from '@google-cloud/firestore';
import { stored, type Event, type NewEvent, type EventStore, type Person } from './types.ts';
import { newPersonId, personEmail, noPerson, ONLY_LOSES, withAuthors, FIRESTORE_PEOPLE as LAYOUT } from './people.ts';
import { hashText, newSalt, noText, textKey, withTexts, TEXT_FIELDS, TEXT_REMOVED,
  type RawEvent, type TextField } from './texts.ts';

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

  // `text` and `snapshot` are written as null: their values move to the `texts` collection, and the
  // document keeps only the two's hash, `textHash`/`snapshotHash` (docs/PRIVACY.md, section 4). The
  // event and its texts are created in one transaction — an event with a hash and no matching row,
  // from a crash between the two, is exactly what `withTexts` cannot tell from tampering.
  async append(event: NewEvent, author: string): Promise<Event> {
    const personId = await this.personFor(author);
    const doc = this.#db.collection('events').doc();
    const hashes: Record<TextField, string | null> = { text: null, snapshot: null };
    const rows: { field: TextField; value: string; salt: string }[] = [];
    for (const field of TEXT_FIELDS) {
      const value = event[field];
      if (value == null) continue;
      const salt = newSalt();
      hashes[field] = hashText(value, salt);
      rows.push({ field, value, salt });
    }
    // The shape every store answers, from the one function that decides it; the id is the
    // document's own and the time is the server's, so neither is written as a field. The author is
    // written as the person's id and answered as the address, as a list names it a moment later
    // (docs/PRIVACY.md, section 1). `textRemoved`/`snapshotRemoved`/`textTampered`/`snapshotTampered`
    // are `withTexts`'s to decide on a read, never written here: a row just made cannot yet need them.
    const { id: _id, when: _when, textRemoved: _tr, snapshotRemoved: _sr, textTampered: _tt, snapshotTampered: _st,
      ...fields } = stored({ ...event, text: null, snapshot: null }, doc.id, personId, '');
    await this.#db.runTransaction(async (tx) => {
      tx.create(doc, { ...fields, textHash: hashes.text, snapshotHash: hashes.snapshot, when: FieldValue.serverTimestamp() });
      for (const t of rows) {
        tx.create(this.#db.collection('texts').doc(textKey(doc.id, t.field)),
          { event: doc.id, field: t.field, value: t.value, salt: t.salt });
      }
    });
    const read = await doc.get();
    const { textHash: _th, snapshotHash: _sh, ...withoutHashes } = this.#fromFirestore(read.id, read.data()!);
    // A row just written cannot yet be removed or tampered with, so the plain values in hand — not
    // a round trip through `withTexts` — are what the caller of a fresh append gets back.
    return { ...withoutHashes, text: event.text ?? null, snapshot: event.snapshot ?? null, author: personEmail(author) };
  }

  /**
   * Deletes one field's row in `texts` and records a `TEXT_REMOVED` event naming this event and
   * this field — in one transaction, for the reason `append`'s own comment gives. Refuses with
   * `noText` when the row is not there: never given, or already removed.
   */
  async removeText(event: string, field: TextField, by: string): Promise<Event> {
    const eventDoc = this.#db.collection('events').doc(event);
    const textDoc = this.#db.collection('texts').doc(textKey(event, field));
    const personId = await this.personFor(by);
    const removalDoc = this.#db.collection('events').doc();
    await this.#db.runTransaction(async (tx) => {
      // Reads before writes, as every Firestore transaction demands: the two ONE AT A TIME, since
      // a transaction here reads at most a document or two and the clarity of reading each in turn
      // is worth more than the one round trip saved by asking for both together.
      const original = await tx.get(eventDoc);
      if (!original.exists) throw new Error(`no event ${event}`);
      const row = await tx.get(textDoc);
      if (!row.exists) throw noText(event, field);
      const page = original.data()!.page as string;
      const block = (original.data()!.block as string | null | undefined) ?? null;
      tx.delete(textDoc);
      tx.create(removalDoc, {
        type: TEXT_REMOVED, page, block, fingerprint: null, text: null, snapshot: null,
        textHash: null, snapshotHash: null, author: personId, data: { event, field },
        when: FieldValue.serverTimestamp(),
      });
    });
    const read = await removalDoc.get();
    const { textHash: _th, snapshotHash: _sh, ...withoutHashes } = this.#fromFirestore(read.id, read.data()!);
    return { ...withoutHashes, author: personEmail(by) };
  }

  async list(page?: string | null): Promise<Event[]> {
    let q: FirebaseFirestore.Query = this.#db.collection('events');
    if (page != null) q = q.where('page', '==', page);
    const r = await q.get();
    // The people after the events, never beside them: an append makes the person before the event,
    // so every author a read of the events can see is already in a read of the people that starts
    // after it. Side by side, the people could be read first, and a new person's first event would
    // come back naming their id.
    const people = await this.#db.collection(LAYOUT.rows).get();
    // By the server's timestamp itself, to the nanosecond: `when` is kept to the millisecond, and
    // two events inside one would otherwise come back in document-id order, which is random.
    const at = (d: FirebaseFirestore.QueryDocumentSnapshot) => d.data().when as FirebaseFirestore.Timestamp | undefined;
    const events = withAuthors([...r.docs]
      .sort((a, b) => (at(a)?.seconds ?? 0) - (at(b)?.seconds ?? 0) || (at(a)?.nanoseconds ?? 0) - (at(b)?.nanoseconds ?? 0))
      .map((d) => this.#fromFirestore(d.id, d.data())),
    new Map(people.docs.map((p) => [p.id, (p.data()[LAYOUT.email] as string | null) ?? null])));
    // The texts after the events, for the reason the people are: `append` writes an event's texts
    // rows in the same transaction as the event itself, so every hash a read of the events can see
    // already has its row in a read of the texts that starts after it.
    const textDocs = await this.#db.collection('texts').get();
    const texts = new Map(textDocs.docs.map((t) => {
      const data = t.data();
      return [textKey(data.event as string, data.field as TextField), { value: data.value as string, salt: data.salt as string }];
    }));
    return withTexts(events, texts);
  }

  // The people table, laid out as FIRESTORE_PEOPLE says: `people/{id}` holds the row, and
  // `people_by_email/{address}` points an
  // address that is still held at its row. The pointer is what makes find-or-create safe: `create`
  // fails when the document exists, so two first sightings of one address inside a transaction
  // cannot both make a person — a query for the address could not promise that. Forgetting deletes
  // the pointer, the one copy of the address outside the row; the row itself is never deleted.
  // Nothing here stops a direct writer: in Firestore this rule holds by this code alone
  // (docs/PRIVACY.md, section 3).

  async personFor(email: string): Promise<string> {
    const e = personEmail(email);
    const pointer = this.#db.collection(LAYOUT.pointers).doc(LAYOUT.pointerId(e));
    return this.#db.runTransaction(async (tx) => {
      const found = await tx.get(pointer);
      if (found.exists) return found.data()![LAYOUT.id] as string;
      const id = newPersonId();
      tx.create(this.#db.collection(LAYOUT.rows).doc(id), { [LAYOUT.email]: e });
      tx.create(pointer, { [LAYOUT.id]: id });
      return id;
    });
  }

  async person(id: string): Promise<Person | null> {
    const doc = await this.#db.collection(LAYOUT.rows).doc(id).get();
    return doc.exists ? { id: doc.id, email: doc.data()![LAYOUT.email] ?? null } : null;
  }

  async setEmail(id: string, email: string | null): Promise<void> {
    const row = this.#db.collection(LAYOUT.rows).doc(id);
    await this.#db.runTransaction(async (tx) => {
      const current = await tx.get(row);
      // Existence first, as the other stores answer: an unknown id is "no person" whatever it
      // was asked to hold, not a lecture about e-mails for a row that is not there.
      if (!current.exists) throw noPerson(id);
      if (email !== null) throw new Error(ONLY_LOSES);
      const held = current.data()![LAYOUT.email] as string | null;
      if (held != null) tx.delete(this.#db.collection(LAYOUT.pointers).doc(LAYOUT.pointerId(held)));
      tx.update(row, { [LAYOUT.email]: null });
    });
  }

  async forget(id: string): Promise<void> { await this.setEmail(id, null); }

  async close(): Promise<void> {
    await this.#db.terminate();
  }

  #fromFirestore(id: string, d: FirebaseFirestore.DocumentData): RawEvent<Event> {
    return {
      ...stored(d as NewEvent, id, d.author, d.when?.toDate?.().toISOString() ?? new Date(0).toISOString()),
      // Absent on a document from before texts were extracted, and on `text`/`snapshot` `stored`
      // already kept that document's own plain value — the same back-compat `withTexts` gives a
      // pre-extraction SQLite row.
      textHash: (d.textHash as string | null | undefined) ?? null,
      snapshotHash: (d.snapshotHash as string | null | undefined) ?? null,
    };
  }
}
