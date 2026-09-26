/**
 * The CLI writes through the server's API, and nowhere else (issue #122, docs/ROLES.md section 4).
 *
 * Its old write went straight to Firestore, around the server: no cycle, no roles, no limits, no
 * `asAgent`, and an author the CLI named itself (`agent via <account>`). What replaced it is one
 * `POST /api/events` with the agent's own token. These tests hold both halves — every write takes
 * that one door, and no code path to the store is left in the CLI for a later change to call.
 *
 * `fetch` is replaced for each test and every call written down, so a test can say exactly which
 * requests were made, and — more to the point — which were not.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Source } from '../cli/remote.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const TOKEN = `holdrim_agent_${'a'.repeat(24)}_${'b'.repeat(64)}`;
const EVENT = { type: 'request_state', page: 'A01', block: 'A01.1.1', text: 'applying', data: { request: 'r1', state: 'applying' } };

// The emulator's variable too: with it named the CLI skips gcloud, and the gcloud check below would
// pass for that reason instead of the one it proves.
const VARIABLES = ['HOLDRIM_AGENT_TOKEN', 'HOLDRIM_URL', 'HOLDRIM_LOCAL_URL', 'HOLDRIM_PROJECT', 'HOLDRIM_EVENTS_PATH', 'HOLDRIM_ACCOUNT',
  'FIRESTORE_EMULATOR_HOST'];
let saved;
let calls;
let answer;
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
  for (const v of VARIABLES) delete process.env[v];
  calls = [];
  answer = () => new globalThis.Response(JSON.stringify({ id: 'e1' }), { status: 201 });
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: { ...init.headers }, body: init.body });
    return answer(String(url));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [v, value] of Object.entries(saved)) if (value === undefined) delete process.env[v]; else process.env[v] = value;
});

test('the CLI writes an event through the server\'s POST /api/events, with the agent token as a bearer', async () => {
  process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
  process.env.HOLDRIM_URL = 'https://docs.example.org/';
  // A cloud project named too, as an adopter in cloud mode has it: the write must still not go there.
  const id = await new Source({ project: 'some-project', account: 'ci@example.org' }).add(EVENT);
  assert.equal(id, 'e1');
  assert.equal(calls.length, 1, `one request, the write: ${calls.map((c) => c.url).join(', ')}`);
  const [call] = calls;
  assert.equal(call.url, 'https://docs.example.org/api/events');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.headers['Content-Type'], 'application/json', 'the server refuses any write that is not JSON');
  assert.equal(call.headers['X-Dev-Email'], undefined, 'a deployed server gets the token, never a claimed identity');
  assert.deepEqual(JSON.parse(call.body), EVENT, 'the event as the command built it, with no author of the CLI\'s choosing');
});

test('with no agent token, the CLI refuses a write to a deployed server before it sends anything', async () => {
  process.env.HOLDRIM_URL = 'https://docs.example.org';
  await assert.rejects(new Source({ project: 'some-project' }).add(EVENT), /HOLDRIM_AGENT_TOKEN/);
  assert.deepEqual(calls, [], 'a write with no token of its own reached somewhere');
});

test('with a token and no server address, the CLI refuses before it sends anything, naming HOLDRIM_URL', async () => {
  process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
  await assert.rejects(new Source({ project: 'some-project' }).add(EVENT), /HOLDRIM_URL/);
  assert.deepEqual(calls, []);
});

test('--local with no token writes as the local runner\'s development identity, never as an account it chose', async () => {
  process.env.HOLDRIM_LOCAL_URL = 'http://localhost:9999';
  await new Source({ local: true }).add(EVENT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:9999/api/events');
  assert.equal(calls[0].headers['X-Dev-Email'], 'agent@local');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('--local wins over HOLDRIM_URL, and never carries the token, even with both exported', async () => {
  // An agent with the deployed address and its token in its shell, asked to work against the local
  // runner: the write goes to the runner, as its development identity, and the token stays home —
  // the runner checks no token, and whatever holds the local port would receive one that never ends.
  process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
  process.env.HOLDRIM_URL = 'https://docs.example.org';
  process.env.HOLDRIM_LOCAL_URL = 'http://localhost:9999';
  await new Source({ local: true }).add(EVENT);
  assert.deepEqual(calls.map((c) => c.url), ['http://localhost:9999/api/events'], 'the write left for the deployed server');
  assert.equal(calls[0].headers['X-Dev-Email'], 'agent@local');
  assert.equal(calls[0].headers.Authorization, undefined, 'the token was sent to the local runner');
});

test('the token goes over https, or over http to this machine only: anything else is refused before sending', async () => {
  process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
  for (const url of ['http://docs.example.org', 'http://10.0.0.5:8080', 'ftp://docs.example.org', 'docs.example.org']) {
    process.env.HOLDRIM_URL = url;
    await assert.rejects(new Source({}).add(EVENT), /https/, url);
  }
  assert.deepEqual(calls, [], 'the token left over something other than https');
  for (const url of ['https://docs.example.org', 'http://localhost:8095', 'http://127.0.0.1:8095/', 'http://[::1]:8095']) {
    process.env.HOLDRIM_URL = url;
    await new Source({}).add(EVENT);
  }
  assert.equal(calls.length, 4, 'an https or this-machine address was refused');
  assert.equal(calls[2].url, 'http://127.0.0.1:8095/api/events');
});

test('a write asks gcloud for nothing: the token is its whole credential', async () => {
  // gcloud still reads the cloud; a write that asked it for an account first would fail on a
  // machine with no gcloud, or with an expired login, for a credential it never sends. A gcloud
  // first on the PATH writes down every call.
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-gcloud-'));
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'gcloud'), `#!/bin/sh\necho "$*" >> '${log}'\n[ "$2" = list ] && echo ci@example.org || echo a-token\n`);
  chmodSync(join(dir, 'gcloud'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
    process.env.HOLDRIM_URL = 'https://docs.example.org';
    await new Source({ project: 'some-project', account: 'ci@example.org' }).add(EVENT);
    assert.equal(calls.length, 1);
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', '', 'gcloud was asked for something on a write');
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a token the server refuses is said as revoked or replaced, with what to do', async () => {
  process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
  process.env.HOLDRIM_URL = 'https://docs.example.org';
  answer = () => new globalThis.Response('{"error":"this agent token is not valid"}', { status: 401 });
  await assert.rejects(new Source({}).add(EVENT), /refused the agent token \(401\).*revoked.*people screen/s);
});

test('the server\'s own reason reaches the person when it refuses a write for anything else', async () => {
  process.env.HOLDRIM_AGENT_TOKEN = TOKEN;
  process.env.HOLDRIM_URL = 'https://docs.example.org';
  answer = () => new globalThis.Response('{"error":"only owner and admin triage"}', { status: 403 });
  await assert.rejects(new Source({}).add(EVENT), /refused it \(403\): only owner and admin triage/);
});

/**
 * The half no behaviour shows: that the code to write the store is GONE, not merely unused. A path
 * left in place is one flag, one fallback or one "temporary" call away from coming back — and the
 * day it does, the agent writes around the server again with every test above still green.
 *
 * The Firestore REST API writes through `:commit`, `:batchWrite`, and a document PATCH or DELETE,
 * and stamps server time with `setToServerValue`; the old direct write used `:commit` with
 * `currentDocument` and `updateTransforms`. None of them may appear in the CLI. The events file is
 * the other store the CLI can reach, and it opens that one read-only, every time.
 */
test('no CLI file can write to an event store directly: no Firestore write call, no writable SQLite', () => {
  const folder = join(ROOT, 'engine', 'cli');
  const writes = /:commit\b|:batchWrite\b|updateTransforms|setToServerValue|currentDocument|method:\s*'(PATCH|DELETE)'/;
  const found = [];
  for (const file of readdirSync(folder).filter((f) => f.endsWith('.ts'))) {
    const lines = readFileSync(join(folder, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (writes.test(line)) found.push(`engine/cli/${file}:${i + 1}: ${line.trim()}`);
      if (/new DatabaseSync\(/.test(line) && !/readOnly:\s*true/.test(line)) {
        found.push(`engine/cli/${file}:${i + 1}: opens SQLite writable: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(found, [], 'the CLI can write to a store around the server');
});
