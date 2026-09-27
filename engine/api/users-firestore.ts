import { Firestore, type DocumentData, type WhereFilterOp } from '@google-cloud/firestore';
import {
  AddressInUse, UserStoreBase, type RemovedChange, type SignInFailures, type StoredAgentToken, type StoredSession, type StoredUser,
} from './users.ts';

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
    // A transaction that reads the address's token document, so a token issued between that read
    // and this create aborts one of the two, and the retry sees the other (`writeAgentToken`,
    // users.ts). `create`, still, so an existing account refuses the write as it always did.
    const token = this.#db.collection('agent_tokens').doc(row.email);
    await this.#db.runTransaction(async (tx) => {
      if ((await tx.get(token)).exists) throw new AddressInUse(row.email, 'agentToken');
      tx.create(this.#db.collection('users').doc(row.email), {
        email: row.email, name: row.name, salt: row.salt, hash: row.hash,
        must_change: row.mustChangePassword, created_at: row.createdAt,
        enabled: row.enabled, removed: row.removed === true,
      });
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

  /**
   * A document's id cannot change, so a row given a new key moves: the closed copy created under it
   * and the address's document deleted, with every session naming the address, in one transaction.
   * `create`, so a key already taken refuses rather than overwrites. A row keeping its key is updated
   * in place.
   */
  protected async writeRemoved(email: string, change: RemovedChange): Promise<boolean> {
    const users = this.#db.collection('users');
    const account = users.doc(email);
    const sessions = this.#db.collection('sessions').where('email', '==', email);
    return this.#db.runTransaction(async (tx) => {
      const row = await tx.get(account);
      if (!row.exists) return false;
      const open = await tx.get(sessions);
      const fields = {
        enabled: false, removed: true,
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.salt ? { salt: change.salt } : {}),
        ...(change.hash ? { hash: change.hash } : {}),
      };
      if (change.key === email) {
        tx.update(account, fields);
      } else {
        tx.create(users.doc(change.key), { ...row.data(), ...fields, email: change.key });
        tx.delete(account);
      }
      for (const session of open.docs) tx.delete(session.ref);
      return true;
    });
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

  // The document id is the SHA-256 of the cookie's session id, never the id: users-sqlite.ts says why.
  protected async insertSession(key: string, email: string, createdAt: string, expiresAt: string): Promise<void> {
    await this.#db.collection('sessions').doc(key).create({
      email, created_at: createdAt, expires_at: expiresAt,
    });
  }

  protected async readSession(key: string): Promise<StoredSession | null> {
    const d = (await this.#db.collection('sessions').doc(key).get()).data();
    return d ? { email: d.email, expiresAt: d.expires_at } : null;
  }

  protected async deleteSession(key: string): Promise<void> {
    await this.#db.collection('sessions').doc(key).delete();
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

  protected async deleteSessionsForEmailExcept(email: string, keepKey: string): Promise<void> {
    // Looped for the same reason as `deleteSessionsForEmail` above: every OTHER session has to be
    // gone, not "most of them, eventually" (issue #115, the same gap #113 named for a disable or a
    // reset). The kept id is excluded IN THIS FILE, after the query, rather than as a second `where`
    // clause: Firestore's document id lives at `__name__`, and a query combining an equality filter
    // on `email` with an inequality on `__name__` would need a composite index this project does not
    // otherwise require, to exclude exactly one document a plain filter in JavaScript excludes for
    // free.
    while (await this.#deleteSessionPage('email', '==', email, keepKey));
  }

  /**
   * Deletes one page of at most 400 sessions matching a single-field query — skipping `excludeId`
   * when it is one of them — and reports whether the page was FULL — meaning the 400 limit decided
   * where it stopped, not the data running out, so the caller cannot yet tell this was the last one
   * and has to ask again.
   *
   * ⚠️ "Full" is judged by how many documents the QUERY returned, not by how many this call deleted:
   * with `excludeId` set, a page can return 400 matches and delete only 399 of them, and the loop
   * above still has to run again for whatever is past this page — reading the deleted count instead
   * would stop one page early and leave a session alive that was never meant to survive. The
   * excluded document itself never keeps the loop going by itself: once it is the only match left,
   * the query returns exactly one document, and one is never 400.
   *
   * 400 and not Firestore's own ceiling of 500 writes per batch: it leaves room in a batch for
   * whatever else Firestore or a client library adds around a commit, rather than sitting exactly
   * on the edge of a limit that is not this file's to spend in full.
   */
  async #deleteSessionPage(field: string, op: WhereFilterOp, value: unknown, excludeId?: string): Promise<boolean> {
    const page = await this.#db.collection('sessions').where(field, op, value).limit(400).get();
    if (page.empty) return false;
    const batch = this.#db.batch();
    let queued = 0;
    for (const doc of page.docs) {
      if (doc.id === excludeId) continue;
      batch.delete(doc.ref);
      queued++;
    }
    // A batch with nothing in it is a Firestore round trip for no reason — the whole page was the
    // one document being kept.
    if (queued > 0) await batch.commit();
    return page.size === 400;
  }

  /**
   * The document id is the address, as in `users`: one document per agent, so a second issue
   * OVERWRITES the first and the old token has no document left to be found by. Read and written in
   * one transaction so the id it reports as replaced is the one it actually replaced, and so an
   * account created for the address after the read aborts it (`insertUser` reads this document).
   */
  protected async writeAgentToken(row: StoredAgentToken): Promise<string | null> {
    const ref = this.#db.collection('agent_tokens').doc(row.email);
    const account = this.#db.collection('users').doc(row.email);
    return this.#db.runTransaction(async (tx) => {
      if ((await tx.get(account)).exists) throw new AddressInUse(row.email, 'account');
      const before = (await tx.get(ref)).data();
      tx.set(ref, { email: row.email, kind: row.kind, token_id: row.tokenId, hash: row.hash, issued_at: row.issuedAt });
      return (before?.token_id as string | undefined) ?? null;
    });
  }

  protected async readAgentTokenById(tokenId: string): Promise<StoredAgentToken | null> {
    // A query on one field, which Firestore indexes by itself, and strongly consistent: a token
    // revoked or replaced a moment ago is not found by the next request, on any instance.
    const found = await this.#db.collection('agent_tokens').where('token_id', '==', tokenId).limit(1).get();
    return found.empty ? null : docToToken(found.docs[0]!.data());
  }

  protected async readAllAgentTokens(): Promise<StoredAgentToken[]> {
    const all = await this.#db.collection('agent_tokens').orderBy('__name__').get();
    return all.docs.map((doc) => docToToken(doc.data()));
  }

  protected async deleteAgentToken(email: string): Promise<string | null> {
    const ref = this.#db.collection('agent_tokens').doc(email);
    return this.#db.runTransaction(async (tx) => {
      const before = (await tx.get(ref)).data();
      if (!before) return null;
      tx.delete(ref);
      return (before.token_id as string | undefined) ?? null;
    });
  }

  // ------------------------------------------------------------- wrong passwords
  // Collection `sign_in_failures`, one document per key (users.ts, `failureKey`): users-sqlite.ts
  // says what it is for.
  protected async readFailure(key: string): Promise<SignInFailures | null> {
    return docToFailure((await this.#db.collection('sign_in_failures').doc(key).get()).data());
  }

  protected async updateFailure(
    key: string, next: (current: SignInFailures | null) => SignInFailures | null): Promise<void> {
    // A transaction, so a second wrong password landing between the read and the write aborts one
    // of the two and the retry counts on top of the other — the reason `next` has to be pure.
    const ref = this.#db.collection('sign_in_failures').doc(key);
    await this.#db.runTransaction(async (tx) => {
      const row = next(docToFailure((await tx.get(ref)).data()));
      if (row === null) tx.delete(ref);
      else tx.set(ref, { count: row.count, last_at: row.lastAt, escalated: row.escalated, evict_order: evictOrder(row) });
    });
  }

  protected async pruneFailures(lastBefore: string, keep: number): Promise<void> {
    const failures = this.#db.collection('sign_in_failures');
    // One page of the stale ones and no loop, like `deleteSessionsExpiredBefore`: this runs after
    // every wrong password, so whatever one page leaves, the next wrong password takes.
    const stale = await failures.where('last_at', '<', lastBefore).limit(400).get();
    const batch = this.#db.batch();
    for (const doc of stale.docs) batch.delete(doc.ref);
    if (!stale.empty) await batch.commit();
    // The ceiling, which the page above does not give: an attacker's invented addresses are all
    // fresh. `count()` is billed by index entries read, a fraction of reading the documents.
    const over = (await failures.count().get()).data().count - keep;
    if (over <= 0) return;
    // By `evict_order`, the ranking SQLite and Postgres write as `ORDER BY escalated, last_at`, held
    // in one field: two, one of them an inequality, would need a composite index this project does
    // not otherwise require.
    const oldest = await failures.orderBy('evict_order').limit(Math.min(over, 400)).get();
    const trim = this.#db.batch();
    for (const doc of oldest.docs) trim.delete(doc.ref);
    await trim.commit();
  }

  protected async countFailures(): Promise<number> {
    return (await this.#db.collection('sign_in_failures').count().get()).data().count;
  }

  protected async readOrWriteValue(name: string, fresh: Buffer): Promise<Buffer> {
    // Collection `store_values`, one document per name: users-sqlite.ts says what it is for. In a
    // transaction, so two instances creating it at once end with one value, read by both.
    const ref = this.#db.collection('store_values').doc(name);
    return this.#db.runTransaction(async (tx) => {
      const before = (await tx.get(ref)).data();
      if (before) return Buffer.from(before.value);
      tx.create(ref, { value: fresh });
      return fresh;
    });
  }

  async close(): Promise<void> {
    await this.#db.terminate();
  }
}

/** One document of `sign_in_failures`, or null for none. */
function docToFailure(d: DocumentData | undefined): SignInFailures | null {
  return d ? { count: Number(d.count), lastAt: d.last_at, escalated: d.escalated === true } : null;
}

/**
 * The order rows leave in when the ceiling is reached, as ONE string: rows not escalated first
 * (`0`), then escalated ones (`1`), each oldest first — an ISO date of one fixed shape sorts as
 * the instant it names.
 */
function evictOrder(row: SignInFailures): string {
  return `${row.escalated ? 1 : 0}|${row.lastAt}`;
}

/** One document of `agent_tokens`, shaped as `users.ts` expects it. */
function docToToken(d: DocumentData): StoredAgentToken {
  return { email: d.email, kind: d.kind, tokenId: d.token_id, hash: Buffer.from(d.hash), issuedAt: d.issued_at };
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
    // Absent on every document written before removal existed, and on every account never removed.
    removed: d.removed === true,
  };
}
