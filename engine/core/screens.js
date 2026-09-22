/**
 * Where the engine's own screens are served. One place, because more than one thing has to agree
 * on them: the server matches these paths, and `config.js` sends `/` to the home by default. Written
 * twice, a rename in one would leave the root redirecting to a page that no longer answers.
 *
 * Under `/engine/` so a project's own page called `home` is never shadowed by the engine's.
 */
export const HOME_SCREEN = '/engine/home';

/** Who can sign in, managed from the browser — password identity only. See engine/api/people-page.ts. */
export const PEOPLE_SCREEN = '/engine/people';
