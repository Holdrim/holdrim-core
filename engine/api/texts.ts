import { createHash, randomBytes } from 'node:crypto';

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
 * An event exactly as its store keeps the row: `text`/`snapshot` hold a field's own plain value only
 * for a row written before texts were extracted (docs/PRIVACY.md, section 4, the same back-compat
 * `authorOf` gives an event from before authors were ids) — a fresh row keeps them `null` and carries
 * the field's hash instead, in `textHash`/`snapshotHash`, which never leaves this file: `withTexts`
 * deletes both before an event reaches any reader.
 */
export type RawEvent<E> = E & { textHash?: string | null; snapshotHash?: string | null };

/**
 * What an event's `text` and `snapshot` mean, for every reader: the two server stores and, in time,
 * the CLI's readers of the cloud and of the events file, the way `withAuthors` (engine/api/people.ts)
 * is for `author`. `rows` is what the texts table still holds, keyed by `textKey`. Per field:
 *
 * - no hash on the event: the field was never given (the ordinary `null`), or the row is from before
 *   texts were extracted and already holds its own plain value — returned exactly as it came in.
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
 */
export function withTexts<E extends { id: string; type: string; author: string; when: string;
                                     data?: { [k: string]: unknown } | null }>(
  events: RawEvent<E>[], rows: ReadonlyMap<string, TextRow>,
): E[] {
  const removed = removalsOf(events);
  return events.map((e) => resolveOne(e, rows, removed));
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

function resolveOne<E>(event: RawEvent<E>, rows: ReadonlyMap<string, TextRow>, removed: Removals): E {
  const e = event as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...e };
  for (const field of TEXT_FIELDS) {
    const hashKey = `${field}Hash`;
    const hash = (e[hashKey] as string | null | undefined) ?? null;
    delete out[hashKey];
    // Every branch sets both fields, deterministically: a caller of `withTexts` never has to seed
    // "nothing to say" defaults first, and an event resolved twice answers the same either time.
    if (hash == null) { // never given, or a pre-extraction row already holding its own value
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
    out[`${field}Tampered`] = gone == null || removed.duplicated.has(key);
  }
  return out as unknown as E;
}

/** One field `withTexts` found tampered on a first pass — worth a fresh look before believing it. */
export interface Suspect {
  event: string;
  field: TextField;
}

/** The fields a resolved list reads as tampered, named for `fetchRemovals` below. */
function suspectsOf<E extends { id: string; textTampered?: boolean; snapshotTampered?: boolean }>(
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
 */
export async function withTextsRetrying<E extends { id: string; type: string; author: string; when: string;
                                        data?: { [k: string]: unknown } | null }>(
  events: RawEvent<E>[], rows: ReadonlyMap<string, TextRow>,
  fetchRemovals: (suspects: Suspect[]) => Promise<RawEvent<E>[]>,
): Promise<E[]> {
  const first = withTexts(events, rows);
  const suspects = suspectsOf(first);
  if (suspects.length === 0) return first;
  const more = await fetchRemovals(suspects);
  if (more.length === 0) return first;
  // Appended, not merged in by id: a removal's own event always sorts after the event it names
  // (docs/PRIVACY.md, section 4 — `removeText` cannot pre-date what it removes from), and every
  // target here is already somewhere in `events`, so putting every freshly-fetched removal after
  // all of them keeps `removalsOf`'s own ordering check (finding F) exactly as true as it was.
  const known = new Set(events.map((e) => e.id));
  const resolved = withTexts(events.concat(more.filter((m) => !known.has(m.id))), rows);
  // `fetchRemovals` reads the WHOLE project — a torn read cannot know which page a removal from
  // years ago belonged to any better than list(page) itself can — so `resolved` holds more events
  // than this caller asked for. Only the first `events.length` of them are the caller's own,
  // resolved with the extra removals borrowed to see correctly; the rest go no further; without
  // this, a removal from another page would leak into list(page)'s answer, and calling this twice
  // would duplicate it a second time (round 3, finding 1).
  return resolved.slice(0, events.length);
}
