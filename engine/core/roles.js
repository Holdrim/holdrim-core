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
 * @module
 */

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
 * @param {string|undefined|null} owner  ONE e-mail. Zero or more than one is a config error.
 * @param {string|undefined|null} admins comma-separated e-mails; may be empty.
 */
export function createRoles(owner, admins) {
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
    /** The role `e` holds, for display only — the people screen's column, `/api/me`'s `role` field.
     *  Never compared against a string by a caller: that is exactly the check `can` replaces. */
    roleOf,
    /**
     * Whether `e` may `capability` — the one question every caller outside this file asks. Throws
     * on an unknown capability rather than silently answering false, for the same reason an unknown
     * `holdrim.json` key refuses to start: a typo that answered "no" would look exactly like a real
     * refusal.
     *
     * `'lock'` is answered straight from `isOwner`, never from `capabilitiesOf` — not merely because
     * `ROLE_CAPABILITIES` happens to leave `lock` out today, but so that NO edit to that table, from
     * anywhere in the process, could ever grant it. `docs/ROLES.md` section 3 is what replaces this
     * one line the day `LOCKS` exists: `isOwner(e) || locksHeldBy(e, scope)`, still never a table
     * lookup by role.
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
 * triage as the owner someone the server does not know as one. Where the two values come from —
 * HOLDRIM_OWNER and HOLDRIM_ADMINS, and never holdrim.json — is `readConfig`'s to say, once; this
 * adds no rule of its own, so there is no second copy of it to drift.
 *
 * @param {{ owner: string|null, admins: string }} config  as `readConfig` returns it
 */
export function rolesOf(config) {
  return createRoles(config.owner, config.admins);
}
