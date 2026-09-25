import { MAX_EMAIL_LENGTH, type User, type UserStore } from './users.ts';

/**
 * Identity by user and password, inside the service itself — the alternative to Google IAP.
 *
 * It is what lets Holdrim be used the way Keycloak is: start it, log in, work. No cloud account
 * anywhere, no external provider.
 *
 * The session lives in a `httpOnly` + `SameSite=Strict` cookie: page JavaScript cannot read it (so
 * an XSS does not steal the session) and it does not travel on a request coming from another site
 * (so there is no CSRF by navigation). `Secure` stays on outside development.
 */
export const SESSION_COOKIE = 'holdrim_session';

export class PasswordIdentity {
  #users: UserStore;
  #secure: boolean;

  constructor(users: UserStore, options: { secure?: boolean } = {}) {
    this.#users = users;
    this.#secure = options.secure ?? true;
  }

  get users() { return this.#users; }

  /**
   * Creates the first access, if nobody exists yet. The password is generated and returned to be
   * shown ONCE, in the log of the first start.
   */
  async firstAccess(email: string, name = 'Administration'): Promise<string | null> {
    if (!(await this.#users.isEmpty())) return null;
    return this.#users.create(email, name);
  }

  /**
   * Failed attempts per e-mail, and when the wait ends.
   *
   * ⚠️ In memory on purpose, and that is a real limitation worth knowing: with more than one
   * instance, each counts on its own, and restarting forgets everything. It still raises the cost
   * of an online brute force by orders of magnitude, and putting it in the store would mean a write
   * on every wrong password — which is a denial of service someone can trigger for free.
   * The real fix is a shared cache, and it is not worth the dependency today.
   */
  #failures = new Map<string, { count: number; freeAt: number }>();

  /**
   * A ceiling on the memory this can cost, and it is not academic.
   *
   * The key is the e-mail AS IT ARRIVED IN THE REQUEST BODY, and `/api/sign-in` is the one route
   * that answers without a session. So anybody, with no credential at all, could POST a different
   * invented address in a loop and add one permanent entry per request until the process ran out
   * of memory: without a ceiling, the only thing that removes an entry is a SUCCESSFUL login of
   * that same key — which an attacker has no reason to perform.
   *
   * Two limits, because one would not be enough: a cap on how long a key may be (an e-mail is not
   * a megabyte), and a prune of entries whose wait ended long ago. Past the cap, the oldest go.
   */
  // The same ceiling users.ts puts on an address it stores, read from there: two copies of one
  // limit are two numbers that will one day disagree about what an address is.
  static readonly MAX_EMAIL = MAX_EMAIL_LENGTH;
  static readonly MAX_PASSWORD = 256;   // scrypt on a megabyte of text is a CPU bill, not a login
  static readonly MAX_TRACKED = 10_000;

  /** Overridable so a test can prove the ceiling in milliseconds instead of minutes. */
  #maxTracked = PasswordIdentity.MAX_TRACKED;
  set maxTracked(n: number) { this.#maxTracked = n; }

  /** How many e-mails are being counted right now. Exists so a test can prove the ceiling holds. */
  tracked(): number { return this.#failures.size; }

  /** Forgets whoever finished their wait more than an hour ago, then trims the oldest if needed. */
  #prune() {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, f] of this.#failures) if (f.freeAt < cutoff) this.#failures.delete(k);
    // Map preserves insertion order, so the front is the oldest. Dropping a counter is safe: the
    // worst case is someone getting five fresh free attempts, which is the normal state anyway.
    while (this.#failures.size > this.#maxTracked) {
      this.#failures.delete(this.#failures.keys().next().value!);
    }
  }

  /**
   * How long the wait is after N failures. Free up to the fifth, then doubling, capped at 15
   * minutes.
   *
   * Five free because that is the range of a person mistyping, and a tool that punishes typing is
   * a tool people route around. The cap exists because a wait long enough to be indistinguishable
   * from "the account is gone" stops protecting anything and starts costing support.
   */
  #waitAfter(count: number): number {
    if (count <= 5) return 0;
    return Math.min(2 ** (count - 6) * 5_000, 15 * 60_000);
  }

  /**
   * How long this e-mail still has to wait, in seconds. Zero means it may try.
   *
   * The count is per e-mail and NOT per IP: behind a proxy every request shares one address, and
   * locking by IP would let one person lock out an entire office.
   */
  remainingWait(email: string): number {
    const f = this.#failures.get(email.trim().toLowerCase());
    if (!f) return 0;
    return Math.max(0, Math.ceil((f.freeAt - Date.now()) / 1000));
  }

  async signIn(email: string, password: string): Promise<{ user: User; session: string } | null> {
    const user = await this.#verify(email, password);
    if (!user) return null;
    const session = await this.#users.openSession(user.email);
    // ⚠️ Re-checked with the SAME password, AFTER the session row exists — not merely trusting the
    // `#verify` above. `setEnabled(false)` and `resetPassword` delete every session for an account,
    // but only the sessions that exist AT THAT MOMENT: one that lands in the gap between `#verify`
    // reading the old row and `openSession` inserting this one is not there yet to be caught, and
    // survives untouched — issue #113's fix closes the gap after a session exists, not the one
    // before it exists. Every ordering of a concurrent disable-or-reset against this pair of calls
    // reduces to one of two outcomes: either it lands AFTER this session is inserted, in which case
    // its own delete already takes this session with it, or it lands BEFORE — which means it also
    // landed before `#verify`, or `#verify` would have refused the old password outright — and in
    // that case THIS check, run against whatever the store holds now, fails the same way the first
    // one would have: a changed hash stops matching, a flipped `enabled` is refused inside `check`
    // itself. Either path ends with no live session for a password or an account that no longer
    // authorises one.
    if (!(await this.#users.check(email, password))) {
      await this.#users.closeSession(session);
      return null;
    }
    return { user, session };
  }

  /**
   * The current password of someone already signed in, as `change-password` asks for it — counted
   * against the same e-mail as a sign-in. Checked with no counter at all, a stolen session could
   * guess the password itself as fast as scrypt answers, and keep it for later.
   */
  checkCurrent(email: string, password: string): Promise<User | null> {
    return this.#verify(email, password);
  }

  /** A password check at any door that asks for one, with the wait that follows a wrong one. */
  async #verify(email: string, password: string): Promise<User | null> {
    // Refused before the Map is touched and before scrypt runs: an oversized field is not a login
    // attempt, it is an attempt to make the server work. Costs nothing to say no.
    if (email.length > PasswordIdentity.MAX_EMAIL || password.length > PasswordIdentity.MAX_PASSWORD) {
      return null;
    }
    const key = email.trim().toLowerCase();
    const locked = this.remainingWait(key) > 0;

    // ⚠️ An attempt made DURING the wait still counts. Without this the wait never escalates:
    // whoever is guessing simply pauses five seconds between bursts and keeps going forever, and
    // the doubling above would be decoration. It also means an impatient person who keeps hammering
    // makes their own wait longer — which is the right trade, because the alternative is no
    // protection at all.
    // Checked even while locked, and the cost is the point: answering a locked attempt instantly
    // while a real one takes 50ms of scrypt would tell whoever is guessing exactly when the wait
    // is on, which is half of what they wanted to learn.
    const user = await this.#users.check(email, password);

    if (locked || !user) {
      const f = this.#failures.get(key) ?? { count: 0, freeAt: 0 };
      f.count++;
      f.freeAt = Date.now() + this.#waitAfter(f.count);
      this.#failures.set(key, f);
      this.#prune();
      // Pruned AFTER inserting, not before: pruning first leaves the new entry sitting one above
      // the ceiling, which is exactly how a ceiling stops being one.
      return null;
    }
    // Only a successful login clears it. Clearing on any attempt would let an attacker reset the
    // counter by interleaving a login they know to be valid.
    this.#failures.delete(key);
    return user;
  }

  /**
   * The caller, taken from the cookie. Null = not authenticated.
   *
   * A promise even though SQLite could answer right away: the store may be Postgres or Firestore,
   * over the network, and a caller written against the synchronous version would silently pass a
   * pending promise around as if it were a person.
   */
  async fromRequest(headers: Record<string, string | string[] | undefined>): Promise<User | null> {
    return this.#users.fromSession(this.#readCookie(headers, SESSION_COOKIE));
  }

  /**
   * The session id on this request's cookie, or `undefined` with none. Public because
   * `/change-password` needs it to name the one session it must NOT drop — issue #115: changing your
   * own password must not sign out the tab you changed it from. Before this, that route and
   * `/sign-out` each read the cookie their own way (`/sign-out`'s own regex, hard-coded to the
   * string `holdrim_session` rather than the `SESSION_COOKIE` it could drift from); one method
   * against the one constant is what keeps a future rename of the cookie from having two places to
   * remember, this one included.
   */
  sessionIdFrom(headers: Record<string, string | string[] | undefined>): string | undefined {
    return this.#readCookie(headers, SESSION_COOKIE);
  }

  /**
   * `SameSite=Strict` IS the CSRF defence here, and it is the only one: current browsers never
   * attach this cookie to a request started by another site, so a forged POST arrives with no
   * session and is refused like any anonymous call. There is no single-use token generator here
   * for that reason: one that nothing calls is dead code in an auth file, and dead code in an auth
   * file is what someone wires up by mistake later, trusting a protection that was never exercised.
   *
   * A token becomes necessary again the day a form is meant to POST here from ANOTHER origin:
   * that requires loosening `SameSite`, and loosening it is what brings CSRF back.
   */
  sessionCookie(id: string, hours = 12): string {
    const parts = [
      `${SESSION_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${hours * 3600}`,
    ];
    if (this.#secure) parts.push('Secure');
    return parts.join('; ');
  }

  signOutCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  #readCookie(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const raw = headers.cookie;
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (!text) return undefined;
    for (const part of text.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === name) return v.join('=');
    }
    return undefined;
  }
}
