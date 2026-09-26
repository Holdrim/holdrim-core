import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeEmail, isEmailAddress, MAX_EMAIL_LENGTH } from '../core/email.js';

// Re-exported: every route and store implementation already imports these three from here, and
// `engine/core/roles.js` (HOLDRIM_LOCKS) needs the SAME check without pulling in this file's
// node:crypto import — core JavaScript the browser also loads, and this one is not
// (`engine/core/email.js`'s own module comment says why). One definition, two doors onto it,
// rather than two definitions that quietly drift apart.
export { normalizeEmail, isEmailAddress, MAX_EMAIL_LENGTH };

/**
 * Who gets in, with user and password, depending on no provider — and WHERE that is kept.
 *
 * It exists so Holdrim can be used the way Keycloak is: start the image, log in as admin, get to
 * work. With identity coming only from Google IAP, the method would be tied to one specific cloud —
 * anyone outside GCP would have no way to use it.
 *
 * ## Why the storage is pluggable
 *
 * SQLite in a file cannot be the only option: on Cloud Run a file is **ephemeral and per instance**.
 * An access created at 10:00 lives on the instance that served that request; when the platform
 * recycles it, `users.db` goes with it. The person whose account was created simply stops getting
 * in — **no error, no log, nothing to grep**. Nobody discovers this on the day it is configured;
 * they discover it weeks later, when someone says "it forgot me again".
 *
 * So the same choice Keycloak gives is given here: a file for running on a laptop, a real database
 * for a deployment that survives its own instances. The interface below is the whole contract, and
 * `engine/tests/users-conformance.test.js` runs ONE set of tests against every implementation —
 * an implementation that does not pass it is not supported.
 *
 * ## About the passwords
 *
 * - stored with **scrypt** (Node ships it), one salt per person, never in plain text;
 * - comparison in **constant time**, so the response time does not reveal how many characters match;
 * - a hash is derived even for an e-mail that does not exist, or the response time would say who
 *   has an account here;
 * - the admin's initial password is **randomly generated** and shown ONCE in the log of the first
 *   start. "admin/admin" is inviting, but whoever starts it and forgets leaves the door open — and
 *   an internal documentation tool tends to stay up for years with nobody looking;
 * - changing the initial password is **mandatory**: until it changes, the person reaches only the
 *   change screen.
 *
 * ⚠️ All of that lives HERE, in `UserStoreBase`, and not in the implementations. A password hashed
 * one way in SQLite and another way in Postgres is an account that works in one database and not
 * in the other — and the person hits "e-mail or password do not match" with the right password in
 * their hands. The implementations below know about rows. They do not know about scrypt.
 * @module
 */

const derive = promisify(scrypt) as (secret: string, salt: Buffer, length: number) => Promise<Buffer>;

/** scrypt output length, in bytes. Same number for every implementation — see the note above. */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Short enough to type, long enough that guessing is not a strategy.
 *
 * Exported because the login screen states the rule before the person breaks it, and a screen
 * saying "12 or more" next to a server enforcing something else is the kind of mismatch nobody
 * catches until someone is stuck at the door.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * A ceiling on the display name. Generous enough for any real name with its titles, small enough
 * that a name is never a way to push a page of text into every screen that lists people.
 */
export const MAX_NAME_LENGTH = 120;

/**
 * A rule the PERSON broke — not the program. It carries the i18n key so the edge can say it in
 * their language (see engine/core/i18n.js for who reads what).
 *
 * ⚠️ `message` stays English, always. It is what reaches a log and a stack trace, and evidence
 * that changes wording by locale is evidence nobody can grep. The key is the translated half; the
 * message is the greppable half. Both, on purpose.
 */
export class UserInputError extends Error {
  readonly key: string;
  readonly params: Record<string, string | number>;

  constructor(message: string, key: string, params: Record<string, string | number> = {}) {
    super(message);
    this.name = 'UserInputError';
    this.key = key;
    this.params = params;
  }

  /** Anything thrown, as something the edge can translate. An unknown cause gets a generic key. */
  static from(cause: unknown, fallbackKey: string): UserInputError {
    if (cause instanceof UserInputError) return cause;
    return new UserInputError(cause instanceof Error ? cause.message : String(cause), fallbackKey);
  }
}

/** A person, as the rest of the service sees them. No secret in here. */
export interface User {
  email: string;
  name: string;
  mustChangePassword: boolean;
  createdAt: string;
  /**
   * Whether this person may still get in. There is no way to DELETE a person, on purpose.
   *
   * ⚠️ This is the central decision of the whole method, not a convenience. Nothing here is
   * erased: the event store refuses `UPDATE` and `DELETE` by trigger, precisely so that a review
   * history can be trusted years later. An approval is signed by an e-mail, and that signature is
   * what turns a ✓ into evidence. Delete the person and every ✓ they ever gave becomes a tick
   * with no owner — the history still says "approved", and nobody can say by whom, or whether
   * that person had the standing to approve. The trail is half the value of the method; losing
   * it costs more than any row ever saved.
   *
   * So: disabling takes the access away and KEEPS the history. Deleting would destroy the history
   * to save one row. Only the first one exists here.
   */
  enabled: boolean;
}

/**
 * Persistence of people and their sessions. SQLite, Firestore and Postgres implement this.
 *
 * Everything is a promise, including what SQLite could answer straight away: a caller that has to
 * know whether the store is local is a caller that breaks when the store changes.
 */
export interface UserStore {
  /** Creates the person. Returns the password — the generated one when none is given. */
  create(email: string, name: string, password?: string, mustChange?: boolean): Promise<string>;
  /**
   * Checks the password. Returns the person, or null — without saying whether the e-mail exists,
   * and without saying whether they are disabled.
   */
  check(email: string, password: string): Promise<User | null>;
  /**
   * A password the person chose themselves, unlike `resetPassword` — nobody else has seen it, so
   * unlike a reset it does not force a further change.
   *
   * `keepSessionId`, when given, is the caller's OWN session: issue #115. Without it, changing your
   * own password left every OTHER session open too — a stolen cookie survives the very act meant to
   * shut it out, for as long as the cookie's twelve hours have left to run. The fix is the same shape
   * as `resetPassword`'s and `setEnabled`'s (see `deleteSessionsForEmail`): drop every session for
   * the account, except this ONE. `sessionsDropped` is `false` only when that drop failed — the
   * credential itself has already changed either way, for the same reason a failed drop never undoes
   * a reset or a disable: the caller decides what to do with the flag (log it, tell whoever asked),
   * because this class knows neither a request nor a language.
   *
   * Optional, and not the account's only other option, because the one caller that exists —
   * `/api/change-password` — always has a live session by the time it reaches here (every other
   * `/api/*` route requires one first); nothing here NEEDS the drop to be all-or-nothing the way a
   * reset or a disable does. Omitting it drops nothing at all, which is `resetPassword`'s job, not
   * this one's, and passing `false`-shaped nonsense instead of a real id would be worse than saying
   * nothing.
   */
  changePassword(email: string, next: string, keepSessionId?: string): Promise<{ sessionsDropped: boolean }>;
  /**
   * Generates a new password, stores it and returns it to be shown ONCE. Demands a change, because
   * somebody other than its owner has seen it.
   *
   * `sessionsDropped` is `false` when the credential change went through but the delete of the
   * account's old sessions failed — the caller decides what to do with that (log it, tell whoever
   * asked), because this class knows neither a request nor a language. The password is returned
   * regardless: the credential already changed, and withholding it would not undo that.
   */
  resetPassword(email: string): Promise<{ password: string; sessionsDropped: boolean }>;
  find(email: string): Promise<User | null>;
  /**
   * Everyone, ordered by e-mail, disabled people included.
   *
   * Ordered in the STORE and not in the caller: three databases with three natural orders would
   * hand the same team three different lists, and "the third row" would mean something different
   * depending on where the service was deployed.
   *
   * ⚠️ These are `User` objects, so no salt and no hash ever leave here — this list goes straight
   * to an HTTP response.
   */
  list(): Promise<User[]>;
  /**
   * Takes the access away, or gives it back. Never deletes: see the note on `User.enabled`.
   *
   * `sessionsDropped` is `false` only when the flag flipped but the delete of the account's old
   * sessions — the one that runs on the way OUT — failed. Giving the access back never attempts a
   * delete, so it is always `true` there: nothing failed because nothing needed to happen.
   */
  setEnabled(email: string, enabled: boolean): Promise<{ sessionsDropped: boolean }>;
  /** Changes the display name. The e-mail is the identity and does not change. */
  rename(email: string, name: string): Promise<void>;
  /** True when nobody has been created yet: the first-access condition. */
  isEmpty(): Promise<boolean>;
  openSession(email: string, hours?: number): Promise<string>;
  fromSession(id: string | undefined): Promise<User | null>;
  closeSession(id: string | undefined): Promise<void>;
  purgeExpiredSessions(): Promise<void>;
  /**
   * A new agent token for `email` (docs/ROLES.md, section 4), returned to be shown ONCE. One per
   * address: whatever token the address held before stops working the moment this one is written,
   * because it is the same row, overwritten. `replaced` is the previous token's public id, for the
   * trail, or null when there was none — never its secret, which nothing here can give back.
   */
  issueAgentToken(email: string): Promise<{ token: string; agent: AgentToken; tokenId: string; replaced: string | null }>;
  /** Removes the address's token; the public id of the one removed, or null when it held none. */
  revokeAgentToken(email: string): Promise<string | null>;
  /** The agent a presented token belongs to, or null for anything that is not a live token. */
  fromAgentToken(token: string | undefined): Promise<AgentToken | null>;
  /** Every address holding a token, ordered by address. No secret and no hash, ever: it goes to HTTP. */
  listAgentTokens(): Promise<AgentToken[]>;
  close(): Promise<void>;
}

/**
 * An agent's credential as anything outside this file sees it. `kind` is always `'agent'`: the one
 * kind of token this store keeps, written into the row so a later kind cannot be read as this one.
 */
export interface AgentToken {
  email: string;
  kind: 'agent';
  issuedAt: string;
}

/** A token row as a database keeps it: the public id it is found by, and the hash of its secret. */
export interface StoredAgentToken extends AgentToken {
  tokenId: string;
  hash: Buffer;
}

/**
 * The shape of every agent token: a prefix a secret scanner can match, a public id the row is found
 * by, and the secret. Both parts are lower-case hex, so no separator can appear inside either.
 */
export const AGENT_TOKEN_FORMAT = /^holdrim_agent_([0-9a-f]{24})_([0-9a-f]{64})$/;

/** A row as a database keeps it: the profile plus the two things that must never leave this file. */
export interface StoredUser extends User {
  salt: Buffer;
  hash: Buffer;
}

/** A session row. Timestamps are ISO strings everywhere, so they compare the same in every store. */
export interface StoredSession {
  email: string;
  expiresAt: string;
}

// normalizeEmail, isEmailAddress and MAX_EMAIL_LENGTH moved to `engine/core/email.js` and are
// re-exported at the top of this file — see the comment there for why.

/**
 * Everything that must not differ between databases: the hashing, the constant-time comparison,
 * the session lifetime, the minimum password length.
 *
 * An implementation fills in the eleven row operations below and gets the rest for free. That is
 * the point — there is no way for one store to hash differently from another, because none of
 * them hashes at all.
 */
export abstract class UserStoreBase implements UserStore {
  // ------------------------------------------------------------- rows: one per database
  protected abstract insertUser(row: StoredUser): Promise<void>;
  protected abstract readUser(email: string): Promise<StoredUser | null>;
  /**
   * ⚠️ `mustChange` is a PARAMETER and not a constant. The decision belongs to the caller above:
   * somebody who chose their own password owes nothing, somebody handed a generated one has to
   * replace it. Hard-coded here, a password reset would silently leave the person free to keep
   * using a secret an admin had seen.
   */
  protected abstract writeCredential(
    email: string, salt: Buffer, hash: Buffer, mustChange: boolean): Promise<void>;
  protected abstract countUsers(): Promise<number>;
  /** Every row, already ordered by e-mail. The secrets are dropped above, in `list()`. */
  protected abstract readAllUsers(): Promise<StoredUser[]>;
  protected abstract writeEnabled(email: string, enabled: boolean): Promise<void>;
  protected abstract writeName(email: string, name: string): Promise<void>;
  protected abstract insertSession(id: string, email: string, createdAt: string, expiresAt: string): Promise<void>;
  protected abstract readSession(id: string): Promise<StoredSession | null>;
  protected abstract deleteSession(id: string): Promise<void>;
  protected abstract deleteSessionsExpiredBefore(instant: string): Promise<void>;
  /**
   * Every session open under this e-mail, gone. See `setEnabled` and `resetPassword` for why this
   * exists as its own primitive rather than a loop of `deleteSession` calls at the call site: three
   * databases with three ways to "delete where email = X" is still one rule, decided once, here.
   */
  protected abstract deleteSessionsForEmail(email: string): Promise<void>;
  /**
   * Every session open under this e-mail EXCEPT `keepSessionId`, gone — issue #115's own primitive,
   * next to `deleteSessionsForEmail` for the same reason that one exists: one rule, decided once,
   * here, rather than three databases each inventing their own "delete where email = X and id is not
   * mine".
   *
   * ⚠️ It has to be ONE operation, not delete-all-then-reopen. Re-opening a fresh session for the
   * caller after deleting everything would leave a real window — between the delete committing and
   * the new session's insert landing — where a request arriving with the OLD, still-valid cookie
   * finds no session at all and is refused, even though nothing about the caller's own session was
   * ever meant to change. That window is exactly the shape of race #113's fix in `identity-password.
   * ts`'s `signIn` closes for a NEW session; reopening one here to reopen the same hole on a session
   * that already exists would be solving #115 by half-reintroducing #113. `WHERE email = ? AND id !=
   * ?` (or its store's equivalent) has no such window: the caller's row is simply never touched, so
   * there is nothing for a concurrent request to race.
   */
  protected abstract deleteSessionsForEmailExcept(email: string, keepSessionId: string): Promise<void>;
  /**
   * Writes the address's token row, REPLACING any row the address already had, in one statement.
   * Returns the public id of the row it replaced, or null. One statement and not delete-then-insert:
   * between the two, a second issue for the same address could land and leave two live tokens.
   */
  protected abstract writeAgentToken(row: StoredAgentToken): Promise<string | null>;
  protected abstract readAgentTokenById(tokenId: string): Promise<StoredAgentToken | null>;
  /** Every token row, ordered by address. The hashes are dropped above, in `listAgentTokens()`. */
  protected abstract readAllAgentTokens(): Promise<StoredAgentToken[]>;
  /** Deletes the address's token row; the public id of the row deleted, or null when there was none. */
  protected abstract deleteAgentToken(email: string): Promise<string | null>;

  abstract close(): Promise<void>;

  // ------------------------------------------------------------- the part that cannot diverge
  async #hash(password: string, salt: Buffer): Promise<Buffer> {
    // NFKC first: the same password typed on two keyboards can arrive as two different byte
    // sequences, and the person would be locked out by an accent they cannot see.
    return derive(password.normalize('NFKC'), salt, KEY_LENGTH);
  }

  /**
   * A password nobody chose, for a first access and for a reset.
   *
   * One place, so the two paths cannot drift: a reset that produced something weaker than the
   * first-access password would be a quiet downgrade, visible to nobody, on the very operation
   * people reach for when they suspect a credential has leaked.
   */
  #generatePassword(): string {
    return randomBytes(12).toString('base64url');
  }

  async create(email: string, name: string, password?: string, mustChange = true): Promise<string> {
    const chosen = password ?? this.#generatePassword();
    const salt = randomBytes(SALT_LENGTH);
    const hash = await this.#hash(chosen, salt);
    await this.insertUser({
      email: normalizeEmail(email), name, salt, hash,
      mustChangePassword: mustChange, createdAt: new Date().toISOString(),
      // Somebody just created on purpose is somebody who is meant to get in. Being disabled is
      // always an explicit act, never a starting state.
      enabled: true,
    });
    return chosen;
  }

  async check(email: string, password: string): Promise<User | null> {
    const row = await this.readUser(normalizeEmail(email));

    // Derive a hash even with no person. Without this, an unknown e-mail would answer in
    // microseconds and a known one in milliseconds — which hands over who has an account here.
    const salt = row ? row.salt : randomBytes(SALT_LENGTH);
    const computed = await this.#hash(password, salt);
    if (!row) return null;

    if (computed.length !== row.hash.length || !timingSafeEqual(computed, row.hash)) return null;
    // ⚠️ Checked AFTER the hash, and refused exactly the way a wrong password is refused: the same
    // `null`, at the same cost, with the same message at the edge. Answering "this account is
    // disabled" would confirm to anyone who asked that the address has an account here, and would
    // do it without a valid password — the very thing the constant-time comparison above exists to
    // prevent. Whoever was disabled already knows why; whoever is guessing learns nothing.
    if (!row.enabled) return null;
    return profileOf(row);
  }

  async changePassword(email: string, next: string, keepSessionId?: string): Promise<{ sessionsDropped: boolean }> {
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw new UserInputError(
        `a password needs at least ${MIN_PASSWORD_LENGTH} characters`,
        'api.password.tooShort', { min: MIN_PASSWORD_LENGTH });
    }
    const salt = randomBytes(SALT_LENGTH);
    const hash = await this.#hash(next, salt);
    const normalized = normalizeEmail(email);
    // `false`: the person just chose this one themselves, so there is nothing left to demand.
    await this.writeCredential(normalized, salt, hash, false);
    // Issue #115: a session opened under the password that just stopped being valid is exactly as
    // exposed as a stolen credential is — the same reasoning `resetPassword` acts on below — except
    // here the caller is IN one of those sessions right now, having just proved who they are with the
    // old password, and dropping it out from under them would be its own kind of lockout. `undefined`
    // (no caller session known) drops nothing, same as never calling this at all — see the interface
    // doc on why the one real caller never actually takes that branch.
    if (keepSessionId === undefined) return { sessionsDropped: true };
    return { sessionsDropped: await this.#dropSessions(normalized, keepSessionId) };
  }

  /**
   * A brand-new generated password for somebody who lost theirs. Returned to be shown ONCE.
   *
   * It lives here, and not in the route that calls it, for the reason the whole class exists: the
   * generating and the hashing are the parts that must not differ between databases, and a route
   * that generated its own password would be a second place able to get scrypt wrong.
   *
   * ⚠️ It demands a change, unlike `changePassword`. The difference is who picked the password: a
   * reset hands somebody a secret that a THIRD PERSON has seen — whoever ran the reset, plus
   * whatever channel carried it to them. Leaving it in place would mean an admin permanently knows
   * the credential of a person whose ✓ is evidence in the record. Forcing the change makes that
   * window as short as one login.
   */
  async resetPassword(email: string): Promise<{ password: string; sessionsDropped: boolean }> {
    const chosen = this.#generatePassword();
    const salt = randomBytes(SALT_LENGTH);
    const hash = await this.#hash(chosen, salt);
    const normalized = normalizeEmail(email);
    await this.writeCredential(normalized, salt, hash, true);
    // A reset means somebody OTHER than the account's owner has just seen a credential that used to
    // be secret. A session opened under the OLD one is exactly as exposed as that password is — it
    // was handed out over the same "somebody stole it" premise that made the reset worth doing — so
    // it is dropped here, not left to ride out its remaining hours on the strength of a password
    // that no longer means anything.
    const sessionsDropped = await this.#dropSessions(normalized);
    return { password: chosen, sessionsDropped };
  }

  /**
   * ⚠️ Finds disabled people too, on purpose. Management has to be able to SEE whoever it took the
   * access away from — otherwise disabling someone would make them vanish from the screen, which
   * is indistinguishable from deleting them and would quietly recreate the thing `User.enabled`
   * exists to avoid. Whether they may get in is decided in `check` and in `fromSession`.
   */
  async find(email: string): Promise<User | null> {
    const row = await this.readUser(normalizeEmail(email));
    return row ? profileOf(row) : null;
  }

  async list(): Promise<User[]> {
    return (await this.readAllUsers()).map(profileOf);
  }

  async setEnabled(email: string, enabled: boolean): Promise<{ sessionsDropped: boolean }> {
    const normalized = normalizeEmail(email);
    await this.writeEnabled(normalized, enabled);
    // Only on the way OUT. Re-enabling opens no session by itself — the person has to sign in again
    // — so there is nothing to drop, and dropping here would do nothing but cost a query on the
    // path that gives access back. `true`: vacuously, nothing failed, because nothing ran.
    //
    // ⚠️ This is what turns "disabling drops the open session" from true for twelve hours into true
    // for good. A stolen cookie is 401 the moment it is disabled either way — `fromSession` refuses
    // it below — but that alone means "dead while disabled". Without THIS delete, the day the
    // account is re-enabled the row is still there with a still-valid expiry, and the same stolen
    // cookie is 200 again for whatever is left of its twelve hours: exactly the story issue #113
    // reproduced, where disable → reset → re-enable ends with the thief still in.
    if (!enabled) return { sessionsDropped: await this.#dropSessions(normalized) };
    return { sessionsDropped: true };
  }

  /**
   * Deletes every session for an e-mail — or every session but one, when `keepSessionId` names it —
   * and says whether it worked, never by throwing.
   *
   * ⚠️ By the time this runs, `writeCredential` or `writeEnabled` has ALREADY committed — the
   * access change is real, whatever happens next. Letting a failed delete here reject the whole
   * `resetPassword`, `setEnabled` or `changePassword` call would turn a real, already-applied change
   * into a 500 with NO `user_password_reset`, `user_enabled_changed` or `password_changed` line in
   * the audit log: the one record of who did this and to whom simply would not exist, for a change
   * that certainly happened. The write-then-delete order stays — the alternative was rejected once
   * already, in the sign-in race `identity-password.ts` guards against — so what changes here is only
   * that the delete's own failure does not also swallow the record of the write that preceded it.
   *
   * The failure is not allowed to vanish either: it means some number of that account's sessions
   * may still be alive, silently, which is a real gap in exactly the guarantee issue #113 exists
   * for. It used to be `console.error` with the e-mail in the message — this class knows no
   * request, no actor and no i18n, so it had no other channel to reach. That put the one thing
   * docs/PRIVACY.md says a log must never carry (the address, where an id belongs) into the log,
   * and told nobody who asked that anything had gone wrong. Both are fixed the same way: the
   * failure is handed back as a plain boolean, so the route above — which HAS the request, the
   * person's id and the JSON answer the caller reads — can log it and report it instead.
   */
  async #dropSessions(email: string, keepSessionId?: string): Promise<boolean> {
    try {
      if (keepSessionId === undefined) await this.deleteSessionsForEmail(email);
      else await this.deleteSessionsForEmailExcept(email, keepSessionId);
      return true;
    } catch {
      return false;
    }
  }

  async rename(email: string, name: string): Promise<void> {
    const trimmed = name.trim();
    // An empty name is not a name, and it is the one that does real damage: the history would show
    // an approval signed by a blank, and "who said this?" would have no answer on the screen even
    // though the e-mail is still in the row.
    if (!trimmed) {
      throw new UserInputError('a name cannot be empty', 'api.name.empty');
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      throw new UserInputError(
        `a name is at most ${MAX_NAME_LENGTH} characters`,
        'api.name.tooLong', { max: MAX_NAME_LENGTH });
    }
    await this.writeName(normalizeEmail(email), trimmed);
  }

  async isEmpty(): Promise<boolean> {
    return (await this.countUsers()) === 0;
  }

  // ------------------------------------------------------------- sessions
  async openSession(email: string, hours = 12): Promise<string> {
    const id = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.insertSession(
      id, normalizeEmail(email), now.toISOString(),
      new Date(now.getTime() + hours * 3600_000).toISOString());
    return id;
  }

  async fromSession(id: string | undefined): Promise<User | null> {
    if (!id) return null;
    const session = await this.readSession(id);
    // Expiry is decided here, against the service's clock, and not by each database's own idea of
    // "now". A session that is dead in SQLite and alive in Postgres is not one product.
    if (!session || session.expiresAt < new Date().toISOString()) return null;
    const person = await this.find(session.email);
    // ⚠️ Checked on EVERY request, not only at login — DEFENCE IN DEPTH, not the only guard any
    // more. `setEnabled(false)` and `resetPassword` delete every session for the account (see
    // both, in this file), so the row this call just read should not exist at all once somebody has
    // been disabled or reset. This check is what still catches it when that deletion did not
    // happen: a store whose `deleteSessionsForEmail` silently no-ops, a future write path that
    // flips `enabled` without going through `setEnabled`, or the narrow window between a login's
    // `check()` passing and its `openSession()` landing, racing a concurrent disable. Deleting the
    // row was added because relying on THIS alone let a stolen cookie come back to life on
    // re-enable — the row survived the disable, still valid, waiting — so the two now do different
    // jobs: the delete makes "disabled" permanent, this makes a missed delete non-fatal.
    if (!person?.enabled) return null;
    return person;
  }

  async closeSession(id: string | undefined): Promise<void> {
    if (id) await this.deleteSession(id);
  }

  async purgeExpiredSessions(): Promise<void> {
    await this.deleteSessionsExpiredBefore(new Date().toISOString());
  }

  // ------------------------------------------------------------- agent tokens
  /**
   * The stored form of a token's secret: plain SHA-256, no salt, no scrypt — and that is a choice,
   * not a shortcut. scrypt and a salt exist for a PASSWORD, which a person picks from a small space
   * an attacker can enumerate; the slowness is what makes each guess expensive. This secret is 32
   * bytes from `randomBytes`, never chosen by anyone: 2^256 possibilities leave nothing to enumerate,
   * so a slow hash would add nothing an attacker has to pay, and would charge scrypt's 50 ms to every
   * API call the agent makes instead. A salt protects a guessable value from a precomputed table;
   * nobody can precompute a table of random 256-bit values. What the hash still buys: a copy of the
   * users database hands over no token anyone can present.
   */
  #tokenHash(secret: string): Buffer {
    return createHash('sha256').update(secret, 'utf8').digest();
  }

  async issueAgentToken(email: string): Promise<{ token: string; agent: AgentToken; tokenId: string; replaced: string | null }> {
    const tokenId = randomBytes(12).toString('hex');
    const secret = randomBytes(32).toString('hex');
    const agent: AgentToken = { email: normalizeEmail(email), kind: 'agent', issuedAt: new Date().toISOString() };
    const replaced = await this.writeAgentToken({ ...agent, tokenId, hash: this.#tokenHash(secret) });
    // The secret leaves here once, inside `token`, and is kept nowhere: from the next line on only its
    // hash exists, so "shown once" is a property of the store, not a promise every caller has to keep.
    return { token: `holdrim_agent_${tokenId}_${secret}`, agent, tokenId, replaced };
  }

  async revokeAgentToken(email: string): Promise<string | null> {
    return this.deleteAgentToken(normalizeEmail(email));
  }

  /**
   * Whose token this is, or null. Every refusal is the same `null` — malformed, unknown id, wrong
   * secret — so the answer says nothing about which part was wrong.
   *
   * ⚠️ `timingSafeEqual`, never `equals` or `===`: the id finds the row, and an attacker who knows an
   * id (it is in the trail) could otherwise time how many leading bytes of a guessed hash match and
   * walk towards the stored one byte by byte. Comparing hashes, not secrets, already blunts that; the
   * constant-time compare removes it, for the cost of nothing. `agent-tokens.test.js` holds the line
   * to this call, since no test can see a timing difference on its own.
   */
  async fromAgentToken(token: string | undefined): Promise<AgentToken | null> {
    const parts = AGENT_TOKEN_FORMAT.exec(token ?? '');
    if (!parts) return null;
    const row = await this.readAgentTokenById(parts[1]!);
    if (!row) return null;
    const presented = this.#tokenHash(parts[2]!);
    if (presented.length !== row.hash.length || !timingSafeEqual(presented, row.hash)) return null;
    // Read back from the row, never assumed: a row some future kind wrote must not pass as an agent's.
    if (row.kind !== 'agent') return null;
    return tokenProfileOf(row);
  }

  async listAgentTokens(): Promise<AgentToken[]> {
    return (await this.readAllAgentTokens()).map(tokenProfileOf);
  }
}

/** Drops the hash and the id. Every token that leaves this file goes through here. */
function tokenProfileOf(row: StoredAgentToken): AgentToken {
  return { email: row.email, kind: row.kind, issuedAt: row.issuedAt };
}

/** Drops the secret. Anything that leaves this file goes through here. */
function profileOf(row: StoredUser): User {
  return {
    email: row.email, name: row.name,
    mustChangePassword: row.mustChangePassword, createdAt: row.createdAt,
    enabled: row.enabled,
  };
}

/** Where SQLite writes when nothing is configured. The tool has to work with no configuration. */
export const DEFAULT_SQLITE_PATH = './data/users.db';

/**
 * Reads `HOLDRIM_USERS` and opens the store it names.
 *
 *   (absent)              | SQLite at `HOLDRIM_USERS_PATH`, or at the default path
 *   sqlite:<path>         | SQLite in that file. `sqlite::memory:` for a throwaway one
 *   firestore             | Firestore, in the project given by `HOLDRIM_PROJECT`
 *   postgres://…          | Postgres. `postgresql://…` too — libpq accepts both
 *
 * Each implementation is imported only when it is chosen: whoever runs on SQLite should not load
 * the Firestore client, and whoever never touches Postgres should not have to install `pg`.
 */
export async function openUserStore(
  url: string | undefined,
  options: { projectId?: string; sqlitePath?: string } = {},
): Promise<UserStore> {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  const chosen = (url ?? '').trim();

  if (chosen === '' || chosen === 'sqlite') {
    const { UsersSqlite } = await import('./users-sqlite.ts');
    return new UsersSqlite(sqlitePath);
  }
  if (chosen.startsWith('sqlite:')) {
    const { UsersSqlite } = await import('./users-sqlite.ts');
    return new UsersSqlite(sqlitePathOf(chosen));
  }
  if (chosen === 'firestore') {
    if (!options.projectId) throw new Error('firestore needs HOLDRIM_PROJECT');
    const { UsersFirestore } = await import('./users-firestore.ts');
    return new UsersFirestore(options.projectId);
  }
  if (chosen.startsWith('postgres://') || chosen.startsWith('postgresql://')) {
    const { UsersPostgres } = await import('./users-postgres.ts');
    return new UsersPostgres(chosen);
  }
  // ⚠️ The value is masked before it goes into the message, and this is not caution for its own
  // sake: a typo as ordinary as `Postgres://` or a missing slash lands here, and the string
  // contains `user:password@host`. The message reaches console.error, which on a hosted runtime is
  // the log collector — readable by anyone who can read logs. Elsewhere this project takes care
  // to log the KIND and never the URL; an unmasked message here would undo it.
  throw new Error(
    `HOLDRIM_USERS="${maskCredentials(chosen)}" is not recognised `
    + '(use sqlite:<path>, firestore, postgres://… or postgresql://…)');
}

/**
 * Does this value end up keeping people in a FILE on the local disk?
 *
 * Absent and `sqlite` both land on SQLite at a path, so both count. `sqlite::memory:` does not:
 * it is already understood to be thrown away, and warning about it would be noise. Anything else
 * — firestore, postgres, or a value this factory does not recognise — is not a local file.
 */
export function isFileBackedUserStore(url: string | undefined): boolean {
  const chosen = (url ?? '').trim();
  if (chosen === '' || chosen === 'sqlite') return true;
  if (!chosen.startsWith('sqlite:')) return false;
  return sqlitePathOf(chosen) !== ':memory:';
}

/**
 * Does the runtime look like one whose disk does not survive the instance?
 *
 * ⚠️ `K_SERVICE` is a SIGNAL, not a certainty. It is what Cloud Run sets on every instance, and
 * it is the cheapest reliable evidence available at boot — but a container on Fly, App Runner or
 * a Kubernetes pod with no volume loses a file just as quietly, and each announces itself with a
 * different variable. This list is expected to GROW. A `false` here means "no evidence", never
 * "the disk is safe".
 */
export function looksEphemeral(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.K_SERVICE);
}

/**
 * The boot warning for the combination that loses people, or `null` when there is nothing to say.
 *
 * ⚠️ It says what WILL happen and what to do instead, because "warning: ephemeral storage" is a
 * line everybody scrolls past. The failure it describes is silent by nature — the account is
 * simply gone and nobody connects it to a deploy — so this line is the only chance anyone gets to
 * connect the two.
 *
 * English and hard-coded, NOT through i18n: this prints before there is a session, a person or a
 * chosen language. The comment at the top of engine/core/i18n.js is the long version.
 *
 * ⚠️ Both halves of the condition matter equally. A warning that shows up on a laptop, where a
 * file is exactly the right answer, is a warning people learn to ignore — and then it protects
 * nothing on the day it is true.
 */
export function ephemeralUserStoreWarning(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isFileBackedUserStore(url) || !looksEphemeral(env)) return null;
  return 'users are kept in a file on a disk that looks ephemeral (K_SERVICE is set). '
    + 'Accounts created here vanish when the platform recycles the instance, with no error and no '
    + 'log: the person simply stops being able to sign in. '
    + 'Set HOLDRIM_USERS=firestore (with HOLDRIM_PROJECT) or HOLDRIM_USERS=postgres://… to keep them.';
}

/** Hides `user:password@` in anything URL-shaped, so a connection string can be quoted safely. */
export function maskCredentials(value: string): string {
  return value.replace(/:\/\/[^@/]*@/, '://***@');
}

/**
 * `sqlite:./data/x.db`, `sqlite:/var/lib/x.db` and `sqlite::memory:` all have to land on the path
 * SQLite expects. The `//` form is accepted too, because everyone writes URLs that way at least
 * once.
 */
function sqlitePathOf(url: string): string {
  const rest = url.slice('sqlite:'.length);
  return rest.startsWith('//') ? rest.slice(2) : rest;
}
