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
      'The owner is unique by definition: they are the founding architect of the project.');
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
