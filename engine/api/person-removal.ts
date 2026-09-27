import { AS_AGENT_FIELD, LOCK_BASELINE_PAGE, earliestLockBaseline, type Event, type EventStore, type NewEvent } from './types.ts';
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
 * sessions (`UserStore.closeAccount`, `UserStore.emptyAccount`), the text of every event they wrote
 * (`EventStore.removeText`, each with its own `text_removed` event), the grants of the project's roles
 * in force for them (each revoked by a later `grant_revoked`), and the e-mail in their row of the
 * people table (`EventStore.forget`). What stays is the trail: every event, its fingerprint, its
 * snapshot — the documentation's own text, never the person's — and the lock written on it, so a ✓
 * they gave stays exactly what it was, under an id that leads to nobody. Nothing is erased that §5
 * does not name.
 *
 * `person_removed` records that it happened: who removed whom, by ids only, and what this run let go
 * of and could not. Like `grant_revoked` and `agent_token_issued`, it is not in `EVENT_TYPES`
 * (types.ts), so `POST /events` refuses it as unknown: a client able to post one could claim a person
 * was removed while their e-mail is still in the table.
 */

export const PERSON_REMOVED = 'person_removed';

/**
 * Where `person_removed` lives, as `_roles` and `_agent_tokens` hold theirs: never a content page,
 * since `PAGE_FORMAT` refuses a leading `_`, and listable by anyone signed in, as those two are.
 */
export const PEOPLE_PAGE = '_people';

/** What one run of a removal did, counted, for the event, the log line and the screen. */
export interface Removal {
  /** The person's id: what the trail names them by from now on. */
  person: string;
  /** Texts this run removed, each with its own `text_removed` event. */
  texts: number;
  /**
   * Texts left because they read as tampered with: a removal beside one would read as the reason
   * its row is gone, and silence the finding (#133).
   */
  textsTampered: number;
  /**
   * Texts left because they have no row of their own to remove: held inside the event itself, from
   * before texts moved out of events, where nothing can remove them — or removed a moment earlier by
   * a removal running beside this one.
   */
  textsInline: number;
  /**
   * Events whose author is still the address itself, from before authors were ids. Nothing rewrites
   * an event, so they go on naming the address — and, under password sign-in, the address stays
   * taken by the closed account, so nobody new becomes their author.
   */
  legacyEvents: number;
  /** Grants of the project's roles this run revoked. */
  grants: number;
  /** Whether there was an account to close: never, behind an identity proxy. */
  account: boolean;
}

/**
 * The event, with ids and counts only. Every value is a string, as `writtenBoolean` (types.ts) says
 * every value in `data` is. `asAgent` from the identity the server saw, as on every other event.
 */
export function removedPersonEvent(removal: Removal, asAgent: boolean): NewEvent {
  const data = {
    person: removal.person, texts: String(removal.texts), textsTampered: String(removal.textsTampered),
    textsInline: String(removal.textsInline), legacyEvents: String(removal.legacyEvents),
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

/** Whether an event's author, as stored, is the address itself — an event from before authors were ids. */
const namesAddress = (e: Event, address: string) => normalizeEmail(e.authorId ?? e.author) === address;

/**
 * Removes the person `asked.email` names. Who may ask is the caller's to decide, before this runs:
 * the owner alone (docs/ROLES.md, section 1; `serveSettings` and `removeFromSettings`, server.ts).
 *
 * Refused, and nothing written:
 * - without `confirmed`: removing cannot be undone, so the form asks, and so does this;
 * - the owner: named by `HOLDRIM_OWNER`, and the one account that has to exist for anyone to hand
 *   over (AGENTS.md, "Exactly one owner"). The owner hands over first;
 * - an address the deployment still names — `HOLDRIM_ADMINS`, `HOLDRIM_LOCKS`, `HOLDRIM_AGENTS`. The
 *   variable is authority set where Holdrim runs, and it would go on naming the address after the
 *   row was emptied: behind a proxy the person's next visit comes back an admin, as a new person.
 *   Out of the variable and restarted first, then removed;
 * - an address holding an agent token: the token would go on writing, as a new person, the moment
 *   the row was emptied. Revoked first;
 * - the person whose row makes their oldest ✓s locks: the author of the lock baseline, when a ✓ from
 *   before it still names their address (`legacyLock`, types.ts). Such a ✓ is a lock only because
 *   the baseline's author id reads as that address, and forgetting the row would un-lock it;
 * - an address with no account and no row in the people table: nobody to remove. This is also what
 *   a second run answers, since the first emptied both — or, when events from before authors were
 *   ids name it, nothing that can be let go of, and it says so.
 *
 * The steps run in an order a failure can be resumed from, and never leave the address free while
 * the row still leads to the person — an account made for it then would act under their id. The
 * account is closed first, keyed by its address, so no session of theirs acts meanwhile and the
 * address stays taken; the grants go before the texts; the account is emptied before the row is
 * forgotten; and the address is freed only after. Run again, a removal a failure stopped finds the row
 * still holding the address and finishes, writing `person_removed` only if no earlier run did.
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
  if (known) {
    const baseline = earliestLockBaseline(await events.listBare(LOCK_BASELINE_PAGE));
    // Any ✓ naming the address, not only those dated before the baseline: one dated after it is no
    // lock anyway, and refusing for it costs a removal nothing that the rule does not already cost.
    if (baseline && (baseline.authorId ?? baseline.author) === known
      && (await events.list(null)).some((e) => e.type === 'approval' && namesAddress(e, address))) {
      return { status: 409, key: 'api.removal.holdsOldLocks', params: { email: address } };
    }
  }
  if (!known && !account) {
    // Named only by events from before authors were ids: nothing rewrites them, and there is no row
    // or account to let go of. Made into a person here, every later run would make another.
    const older = (await events.list(null)).some((e) => namesAddress(e, address));
    return older ? { status: 409, key: 'api.removal.onlyOlderEvents', params: { email: address } }
      : { status: 404, key: 'api.removal.nobody', params: { email: address } };
  }
  // An account whose person never acted has no row yet: one is made, to be emptied at once, so the
  // event has an id to name — the id nothing else in the trail names.
  const person = known ?? await events.personFor(address);

  const hadAccount = users ? await users.closeAccount(address) : false;

  const mine = projectRolesOf(await events.listBare(ROLES_PAGE)).grants.filter((g) => g.person === person);
  for (const g of mine) await recordAuthored(events, revokedGrantEvent(g.id, context.byAgent), by);

  let texts = 0;
  let textsTampered = 0;
  let textsInline = 0;
  let legacyEvents = 0;
  for (const e of await events.list(null)) {
    const legacy = namesAddress(e, address);
    if (e.authorId !== person && !legacy) continue;
    if (legacy) legacyEvents++;
    // Before the value is read: a tampered field reads as null, and would pass for one never given.
    if (e.textTampered) { textsTampered++; continue; }
    if (e.text == null) continue;
    try {
      await events.removeText(e.id, 'text', by);
      texts++;
    } catch (error) {
      // No row of its own to remove. Anything else is the store failing, and stops here: run again,
      // the removal picks up where it stopped.
      if (!(error instanceof NoText)) throw error;
      textsInline++;
    }
  }

  const removal: Removal = { person, texts, textsTampered, textsInline, legacyEvents, grants: mine.length, account: hadAccount };
  // Once per person: a run that a failure stopped after the event was written finishes without a
  // second one, and answers with the first.
  const earlier = (await events.list(PEOPLE_PAGE)).find((e) => e.type === PERSON_REMOVED && e.data?.person === person);
  const event = earlier ?? (await recordAuthored(events, removedPersonEvent(removal, context.byAgent), by)).event;
  if (users) await users.emptyAccount(address, true);
  await events.forget(person);
  // Freed last, once nothing leads from the address to the id; kept while an older event names it.
  if (users && legacyEvents === 0) await users.emptyAccount(address, false);
  return { status: 201, event, removal };
}
