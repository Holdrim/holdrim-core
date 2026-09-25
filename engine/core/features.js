/**
 * Feature toggles: what a PROJECT can turn off without the engine's code disappearing
 * (docs/ROLES.md, section 7).
 *
 * The list is closed, the same way `CAPABILITIES` is closed in `engine/core/roles.js`: a project
 * combines these into `holdrim.json`'s `features` block, and can never invent one. An unknown key
 * refuses to start, exactly as an invalid theme colour does (`engine/api/theme.ts`) — a toggle
 * misspelled is a toggle that silently did nothing, and the only honest answer to that is to refuse
 * to boot rather than run with a default nobody chose on purpose.
 *
 * ⚠️ A toggle never reaches a guard. `engine/core/roles.js` decides every capability and the lock,
 * and reads nothing from here — `engine/tests/features.test.js` proves it by grepping the source,
 * the same way `engine/tests/roles-boundary.test.js` proves no caller decides from a role's name.
 * "Locks, the owner's powers, nothing is erased, the theme validation: none of these is a feature,
 * and none gets a toggle" (docs/ROLES.md).
 * @module
 */

/**
 * The closed list of toggles this version ships, with the default each one takes when a project's
 * `holdrim.json` names none: today's behaviour, exactly, so a project that configures nothing sees
 * nothing change.
 *
 *   comments      the panel's "leave a remark" action, and the server's acceptance of a `comment`
 *                 event. On today, because commenting has always been on.
 *   pageRequests  the home screen's "ask for a page" form, and a `request` whose `data.category`
 *                 is `"page"`. On today, same reason.
 *   bugCategory   the "Report a bug" choice among a request's categories (`cycle.json`,
 *                 `request_categories.bug`), and a `request` whose `data.category` is `"bug"`.
 *                 On today.
 *   peopleScreen  the people-management SCREEN (`/engine/people`) and its link in the nav. NEVER
 *                 the `/api/users*` routes behind it: those guard who may create, reset or disable
 *                 an access, and hiding a screen must never mean disabling what it fronts
 *                 (docs/ROLES.md, "no toggle may disable a guard"). On today, because the screen
 *                 has always been reachable.
 *   graph         `holdrim graph` (engine/cli/graph.ts) and any panel rendering of the same
 *                 dependency graph. On today: the command shipped in #106 with no toggle at all.
 *   voice         NOT BUILT YET. The key exists, closed and validated, and carries a default, so a
 *                 project's `holdrim.json` can name it today and nothing has to change the day the
 *                 feature ships — but no code anywhere reads `features.voice`. Off, because "not
 *                 built" is what today's behaviour actually is: turning it "on" would promise
 *                 something that does not exist.
 *   sketch        NOT BUILT YET, same reasoning as `voice`.
 */
export const FEATURE_DEFAULTS = Object.freeze({
  comments: true,
  pageRequests: true,
  bugCategory: true,
  peopleScreen: true,
  graph: true,
  voice: false,
  sketch: false,
});

/** The toggles' names, in the order `FEATURE_DEFAULTS` declares them — read by the closed-list
 *  error message below, and by whoever wants the list without also wanting the defaults. */
export const FEATURE_KEYS = Object.freeze(Object.keys(FEATURE_DEFAULTS));

/**
 * The project's `features`, checked against the closed list — merged with `FEATURE_DEFAULTS`, never
 * replacing it, so a `holdrim.json` that sets one toggle leaves every other exactly as it was.
 *
 * Throws, rather than warns, on a key this version does not know or a value that is not a plain
 * boolean: unlike the theme (decoration, refused quietly so a bad colour cannot lock anyone out of
 * signing in), a feature toggle decides whether code that gates access RUNS AT ALL, and a project
 * that thinks it turned something off while the engine silently ignored the key is worse off than
 * one told loudly that it cannot start.
 *
 * @param {unknown} configured  `file.features` as `holdrim.json` has it, or undefined
 * @param {string} root         only for the error message, as `readConfig`'s other checks do
 */
export function readFeatures(configured, root) {
  if (configured === undefined) return { ...FEATURE_DEFAULTS };
  if (configured === null || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error(
      `${root}/holdrim.json's "features" must be an object of true/false, one per known toggle: ` +
      `${FEATURE_KEYS.join(', ')}.`);
  }

  const unknown = Object.keys(configured).filter((key) => !Object.hasOwn(FEATURE_DEFAULTS, key));
  if (unknown.length) {
    throw new Error(
      `${root}/holdrim.json names ${unknown.map((k) => `"${k}"`).join(', ')} under "features", ` +
      `which this version does not know. The toggles it ships are: ${FEATURE_KEYS.join(', ')}. ` +
      'A misspelled toggle would otherwise silently do nothing.');
  }

  for (const [key, value] of Object.entries(configured)) {
    if (typeof value !== 'boolean') {
      throw new Error(
        `${root}/holdrim.json's "features.${key}" must be true or false; got ` +
        `${JSON.stringify(value)}. Values other than booleans are refused the same way an invalid ` +
        'theme colour is: silently accepting one would mean guessing what it meant.');
    }
  }

  return { ...FEATURE_DEFAULTS, ...configured };
}
