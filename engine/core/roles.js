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
 * owner, through events at a settings screen — a later piece. `ROLE_NAME_FORMAT` and `isValidScope`
 * below are validated and tested now anyway: they are the grammar that path will check a role's name
 * and a grant's scope against, and building them once, ahead of their first caller, means the settings
 * screen validates a name or a scope the same way `HOLDRIM_LOCKS` already does, not a second way.
 *
 * `HOLDRIM_LOCKS` (below, `parseLocks`) is different: who holds `lock` besides the owner is read from
 * the environment, same as `owner` and `admins`, because a forged lock is the one thing signed events
 * (phase E) have not closed yet. `can('lock', …)` does not consult it in this change — see `can`'s own
 * comment for why.
 * @module
 */
import { PAGE_FORMAT, ID_FORMAT } from './limits.js';

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
 * A project-defined role's name, the shape the future settings screen will validate a typed name
 * against — lowercase, digits and hyphens only, the same restraint `PAGE_FORMAT` puts on a page code,
 * and for the same reason: a role's name is shown on the people screen and, per `people.show:
 * 'role'`, may be the ONLY thing a reader ever sees about who acted, so it has to be safe to put in
 * HTML before anything trusts it. No caller in this version asks it yet — `engine/tests/roles.test.js`
 * is the one that does, so this grammar is proved before its first real use, not invented after.
 */
export const ROLE_NAME_FORMAT = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A page-FAMILY scope: `PAGE_FORMAT`'s own shape with an explicit trailing `*` (docs/ROLES.md, "A
 * grant can be limited to pages or to blocks" — "P0*" reaches P01..P09 and nothing that merely
 * starts with "P"). Kept as its own pattern, not derived from `PAGE_FORMAT`, so the two stay two
 * plain regexes anyone can read side by side rather than one built by string surgery on the other.
 */
const SCOPE_FAMILY_FORMAT = /^[A-Za-z][A-Za-z0-9-]{0,7}\*$/;

/**
 * Whether `scope` is one of the three shapes docs/ROLES.md allows on a grant or a `HOLDRIM_LOCKS`
 * entry: an exact page code, a page family with its explicit `*`, or a block id. Nothing else,
 * because a scope that reached the panel unchecked would be exactly the kind of untrusted value
 * `engine/api/theme.ts` already refuses to trust raw — it would end up choosing which pages and
 * blocks a payload includes.
 *
 * `ID_FORMAT` alone would also accept a bare page code or a family with no `*`; checked in this
 * order, those are already true by the time this reaches it, so nothing is lost by asking it last —
 * it is here only for the third shape, a block id (`P03.2.1`), which `PAGE_FORMAT` never accepts.
 * @param {unknown} scope
 */
export function isValidScope(scope) {
  if (typeof scope !== 'string' || scope === '') return false;
  return PAGE_FORMAT.test(scope) || SCOPE_FAMILY_FORMAT.test(scope) || ID_FORMAT.test(scope);
}

/**
 * `HOLDRIM_LOCKS`, parsed once at start: `"ana@example.org:P0*; bea@example.org:F12"` — entries
 * separated by `;`, each an e-mail, a colon, and a scope validated by `isValidScope`. Read from the
 * environment only, next to `HOLDRIM_OWNER` and `HOLDRIM_ADMINS`, and never from `holdrim.json`
 * (`engine/core/config.js`'s `AUTHORITY_KEYS` refuses the file the key would otherwise sit in) —
 * docs/ROLES.md, section 3: "Set where the owner is set."
 *
 * The address is normalized exactly as the store normalizes one — trim, then lower-case
 * (`engine/api/users.ts`'s `normalizeEmail`) — repeated here rather than imported: this file is core
 * JavaScript the browser also loads (`AGENTS.md`, "JavaScript or TypeScript"), and `users.ts` is not.
 *
 * Anything that does not fit — no colon, an empty address, a scope `isValidScope` refuses — throws:
 * a malformed entry here is a lock silently never granted, which is worse than a service that will
 * not start, the same reasoning `HOLDRIM_OWNER`'s own parsing already follows.
 *
 * Naming the owner in it is harmless: the owner already holds `lock` from `isOwner` alone (below),
 * so nothing here treats that address specially.
 *
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
    const email = entry.slice(0, colon).trim().toLowerCase();
    const scope = entry.slice(colon + 1).trim();
    if (!email) {
      throw new Error(`HOLDRIM_LOCKS has "${entry}", which names no e-mail before the colon.`);
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
  const split = (s) =>
    String(s ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

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
  const normalized = (e) => String(e ?? '').trim().toLowerCase();

  // Validated once, at construction, exactly like `list` above: a malformed LOCKS entry is a config
  // error, and a config error refuses to start rather than surfacing the first time something asks
  // about it.
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
     * re-enable) and any future lock check both ask, so a rule added for one reaches the other
     * (docs/ROLES.md, section 3, "One parser, one question").
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
