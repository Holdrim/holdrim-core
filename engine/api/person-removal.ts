import { randomBytes } from 'node:crypto';
import { AS_AGENT_FIELD, authoritative, type Event, type EventStore, type NewEvent } from './types.ts';
import { normalizeEmail, isEmailAddress, type UserStore } from './users.ts';
import { recordAuthored } from './people.ts';
import { NoText } from './texts.ts';
import { ROLES_PAGE, projectRolesOf, revokedGrantEvent } from './role-grants.ts';
import { log } from './log.ts';
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
  /** The time, in milliseconds, for the removal's claim: `Date.now` unless a test sets another. */
  clock?: () => number;
}

/** Whether an event's author, as stored, is the address itself — an event from before authors were ids. */
const namesAddress = (e: Event, address: string) => normalizeEmail(e.authorId ?? e.author) === address;

/**
 * How long a run's claim on a removal lasts (`EventStore.claimRemoval`) before another run may take it
 * over. A run renews it as it goes, so a long removal keeps it however long it takes; a run whose
 * process died lets it lapse, and the removal is run again that much later. Two minutes: far longer
 * than any pause between two steps of one run, and short enough that nobody waits long to resume.
 */
export const REMOVAL_CLAIM_MS = 2 * 60_000;

/** How often a run renews its claim: every quarter of it, so three quarters are always left. */
const REMOVAL_RENEW_MS = REMOVAL_CLAIM_MS / 4;

/** What another run's claim answers: the removal is running, and running it twice would count twice. */
const inProgress = (address: string): RemovalOutcome =>
  ({ status: 409, key: 'api.removal.inProgress', params: { email: address } });

/** Thrown when a run's claim went to another run: this one stops where it is, and the other finishes. */
class ClaimLost extends Error {}

/**
 * One run's claim on the removal of `person`, under a holder nobody else has. `hold` takes or renews
 * it, and says whether it was given; `keep` renews it once `REMOVAL_RENEW_MS` has gone by since the
 * last renewal, or at once when `now` is set, and stops the run when it was not given.
 */
function claimOn(events: EventStore, person: string, clock: () => number) {
  const holder = randomBytes(12).toString('hex');
  const iso = (ms: number) => new Date(ms).toISOString();
  let renewed = -Infinity;
  const hold = async (): Promise<boolean> => {
    const at = clock();
    if (!(await events.claimRemoval(person, holder, iso(at), iso(at + REMOVAL_CLAIM_MS)))) return false;
    renewed = at;
    return true;
  };
  return {
    hold,
    keep: async (now = false): Promise<void> => {
      if (!now && clock() - renewed < REMOVAL_RENEW_MS) return;
      if (!(await hold())) throw new ClaimLost();
    },
    release: () => events.releaseRemoval(person, holder),
  };
}
type Claim = ReturnType<typeof claimOn>;

/**
 * What a run answers when nobody is left to remove: no account and no row in the people table. When
 * events from before authors were ids name the address, the refusal says so: nothing rewrites them,
 * and made into a person here, every later run would make another.
 */
async function nobodyLeft(events: EventStore, address: string): Promise<RemovalOutcome> {
  const older = (await events.list(null)).some((e) => namesAddress(e, address));
  return older ? { status: 409, key: 'api.removal.onlyOlderEvents', params: { email: address } }
    : { status: 404, key: 'api.removal.nobody', params: { email: address } };
}

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
 * - an address with no account and no row in the people table: nobody to remove. This is also what
 *   a second run answers, since the first emptied both — or, when events from before authors were
 *   ids name it, nothing that can be let go of, and it says so;
 * - a person another run is removing right now: see "One run at a time", below.
 *
 * The steps run in an order a failure can be resumed from, and never leave the address free while
 * the row still leads to the person — an account made for it then would act under their id. The
 * account is closed first, keyed by its address, so no session of theirs acts meanwhile and the
 * address stays taken; the grants go before the texts; the account is emptied before the row is
 * forgotten; and the address is freed only after. Run again, a removal a failure stopped finds the row
 * still holding the address and finishes, writing `person_removed` only if no earlier run did.
 *
 * One run at a time (#181). Two runs side by side — the form sent twice, two tabs, two server
 * instances — would each see no `person_removed` yet and each write one, each counting what it
 * happened to reach first. So before its first write a run claims the removal of the person's id
 * (`EventStore.claimRemoval`), in the store the removal writes to, which every instance shares; a
 * second run is refused while the claim holds, with nothing written but, for an account whose person
 * never acted, the row both runs make for it. The claim is let go of when the run ends, however it
 * ends, so a removal a failure stopped is run again at once. A run whose process died cannot let go
 * of it: the claim lapses `REMOVAL_CLAIM_MS` later, and the removal is run again then. A run renews
 * it as it goes, and again before closing the account and before each of its last writes, and stops
 * if another run has taken it over. What it cannot cover is a run that stalls between a renewal and
 * the write right after it for longer than the whole claim: that one write can then land after
 * another run's. A `person_removed` written that late is a second one for the person; an account
 * closed that late can be one somebody new opened at the freed address, closed and never emptied;
 * and an address freed that late can be one a third removal, of the person who took it next, has
 * closed and is still running on, left free before that person's row is forgotten.
 *
 * The claim is not signed, and needs no signature (#50): it is not an event and grants nothing — it
 * only makes a second run wait. A claim written into the store directly can make a removal wait, at
 * most one claim's length (`claimGiven`, types.ts, voids one that ends further off), which anyone
 * able to write the store could do by far simpler means. What a removal leaves behind that does
 * count — its `grant_revoked`, `text_removed` and `person_removed` events — is signed like every
 * event, and a resumed run finishes only from a `person_removed` this server signed.
 */
export async function removePerson(
  context: RemovalContext, asked: { email: unknown; confirmed: boolean },
): Promise<RemovalOutcome> {
  const { events, users, deployment } = context;
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
  // No ✓ ties a lock to this person's row: a lock is the signed `locks` on the event, whoever its
  // author's id leads to, so forgetting the row un-locks nothing (#50 retired the lock baseline, which
  // read an old ✓ as a lock through the row of the owner it named, and made this refuse for it).
  const known = await events.personOf(address);
  const account = users ? await users.find(address) : null;
  if (!known && !account) return nobodyLeft(events, address);
  // An account whose person never acted has no row yet: one is made, to be emptied at once, so the
  // event has an id to name — the id nothing else in the trail names. Before the claim, which is
  // taken on that id: two runs for one address are handed the same one.
  const person = known ?? await events.personFor(address);

  const claim = claimOn(events, person, context.clock ?? Date.now);
  if (!(await claim.hold())) return inProgress(address);
  try {
    return await removeClaimed(context, address, person, known !== null, claim);
  } catch (error) {
    if (error instanceof ClaimLost) {
      // Said, by id: a run that stops here may already have written its part, and the log is where
      // the operator sees that another run went on with it.
      log('WARNING', 'person_removal_stopped', { person });
      return inProgress(address);
    }
    throw error;
  } finally {
    // A claim that cannot be let go of lapses on its own, `REMOVAL_CLAIM_MS` later: the run's own
    // answer, or its own error, is still the one to hand back.
    await claim.release().catch(() => log('WARNING', 'removal_claim_kept', { person }));
  }
}

/** The removal itself, under the run's claim: `removePerson` has decided whom, and that they may go. */
async function removeClaimed(
  context: RemovalContext, address: string, person: string, hadRow: boolean, claim: Claim,
): Promise<RemovalOutcome> {
  const { events, users, by } = context;
  // Read again under the claim: what was read before it may be what another run has changed since.
  // A run that finished meanwhile forgot the row, and this one answers as a second run does. Nor is
  // an account whose row this run just made still there, if a removal took it meanwhile: the row
  // names nothing, and is forgotten again rather than removed as a person.
  if ((await events.personOf(address)) !== person) return nobodyLeft(events, address);
  if (!hadRow && users && !(await users.find(address))) {
    await events.forget(person);
    return nobodyLeft(events, address);
  }

  // Every write that acts on the address — closing the account here, emptying it, forgetting the row
  // — goes only while this run still holds the claim and the address still leads to this person: a
  // run that stalled before it long enough for another to take the claim over and finish would
  // otherwise act after it, on an address somebody new may have taken since.
  const stillMine = async () => {
    await claim.keep(true);
    if ((await events.personOf(address)) !== person) throw new ClaimLost();
  };

  let hadAccount = false;
  if (users) {
    await stillMine();
    hadAccount = await users.closeAccount(address);
  }

  const mine = projectRolesOf(await events.listBare(ROLES_PAGE)).grants.filter((g) => g.person === person);
  for (const g of mine) {
    await claim.keep();
    await recordAuthored(events, revokedGrantEvent(g.id, context.byAgent), by);
  }

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
    await claim.keep();
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
  // second one, and answers with the first. Only one this server signed: a `person_removed` inserted
  // by a direct writer would otherwise stop every later removal of that person from being recorded.
  const earlier = authoritative(await events.list(PEOPLE_PAGE))
    .find((e) => e.type === PERSON_REMOVED && e.data?.person === person);
  let event = earlier;
  if (!event) {
    // Renewed now, whenever it last was: the write is what a run that took the claim over meanwhile
    // would also make, and this is the last moment to find out.
    await claim.keep(true);
    event = (await recordAuthored(events, removedPersonEvent(removal, context.byAgent), by)).event;
  }
  // The last three steps, as closing was: the first two under `stillMine`, and freeing under the
  // claim alone, since the row no longer leads anywhere. `emptyAccount` itself touches only a row a
  // removal closed, never an account open at the address, whatever reaches it.
  if (users) {
    await stillMine();
    await users.emptyAccount(address, true);
  }
  await stillMine();
  await events.forget(person);
  // Freed last, once nothing leads from the address to the id; kept while an older event names it.
  if (users && legacyEvents === 0) {
    await claim.keep(true);
    await users.emptyAccount(address, false);
  }
  return { status: 201, event, removal };
}
