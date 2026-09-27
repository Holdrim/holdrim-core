import { AS_AGENT_FIELD, type Event, type NewEvent } from './types.ts';
import { PERSON_ID } from './people.ts';
import { isValidRoleName, isValidScope, projectCapabilitiesOf } from '../core/roles.js';

/**
 * The project's own roles, and who holds them (docs/ROLES.md, sections 1, 2 and 5): three events,
 * written by the owner's own routes (`server.ts`) and read back on every request.
 *
 *   role_defined   a role's name and the capabilities it holds. Defining it again redefines it in
 *                  place: the latest definition is the role, and every earlier one stays in the trail.
 *   role_granted   a role, a person, and where — a scope, or everywhere.
 *   grant_revoked  which grant stopped, by the grant event's id. The grant itself is never touched:
 *                  nothing is erased, and a revocation is a later event (AGENTS.md).
 *
 * None of the three is in `EVENT_TYPES` (types.ts), so `POST /events` refuses each as unknown before
 * anything else runs — the guard `text_removed`, `lock_baseline` and the agent-token events already
 * rely on. A client able to post one could grant itself `triage` with nobody having decided it.
 *
 * `data` names the person by their id, never their address: an event cannot be emptied of an e-mail
 * later, and the people table can (docs/PRIVACY.md, sections 1 and 5). A person forgotten that way
 * keeps their grants in the trail and loses them in effect, since no address leads to the id any more.
 * Every value in `data` is a string, as `writtenBoolean` (types.ts) explains for every other field.
 */

export const ROLE_DEFINED = 'role_defined';
export const ROLE_GRANTED = 'role_granted';
export const GRANT_REVOKED = 'grant_revoked';

/**
 * Where all three live, as the agent tokens' events live on `_agent_tokens`: never a content page —
 * `PAGE_FORMAT` refuses a leading `_`, so no page's own list shows them and no page a project adds can
 * collide — and listable, like any page, by any signed-in reader through `GET /api/events?page=_roles`
 * (the owner's decision on #36): who may do what is not a secret from the people it applies to.
 */
export const ROLES_PAGE = '_roles';

/**
 * How capabilities travel inside `data`: one string, names joined by `,`. A string and not an array
 * for the reason every other value in `data` is one (`writtenBoolean`, types.ts): the CLI's Firestore
 * reader keeps only string values, and a list would come back empty there.
 */
const CAPABILITY_SEPARATOR = ',';

/** The event for defining, or redefining, a role. The capabilities come from `projectCapabilitiesOf`. */
export function definedEvent(role: string, capabilities: readonly string[], asAgent: boolean): NewEvent {
  const data = { role, capabilities: capabilities.join(CAPABILITY_SEPARATOR), [AS_AGENT_FIELD]: String(asAgent) };
  return { type: ROLE_DEFINED, page: ROLES_PAGE, block: null, data };
}

/** The event for a grant: the person by id, and `''` for a grant limited to no scope. */
export function grantedEvent(role: string, person: string, scope: string | null, asAgent: boolean): NewEvent {
  const data = { role, person, scope: scope ?? '', [AS_AGENT_FIELD]: String(asAgent) };
  return { type: ROLE_GRANTED, page: ROLES_PAGE, block: null, data };
}

/** The event for a revocation, naming the grant event it stops. */
export function revokedGrantEvent(grant: string, asAgent: boolean): NewEvent {
  const data = { grant, [AS_AGENT_FIELD]: String(asAgent) };
  return { type: GRANT_REVOKED, page: ROLES_PAGE, block: null, data };
}

/** A role as its latest definition says. `capabilities` is empty when that definition does not read. */
export interface RoleDefinition { role: string; capabilities: string[]; id: string; when: string }

/** A grant in force: never revoked, and well formed. */
export interface Grant { id: string; role: string; person: string; scope: string | null; when: string }

/** What the `_roles` events add up to, at the moment they were read. */
export interface ProjectRoles {
  /** Each role by name, as its LATEST definition has it. */
  roles: Map<string, RoleDefinition>;
  /** Every grant in force, in the order they were given. */
  grants: Grant[];
  /** The ids of the grants a revocation names. */
  revoked: Set<string>;
  /** Grants given and no longer in force, in the order they were given — for the screen's record. */
  ended: Grant[];
}

const text = (data: Event['data'], key: string): string | undefined => {
  const v = (data as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === 'string' ? v : undefined;
};

/**
 * The `_roles` events, folded: each role's latest definition, and the grants in force. Pure, and
 * the one reading every caller makes — the request's roles (`server.ts`), the routes' refusals and
 * the settings screen — so the screen never shows a grant the server does not apply, or the reverse.
 *
 * Read in the order the store returns them, which is the order they were recorded in every store
 * (`engine/tests/events-conformance.test.js`, `list` and `listBare` alike), so "latest" means the
 * last one written. Nothing here reads an event's author or text, which `listBare` leaves unresolved.
 *
 * Everything is checked again on the way in, and fails closed. The routes never write a malformed
 * event, so one here came from somewhere else — a direct writer to the store (docs/ROLES.md, section
 * 5), or a later version this one does not understand:
 *   - a definition whose name or capabilities do not read still becomes the role's latest, holding
 *     nothing: falling back to the definition before it would let a stale one stand for a role the
 *     owner meant to change;
 *   - a grant whose role, person or scope does not read is left out;
 *   - a revocation stops the grant it names wherever it sits in the order. A revocation only ever
 *     takes away, so honouring one whatever its place cannot hand anybody anything.
 */
export function projectRolesOf(events: readonly Event[]): ProjectRoles {
  const roles = new Map<string, RoleDefinition>();
  const given: Grant[] = [];
  const revoked = new Set<string>();
  for (const e of events) {
    if (e.type === ROLE_DEFINED) {
      const role = text(e.data, 'role');
      if (!isValidRoleName(role)) continue;
      const listed = text(e.data, 'capabilities');
      const capabilities = listed === undefined ? null : projectCapabilitiesOf(listed.split(CAPABILITY_SEPARATOR));
      roles.set(role!, { role: role!, capabilities: capabilities ?? [], id: e.id, when: e.when });
    } else if (e.type === ROLE_GRANTED) {
      const role = text(e.data, 'role');
      const person = text(e.data, 'person');
      const scope = text(e.data, 'scope');
      if (!isValidRoleName(role) || !person || !PERSON_ID.test(person)) continue;
      if (scope === undefined || (scope !== '' && !isValidScope(scope))) continue;
      given.push({ id: e.id, role: role!, person, scope: scope || null, when: e.when });
    } else if (e.type === GRANT_REVOKED) {
      const grant = text(e.data, 'grant');
      if (grant) revoked.add(grant);
    }
  }
  return {
    roles, revoked,
    grants: given.filter((g) => !revoked.has(g.id)),
    ended: given.filter((g) => revoked.has(g.id)),
  };
}

/**
 * The grants in force for one person, with what their role holds right now — the shape
 * `withProjectGrants` (engine/core/roles.js) takes, the address being the caller's to supply, since
 * the events hold only ids. A grant whose role has no definition that reads holds nothing, and is
 * left out.
 */
export function grantsOfPerson(state: ProjectRoles, person: string, email: string):
  { email: string; capabilities: string[]; scope: string | null }[] {
  return state.grants.filter((g) => g.person === person).flatMap((g) => {
    const capabilities = state.roles.get(g.role)?.capabilities ?? [];
    return capabilities.length ? [{ email, capabilities, scope: g.scope }] : [];
  });
}
