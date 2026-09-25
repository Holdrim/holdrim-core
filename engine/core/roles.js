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
 * working the day a project renamed it, and could not be checked against a future holdrim.json grant
 * (#29) the way a capability from this closed list can. `engine/tests/roles-boundary.test.js` proves
 * no caller outside this file does.
 *
 * #29 is that grant: a project may define its OWN roles under `holdrim.json`'s `roles` key — a name
 * and a subset of `CAPABILITIES`, the same shape `ROLE_CAPABILITIES` gives the three shipped ones —
 * and grant them to people under `grants`. Both are validated here, at the one door `readConfig`
 * already funnels every project setting through, so a typo in either refuses to start the same way
 * an unknown `holdrim.json` key does. `lock` stays out of reach exactly as it is for `admin`: a
 * project role MAY list it (it is a known capability, not a typo) but `can`'s `'lock'` branch never
 * consults a role's capabilities at all, project-defined or shipped, so listing it changes nothing —
 * see `can`, below, and docs/ROLES.md, "Authority comes from the deployment only".
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
 * `#29` (grants from `holdrim.json`) extends this shape rather than replacing it: a project-defined
 * role is the same kind of array, read from configuration instead of written here.
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
 * A project-defined role's name, as `holdrim.json`'s `roles` key writes it. Lowercase, digits and
 * hyphens only — the same restraint `PAGE_FORMAT` puts on a page code, and for the same reason: a
 * role's name is shown on the people screen and, per `people.show: 'role'`, may be the ONLY thing a
 * reader ever sees about who acted, so it is validated before it is trusted the way a theme colour
 * is (`engine/api/theme.ts`) rather than interpolated as written.
 */
export const ROLE_NAME_FORMAT = /^[a-z][a-z0-9-]{0,31}$/;

/** The names this version ships. A project's own role may never reuse one — see `projectRoles` —
 *  because `capabilitiesOf` and `can` both trust that these three mean exactly what this file says. */
const SHIPPED_ROLE_NAMES = new Set(Object.keys(ROLE_CAPABILITIES));

/**
 * A page-FAMILY scope: `PAGE_FORMAT`'s own shape with an explicit trailing `*` (docs/ROLES.md, "A
 * grant can be limited to pages or to blocks" — "P0*" reaches P01..P09 and nothing that merely
 * starts with "P"). Kept as its own pattern, not derived from `PAGE_FORMAT`, so the two stay two
 * plain regexes anyone can read side by side rather than one built by string surgery on the other.
 */
const SCOPE_FAMILY_FORMAT = /^[A-Za-z][A-Za-z0-9-]{0,7}\*$/;

/**
 * Whether `scope` is one of the three shapes docs/ROLES.md allows on a grant: an exact page code, a
 * page family with its explicit `*`, or a block id. Nothing else, because a scope that reached the
 * panel unchecked would be exactly the kind of untrusted value `engine/api/theme.ts` already refuses
 * to trust raw — it would end up choosing which pages and blocks a payload includes.
 *
 * `ID_FORMAT` alone would also accept a bare page code or a family with no `*`; checked in this
 * order, those are already true by the time this reaches it, so nothing is lost by asking it last —
 * it is here only for the third shape, a block id (`P03.2.1`), which `PAGE_FORMAT` never accepts.
 * @param {unknown} scope
 */
export function isValidGrantScope(scope) {
  if (typeof scope !== 'string' || scope === '') return false;
  return PAGE_FORMAT.test(scope) || SCOPE_FAMILY_FORMAT.test(scope) || ID_FORMAT.test(scope);
}

/**
 * The project's own roles, from `holdrim.json`'s `roles` key — a name and the subset of
 * `CAPABILITIES` it holds, validated the same way an unknown key elsewhere refuses to start. Called
 * once, from `createRoles`, so a bad definition fails at boot rather than the first time somebody's
 * grant tries to use it.
 *
 * @param {Record<string, unknown>|undefined|null} rolesConfig  `holdrim.json`'s `roles`, as
 *   `JSON.parse` returns it
 * @returns {Map<string, Set<string>>}
 */
export function projectRoles(rolesConfig) {
  const roles = new Map();
  if (rolesConfig === undefined || rolesConfig === null) return roles;
  if (typeof rolesConfig !== 'object' || Array.isArray(rolesConfig)) {
    throw new Error('holdrim.json\'s "roles" must be an object mapping a role name to its capabilities.');
  }
  for (const [name, capabilities] of Object.entries(rolesConfig)) {
    if (!ROLE_NAME_FORMAT.test(name)) {
      throw new Error(
        `holdrim.json defines a role named "${name}", and a role name must be lowercase letters, ` +
        'digits and hyphens (like a page code) — it can end up on the people screen, where anything ' +
        'else would be untrusted input landing in HTML.');
    }
    if (SHIPPED_ROLE_NAMES.has(name)) {
      throw new Error(
        `holdrim.json defines a role named "${name}", which this version of the engine already ships. ` +
        'Give the project\'s role a different name — redefining a shipped one would make two different ' +
        'things answer to it.');
    }
    if (!Array.isArray(capabilities)) {
      throw new Error(`holdrim.json's role "${name}" must list its capabilities as an array.`);
    }
    for (const capability of capabilities) {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(
          `holdrim.json's role "${name}" grants "${capability}", which is not a capability this ` +
          `version of the engine knows: ${CAPABILITIES.join(', ')}.`);
      }
    }
    // `lock` is not stripped here, on purpose: a project that lists it made no typo (`lock` IS one
    // of `CAPABILITIES`), and refusing to start over it would be refusing a file that changes
    // nothing — `can`'s `'lock'` branch never reads a role's capabilities, this table included.
    roles.set(name, new Set(capabilities));
  }
  return roles;
}

/**
 * Who the project's own roles are granted to, from `holdrim.json`'s `grants` key — each entry names
 * one of `roles` and, optionally, a scope. A grant naming a role `roles` does not hold, or a scope
 * that fails `isValidGrantScope`, refuses to start: both are untrusted input the moment they exist,
 * the same as a role's own name above.
 *
 * A scoped grant is validated here and carried on the result, but not yet CONSULTED by `can` —
 * scopes are read with no page or block in hand today (docs/ROLES.md, "Built / not built": "Scopes:
 * exact pages, explicit wildcard, blocks — not built"). Honouring one now, with no way to check it
 * against where a request or a ✓ actually landed, would hand out MORE than the file asked for —
 * exactly the "grant `'lock'`" mistake this module refuses, in a different shape. An UNSCOPED grant
 * ("no scope means everywhere") has no such gap, so it is live from this issue on.
 *
 * @param {Record<string, unknown>|undefined|null} grantsConfig  `holdrim.json`'s `grants`
 * @param {Map<string, Set<string>>} roles  from `projectRoles`
 * @returns {Map<string, {role: string, scope: string|null}[]>} keyed by the e-mail, normalized the
 *   same way `createRoles` normalizes the owner's and the admins'
 */
export function projectGrants(grantsConfig, roles) {
  const grants = new Map();
  if (grantsConfig === undefined || grantsConfig === null) return grants;
  if (typeof grantsConfig !== 'object' || Array.isArray(grantsConfig)) {
    throw new Error('holdrim.json\'s "grants" must be an object mapping an e-mail to a list of grants.');
  }
  for (const [rawEmail, list] of Object.entries(grantsConfig)) {
    if (!Array.isArray(list)) {
      throw new Error(`holdrim.json's grant for "${rawEmail}" must be an array of {role, scope} entries.`);
    }
    const entries = list.map((entry) => {
      const role = entry?.role;
      if (typeof role !== 'string' || !roles.has(role)) {
        const known = [...roles.keys()].join(', ') || 'none defined';
        throw new Error(
          `holdrim.json grants "${rawEmail}" the role "${role}", which is not one of the project's ` +
          `own roles (${known}) — a grant can only name a role "roles" defines.`);
      }
      const scope = entry?.scope ?? null;
      if (scope !== null && !isValidGrantScope(scope)) {
        throw new Error(
          `holdrim.json grants "${rawEmail}" the scope "${scope}", which is none of a page, a page ` +
          'family ("P0*") or a block id — see docs/ROLES.md, "A grant can be limited to pages or to blocks".');
      }
      return { role, scope };
    });
    grants.set(String(rawEmail).trim().toLowerCase(), entries);
  }
  return grants;
}

/**
 * @param {string|undefined|null} owner  ONE e-mail. Zero or more than one is a config error.
 * @param {string|undefined|null} admins comma-separated e-mails; may be empty.
 * @param {Record<string, unknown>|undefined|null} [rolesConfig]  `holdrim.json`'s `roles` (#29)
 * @param {Record<string, unknown>|undefined|null} [grantsConfig] `holdrim.json`'s `grants` (#29)
 */
export function createRoles(owner, admins, rolesConfig = {}, grantsConfig = {}) {
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

  // Validated once, at construction, exactly like `list` above: a bad role or a bad grant is a
  // config error, and a config error refuses to start rather than surfacing the first time somebody
  // asks `can` about it.
  const roles = projectRoles(rolesConfig);
  const grants = projectGrants(grantsConfig, roles);

  /** Whether `e` is THE owner — an identity check, not a capability. Defined once, here, so `can`
   *  and the returned `isOwner` are provably the same question asked the same way. */
  const isOwner = (e) => normalized(e) === ownerEmail;
  /** The SHIPPED role `e` holds — never handed to a caller, only used to look up its capabilities.
   *  Never a project role's name: `capabilitiesOf` only knows the three this file ships, and asking
   *  it for anything else is the bug `capabilitiesOf` itself refuses (see its own comment). */
  const shippedRoleOf = (e) => (isOwner(e) ? 'owner' : everyone.has(normalized(e)) ? 'admin' : 'member');

  /**
   * The capabilities `e` holds through an UNSCOPED grant of a project's own role — "no scope means
   * everywhere" (docs/ROLES.md). A grant WITH a scope is validated but not read here — see the
   * comment on `projectGrants` for why consulting it without a page or block in hand would be
   * exactly the kind of over-grant this module exists to refuse.
   */
  const globalCapabilitiesOf = (e) => {
    const held = new Set();
    for (const grant of grants.get(normalized(e)) ?? []) {
      if (grant.scope === null) for (const capability of roles.get(grant.role)) held.add(capability);
    }
    return held;
  };

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
     * The role `e` holds, for display only — the people screen's column, `/api/me`'s `role` field.
     * Never compared against a string by a caller: that is exactly the check `can` replaces.
     *
     * Owner and admin are never displaced: the shipped role wins over any project grant, so an admin
     * granted a project role by mistake still reads as "admin" rather than something narrower.
     * Otherwise, the first unscoped grant's role name is shown, or "member" with none.
     */
    roleOf: (e) => {
      const shipped = shippedRoleOf(e);
      if (shipped !== 'member') return shipped;
      const grant = (grants.get(normalized(e)) ?? []).find((g) => g.scope === null);
      return grant?.role ?? 'member';
    },
    /**
     * Whether `e` may `capability` — the one question every caller outside this file asks. Throws
     * on an unknown capability rather than silently answering false, for the same reason an unknown
     * `holdrim.json` key refuses to start: a typo that answered "no" would look exactly like a real
     * refusal.
     *
     * `'lock'` is answered straight from `isOwner`, never from `capabilitiesOf` or a project grant —
     * not merely because `ROLE_CAPABILITIES` happens to leave `lock` out today, but so that NO edit
     * to either table, from anywhere in the process, could ever grant it. `docs/ROLES.md` section 3
     * is what replaces this one line the day `LOCKS` exists: `isOwner(e) || locksHeldBy(e, scope)`,
     * still never a table lookup by role.
     */
    can: (capability, e) => {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(`"${capability}" is not a capability engine/core/roles.js knows: ${CAPABILITIES.join(', ')}.`);
      }
      if (capability === 'lock') return isOwner(e);
      return capabilitiesOf(shippedRoleOf(e)).has(capability) || globalCapabilitiesOf(e).has(capability);
    },
  };
}

/**
 * The roles a project's configuration grants — what `readConfig` returned, turned into roles.
 *
 * ⚠️ The one way from configuration to roles, for the server AND the CLI. Who the owner is decides
 * whose ✓ becomes a lock, so the two cannot be allowed to answer it differently: a CLI that read
 * the owner one way while the server read it another would lock nothing the owner approved, or
 * triage as the owner someone the server does not know as one. Where the two values come from —
 * HOLDRIM_OWNER and HOLDRIM_ADMINS, and never holdrim.json — is `readConfig`'s to say, once; this
 * adds no rule of its own, so there is no second copy of it to drift.
 *
 * `roles` and `grants` (#29) are the opposite of `owner` and `admins`: `readConfig` reads them FROM
 * `holdrim.json`, on purpose — they are the project's own roles, never the three authorities
 * `AUTHORITY_KEYS` (`engine/core/config.js`) refuses to find there.
 *
 * @param {{ owner: string|null, admins: string, roles?: Record<string, unknown>,
 *           grants?: Record<string, unknown> }} config  as `readConfig` returns it
 */
export function rolesOf(config) {
  return createRoles(config.owner, config.admins, config.roles, config.grants);
}
