import { Firestore, type DocumentData, type WhereFilterOp } from '@google-cloud/firestore';
import { UserStoreBase, type StoredSession, type StoredUser } from './users.ts';

/**
 * People and sessions in Firestore: collections `users` and `sessions`.
 *
 * This is the answer for Cloud Run, where the local disk is ephemeral and per instance — an access
 * created on one instance disappears when the platform recycles it, with no error and no log. See
 * `users.ts` for why that is the reason this whole seam exists.
 *
 * The document id is the e-mail, already normalised. That is what makes `create` able to use
 * `create()` instead of `set()`: Firestore refuses a document that already exists, so two
 * simultaneous first accesses cannot both win. With a generated id the duplicate would be legal
 * and nobody would notice until two people shared an account.
 *
 * Unlike the event store next door, this collection is NOT insert-only: a password change is an
 * update, and a logout is a delete. People are state, not facts.
 *
 * ⚠️ Proved by the conformance suite ONLY when the emulator is running. `npm test` on its own
 * skips this implementation with a message instead of pretending. To prove it:
 *
 *   eval "$(bash scripts/firestore-emulator.sh)"
 *   npm test
 *
 * Without that variable, do not read a green suite as evidence that this file works.
 */
export class UsersFirestore extends UserStoreBase {
  #db: Firestore;

  constructor(projectId: string) {
    super();
    this.#db = new Firestore({ projectId });
  }

  protected async insertUser(row: StoredUser): Promise<void> {
    await this.#db.collection('users').doc(row.email).create({
      email: row.email, name: row.name, salt: row.salt, hash: row.hash,
      must_change: row.mustChangePassword, created_at: row.createdAt,
      enabled: row.enabled,
    });
  }

  protected async readUser(email: string): Promise<StoredUser | null> {
    const doc = await this.#db.collection('users').doc(email).get();
    const d = doc.data();
    return d ? docToUser(d) : null;
  }

  protected async readAllUsers(): Promise<StoredUser[]> {
    // Ordered by document id, which IS the normalised e-mail — the same ordering the other two
    // stores produce, and it needs no extra index because Firestore always has this one.
    const all = await this.#db.collection('users').orderBy('__name__').get();
    return all.docs.map((doc) => docToUser(doc.data()));
  }

  protected async writeEnabled(email: string, enabled: boolean): Promise<void> {
    await this.#db.collection('users').doc(email).update({ enabled });
  }

  protected async writeName(email: string, name: string): Promise<void> {
    await this.#db.collection('users').doc(email).update({ name });
  }

  protected async writeCredential(
    email: string, salt: Buffer, hash: Buffer, mustChange: boolean): Promise<void> {
    await this.#db.collection('users').doc(email).update({ salt, hash, must_change: mustChange });
  }

  protected async countUsers(): Promise<number> {
    // `isEmpty` is the only caller and it asks a yes/no question, so one document is enough to
    // answer it. Counting the collection would bill a read per person to learn nothing more.
    const r = await this.#db.collection('users').limit(1).get();
    return r.size;
  }

  protected async insertSession(id: string, email: string, createdAt: string, expiresAt: string): Promise<void> {
    await this.#db.collection('sessions').doc(id).create({
      email, created_at: createdAt, expires_at: expiresAt,
    });
  }

  protected async readSession(id: string): Promise<StoredSession | null> {
    const d = (await this.#db.collection('sessions').doc(id).get()).data();
    return d ? { email: d.email, expiresAt: d.expires_at } : null;
  }

  protected async deleteSession(id: string): Promise<void> {
    await this.#db.collection('sessions').doc(id).delete();
  }

  protected async deleteSessionsExpiredBefore(instant: string): Promise<void> {
    // ONE page and no loop: this runs on its own schedule (see `purgeExpiredSessions`) and can
    // afford to leave the rest for next time — a service left running for a month accumulates more
    // dead sessions than one page, but the next sweep gets to them.
    await this.#deleteSessionPage('expires_at', '<', instant);
  }

  protected async deleteSessionsForEmail(email: string): Promise<void> {
    // Looped, unlike the purge above: this guards a disable or a password reset, and every session
    // for the account has to be gone before the caller moves on — "most of them, eventually" is
    // exactly the gap issue #113 was about, not an acceptable partial result here.
    while (await this.#deleteSessionPage('email', '==', email));
  }

  /**
   * Deletes one page of at most 400 sessions matching a single-field query, and reports whether
   * the page was FULL — meaning the 400 limit decided where it stopped, not the data running out,
   * so the caller cannot yet tell this was the last one and has to ask again.
   *
   * 400 and not Firestore's own ceiling of 500 writes per batch: it leaves room in a batch for
   * whatever else Firestore or a client library adds around a commit, rather than sitting exactly
   * on the edge of a limit that is not this file's to spend in full.
   */
  async #deleteSessionPage(field: string, op: WhereFilterOp, value: unknown): Promise<boolean> {
    const page = await this.#db.collection('sessions').where(field, op, value).limit(400).get();
    if (page.empty) return false;
    const batch = this.#db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    await batch.commit();
    return page.size === 400;
  }

  async close(): Promise<void> {
    await this.#db.terminate();
  }
}

/**
 * One document of `users`, as the rest of the code expects it. Shared by the single read and the
 * listing so the two can never drift — a listing that decoded `enabled` differently from the login
 * path is a screen that shows someone as able to get in while the door says otherwise.
 *
 * ⚠️ `enabled` is read as `!== false`, not as `!!`: a document with no `enabled` field at all is
 * somebody nobody ever disabled, and `undefined` is falsy. Firestore has no `ALTER TABLE`, so the
 * default has to live at the read, or a field added later would lock a whole team out.
 */
function docToUser(d: DocumentData): StoredUser {
  return {
    email: d.email, name: d.name,
    // Firestore hands bytes back as a Buffer already; the copy costs nothing and means the
    // constant-time comparison never receives something that is merely Buffer-like.
    salt: Buffer.from(d.salt), hash: Buffer.from(d.hash),
    mustChangePassword: !!d.must_change, createdAt: d.created_at,
    enabled: d.enabled !== false,
  };
}
