import { AS_AGENT_FIELD, type Event, type EventStore, type NewEvent } from './types.ts';
import { normalizeEmail, isEmailAddress, type UserStore } from './users.ts';
import { recordAuthored } from './people.ts';
import { NoText } from './texts.ts';
import { ROLES_PAGE, projectRolesOf, revokedGrantEvent } from './role-grants.ts';
import type { Identity } from '../core/roles.js';

/**
 * Removing a person, at their request (docs/PRIVACY.md, section 5): the owner's one step from the
 * settings screen, which the section used to describe as a procedure run by hand.
 *
 * What goes is what names the person, and what they wrote: their account's e-mail, name, password and
 * sessions (`UserStore.removeAccount`), the text of every event they wrote (`EventStore.removeText`,
 * each with its own `text_removed` event), the grants of the project's roles in force for them (each
 * revoked by a later `grant_revoked`), and the e-mail in their row of the people table
 * (`EventStore.forget`). What stays is the trail: every event, its fingerprint, its snapshot — the
 * documentation's own text, never the person's — and the lock written on it, so a ✓ they gave stays
 * exactly what it was, under an id that leads to nobody. Nothing is erased that §5 does not name.
 *
 * `person_removed` records that it happened: who removed whom, by ids only, and how many texts and
 * grants went with it. Like `grant_revoked` and `agent_token_issued`, it is not in `EVENT_TYPES`
 * (types.ts), so `POST /events` refuses it as unknown: a client able to post one could claim a person
 * was removed while their e-mail is still in the table.
 */

export const PERSON_REMOVED = 'person_removed';

/**
 * Where `person_removed` lives, as `_roles` and `_agent_tokens` hold theirs: never a content page,
 * since `PAGE_FORMAT` refuses a leading `_`, and listable by anyone signed in, as those two are.
 */
export const PEOPLE_PAGE = '_people';

/** What a removal wrote, counted, for the event and the log line. */
export interface Removal {
  /** The person's id: what the trail names them by from now on. */
  person: string;
  /** Texts removed, each with its own `text_removed` event. */
  texts: number;
  /**
   * Texts this run found and did not remove: tampered with — a removal would read as the reason the
   * row is gone and silence the finding (#133) — held inside the event itself, from before texts
   * moved out of events, where nothing can remove them, or removed a moment earlier by a removal
   * running beside this one.
   */
  textsLeft: number;
  /** Grants of the project's roles revoked. */
  grants: number;
  /** Whether there was an account to empty: never, behind an identity proxy. */
  account: boolean;
}

/**
 * The event, with ids and counts only. Every value is a string, as `writtenBoolean` (types.ts) says
 * every value in `data` is. `asAgent` from the identity the server saw, as on every other event.
 */
export function removedPersonEvent(removal: Removal, asAgent: boolean): NewEvent {
  const data = {
    person: removal.person, texts: String(removal.texts), textsLeft: String(removal.textsLeft),
    grants: String(removal.grants), account: String(removal.account), [AS_AGENT_FIELD]: String(asAgent),
  };
  return { type: PERSON_REMOVED, page: PEOPLE_PAGE, block: null, data };
}

/** What `removePerson` answered: the event and the counts, or the sentence that says why not. */
export type RemovalOutcome =
  | { status: 201; event: Event; removal: Removal }
  | { status: 400 | 404 | 409; key: string; params?: Record<string, string> };

/** What `removePerson` works on: the stores, the deployment, and who is removing. */
export interface RemovalContext {
  events: EventStore;
  /** The accounts, under password sign-in; null behind an identity proxy, where there are none. */
  users: UserStore | null;
  /** Who the deployment names: the owner, the admins, the lock-holders, the agents. */
  deployment: Identity;
  /** The address of whoever removes — the owner, which the caller has already checked. */
  by: string;
  /** Whether whoever removes is an agent, for `asAgent`. */
  byAgent: boolean;
}

/**
 * Removes the person `asked.email` names. Who may ask is the caller's to decide, before this runs:
 * the owner alone (docs/ROLES.md, section 1; `serveSettings` and `removeFromSettings`, server.ts).
 *
 * Refused, and nothing written:
 * - without `confirmed`: removing cannot be undone, so the form asks, and so does this;
 * - the owner: named by `HOLDRIM_OWNER`, and the one account that has to exist for anyone to hand
 *   over (AGENTS.md, "Exactly one owner"). The owner hands over first; the new owner removes the old;
 * - an address the deployment still names — `HOLDRIM_ADMINS`, `HOLDRIM_LOCKS`, `HOLDRIM_AGENTS`. The
 *   variable is authority set where Holdrim runs, and it would go on naming the address after the
 *   row was emptied: behind a proxy the person's next visit comes back an admin, as a new person.
 *   Out of the variable and restarted first, then removed;
 * - an address holding an agent token: the token would go on writing, as a new person, the moment
 *   the row was emptied. Revoked first;
 * - an address with no account and no row in the people table: nobody to remove. This is also what
 *   a second run answers, since the first emptied both.
 *
 * The steps run in an order a failure can resume from: run again, a removal that stopped half-way
 * finds the row still holding the address and finishes. The account goes first, so no session of
 * theirs acts while the rest runs; the row is emptied last, since it is what finds the person again.
 */
export async function removePerson(
  context: RemovalContext, asked: { email: unknown; confirmed: boolean },
): Promise<RemovalOutcome> {
  const { events, users, deployment, by } = context;
  const address = normalizeEmail(typeof asked.email === 'string' ? asked.email : '');
  if (!isEmailAddress(address)) return { status: 400, key: 'api.users.emailInvalid', params: { email: address } };
  if (!asked.confirmed) return { status: 400, key: 'api.removal.unconfirmed' };
  if (deployment.isOwner(address)) return { status: 409, key: 'api.removal.notTheOwner' };
  const variable = deployment.admins.includes(address) ? 'HOLDRIM_ADMINS'
    : deployment.isLockHolder(address) ? 'HOLDRIM_LOCKS'
      : deployment.isAgent(address) ? 'HOLDRIM_AGENTS' : null;
  if (variable) return { status: 409, key: 'api.removal.namedByDeployment', params: { email: address, variable } };
  if (users && (await users.listAgentTokens()).some((t) => t.email === address)) {
    return { status: 409, key: 'api.removal.holdsAgentToken', params: { email: address } };
  }
  const known = await events.personOf(address);
  const account = users ? await users.find(address) : null;
  if (!known && !account) return { status: 404, key: 'api.removal.nobody', params: { email: address } };
  // An account whose person never acted has no row yet: one is made, to be emptied at once, so the
  // event has an id to name — the id nothing else in the trail names.
  const person = known ?? await events.personFor(address);

  const hadAccount = users ? await users.removeAccount(address) : false;

  let texts = 0;
  let textsLeft = 0;
  for (const e of await events.list(null)) {
    if (e.authorId !== person) continue;
    // Before the value is read: a tampered field reads as null, and would pass for one never given.
    if (e.textTampered) { textsLeft++; continue; }
    if (e.text == null) continue;
    try {
      await events.removeText(e.id, 'text', by);
      texts++;
    } catch (error) {
      // Never in a row of its own, from before texts left the event — or gone a moment ago, to a
      // removal running beside this one. Anything else is the store failing, and stops here: run
      // again, the removal picks up where it stopped.
      if (!(error instanceof NoText)) throw error;
      textsLeft++;
    }
  }

  const roles = projectRolesOf(await events.listBare(ROLES_PAGE));
  const mine = roles.grants.filter((g) => g.person === person);
  for (const g of mine) await recordAuthored(events, revokedGrantEvent(g.id, context.byAgent), by);

  const removal: Removal = { person, texts, textsLeft, grants: mine.length, account: hadAccount };
  const { event } = await recordAuthored(events, removedPersonEvent(removal, context.byAgent), by);
  await events.forget(person);
  return { status: 201, event, removal };
}
