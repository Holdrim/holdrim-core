/**
 * The written fields and the authority they carry (engine/api/types.ts), on their own, with no store,
 * no project and no server; and the CLI's reading of a Firestore time. `sync`, `requests()` and the
 * contract test prove the same rules end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writtenBoolean, isLocked, authorCouldTriage, authoritative } from '../api/types.ts';
import { normalizeWhen, firestoreEventOf } from '../cli/remote.ts';

/**
 * MINOR (round 2's review): the CLI's Firestore reader compares raw `timestampValue` strings, whose
 * fractional-digit count varies (0, 3, 6 or 9, per `google.protobuf.Timestamp`'s JSON mapping), while
 * every comparison of `when` elsewhere is a plain string compare. Un-normalized, a whole-second
 * timestamp sorts AFTER a fractional one from the very same second — this pins the exact boundary.
 */
test('normalizeWhen: a Firestore timestamp with fewer fractional digits still sorts correctly', () => {
  const wholeSecond = normalizeWhen('2026-09-25T02:43:44Z');         // 0 fractional digits: the START of that second
  const oneMillisecondLater = normalizeWhen('2026-09-25T02:43:44.001Z'); // 3 digits, one ms into the SAME second
  const nextSecond = normalizeWhen('2026-09-25T02:43:45.123456789Z');   // 9 digits, but a whole second later
  assert.ok(wholeSecond < oneMillisecondLater,
    'the start of the second is earlier than one millisecond into it, even with fewer digits written');
  assert.ok(oneMillisecondLater < nextSecond, 'and both are earlier than the next second, however many digits it carries');
  // The raw strings, un-normalized, would fail the first of those comparisons: 'Z' (0x5A) sorts after
  // '.' (0x2E), so the whole-second string reads as the LATER one — the bug this function fixes.
  assert.ok('2026-09-25T02:43:44Z' > '2026-09-25T02:43:44.001Z', 'the bug this function fixes, shown on the raw strings');
  assert.equal(normalizeWhen(undefined), '');
  assert.equal(normalizeWhen(null), '');
});

/**
 * MINOR (round 2's review): `locks: null` — an explicit null, not an absent key — has to read as
 * ABSENT (`undefined`), the same as the key never being set at all. `data` itself is `null` for most
 * events (`stored`, types.ts), so `writtenBoolean` already handles a null `data`; this pins the
 * narrower case of a null VALUE for a key that is nonetheless present in an otherwise real object,
 * which the `v === undefined || v === null` guard has to catch on its own.
 */
test('writtenBoolean: an explicit null value reads as absent, same as no key at all', () => {
  assert.equal(writtenBoolean({ locks: null }, 'locks'), undefined, 'a null VALUE is absent, not false');
  assert.equal(writtenBoolean(null, 'locks'), undefined, 'a null `data` object is absent too');
  assert.equal(writtenBoolean(undefined, 'locks'), undefined, 'and undefined `data`');
  assert.equal(writtenBoolean({}, 'locks'), undefined, 'and a `data` object with no such key');
  assert.equal(writtenBoolean({ locks: 'true' }, 'locks'), true);
  assert.equal(writtenBoolean({ locks: 'false' }, 'locks'), false);
});

/**
 * #50: authority rests on a signature. Every pairing of signed × what was written, for both readers
 * of a written field: only a signed event written exactly `"true"` grants anything. A `signed` that is
 * missing — an event from a reader that set no answer — grants nothing either.
 */
test('isLocked and authorCouldTriage: only a signed event written exactly "true" grants anything', () => {
  for (const [read, field] of [[isLocked, 'locks'], [authorCouldTriage, 'authorCouldTriage']]) {
    for (const signed of [true, false, undefined]) {
      for (const written of ['true', 'false', undefined, 'TRUE', true, 1]) {
        const data = written === undefined ? {} : { [field]: written };
        const expected = signed === true && written === 'true';
        assert.equal(read({ data, signed }), expected, `${read.name}: signed ${signed}, ${field} ${JSON.stringify(written)}`);
      }
    }
    assert.equal(read({ data: null, signed: true }), false, `${read.name}: signed, nothing written`);
  }
});

test('authoritative keeps exactly the signed events, in their order', () => {
  const events = [{ id: 'a', signed: true }, { id: 'b', signed: false }, { id: 'c' }, { id: 'd', signed: true }, { id: 'e', signed: 'true' }];
  assert.deepEqual(authoritative(events).map((e) => e.id), ['a', 'd']);
});

/**
 * Round 4's review, MINOR (n5b): nothing drove `Source`'s Firestore reader far enough to prove it
 * calls `normalizeWhen` on a real document's `when` — `normalizeWhen` itself was only ever pinned in
 * isolation, above. `firestoreEventOf` is the exact mapping `events()` runs on every document the
 * cloud hands back; reverting its `when` line to the raw `f.when?.timestampValue` (dropping
 * `normalizeWhen`) would still pass every other test in this file, since none of them read a
 * Firestore document at all.
 */
test('firestoreEventOf: a whole-second timestampValue comes back normalized, the same as normalizeWhen', () => {
  const doc = {
    name: 'projects/p/databases/(default)/documents/events/abc123def456',
    fields: {
      type: { stringValue: 'approval' }, page: { stringValue: 'A01' },
      block: { stringValue: 'A01.1.1' }, fingerprint: { stringValue: 'f1' },
      text: { stringValue: 'this is the block, before texts were extracted' },
      author: { stringValue: 'owner@example.org' },
      when: { timestampValue: '2026-09-25T02:43:44Z' }, // 0 fractional digits: the un-normalized bug shape
      data: { mapValue: { fields: { locks: { stringValue: 'true' } } } },
    },
  };
  const event = firestoreEventOf(doc);
  assert.equal(event.id, 'abc123def456');
  assert.equal(event.when, normalizeWhen('2026-09-25T02:43:44Z'), 'normalized the same way normalizeWhen would');
  assert.equal(event.when, '2026-09-25T02:43:44.000Z', 'and not the raw, un-normalized timestampValue string');
  assert.deepEqual(event.data, { locks: 'true' });
  assert.equal(event.block, 'A01.1.1');
  assert.equal(event.fingerprint, 'f1');
  assert.equal(event.text, 'this is the block, before texts were extracted');
});
