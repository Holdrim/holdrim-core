/**
 * One resolver for what an event's `text` and `snapshot` mean, the way authors.test.js is for
 * `author`: the rule on its own, `hashText`/`newSalt`, and the CLI's two readers of stored events —
 * the events file and the cloud — which build events from what is stored without going through a
 * store (docs/PRIVACY.md, section 4).
 *
 * ⚠️ The cloud path needs the Firestore emulator. Without `FIRESTORE_EMULATOR_HOST` those tests
 * SKIP, with a message saying so, as in authors.test.js.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hashText, newSalt, textKey, withTexts, withTextsRetrying, reportTampered, suspectsOf,
  noText, TEXT_REMOVED, resolveRemovedBy } from '../api/texts.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { MemoryEventStore } from '../api/store.ts';
import { Source } from '../cli/remote.ts';
import { freshFirestoreProject } from './helpers/firestore.js';

// The plain `console.error` line AND the structured `log()` line `reportTampered` prints, captured
// the way store-sqlite-guards.test.js captures `sqlite_guard_missing`: `log()` writes one JSON line
// per call through `console.log`, which nothing else in this file calls with a JSON string, so a line
// that parses and carries a `severity` is one of ours; anything else passes through untouched.
function capturingReports(fn) {
  return async (t) => {
    const said = [];
    const logged = [];
    const err = console.error;
    const info = console.log;
    console.error = (line) => said.push(line);
    console.log = (line) => {
      const parsed = typeof line === 'string' ? tryParse(line) : undefined;
      if (parsed && typeof parsed.severity === 'string') logged.push(parsed);
      else info(line);
    };
    try {
      await fn(t, said, logged);
    } finally {
      console.error = err;
      console.log = info;
    }
  };
}
const tryParse = (line) => { try { return JSON.parse(line); } catch { return undefined; } };

// The Source reads these before its own options; a developer's own would point these tests at
// their real events file or account.
const saved = { path: process.env.HOLDRIM_EVENTS_PATH, account: process.env.HOLDRIM_ACCOUNT };
delete process.env.HOLDRIM_EVENTS_PATH;
delete process.env.HOLDRIM_ACCOUNT;
after(() => {
  if (saved.path !== undefined) process.env.HOLDRIM_EVENTS_PATH = saved.path;
  if (saved.account !== undefined) process.env.HOLDRIM_ACCOUNT = saved.account;
});

// ===================================================================== hashText, newSalt
test('the same value and salt always hash the same, and a different one of either does not', () => {
  const salt = newSalt();
  assert.equal(hashText('a value', salt), hashText('a value', salt));
  assert.notEqual(hashText('a value', salt), hashText('a value', newSalt()));
  assert.notEqual(hashText('a value', salt), hashText('another value', salt));
});

test('the salt-value boundary is part of the hash: moving it changes the answer', () => {
  // Without the separator, hashText('ab', 'c') and hashText('a', 'bc') would hash identically.
  assert.notEqual(hashText('c', 'ab'), hashText('bc', 'a'));
});

// ===================================================================== withTexts, the rule
const AN_EVENT = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z', data: null };

test('no hash on the event: the field is left exactly as it came in', () => {
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: null }], new Map());
  assert.equal(out.text, null);
  assert.equal(out.textTampered, false);

  const [legacy] = withTexts([{ ...AN_EVENT, text: 'a row from before extraction', textHash: null }], new Map());
  assert.equal(legacy.text, 'a row from before extraction', 'a pre-extraction row keeps its own value');
});

test('a hash, and a row whose own hash matches it: the row is the text', () => {
  const salt = newSalt();
  const hash = hashText('the real text', salt);
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hash }],
    new Map([[textKey('e1', 'text'), { value: 'the real text', salt }]]));
  assert.equal(out.text, 'the real text');
  assert.equal(out.textRemoved, null);
  assert.equal(out.textTampered, false);
});

test('a hash, no matching row, and a TEXT_REMOVED event naming it: removed on purpose', () => {
  const salt = newSalt();
  const removal = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } };
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', salt) }, removal], new Map());
  assert.deepEqual(out.textRemoved, { by: 'owner@example.org', when: '2026-01-02T00:00:00.000Z' });
  assert.equal(out.text, null);
  assert.equal(out.textTampered, false, 'a removal that is accounted for is not tampering');
});

/**
 * `resolveRemovedBy` — round 1 of the issue #31 review, finding 1. `withTexts` above records `by` as
 * the resolved address, because `withAuthors` runs before it; a reader that sends `Removed` on to a
 * viewer without also sending `by` through the same resolution `author` gets from `people.show`
 * leaks the remover's raw e-mail to someone the setting was configured to hide it from.
 */
test('resolveRemovedBy sends `by` through the same displays map `author` uses', () => {
  const removed = { by: 'owner@example.org', when: '2026-01-02T00:00:00.000Z' };
  const displays = new Map([['owner@example.org', 'Admin']]);
  assert.deepEqual(resolveRemovedBy(removed, displays), { by: 'Admin', when: '2026-01-02T00:00:00.000Z' },
    'a plain member under people.show: "role" or "id" must see the resolved value, never the address');
});

test('resolveRemovedBy leaves a field that was never removed exactly as it was', () => {
  const displays = new Map([['owner@example.org', 'Admin']]);
  assert.equal(resolveRemovedBy(null, displays), null);
  assert.equal(resolveRemovedBy(undefined, displays), undefined);
});

test('resolveRemovedBy keeps the address when the remover has no entry in displays', () => {
  // Not expected in practice — `removeText` always writes an authored event for the remover to be
  // resolved from — but a caller that could not resolve one must not turn `by` into `undefined`,
  // the same fallback `author` itself already falls back to.
  const removed = { by: 'ghost@example.org', when: '2026-01-02T00:00:00.000Z' };
  assert.deepEqual(resolveRemovedBy(removed, new Map()), removed);
});

test('a removal dated before the event it names does not count, even placed after it in the list', () => {
  // Round 2, finding F(a): a direct writer can insert a text_removed of their own — the general
  // POST /events path refuses the type, but a row inserted straight into the file cannot be told
  // from a real one this way — so a removal only counts once it is LATER than the event it names,
  // in time and not only in list order: a forger dating their fake removal ahead of a real text
  // must not have it read as though that text never existed past that moment.
  const salt = newSalt();
  const backdated = { id: 'r1', type: TEXT_REMOVED, author: 'forger@example.org', when: '2025-01-01T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } }; // earlier than AN_EVENT's own when, later in the list
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', salt) }, backdated], new Map());
  assert.equal(out.textRemoved, null, 'a removal dated before its target is not accepted as one');
  assert.equal(out.textTampered, true, 'so it reads as tampering — missing, and nothing at hand explains why');
});

test('a removal earlier in the list than the event it names does not count, even dated after it', () => {
  const salt = newSalt();
  const outOfOrder = { id: 'r1', type: TEXT_REMOVED, author: 'forger@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } }; // later `when`, but placed BEFORE its target in the list
  const [, out] = withTexts([outOfOrder, { ...AN_EVENT, text: null, textHash: hashText('gone', salt) }], new Map());
  assert.equal(out.textRemoved, null, 'a removal that precedes its own target in the list is not accepted either');
  assert.equal(out.textTampered, true);
});

test('a removal naming an event that is not in the list at all does not count', () => {
  const removal = { id: 'r1', type: TEXT_REMOVED, author: 'forger@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 'no-such-event', field: 'text' } };
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', newSalt()) }, removal], new Map());
  assert.equal(out.textRemoved, null, 'nothing to compare against: the removal cannot be verified, so it does not count');
  assert.equal(out.textTampered, true);
});

test('a second text_removed for the same field does not silently re-credit who removed it', () => {
  // Round 3, finding 6: removeText deletes the row it names, so it can never itself produce a
  // second valid removal of one field — a second, however correctly dated and ordered, is proof
  // someone forged it. The first one found keeps its credit, so a forgery arriving second cannot
  // swap who reads as the remover — but the field itself still reads as tampered: a duplicate is
  // the same suspicion as a missing one, from the other direction.
  const salt = newSalt();
  const tampered = { ...AN_EVENT, text: null, textHash: hashText('gone', salt) };
  const firstRemoval = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } };
  const secondRemoval = { id: 'r2', type: TEXT_REMOVED, author: 'forger@example.org', when: '2026-01-03T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } };
  const [out] = withTexts([tampered, firstRemoval, secondRemoval], new Map());
  assert.equal(out.textRemoved?.by, 'owner@example.org', 'the first valid removal keeps its credit');
  assert.equal(out.textTampered, true, 'a second removal of the same field is proof of forgery');
});

test('a hash, no matching row, and no removal event: tampered — the "Done when" of issue #28', () => {
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', newSalt()) }], new Map());
  assert.equal(out.text, null);
  assert.equal(out.textRemoved, null);
  assert.equal(out.textTampered, true, 'missing with nothing to say why reads as tampering, not absence');
});

test('a hash, and a row that no longer hashes to it: tampered, even though the row is still there', () => {
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('the real text', newSalt()) }],
    new Map([[textKey('e1', 'text'), { value: 'a forged text', salt: newSalt() }]]));
  assert.equal(out.text, null, 'a value that fails its own hash is not handed out as the text');
  assert.equal(out.textTampered, true);
});

test('a removal event whose target is not a string names no removal, even one that would print as the right id', () => {
  const salt = newSalt();
  // `['e1']` stringifies to exactly `'e1'` wherever a template literal reads it — `textKey` does —
  // so this is the one input that actually exercises `typeof target === 'string'`: a version of
  // `removalsOf` missing that check would still build the same key from this array, and count it as
  // the removal it never validly named. A target like `42` would too, incidentally, but proves
  // nothing: nothing here can tell "coerced by accident" from "correct by construction".
  const notActuallyAString = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: ['e1'], field: 'text' } };
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', salt) }, notActuallyAString], new Map());
  assert.equal(out.textRemoved, null, 'a non-string target names no removal, however it would print');
  assert.equal(out.textTampered, true, 'so the missing field still reads as tampering');
});

// The other half of the same guard, `field === 'text' || field === 'snapshot'`, has no
// runtime-observable effect of its own to test here: a removal event with any other `field` value
// builds a key (`textKey`) that no lookup ever asks for — `text` and `snapshot` are the only two
// this file ever looks up — so it matches nothing whether or not the check is there. What the check
// is for is TypeScript: `field` comes off `data` as `unknown`, and `textKey` demands a `TextField`;
// removing the check fails `tsc`, not a test — the honest proof for this half of `removalsOf`, per
// AGENTS.md: "when there is no logic to mutate ... say so instead of inventing one".

test('text and snapshot are resolved independently, and a list is resolved without mutating what it was given', () => {
  const salt = newSalt();
  const events = [{ ...AN_EVENT, text: null, snapshot: null,
    textHash: hashText('a', salt), snapshotHash: hashText('b', salt) }];
  const rows = new Map([[textKey('e1', 'text'), { value: 'a', salt }]]); // snapshot's own row is missing
  const [out] = withTexts(events, rows);
  assert.equal(out.text, 'a');
  assert.equal(out.snapshot, null);
  assert.equal(out.snapshotTampered, true);
  assert.equal(events[0].text, null, 'the event withTexts was given is left exactly as it was');
});

test('removeText refuses a field with no row, whether it was never given or already removed', () => {
  const err = noText('e1', 'text');
  assert.match(err.message, /no text to remove/);
});

// ===================================================================== reportTampered, issue #91
// "Every read that resolves a field to tampered reports it once to a single place in the engine,
// with the event id, the field, and which of the three cases it was."

test('withTexts reports nothing when nothing is tampered, even with `reports` given', () => {
  const salt = newSalt();
  const hash = hashText('the real text', salt);
  const reports = [];
  withTexts([{ ...AN_EVENT, text: null, textHash: hash }],
    new Map([[textKey('e1', 'text'), { value: 'the real text', salt }]]), reports);
  assert.deepEqual(reports, [], 'a matching row is not tampering, and reports nothing');
});

test('withTexts reports "overwritten" for a row that is there but fails its own hash', () => {
  const reports = [];
  withTexts([{ ...AN_EVENT, text: null, textHash: hashText('the real text', newSalt()) }],
    new Map([[textKey('e1', 'text'), { value: 'a forged text', salt: newSalt() }]]), reports);
  assert.deepEqual(reports, [{ event: 'e1', field: 'text', kind: 'overwritten' }]);
});

test('withTexts reports "unaccounted" for a hash with no row and no removal', () => {
  const reports = [];
  withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', newSalt()) }], new Map(), reports);
  assert.deepEqual(reports, [{ event: 'e1', field: 'text', kind: 'unaccounted' }]);
});

test('withTexts reports "double_removal" for a field two removals claim', () => {
  const salt = newSalt();
  const tampered = { ...AN_EVENT, text: null, textHash: hashText('gone', salt) };
  const firstRemoval = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } };
  const secondRemoval = { id: 'r2', type: TEXT_REMOVED, author: 'forger@example.org', when: '2026-01-03T00:00:00.000Z',
    data: { event: 'e1', field: 'text' } };
  const reports = [];
  withTexts([tampered, firstRemoval, secondRemoval], new Map(), reports);
  assert.deepEqual(reports, [{ event: 'e1', field: 'text', kind: 'double_removal' }]);
});

test('withTexts appends to `reports` rather than replacing it, and reports both fields when both are tampered',
  () => {
    const reports = [{ event: 'earlier', field: 'text', kind: 'overwritten' }];
    withTexts([{ ...AN_EVENT, text: null, snapshot: null,
      textHash: hashText('a', newSalt()), snapshotHash: hashText('b', newSalt()) }], new Map(), reports);
    assert.deepEqual(reports, [
      { event: 'earlier', field: 'text', kind: 'overwritten' },
      { event: 'e1', field: 'text', kind: 'unaccounted' },
      { event: 'e1', field: 'snapshot', kind: 'unaccounted' },
    ]);
  });

test('reportTampered prints a human line AND a structured CRITICAL log line, never the text itself',
  capturingReports(async (t, said, logged) => {
    reportTampered({ event: 'e1', field: 'text', kind: 'overwritten' });
    assert.equal(said.length, 1, 'exactly one human line');
    assert.match(said[0], /CRITICAL/);
    assert.match(said[0], /e1/);
    assert.doesNotMatch(said[0], /the real text|a forged text/, 'never the text itself');
    assert.equal(logged.length, 1, 'exactly one structured line');
    // `event` stays the log's own stable NAME (never the tampered event's id, which is `eventId`) —
    // an alert rule keyed on `event: "text_tampered"` has to keep matching no matter which event.
    assert.deepEqual(logged[0], { severity: 'CRITICAL', event: 'text_tampered', time: logged[0].time,
      eventId: 'e1', field: 'text', kind: 'overwritten' });
  }));

// ===================================================================== withTextsRetrying must not
// cry wolf on a torn read it is about to correct — the false positive resolveOne's own comment warns
// about, and the one this whole function exists to close.

test('withTextsRetrying does not report a field the retry resolves as a genuine removal',
  capturingReports(async (t, said, logged) => {
    const salt = newSalt();
    const tampered = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
      data: null, text: null, textHash: hashText('gone', salt) };
    const removal = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
      data: { event: 'e1', field: 'text' } };
    const reports = [];
    const out = await withTextsRetrying([tampered], new Map(), async () => [removal], reports);
    assert.equal(out[0].textTampered, false, 'the retry found the removal: this was never tampering');
    assert.deepEqual(reports, [], 'so nothing is reported — a torn read resolved by retry is not an alert');
    assert.deepEqual(said, [], 'and nothing is printed either');
    assert.deepEqual(logged, []);
  }));

test('withTextsRetrying reports a field the retry could not explain either', () => {
  const salt = newSalt();
  const tampered = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
    data: null, text: null, textHash: hashText('gone', salt) };
  const reports = [];
  return withTextsRetrying([tampered], new Map(), async () => [], reports).then((out) => {
    assert.equal(out[0].textTampered, true);
    assert.deepEqual(reports, [{ event: 'e1', field: 'text', kind: 'unaccounted' }],
      'genuinely nothing explains it, on the FINAL pass: this is the real answer, not a torn read');
  });
});

test('withTextsRetrying never reports a tampered field that belongs to another page', () => {
  // The same leak round 3, finding 1 already closes for the resolved EVENTS — a whole-project
  // re-read can turn up a removal, or here a tampered field, that has nothing to do with the page
  // this call was actually asked about.
  const salt = newSalt();
  const e1 = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
    data: null, text: null, textHash: hashText('gone', salt) }; // tampered, triggers the retry
  // A second, unrelated event with its OWN tampered field, standing in for "something the
  // whole-project re-read drags in that this caller never asked about" — outside `events`.
  const foreign = { id: 'foreign', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:01.000Z',
    data: null, text: null, textHash: hashText('gone', newSalt()) };
  const reports = [];
  return withTextsRetrying([e1], new Map(), async () => [foreign], reports).then((out) => {
    assert.deepEqual(out.map((e) => e.id), ['e1'], 'only the caller\'s own event comes back');
    assert.deepEqual(reports, [{ event: 'e1', field: 'text', kind: 'unaccounted' }],
      'the foreign event\'s own tampering is never this caller\'s to report');
  });
});

// ===================================================================== the store reports too
// One real call site each, on top of `withTexts`/`withTextsRetrying`'s own unit tests above: proof
// that `list()` actually wires `reports` through to `reportTampered`, not only that the pure
// functions could.

test('[memory] list() raises the alert for a field it reads as tampered',
  capturingReports(async (t, said, logged) => {
    const store = new MemoryEventStore();
    const kept = await store.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
    await store.removeText(kept.id, 'text', 'owner@example.org');
    // A duplicate, forged removal — `removeText` itself can never produce a second one — is the one
    // case reachable through this store's own public surface without private-field surgery.
    const forged = { type: TEXT_REMOVED, page: 'A01', data: { event: kept.id, field: 'text' } };
    await store.append(forged, 'forger@example.org');
    await store.list(null);
    assert.ok(said.some((line) => /CRITICAL/.test(line) && line.includes(kept.id)),
      'list() printed the alert for the field the forged removal made tampered');
    assert.ok(logged.some((l) => l.severity === 'CRITICAL' && l.event === 'text_tampered' && l.eventId === kept.id
      && l.field === 'text' && l.kind === 'double_removal'));
  }));

test('[sqlite] list() raises the alert for a row edited straight in the database', capturingReports(
  async (t, said, logged) => {
    const dir = mkdtempSync(join(tmpdir(), 'holdrim-tamper-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'events.db');
    const store = new SqliteEventStore(path);
    const written = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
    await store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec(`DROP TRIGGER IF EXISTS texts_no_update`);
    db.prepare("UPDATE texts SET value = 'forged' WHERE event = ?").run(written.id);
    db.close();
    const reopened = new SqliteEventStore(path);
    await reopened.list(null);
    await reopened.close();
    assert.ok(said.some((line) => /CRITICAL/.test(line) && line.includes(written.id)));
    assert.ok(logged.some((l) => l.severity === 'CRITICAL' && l.event === 'text_tampered'
      && l.eventId === written.id && l.field === 'text' && l.kind === 'overwritten'));
  }));

test('[sqlite] the CLI\'s own direct reader of the events file raises the alert too', capturingReports(
  async (t, said, logged) => {
    const dir = mkdtempSync(join(tmpdir(), 'holdrim-tamper-file-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'events.db');
    const store = new SqliteEventStore(path);
    const written = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
    await store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    db.exec(`DROP TRIGGER IF EXISTS texts_no_update`);
    db.prepare("UPDATE texts SET value = 'forged' WHERE event = ?").run(written.id);
    db.close();
    // The CLI's `--db` reader (Source#fromFile), not the server: this is the one path issue #91
    // means by "the events file" among the CLI's two direct readers.
    await new Source({ db: path }).events();
    assert.ok(said.some((line) => /CRITICAL/.test(line) && line.includes(written.id)));
    assert.ok(logged.some((l) => l.severity === 'CRITICAL' && l.kind === 'overwritten'));
  }));

test('suspectsOf, exported for the CLI\'s own list/sync, reads the same pairs on a final resolved list', () => {
  const out = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', newSalt()) }], new Map());
  assert.deepEqual(suspectsOf(out), [{ event: 'e1', field: 'text' }]);
});

// ===================================================================== withTextsRetrying's own contract
// Round 3, finding 2: the ordinary-path early return had no test of its own.

test('withTextsRetrying never asks for more when nothing looks tampered', async () => {
  const plain = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
    data: null, text: 'fine', textHash: null };
  const out = await withTextsRetrying([plain], new Map(),
    async () => { throw new Error('fetchRemovals must never run on the ordinary path'); });
  assert.equal(out[0].text, 'fine');
});

test('withTextsRetrying asks exactly once when something looks tampered', async () => {
  const salt = newSalt();
  const tampered = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
    data: null, text: null, textHash: hashText('gone', salt) };
  let calls = 0;
  await withTextsRetrying([tampered], new Map(), async () => { calls++; return []; });
  assert.equal(calls, 1);
});

// Round 3, finding 1: a whole-project re-read (finding A) can turn up a removal that belongs to a
// different page entirely, and calling this twice must not duplicate one it already has.

test('withTextsRetrying returns exactly the events it was given, never the extra removals it borrowed to resolve them', async () => {
  const salt = newSalt();
  const e1 = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
    data: null, text: null, textHash: hashText('gone', salt) }; // tampered on a first pass
  const e2 = { id: 'e2', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:01.000Z', data: null };
  // A real, valid removal of e2 — standing in for "whatever a whole-project re-read can turn up
  // that has nothing to do with e1's own page", which round 3, finding 1 says must not leak in.
  const removal = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-01T00:00:02.000Z',
    data: { event: 'e2', field: 'text' } };
  let calls = 0;
  const out = await withTextsRetrying([e1, e2], new Map(), async () => { calls++; return [removal]; });
  assert.equal(calls, 1);
  assert.deepEqual(out.map((e) => e.id), ['e1', 'e2'],
    'exactly the events given, same order, same length — never the fetched removal itself');
});

// `fetchRemovals` reads the whole project unfiltered by page (see withTextsRetrying's own doc
// comment), so a removal that already sits in `events` — because it happened on the same page as
// the tampered field that triggered the re-read — comes back again in `more`. Without the `known`
// filter, `events.concat(more)` would carry that removal twice, and `removalsOf`'s duplicate rule
// (round 3, finding 6) would then mark the field it genuinely removed as tampered too — punished
// for another field's tampering, which has nothing to do with it.
test('withTextsRetrying does not re-count a removal fetchRemovals hands back that was already in the list', async () => {
  const salt = newSalt();
  const tampered = { id: 'e1', type: 'comment', author: 'r@example.org', when: '2026-01-01T00:00:00.000Z',
    data: null, text: null, textHash: hashText('gone', salt) }; // no row, no removal: tampered on its own
  const removedOk = { id: 'e2', type: 'comment', author: 'r@example.org', when: '2026-01-02T00:00:00.000Z',
    data: null, text: null, textHash: hashText('y', salt) };
  const r2 = { id: 'r2', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-03T00:00:00.000Z',
    data: { event: 'e2', field: 'text' } }; // e2's own genuine removal, already in `events`
  const out = await withTextsRetrying([tampered, removedOk, r2], new Map(), async () => [r2]);
  const e1 = out.find((e) => e.id === 'e1');
  const e2 = out.find((e) => e.id === 'e2');
  assert.equal(e2.textTampered, false, 'a removal already in the list must not be counted a second time');
  assert.equal(e2.textRemoved?.by, 'owner@example.org');
  assert.equal(e1.textTampered, true, 'the other, genuinely unaccounted-for field is unaffected either way');
});

// ===================================================================== the events file
function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-texts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'events.db');
}

test('the CLI reads the events file\'s texts as the server does: present, removed, and from before extraction', async (t) => {
  const path = tempFile(t);
  const s = new SqliteEventStore(path);
  const kept = await s.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
  const gone = await s.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
  await s.removeText(gone.id, 'text', 'owner@example.org');
  const server = await s.list(null);
  await s.close();

  const cli = await new Source({ db: path }).events();
  assert.deepEqual(cli.map((e) => ({ id: e.id, text: e.text, textRemoved: e.textRemoved, textTampered: e.textTampered })),
    server.map((e) => ({ id: e.id, text: e.text, textRemoved: e.textRemoved, textTampered: e.textTampered })),
    'the CLI and the server read one file the same way');
  assert.equal(cli.find((e) => e.id === kept.id).text, 'a remark');
  assert.equal(cli.find((e) => e.id === gone.id).text, null);
  assert.equal(cli.find((e) => e.id === gone.id).textRemoved.by, 'owner@example.org');
});

/**
 * `SqliteEventStore.list()` orders `ORDER BY happened_at, rowid` (store-sqlite.ts) precisely because
 * a clock stepping back between an `append` and its `removeText` (round 3, finding 3) can tie a
 * removal's `when` to its target's own `happened_at` exactly — `notBefore` clamps to it — and a tie
 * has to keep breaking toward insertion order, or `removalsOf`'s own list-order check (round 2,
 * finding F) could see the removal sorted BEFORE the very event it names. `Source#fromFile`
 * (engine/cli/remote.ts) reads the same table and has to agree.
 */
test('a removal tied to its target\'s happened_at still reads as the removal it was, through the CLI', async (t) => {
  const RealDate = Date;
  const path = tempFile(t);
  const s = new SqliteEventStore(path);
  const written = await s.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
  class SteppedBack extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2000-01-01T00:00:00.000Z'])); }
    static now() { return new RealDate('2000-01-01T00:00:00.000Z').getTime(); }
  }
  globalThis.Date = SteppedBack;
  let removal;
  try {
    removal = await s.removeText(written.id, 'text', 'owner@example.org');
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(removal.when, written.when, 'notBefore clamped the removal to an exact tie with its target');
  await s.close();

  const [read] = await new Source({ db: path }).events();
  assert.equal(read.text, null);
  assert.equal(read.textRemoved?.by, 'owner@example.org', 'a tied removal still reads as the removal it was');
  assert.equal(read.textTampered, false);
});

test('an events file from before texts were extracted reads its own plain text, through the CLI too', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const path = tempFile(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, page TEXT NOT NULL, block TEXT,
    fingerprint TEXT, text TEXT, snapshot TEXT, author TEXT NOT NULL, happened_at TEXT NOT NULL, data TEXT)`);
  db.prepare("INSERT INTO events (id, type, page, author, happened_at, text) VALUES " +
    "('old', 'comment', 'A01', 'owner@example.org', '2026-01-01T00:00:00.000Z', 'from before extraction')").run();
  db.close();
  const [read] = await new Source({ db: path }).events();
  assert.equal(read.text, 'from before extraction');
  assert.equal(read.textTampered, false);
});

// ===================================================================== the downgrade forgery
// Round 1 of the #91 review, finding 1: a direct writer sets `text_hash` back to NULL and writes the
// forged value straight into `text`, dressing a POST-extraction event as one of the genuinely
// unhashed pre-extraction rows above. `rowid` is the forge-proof line between the two — nothing here
// is ever deleted, and a real `append` always takes the NEXT one — so any row after the first
// genuinely hashed one, with no hash, did not come from before extraction.

async function tamperedByDowngrade(t) {
  const path = tempFile(t);
  const { DatabaseSync } = await import('node:sqlite');
  // A genuine pre-extraction row, made directly the way an old server version would have: no
  // text_hash column exists yet, so its own plain value is all `text` ever held.
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, page TEXT NOT NULL, block TEXT,
    fingerprint TEXT, text TEXT, snapshot TEXT, author TEXT NOT NULL, happened_at TEXT NOT NULL, data TEXT)`);
  raw.prepare("INSERT INTO events (id, type, page, author, happened_at, text) VALUES " +
    "('old', 'comment', 'A01', 'owner@example.org', '2020-01-01T00:00:00.000Z', 'from before extraction')").run();
  raw.close();

  // Opening it for real migrates the schema (adds text_hash/snapshot_hash, both NULL on 'old') and
  // appends one genuinely hashed event — the first row `extractionBoundary` will ever find.
  const store = new SqliteEventStore(path);
  const written = await store.append({ type: 'comment', page: 'A01', text: 'a real remark' }, 'r@example.org');
  await store.close();

  // The forgery: inserted straight into the file, dressed as pre-extraction — null hash, its own
  // inline value — but its rowid sorts AFTER `written`'s, which already carries a hash.
  const raw2 = new DatabaseSync(path);
  raw2.prepare(`INSERT INTO events (id, type, page, author, happened_at, text)
    VALUES ('forged', 'comment', 'A01', 'owner@example.org', '2020-01-01T00:00:00.000Z', 'forged inline text')`).run();
  raw2.close();
  return { path, oldId: 'old', realId: written.id, forgedId: 'forged' };
}

test('[sqlite] a value with no hash, on a row proven to postdate the first hashed one, reads as "downgraded" tampering',
  async (t) => {
    const { path, oldId, realId, forgedId } = await tamperedByDowngrade(t);
    const store = new SqliteEventStore(path);
    const out = await store.list(null);
    await store.close();
    const old = out.find((e) => e.id === oldId);
    const real = out.find((e) => e.id === realId);
    const forged = out.find((e) => e.id === forgedId);
    assert.equal(old.text, 'from before extraction', 'a genuinely pre-extraction row still reads through');
    assert.equal(old.textTampered, false);
    assert.equal(real.text, 'a real remark');
    assert.equal(real.textTampered, false);
    assert.equal(forged.text, null, 'the forged inline text is never handed out, downgraded or not');
    assert.equal(forged.textTampered, true, 'it postdates the first hashed row, so it cannot genuinely be pre-extraction');
  });

test('[sqlite] list() reports the downgrade forgery as its own kind', capturingReports(async (t, said, logged) => {
  const { path, forgedId } = await tamperedByDowngrade(t);
  const store = new SqliteEventStore(path);
  await store.list(null);
  await store.close();
  assert.ok(logged.some((l) => l.severity === 'CRITICAL' && l.eventId === forgedId && l.kind === 'downgraded'));
}));

test('[sqlite] the CLI\'s own direct file reader catches the same downgrade forgery', async (t) => {
  const { path, forgedId } = await tamperedByDowngrade(t);
  const out = await new Source({ db: path }).events();
  const forged = out.find((e) => e.id === forgedId);
  assert.equal(forged.textTampered, true);
});

// Round 1 of the #91 review, finding 2: `Source#fromFile` read events, people and texts as three
// separate, autocommitted SELECTs on a WAL file — a `removeText` from the real server, landing
// between two of them, could read back as tampering that never happened, the false CRITICAL alert
// that teaches whoever sees it that this one cries wolf. `node:sqlite` runs every statement
// synchronously with no `await` between the reads in `#fromFile`'s own loop, so nothing can actually
// land IN one of its gaps to prove the race directly (unlike the Firestore tests below, where
// `Query.prototype.get` gives a real point to intercept between two awaited REST calls) — proving the
// fix instead means proving the STRUCTURE: one `BEGIN`, all four reads, one `COMMIT`, the same shape
// `SqliteEventStore.list()` already has.
test('[sqlite] the CLI\'s direct file reader wraps its four reads in one transaction, not four autocommits',
  async (t) => {
    const path = tempFile(t);
    const store = new SqliteEventStore(path);
    await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
    await store.close();

    const { DatabaseSync } = await import('node:sqlite');
    const original = DatabaseSync.prototype.exec;
    const execCalls = [];
    // `exec` is how a transaction is opened and closed (`db.exec('BEGIN DEFERRED')`/`'COMMIT'`);
    // node:sqlite's own autocommit for an ordinary, unwrapped statement never calls it at all. So a
    // version with no transaction around the reads leaves `execCalls` empty here — not a different
    // pair, none — which is exactly the regression this guards.
    DatabaseSync.prototype.exec = function (sql, ...args) {
      execCalls.push(sql);
      return original.call(this, sql, ...args);
    };
    try {
      await new Source({ db: path }).events();
    } finally {
      DatabaseSync.prototype.exec = original;
    }
    assert.deepEqual(execCalls, ['BEGIN DEFERRED', 'COMMIT'],
      'exactly one transaction around the events, people, texts and boundary reads together');
  });

// Round 3 of the #91 review, MAJOR: the catch above calls `rollbackQuietly` (engine/api/
// store-sqlite.ts) before its own `throw err`, so a ROLLBACK that itself fails cannot replace the
// read's real error with a complaint about undoing a failure that already happened — see
// engine/tests/hooks/fake-sqlite-rollback-throws.js for why this needs a substitute DatabaseSync at
// all. A real SQLite file never fails a ROLLBACK on an empty read-only transaction, so the read's
// own failure has to come from somewhere else: a file that opens (so the constructor succeeds) but
// is not a valid database, so the first real statement inside the transaction fails with SQLite's
// own "file is not a database" — the smallest page SQLite reads before it can tell is 4096 bytes, so
// anything shorter reads as a plain I/O error instead. `rollbackQuietly` has no test of its own:
// this test and the one below it, for `installGuards`, are what prove it. `SqliteEventStore.list()`
// is the third call site and shares the identical helper, but has no test of its own — nothing about
// `list`'s own catch block differs from what these two already exercise on the same function.
//
// A child process, not a prototype patch in this process like the test just above: that test only
// needs `exec` to keep working while it records calls, but this one needs `node:sqlite` itself
// swapped out from under a fresh `import('node:sqlite')`, and a loader hook is the seam that reaches
// that.
test('[sqlite] a ROLLBACK that itself throws does not mask the read error that caused it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const junkPath = join(dir, 'not-a-database.db');
  writeFileSync(junkPath, 'x'.repeat(4096));

  const hook = new URL('./hooks/fake-sqlite-rollback-throws.js', import.meta.url);
  const remote = new URL('../cli/remote.ts', import.meta.url);
  const code = `
    const { Source } = await import(${JSON.stringify(remote.pathname)});
    try {
      await new Source({ db: ${JSON.stringify(junkPath)} }).events();
      console.log(JSON.stringify({ threw: false }));
    } catch (err) {
      console.log(JSON.stringify({
        threw: true, message: err.message,
        rollbackAttempts: globalThis.__HOLDRIM_FAKE_ROLLBACK_THROWN__ ?? 0,
      }));
    }
  `;
  const r = spawnSync(process.execPath, ['--import', hook.pathname, '--input-type=module', '-e', code],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `the child process itself must not crash: ${r.stderr}`);
  const result = JSON.parse(r.stdout.trim());
  assert.equal(result.threw, true, 'a file that is not a database must still fail the read');
  // Checked BEFORE the message: a real ROLLBACK on this empty, read-only transaction never fails
  // either, so if the hook's own redirect ever stopped catching `node:sqlite`, the exact same
  // message would still come out below — proving nothing about the masking this test exists to
  // catch. This is what tells the two cases apart.
  assert.ok(result.rollbackAttempts >= 1, 'the fake ROLLBACK must actually have run for this test to prove anything');
  assert.match(result.message, /file is not a database/,
    'the ORIGINAL error must surface, not whatever the failing ROLLBACK throws instead');
});

// Round 3 of the #91 review, MINOR: `installGuards` (engine/api/store-sqlite.ts) shares the exact
// same shape — `rollbackQuietly` in its catch, then `throw err` — for the repair transaction it runs
// under `BEGIN IMMEDIATE`. `zz_broken`'s body is invalid SQL (`SELEC`, not `SELECT`), so the
// `CREATE TRIGGER` statement that installs it fails with SQLite's own "near \"SELEC\": syntax error",
// and the fake ROLLBACK then fails on top of that while `installGuards` is unwinding — exactly the
// two-failures-at-once shape the test above proves for `Source#fromFile`, now proved for this second
// call site.
test('[sqlite] installGuards surfaces the ORIGINAL repair error too, not a masked ROLLBACK', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.db');

  const hook = new URL('./hooks/fake-sqlite-rollback-throws.js', import.meta.url);
  const storeSqlite = new URL('../api/store-sqlite.ts', import.meta.url);
  const code = `
    const { SqliteEventStore, installGuards, GUARDS } = await import(${JSON.stringify(storeSqlite.pathname)});
    const { DatabaseSync } = await import('node:sqlite');
    // Opened and closed first, so the events/people/texts tables and the real guards already exist
    // — the broken one below is installed on top of a normal store, the same repair path a boot with
    // a foreign trigger takes, not a first install.
    (new SqliteEventStore(${JSON.stringify(path)})).close();
    const db = new DatabaseSync(${JSON.stringify(path)});
    try {
      installGuards(db, { ...GUARDS, zz_broken: 'BEFORE INSERT ON events BEGIN SELEC 1; END' }, () => {});
      console.log(JSON.stringify({ threw: false }));
    } catch (err) {
      console.log(JSON.stringify({
        threw: true, message: err.message,
        rollbackAttempts: globalThis.__HOLDRIM_FAKE_ROLLBACK_THROWN__ ?? 0,
      }));
    }
    db.close();
  `;
  const r = spawnSync(process.execPath, ['--import', hook.pathname, '--input-type=module', '-e', code],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `the child process itself must not crash: ${r.stderr}`);
  // Two lines, not one: `installGuards` itself logs `sqlite_guard_missing` as a JSON line on stdout
  // (engine/api/log.ts) before it ever reaches the broken guard's `CREATE TRIGGER` — the last line
  // is always this test's own.
  const lines = r.stdout.trim().split('\n');
  const result = JSON.parse(lines[lines.length - 1]);
  assert.equal(result.threw, true, 'an invalid guard body must still fail the repair');
  assert.ok(result.rollbackAttempts >= 1, 'the fake ROLLBACK must actually have run for this test to prove anything');
  assert.match(result.message, /SELEC/,
    'the ORIGINAL syntax error must surface, not whatever the failing ROLLBACK throws instead');
});

// ===================================================================== one snapshot, not three reads
// Round 1, finding 6: FirestoreEventStore.list() read events, people and texts as three separate,
// untransacted calls, and a removeText committing between the events read and the texts read read
// back as tampering. Round 1's fix was one Firestore transaction around the three; round 2, finding
// A, is why that is gone — a read-only transaction aborts after 270 seconds, and events/texts only
// grow, so it would eventually fail outright on nothing more than a project living long enough.
// list's own reads are ordinary again; withTextsRetrying (engine/api/texts.ts) is what closes the
// same gap now, by asking once more, later, for the removal a first pass could not have seen yet.

test('[firestore] list reads a removal committed mid-read as the removal it was, never as tampering',
  process.env.FIRESTORE_EMULATOR_HOST ? {} : { skip: 'needs the Firestore emulator, as above' }, async (t) => {
  const project = freshFirestoreProject('holdrim-texts');
  const { Query } = await import('@google-cloud/firestore');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const store = new FirestoreEventStore(project);
  t.after(async () => { await store.close(); });
  const written = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');

  // Between list()'s events read (its first) and its texts read (its third), remove the text for
  // real, through a second store on the same project: the exact torn read a first pass cannot help
  // reading as tampering — the events read missed the removal event, the texts read already misses
  // the row — and only withTextsRetrying's later, second look, made after the removal has landed,
  // can still catch. `Query.prototype.get` underlies every one of list's reads, that later look
  // included, so the count guards against firing twice.
  const originalGet = Query.prototype.get;
  let calls = 0;
  Query.prototype.get = async function (...args) {
    calls++;
    if (calls === 2) { // right after the events read, before people and texts
      const other = new FirestoreEventStore(project);
      await other.removeText(written.id, 'text', 'owner@example.org');
      await other.close();
    }
    return originalGet.apply(this, args);
  };
  try {
    const [read] = await store.list('A01');
    assert.equal(read.textTampered, false, 'a removal mid-read must never look like tampering');
    assert.equal(read.textRemoved?.by, 'owner@example.org', 'and it has to read as the removal it was');
  } finally {
    Query.prototype.get = originalGet;
  }
});

// Round 1 of the #91 review, finding 4: nothing proved `FirestoreEventStore.list()`'s own report
// loop actually fires — every existing tamper test above ran against memory or SQLite. CI's `stores`
// job starts the emulator, so this runs there even where a local session has none.
test('[firestore] list() raises the alert for a field it reads as tampered',
  process.env.FIRESTORE_EMULATOR_HOST ? {} : { skip: 'needs the Firestore emulator, as above' }, capturingReports(
  async (t, said, logged) => {
    const project = freshFirestoreProject('holdrim-texts');
    const { FirestoreEventStore } = await import('../api/store-firestore.ts');
    const store = new FirestoreEventStore(project);
    t.after(async () => { await store.close(); });
    const kept = await store.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
    await store.removeText(kept.id, 'text', 'owner@example.org');
    // A duplicate, forged removal — `removeText` itself can never produce a second one — reached
    // through `append`, which validates no more than the store interface always has (docs/PRIVACY.md,
    // section 4's own note on `TEXT_REMOVED`: the general events path is the one that refuses it).
    await store.append({ type: TEXT_REMOVED, page: 'A01', data: { event: kept.id, field: 'text' } }, 'forger@example.org');
    await store.list('A01');
    assert.ok(said.some((line) => /CRITICAL/.test(line) && line.includes(kept.id)));
    assert.ok(logged.some((l) => l.severity === 'CRITICAL' && l.event === 'text_tampered' && l.eventId === kept.id
      && l.field === 'text' && l.kind === 'double_removal'));
  }));

// ===================================================================== the cloud, over REST
const cloud = process.env.FIRESTORE_EMULATOR_HOST
  ? {}
  : { skip: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. Start the emulator '
      + 'with: eval "$(bash scripts/firestore-emulator.sh)", then re-run.' };

test('[firestore] the CLI reads the cloud\'s texts as the server\'s own store does', cloud, async (t) => {
  const project = freshFirestoreProject('holdrim-texts');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const store = new FirestoreEventStore(project);
  t.after(async () => { await store.close(); });
  const kept = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');
  const gone = await store.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
  await store.removeText(gone.id, 'text', 'owner@example.org');

  const cli = await new Source({ project, account: 'ci@example.org' }).events();
  assert.equal(cli.find((e) => e.id === kept.id).text, 'a remark');
  const read = cli.find((e) => e.id === gone.id);
  assert.equal(read.text, null);
  assert.equal(read.textRemoved.by, 'owner@example.org');
});

test('[firestore] the CLI reads a removal committed mid-read as the removal it was, never as tampering', cloud, async (t) => {
  // Round 2, finding C: the CLI's own reader of the cloud has the same torn-read window
  // `withTextsRetrying` closes in the server (finding A) — proved here the way the proof lens did,
  // wrapping fetch to land a real removeText right after the CLI's first :runQuery response (its
  // events read), ahead of its texts read and of its own later re-read of removals.
  const project = freshFirestoreProject('holdrim-texts');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const store = new FirestoreEventStore(project);
  t.after(async () => { await store.close(); });
  const written = await store.append({ type: 'comment', page: 'A01', text: 'a remark' }, 'r@example.org');

  const original = globalThis.fetch;
  let queries = 0;
  globalThis.fetch = async (url, init) => {
    const res = await original(url, init);
    if (String(url).endsWith(':runQuery') && ++queries === 1) {
      await res.clone().text(); // let this response finish landing before the next store starts
      const other = new FirestoreEventStore(project);
      await other.removeText(written.id, 'text', 'owner@example.org');
      await other.close();
    }
    return res;
  };
  let events;
  try {
    events = await new Source({ project, account: 'ci@example.org' }).events();
  } finally {
    globalThis.fetch = original;
  }
  const read = events.find((e) => e.id === written.id);
  assert.equal(read.textTampered, false, 'a removal mid-read must never look like tampering');
  assert.equal(read.textRemoved?.by, 'owner@example.org', 'and it has to read as the removal it was');
});

// Round 1 of the #91 review, finding 5: the CLI's OWN reader of the cloud (`Source.events()`, its
// `withTextsRetrying` branch) has its own report loop, separate from `FirestoreEventStore.list()`'s —
// nothing proved this one fires either.
test('[firestore] the CLI\'s own reader of the cloud raises the alert too', cloud, capturingReports(
  async (t, said, logged) => {
    const project = freshFirestoreProject('holdrim-texts');
    const { FirestoreEventStore } = await import('../api/store-firestore.ts');
    const store = new FirestoreEventStore(project);
    t.after(async () => { await store.close(); });
    const kept = await store.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
    await store.removeText(kept.id, 'text', 'owner@example.org');
    await store.append({ type: TEXT_REMOVED, page: 'A01', data: { event: kept.id, field: 'text' } }, 'forger@example.org');
    await new Source({ project, account: 'ci@example.org' }).events();
    assert.ok(said.some((line) => /CRITICAL/.test(line) && line.includes(kept.id)));
    assert.ok(logged.some((l) => l.severity === 'CRITICAL' && l.eventId === kept.id && l.kind === 'double_removal'));
  }));

test('[firestore] the CLI pages through more documents than one page holds, and drops none', cloud, async (t) => {
  // Round 2, finding D: pagination was untested, and three of its lines can each fail silently —
  // a cursor never sent loops forever re-reading the first page; a page not fully drained stops
  // one document short. A `pageSize` of 2 against 5 documents forces three pages without writing
  // hundreds of them; the cap on :runQuery calls below is what makes a looping mutant fail fast,
  // as this named test, instead of hanging the run — node:test's own `timeout` option marks a test
  // failed at the deadline but does not stop the dangling call still running underneath it, and a
  // fetch against the local emulator loops far too fast for that to ever matter anyway.
  const project = freshFirestoreProject('holdrim-texts');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const store = new FirestoreEventStore(project);
  t.after(async () => { await store.close(); });
  const written = [];
  for (let i = 0; i < 5; i++) written.push(await store.append({ type: 'comment', page: 'A01', text: `t${i}` }, 'r@example.org'));

  const original = globalThis.fetch;
  let calls = 0;
  // 5 documents at 2 a page is 3 calls for events, and a handful more for people, texts and (if
  // anything looked tampered, which nothing here does) a re-read — comfortably under the cap; a
  // cursor that never advances would still be on page 1 at call 30.
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith(':runQuery') && ++calls > 30) throw new Error('too many :runQuery calls: a page never advanced');
    return original(url, init);
  };
  let events;
  try {
    events = await new Source({ project, account: 'ci@example.org', pageSize: 2 }).events();
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual([...events.map((e) => e.id)].sort(), written.map((e) => e.id).sort(),
    'every document comes back exactly once, however many pages it took');
});

test('[firestore] list does not re-count a same-page removal fetchRemovals hands back a second time', cloud, async (t) => {
  // The store-level version of the unit test above: `removeText` gives its removal event the same
  // `page` as the text it removes (store-firestore.ts), so a removal on this page is already inside
  // `list(page)`'s own `events` read before `fetchRemovals` — triggered here by the OTHER comment's
  // field looking tampered — asks the whole project again and hands the very same removal back.
  const project = freshFirestoreProject('holdrim-texts');
  const { Firestore } = await import('@google-cloud/firestore');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const store = new FirestoreEventStore(project);
  const db = new Firestore({ projectId: project });
  t.after(async () => { await store.close(); await db.terminate(); });
  const tampered = await store.append({ type: 'comment', page: 'A01', text: 'tampered one' }, 'r@example.org');
  const removed = await store.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
  await db.collection('texts').doc(`${tampered.id}:text`).delete(); // no event names this: genuine tampering
  await store.removeText(removed.id, 'text', 'owner@example.org'); // genuine, on the SAME page

  const a01 = await store.list('A01');
  const tamperedRead = a01.find((e) => e.id === tampered.id);
  const removedRead = a01.find((e) => e.id === removed.id);
  assert.equal(tamperedRead.textTampered, true, 'still correctly tampered — unrelated to the other field');
  assert.equal(removedRead.textTampered, false,
    'a genuine removal must not be counted twice just because another field on the same page is tampered');
  assert.equal(removedRead.textRemoved?.by, 'owner@example.org');
});

test('[firestore] list(page) never leaks another page\'s removal event into its answer', cloud, async (t) => {
  // Round 3, finding 1: withTextsRetrying's fetchRemovals reads the WHOLE project — a torn read
  // cannot know which page a removal belongs to any better than list(page) itself can — so a
  // removal that genuinely happened on a DIFFERENT page must still not show up in this page's list.
  const project = freshFirestoreProject('holdrim-texts');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const { Firestore } = await import('@google-cloud/firestore');
  const store = new FirestoreEventStore(project);
  const db = new Firestore({ projectId: project });
  t.after(async () => { await store.close(); await db.terminate(); });
  const tampered = await store.append({ type: 'comment', page: 'A01', text: 'tampered one' }, 'r@example.org');
  const other = await store.append({ type: 'comment', page: 'A02', text: 'other page' }, 'r@example.org');
  await store.removeText(other.id, 'text', 'owner@example.org'); // a real removal, on a different page
  await db.collection('texts').doc(`${tampered.id}:text`).delete(); // force A01's own field to look tampered

  const a01 = await store.list('A01');
  assert.deepEqual(a01.map((e) => e.page), ['A01'], 'only A01\'s own events come back, whatever the re-read had to fetch');
  const read = a01.find((e) => e.id === tampered.id);
  assert.equal(read.textTampered, true, 'still correctly tampered: nothing here should quietly fix that up');
});
