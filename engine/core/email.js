/**
 * What "the same e-mail" means, and what can even be one — asked in two places that must never
 * drift apart: `engine/api/users.ts` (the store, and every route built on it) and
 * `engine/core/roles.js` (`HOLDRIM_LOCKS`). Before this file they were two copies of the same three
 * lines, one in each — harmless while they agreed, and exactly the kind of thing that stops
 * agreeing the day only one of the two is edited.
 *
 * Core, not API: this is JavaScript the browser also loads (`AGENTS.md`, "JavaScript or
 * TypeScript"), so it holds no `node:*` import and nothing async — a plain string check either
 * side can call.
 * @module
 */

/** The longest address RFC 5321 allows. Anything past it is not a typo, it is a payload. */
export const MAX_EMAIL_LENGTH = 320;

/** One place, so every store agrees on what "the same e-mail" means.
 *  @param {string} email */
export function normalizeEmail(email) {
  return String(email ?? '').toLowerCase().trim();
}

/**
 * Is this something that can be an address here?
 *
 * ⚠️ Deliberately NOT an RFC 5322 parse, and the restraint is the point. The exhaustive regular
 * expressions for that are famous for rejecting addresses that work, and the only thing this check
 * is here to catch is the empty field and the obvious typo — somebody typing a NAME into the
 * e-mail box, which would otherwise create an access nobody can ever sign in to, and which cannot
 * be deleted afterwards because nothing here is deleted.
 *
 * No dot is demanded in the domain: `root@localhost` and internal single-label hosts are real, and
 * refusing them would be this checker deciding what someone else's network looks like.
 * @param {string} value
 */
export function isEmailAddress(value) {
  const email = String(value ?? '').trim();
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (/\s/.test(email)) return false;
  const at = email.indexOf('@');
  // Exactly one `@`, with something on both sides of it.
  return at > 0 && at === email.lastIndexOf('@') && at < email.length - 1;
}
