/**
 * Loaded with `node --import`: `rolesOf` (engine/core/roles.js) hands back the real roles, except
 * that ONE address, `scoped@example.org`, holds `triage` on page A01 alone and `approve` on page A02
 * alone — never the same place, the one shape no shipped role can take.
 *
 * Proof for #33, round 2 of its review: the server judges triage and "add details" on the STORED
 * request's place, never on the page and block the event itself names. The shipped roles are
 * unscoped, so a server that read the client's block instead gives every one of them the same answer,
 * and `engine/test-contract.sh` could not tell the two apart; `engine/tests/here.test.js` proves
 * `engine/api/here.ts` alone, not what `server.ts` hands it. Booting the real server with this hook is
 * the only way to drive the server's own event path with roles where the place changes the answer.
 *
 * Test-only by construction: nothing in configuration, the environment or a route reaches it — only
 * a process started with `--import` of this file, which the contract test does once, for this.
 * Everything else about the roles is the real code: the wrapper answers `can` for the one address and
 * hands every other question, and every other person, to the roles `rolesOf` really built.
 *
 * A `data:` URL module over the real file, reached through a `?real` query: the redirect below would
 * otherwise catch the wrapper's own import of roles.js and recurse into itself forever.
 */
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function load(url, context, next) {
    if (!url.endsWith('/engine/core/roles.js')) return next(url, context);
    const real = JSON.stringify(url + '?real');
    return {
      format: 'module', shortCircuit: true,
      source: \`
        import * as real from \${real};
        export * from \${real};
        const SCOPED = 'scoped@example.org';
        const MAY = { triage: 'A01', approve: 'A02', read: null, comment: null, request: null };
        export function rolesOf(config) {
          const roles = real.rolesOf(config);
          return { ...roles, can(capability, who, where) {
            if (real.addressOf(who) !== SCOPED) return roles.can(capability, who, where);
            if (roles.isAgent(who)) return roles.can(capability, who, where);
            if (where === undefined) throw new Error('asked without where');
            return Object.hasOwn(MAY, capability) && real.scopeCovers(MAY[capability], where);
          } };
        }
      \`,
    };
  }
`));
