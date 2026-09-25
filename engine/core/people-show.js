/**
 * `people.show`: how much of a person's identity a reader is sent next to a comment, a request or a
 * ✓ (docs/ROLES.md, "How a person appears"). A privacy decision, made once by the owner in
 * `holdrim.json`, never hardcoded and never left to whichever screen happens to render an event.
 *
 * The list is closed, the same way `FEATURE_DEFAULTS` is closed in `engine/core/features.js`: a
 * project picks one of these four, and can never invent a fifth. An unknown value refuses to start
 * the service — a misspelled setting would otherwise silently show whatever the code fell back to,
 * which for a PRIVACY setting is the one kind of mistake nobody may make quietly.
 *
 * ⚠️ NOT AUTHORITY. This decides what a reader is SENT, never what they may DO — it is read from
 * `holdrim.json` like `features`, not from the environment like `owner`/`admins`/`locks`, and
 * `engine/core/config.js`'s `AUTHORITY_KEYS` does not, and must not, ever name it. A project that
 * hides names from everyone still has exactly the same owner, the same admins and the same locks —
 * this setting cannot touch any of that, only how a name is spelled out on screen.
 * @module
 */

/** @typedef {'name'|'email'|'role'|'id'} PeopleShow */

/** The closed list `people.show` may hold — docs/ROLES.md, "How a person appears". */
export const PEOPLE_SHOW_VALUES = /** @type {readonly PeopleShow[]} */ (Object.freeze(['name', 'email', 'role', 'id']));

/**
 * Today's behaviour, exactly: the panel, the home and the CLI have always printed the address a
 * request or a ✓ carried, and nothing computed a name, a role or an id in its place. A project that
 * configures nothing sees nothing change — the same promise `FEATURE_DEFAULTS` makes for `features`.
 */
export const DEFAULT_PEOPLE_SHOW = 'email';

/**
 * `file.people?.show`, checked against the closed list — throws, rather than warns, for the same
 * reason `readFeatures` throws: a project that believes it hid names, while the engine silently kept
 * showing them because a value was misspelled, is worse off than one told loudly it cannot start.
 *
 * @param {unknown} configured  `file.people?.show` as `holdrim.json` has it, or undefined
 * @param {string} root         only for the error message, as `readConfig`'s other checks do
 * @returns {PeopleShow}
 */
export function readPeopleShow(configured, root) {
  if (configured === undefined) return DEFAULT_PEOPLE_SHOW;
  if (typeof configured !== 'string' || !PEOPLE_SHOW_VALUES.includes(/** @type {PeopleShow} */ (configured))) {
    throw new Error(
      `${root}/holdrim.json's "people.show" must be one of: ${PEOPLE_SHOW_VALUES.join(', ')}; got ` +
      `${JSON.stringify(configured)}. A misspelled value would otherwise silently keep showing ` +
      'whatever the engine fell back to, which for a privacy setting is not an honest failure.');
  }
  return /** @type {PeopleShow} */ (configured);
}

/**
 * What a reader is sent for one person — the one place the rule from docs/ROLES.md's table lives, so
 * the panel, the home and the CLI compute it the same way rather than each reading `show` for
 * itself. Pure: every input is already resolved by the caller, so this needs no store, no session
 * and no i18n to be tested.
 *
 * @param {{
 *   show: PeopleShow,
 *   email: string,
 *   id: string|null,
 *   name: string|null,
 *   role: string,
 *   alwaysNamed: boolean,
 * }} who
 *   `alwaysNamed` is the caller's own answer to "does docs/ROLES.md's override apply here" — the
 *   owner, a holder of `people`, or the person looking at their own request. It is asked of the
 *   caller, never of a role's name, so this file never has to know what `people` or `owner` mean.
 * @returns {string}
 */
export function personAs(who) {
  if (who.alwaysNamed || who.show === 'name') return who.name || who.email;
  if (who.show === 'email') return who.email;
  if (who.show === 'role') return who.role;
  // 'id': the row id when the caller found one, and the address otherwise — an event written before
  // ids existed, or a reader (the CLI, with no accounts store at all) that never looked one up.
  return who.id || who.email;
}
