/**
 * Capabilities, and roles as sets of them (docs/ROLES.md).
 *
 * The METHOD defines only `owner` and the `founder` tag; `admin`, `member`, `clinical lead` and
 * everything else beyond them are roles of the PROJECT adopting the method. What the method DOES fix
 * is the list of things any role can grant — `CAPABILITIES` below — because a role can be renamed by
 * every adopter, but "can this person triage?" has to mean the same thing everywhere the engine asks
 * it.
 *
 *   owner   exactly one, always the same: the founding architect. `can()` answers true for every
 *           capability, `lock` included, but the owner is not itself a role — nothing grants it and
 *           nothing takes it away (docs/ROLES.md, "The owner is not a role"), and `lock` specifically
 *           is never read from a role's capabilities at all (see `can`, below).
 *   admin   every capability but `lock`. A role of the PROJECT, named by `HOLDRIM_ADMINS`.
 *   member  `read`, `comment`, `request` — everyone else who can sign in.
 *
 * The engine asks `can(capability, email)`, never a role's name: a role name changes with every
 * product this ships inside, and a caller that compared one directly (`role === 'admin'`) would stop
 * working the day a project renamed it. `engine/tests/roles-boundary.test.js` proves no caller
 * outside this file does.
 *
 * A project's OWN roles, and who holds them, are NOT read here yet, and never from `holdrim.json`
 * (docs/ROLES.md, "Authority comes from the deployment only"; `engine/core/config.js`'s
 * `AUTHORITY_KEYS` refuses the file the moment it names `roles` or `grants`). They come from the
 * owner, through events at a settings screen — a later piece, which will need its own name grammar
 * for a project role then, not before: a format with no caller is untested by construction, whatever
 * a unit test that calls it directly says — the settings screen gets one when it exists, not sooner.
 * `isValidScope` below is different: `HOLDRIM_LOCKS` (`parseLocks`) is a real caller of it TODAY, so
 * its grammar is proved against the tier this change actually ships.
 *
 * `HOLDRIM_LOCKS` (below, `parseLocks`) is different: who holds `lock` besides the owner is read from
 * the environment, same as `owner` and `admins`, because a forged lock is the one thing signed events
 * (phase E) have not closed yet. `can('lock', …)` does not consult it in this change — see `can`'s own
 * comment for why.
 * @module
 */
import { PAGE_FORMAT } from './limits.js';
import { normalizeEmail, isEmailAddress } from './email.js';

/**
 * The closed list of capabilities the engine knows. A project combines these into roles; it can
 * never invent one, the same way an unknown `holdrim.json` key refuses to start (`config.js`).
 *
 * `lock` validates here like the other six (`can('lock', …)` throws on a typo exactly as it does for
 * `'triage'`), but it is never part of a role's GRANTABLE set — `ROLE_CAPABILITIES` below leaves it
 * out of every role, owner included — because who holds it is decided by IDENTITY, never by a table
 * a role's capabilities live in. Reconciled once, with why, in `docs/ROLES.md`, "Capabilities are the
 * engine's, roles are the project's" — this comment only points there so the two cannot drift apart.
 */
export const CAPABILITIES = Object.freeze([
  'read', 'comment', 'request', 'triage', 'approve', 'lock', 'people',
]);

/** `lock` is deliberately absent from every one of these — see the comment on `CAPABILITIES`. */
const GRANTABLE = Object.freeze(CAPABILITIES.filter((c) => c !== 'lock'));

/**
 * The capabilities each of the three shipped roles holds, as ARRAYS — never a `Set`: `Object.freeze`
 * on a `Set` freezes the BINDING, not its contents, so a frozen `Set` still accepts `.add()` and
 * `.delete()` without a complaint, in or out of strict mode. `capabilitiesOf` copies one of these
 * into a fresh `Set` on every call for exactly that reason: a caller that mutates what it gets back
 * — `capabilitiesOf('admin').add('lock')` — would otherwise reach into this table itself, and every
 * `can()` call for the rest of the process would read it too.
 *
 * A project-defined role, once the settings screen exists, will extend this shape rather than
 * replace it: the same kind of array, held in the store instead of written here.
 *
 * `owner` is included for `capabilitiesOf` and the mapping test to read from one table, not two,
 * even though the owner is not a role a project can hold or grant (see the module comment) — its
 * entry is `GRANTABLE` too, because the owner needs nothing from this table beyond what admin has:
 * `lock`, its one capability the table never carries for anyone, comes from `can` asking `isOwner`
 * directly, below, never from a lookup here.
 */
const ROLE_CAPABILITIES = Object.freeze({
  owner: GRANTABLE,
  admin: GRANTABLE,
  member: Object.freeze(['read', 'comment', 'request']),
});

/**
 * The capabilities a shipped role holds, as a FRESH `Set` — a new one on every call, copied from the
 * frozen array above, so nothing a caller does to what it gets back can reach the table itself (see
 * the comment on `ROLE_CAPABILITIES`). Exported so the mapping test can read the very table `can`
 * reads, instead of a copy of it that could drift from what `createRoles` actually checks.
 *
 * Never asked for `'lock'`: it holds no role's answer to that question, on purpose, and `can` never
 * calls it for `'lock'` either — see `CAPABILITIES`.
 * @param {'owner'|'admin'|'member'} role
 * @returns {Set<string>}
 */
export function capabilitiesOf(role) {
  const held = ROLE_CAPABILITIES[role];
  if (!held) throw new Error(`"${role}" is not one of the roles this version ships: owner, admin, member.`);
  return new Set(held);
}

/**
 * A page-FAMILY scope: `PAGE_FORMAT`'s own shape with an explicit trailing `*`, and a prefix of at
 * LEAST two characters before it (docs/ROLES.md, "A grant can be limited to pages or to blocks" —
 * "P0*" reaches P01..P09 and nothing that merely starts with "P"). The minimum is not decorative:
 * every real page code in this codebase's own examples (`engine/core/limits.js`'s comment — "D01,
 * T03a, C02, UC-01 and DNN") is two characters or more, and a single-letter family ("P*") would not
 * pick out a family at all — it would mean "everything whose code happens to start with the same
 * letter as this one page", which for a scheme where every page in a whole SECTION shares that first
 * letter is "every page", the exact bare wildcard the next paragraph refuses outright. Kept as its
 * own pattern, not derived from `PAGE_FORMAT`, so the two stay two plain regexes anyone can read side
 * by side rather than one built by string surgery on the other.
 */
const SCOPE_FAMILY_FORMAT = /^[A-Za-z][A-Za-z0-9-]{1,7}\*$/;

/**
 * A block id: a page-code-shaped root, then one or more `.`-separated segments (`P03.2.1`), and
 * optionally a namespace naming another project's block ahead of it (`supplier:C02.1.4`, the shape
 * `docs/PROTOCOL.md`'s own `data-depends` example uses). The dot segment is not optional — a scope
 * with none of them is a PAGE, the first branch of `isValidScope` below, or a FAMILY, the second; a
 * block id is the one shape of the three that is neither, and asking for at least one dot is what
 * tells it apart from a plain page code instead of overlapping it (see `isValidScope`'s own comment
 * on why that overlap used to hide a whole branch behind an "equivalent mutant").
 *
 * This replaces reusing `ID_FORMAT` (`engine/core/limits.js`) here: that format exists to bound an
 * EVENT's own `block` field — free text an author's fingerprint tool wrote, already scoped to one
 * page by the event it sits on — and accepts any non-empty run of its allowed characters, `.`, `-`,
 * `:` and a bare `1` among them. A grant's scope is different: it is untrusted input that itself
 * SELECTS pages and blocks before anything else runs (docs/ROLES.md, "Configuration is untrusted
 * input"), so it is checked against the actual shape a block id has, not merely the alphabet it is
 * allowed to be drawn from.
 */
const SCOPE_BLOCK_FORMAT = /^(?:[A-Za-z][A-Za-z0-9-]{0,15}:)?[A-Za-z][A-Za-z0-9-]{0,7}(?:\.[A-Za-z0-9-]{1,8}){1,8}$/;

/**
 * Whether `scope` is one of the three shapes docs/ROLES.md allows on a grant or a `HOLDRIM_LOCKS`
 * entry: an exact page code, a page family with its explicit `*`, or a block id. Nothing else,
 * because a scope that reached the panel unchecked would be exactly the kind of untrusted value
 * `engine/api/theme.ts` already refuses to trust raw — it would end up choosing which pages and
 * blocks a payload includes.
 *
 * Order matters for what each branch actually proves, not merely for what it accepts: before round 2
 * of #29's review, the third branch was the bare `ID_FORMAT` alphabet check, which is a SUPERSET of
 * `PAGE_FORMAT` — every exact page code `PAGE_FORMAT` accepts, `ID_FORMAT` accepts too. Deleting the
 * `PAGE_FORMAT` branch outright then changed nothing any test could see: an "equivalent mutant", the
 * one shape a mutation this codebase's own method (`AGENTS.md`, rule 2) exists to catch. `PAGE_FORMAT`
 * now proves something `SCOPE_BLOCK_FORMAT` cannot: a block id demands at least one `.` segment, so a
 * plain page code like `P03` fails it, and only `PAGE_FORMAT` still accepts it — deleting that branch
 * now fails `isValidScope('P03')` for real.
 * @param {unknown} scope
 */
export function isValidScope(scope) {
  if (typeof scope !== 'string' || scope === '') return false;
  return PAGE_FORMAT.test(scope) || SCOPE_FAMILY_FORMAT.test(scope) || SCOPE_BLOCK_FORMAT.test(scope);
}

/**
 * `HOLDRIM_LOCKS`, parsed once at start: `"ana@example.org:P0*; bea@example.org:F12"` — entries
 * separated by `;`, each an e-mail, a colon, and a scope validated by `isValidScope`. Read from the
 * environment only, next to `HOLDRIM_OWNER` and `HOLDRIM_ADMINS`, and never from `holdrim.json`
 * (`engine/core/config.js`'s `AUTHORITY_KEYS` refuses the file the key would otherwise sit in) —
 * docs/ROLES.md, section 3: "Set where the owner is set."
 *
 * The address is normalized, and checked, by `engine/core/email.js` — the ONE module both this file
 * and `engine/api/users.ts` import it from (round 2 of #29's review, findings 2 and 6: this used to
 * repeat `users.ts`'s `normalizeEmail` by hand, with no shape check at all).
 *
 * `isEmailAddress` alone is not enough here, though, and round 2 was wrong to claim it was: it stays
 * DELIBERATELY lenient (see its own comment) because `engine/api/users.ts`'s create route uses the
 * very same function for a brand new account, where refusing a real but unusual address is the worse
 * mistake. `<ana@x>`, `"ana"@x` and `ana@x.` all still pass it — a display form's angle brackets, a
 * quoted local part, and a domain with a trailing dot are each something a real mail system might
 * hand you, just not the bare address `HOLDRIM_LOCKS` needs. A `HOLDRIM_LOCKS` typo is a different
 * failure than a rejected sign-up, though: it does not fail loudly, it silently locks NOBODY, forever,
 * with nothing in the product to notice it by. So `parseLocks` asks a second, stricter question of
 * its own, below — `RESERVED_EMAIL_CHARS` and the trailing-dot check — on top of `isEmailAddress`,
 * never inside it: `isEmailAddress` keeps meaning what it means for account creation, unmoved.
 *
 * Anything that does not fit — no colon, an address `isEmailAddress` or this file's own check
 * refuses, a scope `isValidScope` refuses — throws: a malformed entry here is a lock silently never
 * granted, which is worse than a service that will not start, the same reasoning `HOLDRIM_OWNER`'s
 * own parsing already follows.
 *
 * Naming the owner in it is harmless: the owner already holds `lock` from `isOwner` alone (below),
 * so nothing here treats that address specially.
 */
/**
 * Characters `isEmailAddress` lets through on purpose (its own comment: it is not an RFC 5322
 * parse) but a bare address never legitimately carries: the angle brackets and parentheses of a
 * DISPLAY form (`Ana <ana@x>`, a comment inside `(not ana) ana@x`), a quoted local part (`"ana"@x`),
 * and the two separators this file's own grammar already gives a meaning to elsewhere (`,` and `;`,
 * round 3 of #29's review, finding 3). None of the four is something `parseLocks` should have to
 * guess the intent of — `HOLDRIM_LOCKS` is typed by whoever deploys, not pasted from a mail client.
 */
const RESERVED_EMAIL_CHARS = /[<>"()[\],;]/;

/**
 * @param {string|undefined|null} raw
 * @returns {{email: string, scope: string}[]}
 */
export function parseLocks(raw) {
  const entries = String(raw ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  return entries.map((entry) => {
    // The FIRST colon, not the only one: a scope may itself contain one (`ID_FORMAT` allows it, for
    // a block id written with a namespace), so splitting on every colon would cut a valid scope in
    // half the day somebody's block ids use one.
    const colon = entry.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `HOLDRIM_LOCKS has "${entry}", which is missing its scope: an entry is an e-mail, a colon, ` +
        'and a scope, like "ana@example.org:P0*". Entries are separated by ";".');
    }
    const rawEmail = entry.slice(0, colon).trim();
    const email = normalizeEmail(rawEmail);
    const scope = entry.slice(colon + 1).trim();
    if (!rawEmail) {
      throw new Error(`HOLDRIM_LOCKS has "${entry}", which names no e-mail before the colon.`);
    }
    if (!isEmailAddress(email)) {
      throw new Error(
        `HOLDRIM_LOCKS names "${rawEmail}", which is not an e-mail address — the same check ` +
        '`engine/api/users.ts` applies when an account is created.');
    }
    // Stricter than `isEmailAddress` on purpose — see this function's own comment for why account
    // creation cannot ask this same question.
    if (RESERVED_EMAIL_CHARS.test(email) || email.endsWith('.')) {
      throw new Error(
        `HOLDRIM_LOCKS names "${rawEmail}", which is not an e-mail address a mail server would ever ` +
        'deliver to: account creation stays lenient about this, but a HOLDRIM_LOCKS typo does not ' +
        'fail loudly the way a rejected sign-up does — it silently locks nobody, forever.');
    }
    if (!isValidScope(scope)) {
      throw new Error(
        `HOLDRIM_LOCKS grants ${email} the scope "${scope}", which is none of a page, a page family ` +
        '("P0*") or a block id — see docs/ROLES.md, "A grant can be limited to pages or to blocks".');
    }
    return { email, scope };
  });
}

/**
 * @param {string|undefined|null} owner  ONE e-mail. Zero or more than one is a config error.
 * @param {string|undefined|null} admins comma-separated e-mails; may be empty.
 * @param {string|undefined|null} [locksRaw] `HOLDRIM_LOCKS`, in `parseLocks`'s format
 */
export function createRoles(owner, admins, locksRaw) {
  const split = (s) => String(s ?? '').split(',').map(normalizeEmail).filter(Boolean);

  const list = [...new Set(split(owner))];
  if (list.length !== 1) {
    throw new Error(
      `HOLDRIM_OWNER needs exactly one e-mail (got ${list.length}). ` +
      'The owner is unique by definition: they are the founding architect of the project. ' +
      // Said outright because the file is where an adopter looks first, and holdrim.json refuses
      // the key (engine/core/config.js): without this, "set it in the file" is the natural guess.
      'It comes from HOLDRIM_OWNER, set where Holdrim runs, and never from holdrim.json.');
  }
  const ownerEmail = list[0];
  // The owner is an admin by consequence, not by configuration: there is no way to strip their
  // power by accident.
  const everyone = new Set([...split(admins), ownerEmail]);
  // `normalizeEmail` itself (`engine/core/email.js`) is the one function every normalization in this
  // file, and in `engine/api/users.ts`, now calls — see `parseLocks`'s own comment for why a second,
  // hand-written copy of "trim, then lower-case" was the bug findings 2 and 6 closed.
  const normalized = normalizeEmail;

  // Validated once, at construction, exactly like `list` above: a malformed HOLDRIM_LOCKS entry is
  // a config error, and a config error refuses to start rather than surfacing the first time
  // something asks about it.
  const lockHolders = new Set(parseLocks(locksRaw).map((l) => l.email));

  /** Whether `e` is THE owner — an identity check, not a capability. Defined once, here, so `can`
   *  and the returned `isOwner` are provably the same question asked the same way. */
  const isOwner = (e) => normalized(e) === ownerEmail;
  /** The shipped role `e` holds — never handed to a caller, only used to look up its capabilities. */
  const roleOf = (e) => (isOwner(e) ? 'owner' : everyone.has(normalized(e)) ? 'admin' : 'member');

  return {
    owner: ownerEmail,
    admins: [...everyone],
    /**
     * Whether `e` is THE owner — an identity check, not a capability: resetting or creating the
     * owner's account, and disabling nobody's, belong to the owner alone and to no capability any
     * role can hold (docs/ROLES.md, "The owner is not a role"). Every other decision asks `can`.
     */
    isOwner,
    /**
     * Whether `e` is named in `HOLDRIM_LOCKS` — an identity check, like `isOwner`, never a
     * capability. This is the ONE function `engine/api/server.ts`'s account guards (create, reset,
     * disable and re-enable) and any future lock check both ask, so a rule added for one reaches the
     * other (docs/ROLES.md, section 3, "One parser, one question").
     *
     * Not yet read by `can('lock', …)` — see the comment there for why.
     */
    isLockHolder: (e) => lockHolders.has(normalized(e)),
    /** The role `e` holds, for display only — the people screen's column, `/api/me`'s `role` field.
     *  Never compared against a string by a caller: that is exactly the check `can` replaces. */
    roleOf,
    /**
     * Whether `e` may `capability` — the one question every caller outside this file asks. Throws
     * on an unknown capability rather than silently answering false, for the same reason an unknown
     * `holdrim.json` key refuses to start: a typo that answered "no" would look exactly like a real
     * refusal.
     *
     * `'lock'` is answered straight from `isOwner`, never from `capabilitiesOf` and never from
     * `isLockHolder` — not merely because `ROLE_CAPABILITIES` happens to leave `lock` out today, but
     * because making a `HOLDRIM_LOCKS` entry actually lock needs docs/ROLES.md section 3's rule: a ✓
     * is a lock only when the session that gave it opened with a credential the PERSON set
     * themselves, after the latest issuance made by the OWNER. That test reads the account's whole
     * credential history, which nothing here does yet. Without it, an admin who reset a
     * soon-to-be-lock-holder's account before their address reached `HOLDRIM_LOCKS`, and kept the
     * session open across the restart that added it, could give a ✓ in that person's name at the
     * moment it starts reading as a lock — the exact forgery section 3 exists to close. `isOwner`
     * alone has no such gap, so `lock` stays exactly that, in this change.
     */
    can: (capability, e) => {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(`"${capability}" is not a capability engine/core/roles.js knows: ${CAPABILITIES.join(', ')}.`);
      }
      if (capability === 'lock') return isOwner(e);
      return capabilitiesOf(roleOf(e)).has(capability);
    },
  };
}

/**
 * The roles a project's configuration grants — what `readConfig` returned, turned into roles.
 *
 * ⚠️ The one way from configuration to roles, for the server AND the CLI. Who the owner is decides
 * whose ✓ becomes a lock, so the two cannot be allowed to answer it differently: a CLI that read
 * the owner one way while the server read it another would lock nothing the owner approved, or
 * triage as the owner someone the server does not know as one. Where the three values come from —
 * HOLDRIM_OWNER, HOLDRIM_ADMINS and HOLDRIM_LOCKS, and never holdrim.json — is `readConfig`'s to
 * say, once; this adds no rule of its own, so there is no second copy of it to drift.
 *
 * @param {{ owner: string|null, admins: string, locks?: string }} config  as `readConfig` returns it
 */
export function rolesOf(config) {
  return createRoles(config.owner, config.admins, config.locks);
}
