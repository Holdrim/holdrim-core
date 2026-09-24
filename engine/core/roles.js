/**
 * System roles. The METHOD defines only `owner` and the `founder` tag; `admin`, `clinical lead`
 * and everything else are roles of the PROJECT adopting the method (design decision, 2026-09-17).
 *
 *   owner   exactly one, always the same: the founding architect. Can do everything, including
 *           creating the roles.
 *   admin   can do everything the owner does, except be the owner.
 *   other   any other allowed identity.
 *
 * The engine speaks in CAPABILITY — "can approve?", "can triage?" — never in the name of a role
 * from somebody's product. Role names change with every company; capabilities do not.
 * @module
 */

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
      // Without this, a project that names its owner in holdrim.json and gets it wrong is sent to
      // look for a variable it never set.
      'It comes from HOLDRIM_OWNER, or from `owner` in holdrim.json when the variable is not set.');
  }
  const ownerEmail = list[0];
  // The owner is an admin by consequence, not by configuration: there is no way to strip their
  // power by accident.
  const everyone = new Set([...split(admins), ownerEmail]);
  const normalized = (e) => String(e ?? '').trim().toLowerCase();

  return {
    owner: ownerEmail,
    admins: [...everyone],
    isOwner: (e) => normalized(e) === ownerEmail,
    /** The owner is an admin too. This is what answers "can approve?" and "can triage?". */
    isAdmin: (e) => everyone.has(normalized(e)),
    canApprove: (e) => everyone.has(normalized(e)),
    canTriage: (e) => everyone.has(normalized(e)),
    roleOf: (e) => (normalized(e) === ownerEmail ? 'owner' : everyone.has(normalized(e)) ? 'admin' : 'other'),
  };
}

/**
 * The roles a project's configuration grants — what `readConfig` returned, turned into roles.
 *
 * ⚠️ The one way from configuration to roles, for the server AND the CLI. Who the owner is decides
 * whose ✓ becomes a lock, so the two cannot be allowed to answer it differently: a CLI that read
 * only HOLDRIM_OWNER while the server also read `owner` from holdrim.json would lock nothing the
 * owner approved, or triage as the owner someone the server does not know as one. The precedence
 * (the variable over the file) lives in `readConfig` alone; this adds no rule of its own, so there
 * is no second copy of it to drift.
 *
 * @param {{ owner: string|null, admins: string }} config  as `readConfig` returns it
 */
export function rolesOf(config) {
  return createRoles(config.owner, config.admins);
}
