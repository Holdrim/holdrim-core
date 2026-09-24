/**
 * One resolver for what an event's author means, and the CLI's two readers that use it.
 *
 * The server's stores are asked in the events suite, beside each other. This file asks the rule on
 * its own, and the CLI's readers of the events file and of the cloud, which build events from what
 * is stored without going through a store — the two places a reader could quietly go on handing a
 * raw id to `sync`, whose owner check would then lock nothing (docs/PRIVACY.md, section 1).
 *
 * ⚠️ The cloud path needs the Firestore emulator. Without `FIRESTORE_EMULATOR_HOST` those tests
 * SKIP, with a message saying so, as in the store suites.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { authorOf, withAuthors, PERSON_ID } from '../api/people.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { Source } from '../cli/remote.ts';

// The Source reads these before its own options; a developer's own would point these tests at
// their real events file or account.
const saved = { path: process.env.HOLDRIM_EVENTS_PATH, account: process.env.HOLDRIM_ACCOUNT };
delete process.env.HOLDRIM_EVENTS_PATH;
delete process.env.HOLDRIM_ACCOUNT;
after(() => {
  if (saved.path !== undefined) process.env.HOLDRIM_EVENTS_PATH = saved.path;
  if (saved.account !== undefined) process.env.HOLDRIM_ACCOUNT = saved.account;
});

const ANA = 'p_aaaaaaaaaaaaaaaaaaaaaaaa';
const GONE = 'p_bbbbbbbbbbbbbbbbbbbbbbbb';
const people = new Map([[ANA, 'ana@example.org'], [GONE, null]]);

// ===================================================================== the rule
test('an id whose row holds an address reads as that address', () => {
  assert.equal(authorOf(ANA, people), 'ana@example.org');
});

test('an id whose row was emptied reads as the id, never as nothing', () => {
  assert.equal(authorOf(GONE, people), GONE);
});

test('an author with no row reads as it is written: an old event\'s address, or an unknown id', () => {
  assert.equal(authorOf('owner@example.org', people), 'owner@example.org');
  assert.equal(authorOf('p_cccccccccccccccccccccccc', people), 'p_cccccccccccccccccccccccc');
});

test('resolving a list changes the author and nothing else, and leaves the list it was given alone', () => {
  const events = [{ id: 'e1', type: 'comment', author: ANA, text: 'x' }, { id: 'e2', type: 'comment', author: GONE, text: 'y' }];
  assert.deepEqual(withAuthors(events, people), [
    { id: 'e1', type: 'comment', author: 'ana@example.org', text: 'x' },
    { id: 'e2', type: 'comment', author: GONE, text: 'y' },
  ]);
  assert.equal(events[0].author, ANA);
});

// ===================================================================== the events file
function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-authors-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'events.db');
}

test('the CLI reads the events file\'s authors as the server does: address, old address, forgotten id', async (t) => {
  const path = tempFile(t);
  const s = new SqliteEventStore(path);
  await s.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' }, 'owner@example.org');
  await s.append({ type: 'comment', page: 'A01', text: 'x' }, 'gone@example.org');
  const gone = await s.personFor('gone@example.org');
  await s.forget(gone);
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO events (id, type, page, author, happened_at) VALUES ('old', 'comment', 'A01', 'old@example.org', '2000-01-01T00:00:00.000Z')").run();
  db.close();
  const server = (await s.list(null)).map((e) => e.author);
  await s.close();

  const cli = (await new Source({ db: path }).events()).map((e) => e.author);
  assert.deepEqual(cli, ['old@example.org', 'owner@example.org', gone]);
  assert.deepEqual(cli, server, 'the CLI and the server read one file the same way');
});

test('an events file from before the people table reads as the addresses it holds', async (t) => {
  const path = tempFile(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT NOT NULL, page TEXT NOT NULL, block TEXT,
    fingerprint TEXT, text TEXT, snapshot TEXT, author TEXT NOT NULL, happened_at TEXT NOT NULL, data TEXT)`);
  db.prepare("INSERT INTO events (id, type, page, author, happened_at) VALUES ('old', 'approval', 'A01', 'owner@example.org', '2026-01-01T00:00:00.000Z')").run();
  db.close();
  assert.deepEqual((await new Source({ db: path }).events()).map((e) => e.author), ['owner@example.org']);
});

// ===================================================================== the cloud, over REST
const cloud = process.env.FIRESTORE_EMULATOR_HOST
  ? {}
  : { skip: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. Start the emulator '
      + 'with: eval "$(bash scripts/firestore-emulator.sh)", then re-run.' };

/** A project of its own per test: the emulator keeps what every earlier run wrote. */
async function cloudProject(t) {
  const project = `holdrim-authors-${randomBytes(6).toString('hex')}`;
  const { Firestore } = await import('@google-cloud/firestore');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const db = new Firestore({ projectId: project });
  const store = new FirestoreEventStore(project);
  t.after(async () => { await store.close(); await db.terminate(); });
  return { project, db, store };
}

test('[firestore] the CLI\'s direct write names its author by an id the server\'s store knows', cloud, async (t) => {
  const { project, db, store } = await cloudProject(t);
  const source = new Source({ project, account: 'ci@example.org' });
  await source.add({ type: 'comment', page: 'A01', text: 'first' });
  await source.add({ type: 'comment', page: 'A01', text: 'second' });

  const stored = (await db.collection('events').get()).docs.map((d) => d.data());
  assert.equal(stored.length, 2);
  assert.ok(!JSON.stringify(stored).includes('@'), `an address in the events collection: ${JSON.stringify(stored)}`);
  assert.match(stored[0].author, PERSON_ID);
  assert.equal(stored[1].author, stored[0].author, 'the second write finds the person the first made');
  assert.equal(await store.personFor('agent via ci@example.org'), stored[0].author,
    'the server\'s store finds the CLI\'s person under the same address, so one person has one id');
  assert.deepEqual((await store.list('A01')).map((e) => e.author), ['agent via ci@example.org', 'agent via ci@example.org']);
});

test('[firestore] the CLI reads the cloud\'s authors as the server does: address, old address, forgotten id', cloud, async (t) => {
  const { project, db, store } = await cloudProject(t);
  await db.collection('events').doc('old').create({ type: 'comment', page: 'A01', author: 'old@example.org',
    when: new Date('2000-01-01T00:00:00Z') });
  await store.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f' }, 'owner@example.org');
  await store.append({ type: 'comment', page: 'A01', text: 'x' }, 'gone@example.org');
  const gone = await store.personFor('gone@example.org');
  await store.forget(gone);

  const cli = (await new Source({ project }).events()).map((e) => e.author);
  assert.deepEqual(cli, ['old@example.org', 'owner@example.org', gone]);
  assert.deepEqual(cli, (await store.list(null)).map((e) => e.author), 'the CLI and the server read one cloud the same way');
});

test('[firestore] a person the server made first is the one the CLI\'s write names', cloud, async (t) => {
  const { project, db, store } = await cloudProject(t);
  const id = await store.personFor('agent via ci@example.org');
  await new Source({ project, account: 'ci@example.org' }).add({ type: 'comment', page: 'A01', text: 'x' });
  assert.deepEqual((await db.collection('events').get()).docs.map((d) => d.data().author), [id]);
  assert.equal((await db.collection('people').get()).size, 1, 'no second person for one address');
});
