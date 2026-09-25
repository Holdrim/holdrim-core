import { createHash, randomBytes } from 'node:crypto';
import { log } from './log.ts';

/**
 * Where a request's, a comment's or a supplement's free text — and an approval's or a request's
 * `snapshot` — actually live: a table of texts, one row per event and field, kept by every event
 * store next to its events and its people (docs/PRIVACY.md, section 4). The event itself keeps only
 * a salted hash of each field it was given: proof, while the row is there, that it is the text that
 * was recorded — and nothing an unsalted hash of a short guess (a CPF, an e-mail) could be tested
 * against once the row, and the salt with it, is gone.
 *
 * The event type a removal is recorded as. Written only by `EventStore.removeText`, which deletes
 * the row and records this event as one step — never by the general POST /events path: that path
 * validates against `EVENT_TYPES` (engine/api/types.ts), and this name is deliberately not in it.
 * The right door for a person to ask for a removal, with its own permission and audit story, is a
 * later issue; a client that could freely claim "this was removed" would only pollute the trail
 * through the API, where nothing but `removeText` can also make the row agree with the claim.
 *
 * ⚠️ That is the API's protection, not the file's. SQLite's guards (`texts_no_update`,
 * `texts_no_replace`, `texts_no_delete` in store-sqlite.ts) refuse an UPDATE, a REPLACE and a bare
 * DELETE from any program that does not first drop them — they stop mistakes and ordinary tools, not
 * someone with write access to the file, who can `DROP TRIGGER` before touching a row, or simply
 * `INSERT` a forged `text_removed` event and let `texts_no_delete` find it there: the event it
 * demands is there, forged or not, so the DELETE it then allows removes a real row on a forged
 * say-so. (A dropped trigger is reinstalled, but only silently, on the next boot — a pre-existing
 * gap, holdrim#89, that this file does not close either.) `removalsOf` below closes part of the
 * forged-event path, by dating (round 2, finding F): a removal only counts once it is later, in time
 * and in the list, than the event it names, so it cannot be backdated ahead of a text that, by its
 * own clock, did not exist yet. It does not close the rest — a removal dated and ordered after its
 * target, forged by the same direct writer, still reads as genuine, and dropping a trigger outright
 * is not dated at all. Closing either needs the events themselves signed, so a reader can tell the
 * server wrote one from one anybody with the file could insert (docs/PRIVACY.md, section 3, "not
 * built"; SECURITY.md says the same of the file as a whole).
 */
export const TEXT_REMOVED = 'text_removed';

export type TextField = 'text' | 'snapshot';
export const TEXT_FIELDS: readonly TextField[] = ['text', 'snapshot'];

/** A row of the texts table, as a store hands it to `withTexts`: the value, and the salt its hash used. */
export interface TextRow {
  value: string;
  salt: string;
}

/** `event` and `field` combined into the one key a store's texts table — and this file — addresses a row by. */
export function textKey(event: string, field: TextField): string {
  return `${event}:${field}`;
}

/**
 * 128 random bits, one per text, never derived from the value it will be hashed with — the same
 * reason `newPersonId` (engine/api/people.ts) gives for a random id over a hash of the e-mail: a
 * salt guessable from the text it protects would make the hash testable against a guess the moment
 * an attacker also knew, or reused, that salt.
 */
export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * The hash an event carries for one field. A NUL byte separates the salt from the value so that no
 * pair of (salt, value) can be mistaken for another with the boundary moved — `("ab", "c")` and
 * `("a", "bc")` hash the same under plain concatenation and do not under this one.
 */
export function hashText(value: string, salt: string): string {
  return createHash('sha256').update(salt, 'utf8').update('\u0000').update(value, 'utf8').digest('hex');
}

/** One freshly-salted row of the texts table, ready to write, for one field an event was given. */
export interface SaltedRow {
  field: TextField;
  value: string;
  salt: string;
}

/** What `append` needs to write, for `text` and `snapshot` together: the event's own hashes, and the texts rows. */
export interface SaltedFields {
  /** What the event's own row keeps — `null` for a field the event was not given. */
  hashes: Record<TextField, string | null>;
  /** One entry per field the event WAS given, ready to insert into the texts table. */
  rows: SaltedRow[];
}

/**
 * Salts and hashes each of `text`/`snapshot` a fresh event carries, in the one place this pairing
 * is built — every store's `append` used to write this same loop out by hand, three chances for
 * the hash on the event and the row in the texts table to quietly stop agreeing with each other.
 */
export function saltFields(event: { text?: string | null; snapshot?: string | null }): SaltedFields {
  const hashes: Record<TextField, string | null> = { text: null, snapshot: null };
  const rows: SaltedRow[] = [];
  for (const field of TEXT_FIELDS) {
    const value = event[field];
    if (value == null) continue;
    const salt = newSalt();
    hashes[field] = hashText(value, salt);
    rows.push({ field, value, salt });
  }
  return { hashes, rows };
}

/** The one error every store gives for a field with nothing to remove, so a caller matches one text. */
export function noText(event: string, field: TextField): Error {
  return new Error(`no ${field} to remove on event ${event}: it was never given, or is already gone`);
}

/**
 * `when`, unless it would date a removal before the text it removes — every store's `removeText`
 * clamps to this before writing the removal event (round 3, finding 3). SQLite and Memory stamp
 * `when` from the process wall clock; a clock that steps back between an `append` and the
 * `removeText` that follows it (NTP, a VM resuming from an earlier snapshot) would otherwise date
 * the removal before its own target, and `removalsOf`'s ordering check (round 2, finding F) — which
 * has to stay exactly as strict as it is — would then refuse a genuine removal forever: events are
 * immutable, so there is no later moment to fix it in. A clamped tie still sorts after its target,
 * by insertion — SQLite's `ORDER BY happened_at, rowid`, Memory's stable sort on equal keys — since
 * a removal is always INSERTED after the event it names, whatever the clock says.
 *
 * Firestore needs none of this: `FieldValue.serverTimestamp()` is the server's own clock, already
 * monotonic across everything one project writes, torn reads and clock skew on any one caller's
 * machine included.
 */
export function notBefore(when: string, target: string): string {
  return when < target ? target : when;
}

/**
 * What a removed field is told as, once resolved: who removed it and when — never the text itself,
 * which left with its salt the moment the row did.
 */
export interface Removed {
  by: string;
  when: string;
}

/**
 * `removed`, with `by` sent through the same resolution `author` already gets — round 1 of the
 * issue #31 review, finding 1. `removalsOf` below records `by` as the resolved address, because
 * `withAuthors` (engine/api/people.ts) always runs before `withTexts`: by the time a removal is
 * found, every event's `author` — the remover's included — is already an e-mail, not the opaque id
 * the store keeps. `GET /api/events` and `/api/events/:id` (engine/api/server.ts) used to rewrite
 * only the top-level `author` to whatever `people.show` and its two overrides decide, and hand the
 * nested `Removed` through untouched: a plain member, under `people.show: "id"` or `"role"`, still
 * read the remover's raw e-mail off `textRemoved.by`/`snapshotRemoved.by` — the very address the
 * setting exists to hide.
 *
 * Pure, so it needs no server, no store and no i18n to prove: the caller resolves `displays`
 * however it already resolves `author` for the same request (`authorDisplaysFor`, server.ts), and
 * this only rewrites the one field `Removed` carries that is ever a raw address. `null`/`undefined`
 * pass through unchanged — a field never removed has nobody to resolve — and a `by` with no entry
 * in `displays` (impossible in practice: the remover always has some event of their own for the
 * caller to have resolved a display from, since `removeText` writes one) keeps its own value rather
 * than turning into `undefined`, the same fallback `author` itself already relies on.
 */
export function resolveRemovedBy(removed: Removed | null | undefined, displays: ReadonlyMap<string, string>): Removed | null | undefined {
  return removed ? { ...removed, by: displays.get(removed.by) ?? removed.by } : removed;
}

/**
 * Which of the cases below made a field read as tampered — issue #91's "which of the three cases it
 * was", so an operator does not have to re-derive it from the raw rows:
 *
 * - `overwritten`: a row is still there, but no longer hashes to what the event claims — the value
 *   was edited in place.
 * - `unaccounted`: no row, and nothing among `events` says it was let go on purpose.
 * - `double_removal`: no row, and TWO removals claim it — `removeText` can never produce a second
 *   one, so this is forgery even though a single one would have been a clean, ordinary removal.
 * - `downgraded`: no hash at all, on an event a store can PROVE was made after text extraction began
 *   — round 1 of the #91 review, finding 1. Stripping `textHash`/`snapshotHash` back to `null` and
 *   writing the value straight into `text`/`snapshot` makes a forged event LOOK like one of the
 *   genuinely unhashed rows `resolveOne`'s own "no hash" branch has always passed through unchanged
 *   (a field never given, or a row from before extraction — see `RawEvent`'s own comment). Only a
 *   store that can tell "before extraction" from "after, with the hash stripped" reports this kind;
 *   see `afterExtraction` on `RawEvent` for which ones can.
 */
export type TamperKind = 'overwritten' | 'unaccounted' | 'double_removal' | 'downgraded';

/** One field a reader resolved to tampered — the text itself never travels in this, only where. */
export interface TamperReport {
  event: string;
  field: TextField;
  kind: TamperKind;
}

/**
 * The one door every reader raises the alert through — issue #91's "reports it once to a single
 * place in the engine". Before this, three read paths (the server's stores and the CLI's two direct
 * readers) each detected the same three cases with the same code, and each would have needed its own
 * log call added, worded, and kept in step by hand; one function is one place for the wording, the
 * event name and the level to agree, and one place left to check when they need to change together.
 *
 * CRITICAL, not ERROR: this is not a bug in the product, it is the product's own proof — a hash that
 * no longer matches its row — saying someone wrote to the store outside it, which almost always means
 * a credential leaked. `console.error` first, so the line is readable without a JSON parser for
 * whoever is at a terminal (`holdrim list`, `sync`); `log()` second, so a collector watching
 * structured lines can alert on `severity: "CRITICAL"` without parsing English.
 *
 * What this cannot do, and no function in this file can: stop the same attacker who forged the write
 * from also silencing this very report — see SECURITY.md's note on this alert's honest limit.
 */
export function reportTampered(report: TamperReport): void {
  console.error(`holdrim: CRITICAL — event ${report.event}, field ${report.field} reads as tampered ` +
    `(${report.kind}): the store was written to outside the product. Rotate its credentials.`);
  // `eventId`, not `event`: `log()`'s own second argument IS `event` — the stable, greppable NAME
  // of what happened (`text_tampered`) — and `{ ...extra }` is spread AFTER it, so an `extra.event`
  // would silently overwrite that name with the tampered event's id, and an alert rule keyed on
  // `event: "text_tampered"` would stop matching on the very first real tampering it was written for.
  log('CRITICAL', 'text_tampered', { eventId: report.event, field: report.field, kind: report.kind });
}

/**
 * An event exactly as its store keeps the row: `text`/`snapshot` hold a field's own plain value only
 * for a row written before texts were extracted (docs/PRIVACY.md, section 4, the same back-compat
 * `authorOf` gives an event from before authors were ids) — a fresh row keeps them `null` and carries
 * the field's hash instead, in `textHash`/`snapshotHash`, which never leaves this file: `withTexts`
 * deletes both before an event reaches any reader.
 *
 * `afterExtraction`, given `true`, is a store's own proof that THIS event was written after text
 * extraction began — round 1 of the #91 review, finding 1: without it, `resolveOne` cannot tell a
 * genuinely pre-extraction row from a forged one dressed to look like one (a direct writer sets
 * `textHash: null` and writes the value straight into `text`), because both arrive here in exactly
 * the same shape, a value with no hash. A store omits it, or gives `false`, when it has no such
 * proof — Firestore's own ordering is a direct writer's to set (`when` is a plain field, not a
 * server-enforced one, once someone is writing outside the SDK's own path — see store-firestore.ts's
 * own comment), so it never claims one; `SqliteEventStore` and the CLI's own file reader can, and do
 * — see `afterExtraction`'s own comment in store-sqlite.ts for the forge-proof reason `rowid` gives
 * them one where Firestore has none.
 */
export type RawEvent<E> = E & { textHash?: string | null; snapshotHash?: string | null; afterExtraction?: boolean };

/**
 * What an event's `text` and `snapshot` mean, for every reader: the two server stores and, in time,
 * the CLI's readers of the cloud and of the events file, the way `withAuthors` (engine/api/people.ts)
 * is for `author`. `rows` is what the texts table still holds, keyed by `textKey`. Per field:
 *
 * - no hash on the event: the field was never given (the ordinary `null`), or the row is from before
 *   texts were extracted and already holds its own plain value — returned exactly as it came in,
 *   UNLESS the store marks this event `afterExtraction`: then a value with no hash is the downgrade
 *   forgery round 1 of the #91 review names, and reads as tampered instead (`RawEvent`'s own comment).
 * - a hash, and a row whose own hash matches it: the row is what was recorded. Its value is the text.
 * - a hash, and no row that still matches it: the text is gone, and MISSING IS NOT ABSENCE. A
 *   `TEXT_REMOVED` event naming this event and this field, found among `events` — the same list, so
 *   no second read is needed — says it was let go on purpose; `<field>Removed` carries who and when.
 *   With no such event — the row deleted straight in the store, or edited until its hash no longer
 *   matches its own value — nothing at hand can tell "let go on purpose" from "tampered with", and
 *   both are marked `<field>Tampered`: the harsher and the honest reading, since a text a reader
 *   cannot account for is suspect, not gone (the "Done when" of issue #28, and docs/PRIVACY.md,
 *   section 4: "a text that is missing with no such event is shown as missing, which is what
 *   tampering looks like").
 *
 * A forged `TEXT_REMOVED` event — one the general events path never accepts, but a store method
 * called directly, or a row inserted straight into the file, could still produce — changes nothing
 * while the row it names is still there: the match above is tried first, so a claim with no row
 * change to back it resolves as nothing. `removalsOf` also refuses one dated, or placed, no later
 * than the event it names — a forgery cannot back-date itself ahead of a text that, by its own
 * clock, did not exist yet. What it cannot refuse is a forgery dated and ordered correctly, paired
 * with deleting the row it names: that is a real erasure passed off as a real removal, closed only
 * once events are signed (see the note on `TEXT_REMOVED` above).
 *
 * `reports`, given, is appended to — never replaced — with one `TamperReport` per field this pass
 * finds tampered. It is an accumulator rather than a return value so this function's own shape stays
 * `E[]`, the one every existing caller and test already destructures; a caller that does not ask for
 * reports (most of `texts.test.js`) pays nothing and reports nothing. `withTextsRetrying` below is
 * the one caller that must NOT always pass its own straight through — see its comment for why.
 */
export function withTexts<E extends { id: string; type: string; author: string; when: string;
                                     data?: { [k: string]: unknown } | null }>(
  events: RawEvent<E>[], rows: ReadonlyMap<string, TextRow>, reports?: TamperReport[],
): E[] {
  const removed = removalsOf(events);
  return events.map((e) => resolveOne(e, rows, removed, reports));
}

/** What `removalsOf` found: the valid removals, and which keys had more than one. */
interface Removals {
  valid: Map<string, Removed>;
  /** A key with a second valid removal — `removeText` can never produce one, so this is forgery. */
  duplicated: Set<string>;
}

function removalsOf<E extends { id: string; type: string; author: string; when: string;
                                data?: { [k: string]: unknown } | null }>(
  events: E[],
): Removals {
  const positionOf = new Map(events.map((e, i) => [e.id, i] as const));
  const valid = new Map<string, Removed>();
  const duplicated = new Set<string>();
  for (const [i, e] of events.entries()) {
    if (e.type !== TEXT_REMOVED) continue;
    const target = e.data?.event;
    const field = e.data?.field;
    if (typeof target !== 'string' || (field !== 'text' && field !== 'snapshot')) continue;
    const targetIndex = positionOf.get(target);
    // A removal counts only once it comes after the event it names: later in the list order, and
    // never dated earlier (round 2, finding F). Without this, a direct writer could forge a
    // text_removed dated ahead of a real one and have it read as the genuine removal of a text
    // that, by its own clock, did not exist yet. A target not in `events` at all cannot be verified
    // either way, so it does not count — `targetIndex == null` alone is the one check for that,
    // since `positionOf` and this loop walk the very same array: there is no id one could know that
    // the other does not.
    if (targetIndex == null) continue;
    const targetEvent = events[targetIndex];
    if (i <= targetIndex || e.when < targetEvent.when) continue;
    const key = textKey(target, field);
    // `removeText` deletes the row it names, so it can never itself produce a second valid removal
    // of one field — the second call finds no row and refuses (`noText`). A second one here, however
    // correctly dated and ordered, is proof someone forged it: the first one found (round 3, finding
    // 6) keeps its credit — a forgery arriving second cannot silently swap who reads as the remover
    // — but the field itself now reads as tampered regardless, in `resolveOne` below.
    if (valid.has(key)) { duplicated.add(key); continue; }
    valid.set(key, { by: e.author, when: e.when });
  }
  return { valid, duplicated };
}

function resolveOne<E>(event: RawEvent<E>, rows: ReadonlyMap<string, TextRow>, removed: Removals,
                       reports?: TamperReport[]): E {
  const e = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  // Internal to this decision, like the two hashes below: a store's own proof of ordering is not part
  // of what an event means to any reader, and leaving it in would leak a fact — this store's rowid —
  // no reader outside this file has any business seeing.
  delete out.afterExtraction;
  for (const field of TEXT_FIELDS) {
    const hashKey = `${field}Hash`;
    const hash = (e[hashKey] as string | null | undefined) ?? null;
    delete out[hashKey];
    // Every branch sets both fields, deterministically: a caller of `withTexts` never has to seed
    // "nothing to say" defaults first, and an event resolved twice answers the same either time.
    if (hash == null) { // never given, or a pre-extraction row already holding its own value
      const value = (e[field] as string | null | undefined) ?? null;
      // A store that can PROVE this event postdates text extraction (`afterExtraction`) rules out
      // "genuinely from before extraction" — see `RawEvent`'s own comment — so a value with no hash
      // here is the downgrade forgery, not back-compat. `value == null` still passes through: a field
      // legitimately never given has no value to have downgraded, whichever side of the boundary the
      // event falls on.
      if (e.afterExtraction === true && value != null) {
        out[field] = null;
        out[`${field}Removed`] = null;
        out[`${field}Tampered`] = true;
        reports?.push({ event: e.id as string, field, kind: 'downgraded' });
        continue;
      }
      out[`${field}Removed`] = null;
      out[`${field}Tampered`] = false;
      continue;
    }
    const row = rows.get(textKey(e.id as string, field));
    if (row && hashText(row.value, row.salt) === hash) {
      out[field] = row.value;
      out[`${field}Removed`] = null;
      out[`${field}Tampered`] = false;
      continue;
    }
    out[field] = null;
    const key = textKey(e.id as string, field);
    const gone = removed.valid.get(key) ?? null;
    out[`${field}Removed`] = gone;
    // Tampered when nothing accounts for it at all, or when TWO removals do — a duplicate is not a
    // cleaner story than a missing one, it is the same suspicion from the other direction.
    const duplicated = removed.duplicated.has(key);
    const tampered = gone == null || duplicated;
    out[`${field}Tampered`] = tampered;
    // `row` truthy here means it FAILED the hash check above — a row that is there but wrong, the
    // "overwritten" case; no row is either simply unaccounted for, or the double-removal forgery.
    if (tampered) reports?.push({ event: e.id as string, field, kind: row ? 'overwritten' : duplicated ? 'double_removal' : 'unaccounted' });
  }
  return out as unknown as E;
}

/** One field `withTexts` found tampered on a first pass — worth a fresh look before believing it. */
export interface Suspect {
  event: string;
  field: TextField;
}

/**
 * The fields a resolved list reads as tampered — named for `fetchRemovals` below, on a PROVISIONAL
 * list `withTextsRetrying` has not yet had its retry settle. Exported as well for a second, unrelated
 * use: on a list that IS final — the CLI's own `queue`/`sync` (engine/cli/requests.ts, validation.ts)
 * — the same {event, field} pairs are exactly what `holdrim list`/`sync` warn from and exit non-zero
 * on, with no need to recompute anything or to know which of the three cases it was: that already
 * went out through `reportTampered`, in whichever store or reader built this same list.
 */
export function suspectsOf<E extends { id: string; textTampered?: boolean; snapshotTampered?: boolean }>(
  resolved: E[],
): Suspect[] {
  const out: Suspect[] = [];
  for (const e of resolved) {
    if (e.textTampered) out.push({ event: e.id, field: 'text' });
    if (e.snapshotTampered) out.push({ event: e.id, field: 'snapshot' });
  }
  return out;
}

/**
 * `withTexts`, tolerant of `events` and `rows` not being one atomic snapshot of the same instant.
 *
 * Round 2, finding A: Firestore aborts a read-only transaction after 270 seconds and does not retry
 * it, and `events`/`texts` only grow — nothing is erased — so a store that holds one open across a
 * full scan of both eventually fails outright, on nothing more than a project living long enough.
 * The fix is to accept the two reads as they come and correct afterwards, not to hold them together:
 *
 * - a genuine `removeText` cannot produce a false positive here. It deletes a text's row and records
 *   why in one transaction (docs/PRIVACY.md, section 4; store-sqlite.ts and store-firestore.ts are
 *   each one transaction for exactly this), so if a texts read finds a row gone because of one, that
 *   transaction has already committed — its event exists by the time anything can read after it.
 * - an `append` cannot produce one either: a fresh row is written with its event, in one transaction
 *   again, and is never removed except through `removeText`, which always leaves its own event.
 *
 * So the one gap a torn read can open is an EVENTS read that ran before a `removeText`'s commit,
 * paired with a TEXTS read that ran after it: the field looks tampered — a hash with no row and,
 * in THAT reading of events, no removal naming it — for a removal that in fact happened. Asking
 * `fetchRemovals` for a fresh, later look at removal events closes exactly that gap: by the time it
 * runs, the removal's event is there to find, wherever the texts read landed. It runs at most once,
 * and only for the fields the first pass could not otherwise account for — never on the ordinary
 * path, where nothing is tampered and nothing more is asked.
 *
 * `suspects` names which fields looked tampered, for a `fetchRemovals` that wants to narrow its own
 * query by them; both callers here (`FirestoreEventStore.list`, `Source.events` in engine/cli/remote.ts)
 * ignore it and just ask for every `text_removed` event in the project instead — `type == text_removed`
 * alone needs no composite index, and removals are a small, bounded subset of an ever-growing events
 * collection, bounded by how many texts have ever been let go, not by how many events there have
 * ever been. `withTextsRetrying` itself only ever keeps the caller's own `events.length` results
 * (round 3, finding 1), so an unnarrowed, whole-project answer costs a wider fetch, never a wrong one.
 *
 * `reports`, given, gets exactly the tampered fields THIS call's own final answer holds — never the
 * provisional ones `first` finds before a retry has had its say. `first`'s own tamper reports are
 * thrown away on purpose: reporting them would raise issue #91's critical alert for every torn read
 * this whole function exists to correct, the one false positive `resolveOne`'s own comment already
 * warns about. Reporting only ever happens once suspects.length or more.length has settled things one
 * way or the other — genuinely nothing tampered, genuinely nothing left to explain it, or genuinely
 * resolved by the fetched removals.
 */
export async function withTextsRetrying<E extends { id: string; type: string; author: string; when: string;
                                        data?: { [k: string]: unknown } | null }>(
  events: RawEvent<E>[], rows: ReadonlyMap<string, TextRow>,
  fetchRemovals: (suspects: Suspect[]) => Promise<RawEvent<E>[]>,
  reports?: TamperReport[],
): Promise<E[]> {
  const provisional: TamperReport[] = [];
  const first = withTexts(events, rows, provisional);
  const suspects = suspectsOf(first);
  if (suspects.length === 0) return first; // nothing tampered: `provisional` is empty too
  const more = await fetchRemovals(suspects);
  // Nothing more exists anywhere to explain them: `first`'s suspects are the real, final answer, not
  // a torn read's false alarm — report them as such.
  if (more.length === 0) { reports?.push(...provisional); return first; }
  // Appended, not merged in by id: a removal's own event always sorts after the event it names
  // (docs/PRIVACY.md, section 4 — `removeText` cannot pre-date what it removes from), and every
  // target here is already somewhere in `events`, so putting every freshly-fetched removal after
  // all of them keeps `removalsOf`'s own ordering check (finding F) exactly as true as it was.
  const known = new Set(events.map((e) => e.id));
  const final: TamperReport[] = [];
  const resolved = withTexts(events.concat(more.filter((m) => !known.has(m.id))), rows, final);
  // `fetchRemovals` reads the WHOLE project — a torn read cannot know which page a removal from
  // years ago belonged to any better than list(page) itself can — so `resolved` holds more events
  // than this caller asked for. Only the first `events.length` of them are the caller's own,
  // resolved with the extra removals borrowed to see correctly; the rest go no further; without
  // this, a removal from another page would leak into list(page)'s answer, and calling this twice
  // would duplicate it a second time (round 3, finding 1) — and reporting a tampered field from
  // another page would repeat the same leak as a false alert nobody asked this call about.
  const ownIds = new Set(events.map((e) => e.id));
  reports?.push(...final.filter((r) => ownIds.has(r.event)));
  return resolved.slice(0, events.length);
}
