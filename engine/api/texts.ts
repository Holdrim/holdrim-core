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
 * (harmless on its own, since a claim with no matching row change resolves as nothing — see
 * `withTexts` below — but a trail full of unearned claims is not one worth keeping).
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

/** The one error every store gives for a field with nothing to remove, so a caller matches one text. */
export function noText(event: string, field: TextField): Error {
  return new Error(`no ${field} to remove on event ${event}: it was never given, or is already gone`);
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
 * called directly could still be handed — changes nothing while the row it names is still there:
 * the match above is tried first, so a claim with no row change to back it resolves as nothing.
 */
export function withTexts<E extends { id: string; type: string; author: string; when: string;
                                     data?: { [k: string]: unknown } | null }>(
  events: RawEvent<E>[], rows: ReadonlyMap<string, TextRow>,
): E[] {
  const removed = removalsOf(events);
  return events.map((e) => resolveOne(e, rows, removed));
}

function removalsOf<E extends { type: string; author: string; when: string; data?: { [k: string]: unknown } | null }>(
  events: E[],
): Map<string, Removed> {
  const out = new Map<string, Removed>();
  for (const e of events) {
    if (e.type !== TEXT_REMOVED) continue;
    const target = e.data?.event;
    const field = e.data?.field;
    if (typeof target === 'string' && (field === 'text' || field === 'snapshot')) {
      out.set(textKey(target, field), { by: e.author, when: e.when });
    }
  }
  return out;
}

function resolveOne<E>(event: RawEvent<E>, rows: ReadonlyMap<string, TextRow>, removed: Map<string, Removed>): E {
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
    const gone = removed.get(textKey(e.id as string, field)) ?? null;
    out[`${field}Removed`] = gone;
    out[`${field}Tampered`] = gone == null;
  }
  return out as unknown as E;
}
