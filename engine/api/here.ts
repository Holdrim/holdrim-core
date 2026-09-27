import { whereOf, pageOfBlock, addressOf, EVERYWHERE, type agentByToken } from '../core/roles.js';
import { isBlockId } from '../core/limits.js';

/**
 * What a person may do HERE — on one page, and on each of its blocks — asked of `roles.can` with the
 * place in hand (docs/ROLES.md, section 2, "Every capability is then asked with the page and the
 * block in hand"). The server's checks and the payload the panel draws its buttons from both come
 * out of these functions, so the panel cannot offer what the server then refuses.
 *
 * Pure, on purpose: `engine/tests/here.test.js` proves each answer with a stubbed `roles` whose
 * `triage` and `approve` disagree — which the three shipped roles never do, so no test against them
 * could tell the two capabilities apart — and `server.ts` only wires these to HTTP.
 */

/** Who asks, as server.ts's own `Who`: the token identity whole, never flattened to its address. */
type Who = string | ReturnType<typeof agentByToken>;

/** The one question these need of `createRoles`, and the identity check the agent states need. */
export interface Asks {
  can(capability: string, who: Who, where: unknown): boolean;
  isAgent(who: Who): boolean;
}

/** A request as the store holds it: where it was filed, and by whom. */
export interface StoredRequest { page: string; block?: string | null; author: string }

/**
 * Whether `request` is `who`'s own. `author` is what the store resolved from the person id the event
 * holds (`withAuthors`, engine/api/people.ts), so this is the person-id comparison with the address
 * standing in for the id: a forgotten author resolves to the id, and matches nobody.
 */
export function isOwnRequest(who: Who, request: StoredRequest): boolean {
  return addressOf(who) === request.author;
}

/**
 * Whether `who` may triage `request`: `triage` on the STORED request's place — its block, or its page
 * when it names none — never the `page` or `block` a triage event itself carries, which the client
 * wrote and could point anywhere it holds `triage`. On their OWN request, `triage` everywhere: a
 * request skips or passes triage only by someone who could have triaged it wherever it may reach, and
 * a triager whose grant is limited to some pages never decides their own (docs/ROLES.md, section 2) —
 * the same question `recordEvent` asks when it writes whether a request starts decided. The owner and
 * an admin hold `triage` everywhere, so for them this is the question it always was.
 */
export function mayTriage(roles: Asks, who: Who, request: StoredRequest): boolean {
  return roles.can('triage', who, isOwnRequest(who, request) ? EVERYWHERE : whereOf(request));
}

/**
 * Whether `who` may move `request` to `target`: `mayTriage`. The states the agent owns (`applying`,
 * `waiting`, `applied`) stay reachable by an agent, and by the local runner, on who is asking alone:
 * an agent holds no `triage` anywhere, and without this it could not move the approved request it
 * exists to apply (docs/ROLES.md, section 4).
 */
export function mayMove(
  roles: Asks, who: Who, request: StoredRequest, target: string,
  opts: { agentStates: readonly string[]; localMode: boolean },
): boolean {
  if (mayTriage(roles, who, request)) return true;
  return (opts.localMode || roles.isAgent(who)) && opts.agentStates.includes(target);
}

/**
 * Whether `who` may add details to `request`: its author, or whoever may approve where it was filed.
 * `approve` and not `triage`, because that is who has always been let in here, and a scope change is
 * not the place to change who may write into somebody else's request.
 */
export function mayAddDetails(roles: Asks, who: Who, address: string, request: StoredRequest): boolean {
  return address === request.author || roles.can('approve', who, whereOf(request));
}

/**
 * A request's `status` as `who` is sent it: the cycle's triage destinations only where `who` may
 * triage this request (`mayTriage`, their own included), and none elsewhere. The panel and the home draw their triage buttons from this
 * list and nothing else, so a list left full for someone the server would refuse is a button that
 * fails on click.
 */
export function statusFor<S extends { triage: string[] }>(
  roles: Asks, who: Who | null, request: StoredRequest, status: S,
): S {
  const may = who !== null && mayTriage(roles, who, request);
  return may ? status : { ...status, triage: [] };
}

/**
 * How many block ids one `POST /api/here` may name. The panel names the blocks it draws, so the
 * question grows with the page; without a ceiling, one request is a `can` call per id for as many ids
 * as a 1 MB body holds. Far above any real page: the template's longest has a few dozen. At the
 * longest id an event may name (`LIMITS.block`, 64), 2000 of them are about 134 KB of JSON, well
 * inside the body limit `rawBody` (server.ts) holds every request to.
 */
export const MAX_BLOCKS_ASKED = 2000;

/**
 * The block ids `POST /api/here` asks about, kept only when each is a block id an event could name
 * (`isBlockId`) AND lives on `page` (`pageOfBlock`) — the answer is about THIS page, and an id from
 * another page, or anything that is no id at all, is left out without a word: nothing a client wrote
 * there is sent back unless it is one of this page's block ids. A `blocks` that is not a list, and a
 * list over `MAX_BLOCKS_ASKED`, are refused whole rather than cut short, since a panel told about
 * only some of its blocks would draw no ✓ on the rest and look like a refusal.
 *
 * In a body and not a query string: at the longest id an event may name, a query holding every
 * block of a long page passes Node's header limit and is answered 431 before any route runs — and
 * the panel switches itself off on a failed answer, for the owner too.
 * @param raw the body's `blocks`, absent when the page level is all that is asked
 * @returns the ids kept, or the locale key of why the list was refused
 */
export function blocksAsked(page: string, raw: unknown): { ids: string[] } | { refused: string } {
  if (raw === undefined) return { ids: [] };
  if (!Array.isArray(raw)) return { refused: 'api.here.badBlocks' };
  if (raw.length > MAX_BLOCKS_ASKED) return { refused: 'api.here.tooManyBlocks' };
  return { ids: [...new Set(raw)].filter((id): id is string => isBlockId(id) && pageOfBlock(id) === page) };
}

/**
 * `POST /api/here`'s answer: what `who` may do on `page`, and on each block the panel named. Booleans
 * only — never a scope, a role or a grant — because the panel draws buttons from this and learns
 * nothing about roles (docs/ROLES.md, section 2), and because a scope string that reached the page
 * would be configuration landing in HTML.
 *
 * `page` must already be a valid page code, and `blockIds` what `blocksAsked` kept: the route checks
 * both before asking.
 */
export function hereOf(roles: Asks, who: Who, page: string, blockIds: Iterable<string>) {
  const onPage = { page };
  const blocks: Record<string, { triage: boolean; approve: boolean }> = {};
  for (const id of blockIds) {
    blocks[id] = { triage: roles.can('triage', who, { block: id }), approve: roles.can('approve', who, { block: id }) };
  }
  return {
    page,
    may: {
      comment: roles.can('comment', who, onPage), request: roles.can('request', who, onPage),
      triage: roles.can('triage', who, onPage), approve: roles.can('approve', who, onPage),
    },
    blocks,
  };
}

/**
 * Whether `who` may act on `block` at all: triage it, or approve it — whichever the block's place
 * grants (docs/ROLES.md, section 2). The one question the home's documentation graph asks per node
 * for its "where I may act" filter (#42, box three): the graph draws no distinction between the two
 * capabilities the way `hereOf` does, only whether there is anything to do here or not, so an `or`
 * of both is the whole answer and not a third capability invented for the filter alone.
 *
 * Boolean only, like `hereOf`'s own answer — never a scope: today no grant `can` reads is scoped
 * (owner and admin hold it everywhere, member holds neither anywhere), so a member's graph empties
 * entirely and an agent's does too, `AGENT_NEVER` refusing both `triage` and `approve` before a
 * grant is ever read (`can`, engine/core/roles.js). Scoped grants (#36) narrow this to real subsets
 * without this function, or its one caller in `server.ts`, changing at all.
 */
export function mayActOn(roles: Asks, who: Who, block: string): boolean {
  return roles.can('triage', who, { block }) || roles.can('approve', who, { block });
}
