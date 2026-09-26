import { AS_AGENT_FIELD, type NewEvent } from './types.ts';

/**
 * The trail of agent tokens (docs/ROLES.md, section 4, "a credential of its own"): an event when the
 * owner issues one, and one when the owner revokes one, each authored by whoever did it.
 *
 * Written only by the server's own routes (`userRoutes`, server.ts), never accepted from `POST
 * /events`: neither name is in `EVENT_TYPES` (types.ts), so that route refuses both as unknown before
 * anything else runs — the guard `lock_baseline` and `text_removed` already rely on. A client able
 * to post one could write "the owner issued a token to X" with nobody having issued anything, or
 * hide a real revocation behind a forged issue.
 *
 * `data` names the agent by its person id and the token by its PUBLIC id, and nothing else: the
 * secret is never in an event, and neither is the address — an event cannot be emptied of an e-mail
 * later, and the people table can (docs/PRIVACY.md, sections 1 and 5).
 */

export const AGENT_TOKEN_ISSUED = 'agent_token_issued';
export const AGENT_TOKEN_REVOKED = 'agent_token_revoked';

/**
 * Where both events live. Never a real content page — no kind numbers a page `_…` — for the reason
 * `LOCK_BASELINE_PAGE` (types.ts) gives: no page's own list ever shows them, and a page a project adds
 * later cannot collide with it.
 */
export const AGENT_TOKEN_PAGE = '_agent_tokens';

/**
 * The event for an issue. `replacedTokenId` is the public id of the token this one replaced, when
 * the address already held one (one token per address), and `''` when it held none: the same event
 * says both that a token was issued and that the previous one stopped working, since one write did
 * both. Always present, so a reader never has to tell "none replaced" from "written before the key".
 *
 * `asAgent` is whether the AUTHOR was an agent, written from the identity the server saw, as
 * `recordEvent` writes it on every other event (docs/ROLES.md, section 4).
 */
export function issuedEvent(agentId: string, tokenId: string, replacedTokenId: string | null, asAgent: boolean): NewEvent {
  const data = { agent: agentId, tokenId, replacedTokenId: replacedTokenId ?? '', [AS_AGENT_FIELD]: String(asAgent) };
  return { type: AGENT_TOKEN_ISSUED, page: AGENT_TOKEN_PAGE, block: null, data };
}

/** The event for a revocation: which agent, and which token stopped working. */
export function revokedEvent(agentId: string, tokenId: string, asAgent: boolean): NewEvent {
  const data = { agent: agentId, tokenId, [AS_AGENT_FIELD]: String(asAgent) };
  return { type: AGENT_TOKEN_REVOKED, page: AGENT_TOKEN_PAGE, block: null, data };
}
