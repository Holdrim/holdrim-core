import { MAX_EMAIL_LENGTH, type SignInFailures, type User, type UserStore } from './users.ts';

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
   * Wrong passwords are counted in the USER STORE, per address as typed — every instance reads the
   * same count, and a restart forgets nothing.
   *
   * In memory instead, the count resets on every restart and is kept separately by every instance:
   * whoever can make the service restart — a deploy, a crash, a platform recycling an idle
   * instance — gets a fresh set of free guesses each time, and N instances give N times the
   * guesses. The price is a write on every wrong password, which is small next to what each one
   * already costs the server: a read of the account and a scrypt, tens of milliseconds of CPU,
   * before the write is even reached.
   *
   * The shape, and what each part of it refuses:
   *
   * - **Keyed by the address as typed, not by the account.** An address nobody has is counted,
   *   written, pruned and waited on exactly like one somebody has — the same reads, the same write,
   *   the same answer. Counting only real accounts would put a write on the known-address path and
   *   none on the other, and the time a wrong password takes would say who has an account here,
   *   which `check` spends a whole scrypt on an unknown address to hide.
   * - **Stored under a hash of the address, never the address** (`users.ts`, `#failureKey`): the
   *   table is a record of what people typed at a sign-in form, and most of it names nobody here.
   * - **Bounded twice.** A row is forgotten an hour after its wait ends, and past `MAX_TRACKED`
   *   rows the least recently failed go: an attacker posting a new invented address per request adds
   *   a row each time, and without the ceiling the only thing that ever removed one was a successful
   *   sign-in of that same address, which an attacker has no reason to make.
   * - **Facts, not deadlines.** A row keeps the count and when the last wrong one came; the wait is
   *   worked out on reading, and never longer than the count allows (`#waitOf`). Stored as a
   *   deadline, a clock stepped back an hour would stretch every wait by an hour.
   */
  static readonly MAX_TRACKED = 10_000;

  // The same ceiling users.ts puts on an address it stores, read from there: two copies of one
  // limit are two numbers that will one day disagree about what an address is.
  static readonly MAX_EMAIL = MAX_EMAIL_LENGTH;
  static readonly MAX_PASSWORD = 256;   // scrypt on a megabyte of text is a CPU bill, not a login

  /** The longest a wait gets, and how long a count is kept after its wait ends. */
  static readonly MAX_WAIT_MS = 15 * 60_000;
  static readonly FORGET_AFTER_MS = 3_600_000;

  /** Overridable so a test can prove the ceiling in milliseconds instead of minutes. */
  #maxTracked = PasswordIdentity.MAX_TRACKED;
  set maxTracked(n: number) { this.#maxTracked = n; }

  /** How many addresses are being counted right now. Exists so a test can prove the ceiling holds. */
  tracked(): Promise<number> { return this.#users.countSignInFailures(); }

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
    return Math.min(2 ** (count - 6) * 5_000, PasswordIdentity.MAX_WAIT_MS);
  }

  /**
   * Whether a row is past remembering: its wait ended more than an hour ago. Dropping a counter is
   * safe — the worst case is someone getting five fresh free attempts, which is the normal state.
   */
  #forgotten(row: SignInFailures, now: number): boolean {
    return Date.parse(row.lastAt) + this.#waitAfter(row.count) + PasswordIdentity.FORGET_AFTER_MS < now;
  }

  /**
   * Milliseconds this row still has to wait, from the facts it keeps.
   *
   * ⚠️ Never more than the count's own wait. A `lastAt` in the future — the clock stepped back since
   * it was written, or another instance's clock runs ahead — would otherwise keep the address locked
   * for as long as the clocks disagree, however far that is. Clamped, it waits at most what the count
   * allows, and the next wrong password rewrites `lastAt` on this clock. A forgotten row needs no
   * check of its own here: its wait ended an hour ago, so what is left of it is below zero.
   */
  #waitOf(row: SignInFailures | null, now: number): number {
    if (!row) return 0;
    const wait = this.#waitAfter(row.count);
    return Math.max(0, Math.min(wait, Date.parse(row.lastAt) + wait - now));
  }

  /**
   * How long this e-mail still has to wait, in seconds. Zero means it may try.
   *
   * The count is per e-mail and NOT per IP: behind a proxy every request shares one address, and
   * locking by IP would let one person lock out an entire office.
   */
  async remainingWait(email: string): Promise<number> {
    const row = await this.#users.readSignInFailures(email);
    return Math.ceil(this.#waitOf(row, Date.now()) / 1000);
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
    // Refused before the store is touched and before scrypt runs: an oversized field is not a login
    // attempt, it is an attempt to make the server work. Costs nothing to say no.
    if (email.length > PasswordIdentity.MAX_EMAIL || password.length > PasswordIdentity.MAX_PASSWORD) {
      return null;
    }
    const locked = (await this.remainingWait(email)) > 0;

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
      const now = Date.now();
      await this.#users.updateSignInFailures(email, (current) => ({
        count: current && !this.#forgotten(current, now) ? current.count + 1 : 1,
        lastAt: new Date(now).toISOString(),
      }));
      // Pruned AFTER writing, not before: pruning first leaves the new row sitting one above the
      // ceiling, which is exactly how a ceiling stops being one. The cutoff is the oldest a row can
      // be and still be remembered, whatever its count: `#forgotten` decides the rest on reading.
      await this.#users.pruneSignInFailures(
        new Date(now - PasswordIdentity.MAX_WAIT_MS - PasswordIdentity.FORGET_AFTER_MS).toISOString(),
        this.#maxTracked);
      return null;
    }
    // Only a successful login clears it. Clearing on any attempt would let an attacker reset the
    // counter by interleaving a login they know to be valid.
    await this.#users.updateSignInFailures(email, () => null);
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
