/**
 * The lock baseline (engine/api/types.ts), on its own — round 2's review, findings M-4 and M-5.
 *
 * `earliestLockBaseline` and `ensureLockBaseline` are exercised end to end through `sync`, the
 * server's contract test and `requests()` elsewhere in this suite, but none of those drive the two
 * failure shapes that matter here: several baselines arriving out of order, and a competitor's
 * `append` landing between this call's own `list` and `append`. Both are cheap to construct directly
 * against the exported functions, with no store, no project and no server at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earliestLockBaseline, ensureLockBaseline, writtenBoolean, isLocked, authorCouldTriage,
  LOCK_BASELINE_TYPE, LOCK_BASELINE_PAGE } from '../api/types.ts';
import { normalizeWhen, firestoreEventOf } from '../cli/remote.ts';

const baseline = (id, when, author = 'owner@example.org') =>
  ({ id, type: LOCK_BASELINE_TYPE, page: LOCK_BASELINE_PAGE, author, when, data: null });

test('earliestLockBaseline: null with none, and the earliest `when` wins whatever order they arrive in', () => {
  assert.equal(earliestLockBaseline([]), null, 'no baseline at all');
  assert.equal(earliestLockBaseline([{ id: 'x', type: 'approval', when: '2026-01-01T00:00:00.000Z' }]), null,
    'other event types are not baselines, however early');

  // Three, out of order, none of them first in the list.
  const middle = baseline('b-middle', '2026-01-01T10:00:00.000Z');
  const earliest = baseline('b-earliest', '2026-01-01T09:00:00.000Z');
  const latest = baseline('b-latest', '2026-01-01T11:00:00.000Z');
  assert.equal(earliestLockBaseline([middle, earliest, latest]).id, 'b-earliest',
    'the earliest by `when`, regardless of where it sits in the list');
  assert.equal(earliestLockBaseline([latest, middle, earliest]).id, 'b-earliest',
    'and again, in a different order — this must not be "whichever happens to come first"');

  // A tie: `reduce`'s `<=` keeps the FIRST of two equal `when`s, so the result is deterministic
  // rather than depending on object identity or insertion order the caller cannot control.
  const tie1 = baseline('tie-1', '2026-01-01T09:00:00.000Z', 'first@example.org');
  const tie2 = baseline('tie-2', '2026-01-01T09:00:00.000Z', 'second@example.org');
  assert.equal(earliestLockBaseline([tie1, tie2]).id, 'tie-1', 'a tie keeps the first one encountered');
});

/**
 * M-5 (round 2's review): `ensureLockBaseline` reads the store back AFTER its own `append`, rather
 * than trusting what it just wrote, because another server starting at the same moment against the
 * same empty store can win the race and append its OWN baseline first — the store is insert-only,
 * and nothing here takes a cross-process lock on "is there one yet?". Reverting that read-back to
 * `return e;` (the event `append` itself handed back) would return THIS call's own baseline even
 * when a competitor's, dated earlier, is the one every other reader will agree on — silently
 * splitting the store between two "first" owners.
 */
test('ensureLockBaseline: a competitor appending between list() and append() still yields the earliest', async () => {
  const rows = [];
  const calls = { list: 0, append: 0 };
  const store = {
    async list() { calls.list++; return rows.slice(); },
    async append(event, author) {
      calls.append++;
      // The competitor's baseline lands here, mid-call, dated BEFORE this one — exactly the shape
      // the race produces: two processes both find no baseline, both call append, and the store
      // (insert-only, no lock) accepts both.
      rows.push({ id: 'theirs', type: event.type, page: event.page, author: 'winner@example.org',
        when: '2026-01-01T00:00:00.000Z', data: null });
      const mine = { id: 'mine', type: event.type, page: event.page, author, when: '2026-01-01T00:00:00.001Z', data: null };
      rows.push(mine);
      return mine;
    },
  };
  const got = await ensureLockBaseline(store, 'me@example.org');
  assert.equal(got.id, 'theirs', 'the earliest of the two now in the store, not the one this call itself wrote');
  assert.equal(got.author, 'winner@example.org');
  assert.equal(calls.list, 2, 'once before the append (finding none), once after (resolving the race)');
  assert.equal(calls.append, 1, 'this call still only writes its OWN baseline once');
});

test('ensureLockBaseline: with one already there, it is returned and nothing is appended', async () => {
  const already = baseline('already-here', '2026-01-01T08:00:00.000Z', 'first-owner@example.org');
  let appended = 0;
  const store = {
    async list() { return [already]; },
    async append() { appended++; throw new Error('must not be called: a baseline already exists'); },
  };
  const got = await ensureLockBaseline(store, 'me@example.org');
  assert.equal(got, already);
  assert.equal(appended, 0);
});

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
 * Round 4's review, MINOR "clock stepped back", direct on `isLocked` (engine/tests/cli.test.js has
 * the same case through `sync`; this one isolates the function with no store, no project, no disk).
 * A ✓ dated before the baseline, by the baseline's own author — the exact shape `legacyLock` locks —
 * but written as `locks:"false"`: the written value has to win, because a forged field can only ever
 * help an attacker by claiming `"true"`, never `"false"`, so trusting `"false"` here still fails
 * closed. Reverting the guard this adds — the `writtenBoolean(...) === false` check ahead of the
 * baseline comparison — would make this read `true`, via `legacyLock`.
 */
test('isLocked: a written "false" wins even before the baseline (a clock stepped back)', () => {
  const baseline = { author: 'owner@example.org', when: '2026-09-22T09:00:00Z' };
  const approval = { author: 'owner@example.org', when: '2026-09-22T08:00:00Z', data: { locks: 'false' } };
  assert.equal(isLocked(approval, baseline), false,
    'a written "false" fails closed even though legacyLock, asked directly, would say yes');
  // The exception is `isLocked`'s alone: `authorCouldTriage` has no legacy fallback to protect a
  // written "false" from — its own fail-closed answer already IS "false" — so the same shape there
  // must stay ignored before the baseline, exactly as every other written value is.
  const request = { when: '2026-09-22T08:00:00Z', data: { authorCouldTriage: 'false' } };
  assert.equal(authorCouldTriage(request, baseline), false, 'unaffected: already false, with or without the field');
});

/**
 * Round 4's review, MINOR "the tie" (n1): an event dated EXACTLY at the baseline's own `when` must
 * get the fail-closed answer — the baseline event itself is the moment this version started
 * recording written fields, not a moment IT wrote one onto. `isLocked`'s comparison is a strict `>`;
 * flipping it to `>=` would trust this ✓'s `locks:"true"` instead of falling through to `legacyLock`
 * (same author, but `when < baseline.when` is false at a tie too, so `legacyLock` also says no) —
 * `locks:"true"`, not `"false"`, so the exception the test above pins cannot mask this one.
 */
test('isLocked: an event dated exactly at the baseline\'s own `when` fails closed (the tie)', () => {
  const baseline = { author: 'owner@example.org', when: '2026-09-22T09:00:00Z' };
  const approval = { author: 'owner@example.org', when: baseline.when, data: { locks: 'true' } };
  assert.equal(isLocked(approval, baseline), false,
    'a tie is not AFTER the baseline: the written field is not yet trusted, and legacyLock says no either (not before it)');
});

/** The same tie, for `authorCouldTriage` (n2): `>` → `>=` would trust this request's forged field. */
test('authorCouldTriage: an event dated exactly at the baseline\'s own `when` fails closed (the tie)', () => {
  const baseline = { author: 'owner@example.org', when: '2026-09-22T09:00:00Z' };
  const request = { when: baseline.when, data: { authorCouldTriage: 'true' } };
  assert.equal(authorCouldTriage(request, baseline), false, 'a tie is not AFTER the baseline: still at triage');
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
