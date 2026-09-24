/**
 * Capabilities, and roles as sets of them (docs/ROLES.md).
 *
 * The METHOD defines only `owner` and the `founder` tag; `admin`, `member`, `clinical lead` and
 * everything else beyond them are roles of the PROJECT adopting the method. What the method DOES fix
 * is the list of things any role can grant — `CAPABILITIES` below — because a role can be renamed by
 * every adopter, but "can this person triage?" has to mean the same thing everywhere the engine asks
 * it.
 *
 *   owner   exactly one, always the same: the founding architect. Holds every capability, always,
 *           and is not itself a role — nothing grants it and nothing takes it away (docs/ROLES.md,
 *           "The owner is not a role").
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
 * `lock` is in the list because a role's set can HOLD it — the owner's does, which is what makes
 * `can('lock', owner)` true — but, unlike the other six, it is never GRANTED to a role a project
 * defines: docs/ROLES.md section 3 puts who else holds it in `LOCKS`, read at boot next to
 * `HOLDRIM_OWNER`, never in a role a screen hands out. That is a rule for the issue that builds
 * `LOCKS`; this file only has to keep `lock` out of every role but the owner's, which the mapping
 * test below proves.
 */
export const CAPABILITIES = Object.freeze([
  'read', 'comment', 'request', 'triage', 'approve', 'lock', 'people',
]);

/**
 * The capabilities each of the three shipped roles holds, as SETS of `CAPABILITIES` — the shape
 * `#29` (grants from `holdrim.json`) extends rather than replaces: a project-defined role will be
 * this same kind of set, read from configuration instead of written here. Frozen, and read only
 * through `capabilitiesOf`, so nothing downstream can mutate the one table every check reads.
 *
 * `owner` is included for `capabilitiesOf` and the mapping test to read from one table, not two,
 * even though the owner is not a role a project can hold or grant (see the module comment).
 */
const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze(new Set(CAPABILITIES)),
  admin: Object.freeze(new Set(CAPABILITIES.filter((c) => c !== 'lock'))),
  member: Object.freeze(new Set(['read', 'comment', 'request'])),
});

/**
 * The capabilities a shipped role holds. Exported so the mapping test can read the very table it
 * proves, instead of a copy of it that could drift from what `createRoles` actually checks.
 * @param {'owner'|'admin'|'member'} role
 * @returns {ReadonlySet<string>}
 */
export function capabilitiesOf(role) {
  const set = ROLE_CAPABILITIES[role];
  if (!set) throw new Error(`"${role}" is not one of the roles this version ships: owner, admin, member.`);
  return set;
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

  /** The shipped role `e` holds — never handed to a caller, only used to look up its capabilities. */
  const roleOf = (e) => (normalized(e) === ownerEmail ? 'owner' : everyone.has(normalized(e)) ? 'admin' : 'member');

  return {
    owner: ownerEmail,
    admins: [...everyone],
    /**
     * Whether `e` is THE owner — an identity check, not a capability: resetting or creating the
     * owner's account, and disabling nobody's, belong to the owner alone and to no capability any
     * role can hold (docs/ROLES.md, "The owner is not a role"). Every other decision asks `can`.
     */
    isOwner: (e) => normalized(e) === ownerEmail,
    /** The role `e` holds, for display only — the people screen's column, `/api/me`'s `role` field.
     *  Never compared against a string by a caller: that is exactly the check `can` replaces. */
    roleOf,
    /**
     * Whether `e` may `capability` — the one question every caller outside this file asks. Throws
     * on an unknown capability rather than silently answering false, for the same reason an unknown
     * `holdrim.json` key refuses to start: a typo that answered "no" would look exactly like a real
     * refusal.
     */
    can: (capability, e) => {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(`"${capability}" is not a capability engine/core/roles.js knows: ${CAPABILITIES.join(', ')}.`);
      }
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
