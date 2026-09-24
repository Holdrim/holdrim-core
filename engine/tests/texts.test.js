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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashText, newSalt, textKey, withTexts, noText, TEXT_REMOVED } from '../api/texts.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { Source } from '../cli/remote.ts';
import { freshFirestoreProject } from './helpers/firestore.js';

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

test('a removal event naming the wrong field, or a target that is not a string, names no removal', () => {
  const salt = newSalt();
  const badField = { id: 'r1', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 'e1', field: 'nonsense' } };
  const badTarget = { id: 'r2', type: TEXT_REMOVED, author: 'owner@example.org', when: '2026-01-02T00:00:00.000Z',
    data: { event: 42, field: 'text' } };
  const [out] = withTexts([{ ...AN_EVENT, text: null, textHash: hashText('gone', salt) }, badField, badTarget], new Map());
  assert.equal(out.textRemoved, null, 'neither malformed event counts as the removal it does not correctly name');
  assert.equal(out.textTampered, true, 'so the missing field still reads as tampering');
});

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
