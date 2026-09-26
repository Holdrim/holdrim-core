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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { authorOf, withAuthors, idForLog, actedOn, recordAuthored } from '../api/people.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { Source } from '../cli/remote.ts';
import { stub } from './helpers/stub.js';
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

test('resolving a list changes the author, adds the id it resolved FROM, and nothing else', () => {
  const events = [{ id: 'e1', type: 'comment', author: ANA, text: 'x' }, { id: 'e2', type: 'comment', author: GONE, text: 'y' }];
  assert.deepEqual(withAuthors(events, people), [
    { id: 'e1', type: 'comment', author: 'ana@example.org', authorId: ANA, text: 'x' },
    { id: 'e2', type: 'comment', author: GONE, authorId: GONE, text: 'y' },
  ]);
  assert.equal(events[0].author, ANA);
});

test('authorId is the value BEFORE resolution, for people.show: "id" — never the resolved address', () => {
  // For a forgotten person the two happen to read the same (authorOf falls back to the id too), so
  // this is the one case that tells them apart: authorId must stay ANA's id even though author, on
  // the very same event, is resolved all the way to the e-mail.
  const [resolved] = withAuthors([{ id: 'e1', type: 'comment', author: ANA, text: 'x' }], people);
  assert.equal(resolved.author, 'ana@example.org');
  assert.equal(resolved.authorId, ANA);
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
/**
 * Runs `body` with no emulator, no configured project, and a `gcloud` first on the PATH that answers
 * like a signed-in one and writes down every call — and hands back those calls. Without the
 * emulator, which needs no token, the CLI would ask gcloud; with a working one, a check that came
 * too late would still end in the right error, so only the count shows whether it came first.
 */
async function withGcloud(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-gcloud-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  stub(dir, 'gcloud', `echo "$*" >> '${log}'\n[ "$2" = list ] && echo ci@example.org || echo a-token`);
  const saved = { host: process.env.FIRESTORE_EMULATOR_HOST, project: process.env.HOLDRIM_PROJECT, path: process.env.PATH };
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.HOLDRIM_PROJECT;
  process.env.PATH = `${dir}:${saved.path}`;
  try {
    await body();
  } finally {
    for (const [key, name] of [['host', 'FIRESTORE_EMULATOR_HOST'], ['project', 'HOLDRIM_PROJECT'], ['path', 'PATH']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  }
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

test('the CLI refuses to read a cloud with no project before it asks gcloud for anything', async (t) => {
  const calls = await withGcloud(t, () => assert.rejects(new Source({ account: 'ci@example.org' }).events(),
    /cloud\.project|HOLDRIM_PROJECT/));
  assert.deepEqual(calls, [], 'gcloud was asked for a read that could not happen');
});

const cloud = process.env.FIRESTORE_EMULATOR_HOST
  ? {}
  : { skip: 'FIRESTORE_EMULATOR_HOST is not set, so nothing ran against Firestore. Start the emulator '
      + 'with: eval "$(bash scripts/firestore-emulator.sh)", then re-run.' };

/** A project of its own per test: the emulator keeps what every earlier run wrote. */
async function cloudProject(t) {
  const project = freshFirestoreProject('holdrim-authors');
  const { Firestore } = await import('@google-cloud/firestore');
  const { FirestoreEventStore } = await import('../api/store-firestore.ts');
  const db = new Firestore({ projectId: project });
  const store = new FirestoreEventStore(project);
  t.after(async () => { await store.close(); await db.terminate(); });
  return { project, db, store };
}

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

test('the cloud tests ran when this run was told to expect Firestore', () => {
  // CI's `stores` job starts the emulator and promises it: without this, an emulator that failed to
  // come up would turn every [firestore] test above into a skip and the job green.
  const required = (process.env.HOLDRIM_TEST_REQUIRE ?? '').split(',').map((s) => s.trim());
  if (required.includes('firestore')) assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'promised Firestore and none was set');
});

// ============================================================ idForLog / actedOn, for the server's own log lines
// These take the store as a parameter precisely so a lookup that throws can be tested here, in a
// microsecond, instead of trying to break a real database under a running server.

test('idForLog answers whatever a working lookup answers', async () => {
  const found = { personOf: async (e) => (e === 'ana@example.org' ? 'p_aaaaaaaaaaaaaaaaaaaaaaaa' : null) };
  assert.equal(await idForLog(found, 'ana@example.org'), 'p_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(await idForLog(found, 'nobody@example.org'), null);
});

test('idForLog answers null, never throws, when the lookup itself fails', async () => {
  const broken = { personOf: async () => { throw new Error('the database is down'); } };
  await assert.doesNotReject(idForLog(broken, 'ana@example.org'));
  assert.equal(await idForLog(broken, 'ana@example.org'), null);
});

test('actedOn resolves both sides on their own: one failing does not lose the other', async () => {
  const store = {
    personOf: async (e) => {
      if (e === 'owner@example.org') return 'p_owner00000000000000000a';
      throw new Error('no row, and asking failed outright');
    },
  };
  assert.deepEqual(await actedOn(store, 'somebody@example.org', 'owner@example.org'),
    { person: null, by: 'p_owner00000000000000000a' });
  assert.deepEqual(await actedOn(store, 'owner@example.org', 'somebody@example.org'),
    { person: 'p_owner00000000000000000a', by: null });
});

test('idForLog logs a distinct warning when the lookup itself fails, naming no e-mail', async () => {
  const lines = [];
  const real = console.log;
  console.log = (line) => lines.push(line);
  try {
    assert.equal(await idForLog({ personOf: async () => { throw new Error('down'); } }, 'ana@example.org'), null);
  } finally {
    console.log = real;
  }
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.event, 'person_lookup_failed');
  assert.ok(!JSON.stringify(logged).includes('ana@example.org'), 'the e-mail leaked into the very log this PR removes it from');
});

test('idForLog logs nothing when the lookup simply answers null', async () => {
  const lines = [];
  const real = console.log;
  console.log = (line) => lines.push(line);
  try {
    assert.equal(await idForLog({ personOf: async () => null }, 'nobody@example.org'), null);
    assert.deepEqual(lines, [], 'the ordinary "nobody yet" answer is not a failure, and must not read as one');
  } finally {
    console.log = real;
  }
});

// ============================================================ recordAuthored, for the API's own write path
test('recordAuthored resolves the author before writing, and hands both back', async () => {
  const calls = [];
  const store = {
    personFor: async (e) => { calls.push(['personFor', e]); return 'p_aaaaaaaaaaaaaaaaaaaaaaaa'; },
    append: async (incoming, e) => { calls.push(['append', e]); return { ...incoming, id: 'e1', author: 'p_aaaaaaaaaaaaaaaaaaaaaaaa' }; },
  };
  const result = await recordAuthored(store, { type: 'comment', page: 'A01', text: 'x' }, 'ana@example.org');
  assert.deepEqual(calls, [['personFor', 'ana@example.org'], ['append', 'ana@example.org']],
    'the author must be resolved before the event is written, not after');
  assert.equal(result.author, 'p_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(result.event.id, 'e1');
});

test('an author that cannot be resolved writes no event', async () => {
  let appended = false;
  const store = {
    personFor: async () => { throw new Error('the people table is down'); },
    append: async (incoming, e) => { appended = true; return { ...incoming, id: 'e1', author: e }; },
  };
  await assert.rejects(recordAuthored(store, { type: 'comment', page: 'A01', text: 'x' }, 'ana@example.org'),
    /the people table is down/);
  assert.equal(appended, false, 'append ran even though the author it would have credited was never resolved');
});
