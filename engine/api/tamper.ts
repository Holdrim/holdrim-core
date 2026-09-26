import { AS_AGENT_FIELD, type Event, type NewEvent } from './types.ts';
import { TAMPER_KINDS, type TamperKind, type TamperReport, type TextField } from './texts.ts';

/**
 * Tampered texts, as a person sees them (issue #107): which findings are open, and the owner's
 * acknowledgement of one. Detection is not here — `withTexts` (engine/api/texts.ts) finds a field
 * tampered and `reportTampered` logs it, CRITICAL, on every read. This file only decides what the
 * panel's banner shows, and who may quiet one line of it.
 *
 * Pure, on purpose: every refusal below is proved by `engine/tests/tamper.test.js` without a server,
 * and the route in server.ts only wires these to HTTP.
 */

/**
 * The event an acknowledgement is recorded as. Written by `POST /api/tampered/acknowledge` alone —
 * never by `POST /events`, which validates against `EVENT_TYPES` (types.ts) and so refuses this name
 * as unknown, as it does `text_removed` and `lock_baseline`. The general path takes `data` from the
 * client; this event's `data` has to be what the SERVER found on its own read (which event, which
 * field, which case, which finding), or a client could acknowledge a finding nobody was shown — or
 * one that does not exist yet.
 */
export const TAMPER_ACKNOWLEDGED = 'tamper_acknowledged';

/** Every case `withTexts` reports — the one list, kept beside the type it defines (texts.ts). */
export { TAMPER_KINDS };

/** The sentence the panel says for a case — a key, never prose: the panel translates it. */
export const tamperKey = (kind: TamperKind): string => `panel.tamper.${kind}`;
/** The name of the field in the reader's language — `text` and `snapshot` are contract values. */
export const tamperFieldKey = (field: TextField): string => `panel.tamper.field.${field}`;

/** One open finding, as `GET /api/tampered` answers it. */
export interface Finding {
  finding: string;
  event: string;
  field: TextField;
  kind: TamperKind;
  page: string | null;
  block: string | null;
  key: string;
  fieldKey: string;
}

/**
 * The findings `reports` holds that no acknowledgement names — what the banner shows. `events` is
 * the same read the reports came from, so the page of each finding, and every acknowledgement, are
 * looked up in one list rather than a second read that could disagree with the first.
 *
 * An acknowledgement quiets exactly the finding it names (`findingOf`, texts.ts): a NEW tampering of
 * the same field is a different finding and shows again. It never touches the text: the field goes
 * on reading as tampered, and `reportTampered` goes on logging it, on every read.
 */
export function openFindings(reports: readonly TamperReport[], events: readonly Event[]): Finding[] {
  const acknowledged = new Set(events.filter(isAcknowledgement).map((e) => e.data!.finding as string));
  const byId = new Map(events.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const r of reports) {
    // Once per finding: a caller that read the same event twice must not draw it twice.
    if (acknowledged.has(r.finding) || seen.has(r.finding)) continue;
    seen.add(r.finding);
    const e = byId.get(r.event);
    out.push({
      finding: r.finding, event: r.event, field: r.field, kind: r.kind,
      page: e?.page ?? null, block: e?.block ?? null, key: tamperKey(r.kind), fieldKey: tamperFieldKey(r.field),
    });
  }
  return out;
}

/**
 * Whether an event quiets the finding its `data.finding` names. Its TYPE first: `data` on any other
 * event is whatever a client posted through `POST /events` — a member's comment carrying
 * `finding: <id>` would otherwise quiet the banner, walking round the owner-only route entirely.
 * And only one recorded as NOT an agent's, in the one form the route writes: the route refuses an
 * agent before it writes anything and always stamps `asAgent: "false"`, and no acknowledgement older
 * than that stamp exists. Anything else — `"true"`, a boolean, the field missing — did not come
 * through that route, and asking only `!== "true"` would let the last two quiet the banner.
 */
function isAcknowledgement(e: Event): boolean {
  return e.type === TAMPER_ACKNOWLEDGED && typeof e.data?.finding === 'string' && e.data?.[AS_AGENT_FIELD] === 'false';
}

/** The two identity questions this needs of `createRoles` (engine/core/roles.js), and no more. */
export interface WhoIs {
  isOwner(email: string): boolean;
  isAgent(email: string): boolean;
}

/**
 * Whether `email` may acknowledge a finding — the owner, and only the owner (issue #107's decision:
 * no new capability, and `admin` does not grant it). Asked of IDENTITY, like resetting the owner's
 * account, never of `can`: no role a project defines can then ever carry it.
 *
 * The agent first, as `can` asks it first (docs/ROLES.md, section 4): `rolesOf` already refuses to
 * start when `HOLDRIM_OWNER` names an agent, so today this line changes no answer — it is here so
 * that bypassing that refusal still leaves an agent unable to quiet an alert about the store it
 * writes to.
 */
export function mayAcknowledge(roles: WhoIs, email: string): boolean {
  if (roles.isAgent(email)) return false;
  return roles.isOwner(email);
}

/**
 * Why an acknowledgement is refused, as a status and a locale key — or the open finding it names.
 * Identity first, before the body is even looked at: a non-owner learns nothing about which
 * findings exist from how they are refused. Only `body.finding` is read — every other field a client
 * sends (`owner`, `author`, `asAgent`, `data`, …) is ignored, never trusted, because the event is
 * built from `found`, the server's own read.
 */
export function acknowledgementRefusal(
  roles: WhoIs, email: string, body: Record<string, unknown>, open: readonly Finding[],
): { refused: { status: number; key: string } } | { found: Finding } {
  if (!mayAcknowledge(roles, email)) return { refused: { status: 403, key: 'api.tamper.ownerOnly' } };
  const finding = body.finding;
  if (typeof finding !== 'string' || !/^[0-9a-f]{64}$/.test(finding)) return { refused: { status: 400, key: 'api.tamper.findingRequired' } };
  // Only an OPEN finding: one already acknowledged, one no longer found, and one that does not exist
  // yet are all refused alike — the last is what stops an acknowledgement from being given in
  // advance. A finding is predictable by whoever can see what it hashes: the event's recorded hash
  // is known to whoever can read the store, and the removals' ids are on every read; the row's
  // salted hash is known to whoever is about to write that row — so without this check, that writer
  // could acknowledge the tampering first.
  const found = open.find((f) => f.finding === finding);
  if (!found) return { refused: { status: 409, key: 'api.tamper.notOpen' } };
  return { found };
}

/**
 * The event an acknowledgement is: on the tampered event's own page and block, where its history is
 * read, naming what the server found — and carrying no text, so it holds nothing to erase. It does
 * not repair, re-hash or hide anything: it is one more event appended, and the text it is about goes
 * on reading as tampered.
 */
export function acknowledgementOf(found: Finding): NewEvent {
  return {
    type: TAMPER_ACKNOWLEDGED, page: found.page ?? '', block: found.block,
    data: { event: found.event, field: found.field, kind: found.kind, finding: found.finding },
  };
}
