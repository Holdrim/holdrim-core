/**
 * The CLI and the server agree on who the owner and the admins are — and take them from the
 * deployment alone.
 *
 * The owner decides whose ✓ becomes a lock, and the owner and the admins whose request needs no
 * triage. Both come from HOLDRIM_OWNER and HOLDRIM_ADMINS and from nowhere else: a holdrim.json that
 * names `owner`, `admins` or `locks` refuses to load, because whoever can commit to the repository —
 * or the agent applying an approved request — is not whoever deploys it (docs/ROLES.md, "Authority
 * comes from the deployment only"). With a fallback to the file, a branch editing one line would
 * make `holdrim sync` write somebody else's ✓ as a lock, and a revoked admin still listed there
 * would have their requests read as approved by the agent's CLI.
 *
 * The server side is the calls server.ts makes, `ofProject` then `rolesOf`, in this process, with
 * each request's state derived the way server.ts derives it. The CLI side is the real binary,
 * spawned with the same environment against the same project, and asked what the owner and the
 * admins decide: `list --all --json` (whose request skips triage?) and `sync` (whose ✓ locks?).
 * Every case runs both, and both must answer alike.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { ofProject, readBlocks } from '../cli/pages.ts';
import { rolesOf } from '../core/roles.js';
import { createCycle } from '../core/cycle.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const CLI = join(ROOT, 'engine', 'cli', 'holdrim.ts');
const EXAMPLE = join(ROOT, 'examples', 'hello-world');
const CYCLE = JSON.parse(readFileSync(join(ROOT, 'engine', 'cycle.json'), 'utf8'));
const cycle = createCycle(CYCLE);
/** Where a request starts: a stranger's at triage, the owner's and an admin's past it. */
const { initial: STRANGER_START, initial_for_admin: ADMIN_START } = CYCLE;

const OWNER = 'owner@example.org';
const OTHER = 'other@example.org';
const ADMIN = 'admin@example.org';
/** Each person asks about, and approves, a block of their own, so a lock says whose ✓ it was. */
const BLOCK_OF = { [OWNER]: 'A01.1.1', [OTHER]: 'A01.1.2', [ADMIN]: 'A01.1.3' };

/** What refuses a holdrim.json that claims authority, on both paths. */
const AUTHORITY = /authority is set by the deployment.*HOLDRIM_OWNER.*HOLDRIM_ADMINS/;

/**
 * A copy of the hello world with `extra` merged into its holdrim.json, and an events file holding,
 * for each person, one request they made and one ✓ they gave.
 */
async function project(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-owner-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Read before `extra` is written: a file claiming authority refuses to load, even for this.
  const blocks = await readBlocks(dir);
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  const ids = {};
  for (const [who, block] of Object.entries(BLOCK_OF)) {
    const request = await store.append({ type: 'request', page: 'A01', block, fingerprint: 'x',
      text: `asked by ${who}`, snapshot: null, data: null }, who);
    ids[who] = request.id;
    await store.append({ type: 'approval', page: 'A01', block,
      fingerprint: blocks.get(block).fingerprint, text: null, data: null }, who);
  }
  const events = await store.list();
  await store.close();
  const config = JSON.parse(readFileSync(join(dir, 'holdrim.json'), 'utf8'));
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ ...config, ...extra }));
  return { dir, db, ids, events };
}

/** The environment with the two variables exactly as the case says: set, or absent. */
function environment({ owner, admins }) {
  const env = { ...process.env };
  delete env.HOLDRIM_OWNER;
  delete env.HOLDRIM_ADMINS;
  if (owner !== undefined) env.HOLDRIM_OWNER = owner;
  if (admins !== undefined) env.HOLDRIM_ADMINS = admins;
  return env;
}

function cli(args, dir, env) {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status };
  }
}

/**
 * What the server would boot with, under the case's environment: server.ts's own two calls, and
 * each request's state as server.ts derives it (`cycle.currentState` with `roles.can('triage', …)`).
 */
function serverView({ dir, ids, events }, variables) {
  const before = { owner: process.env.HOLDRIM_OWNER, admins: process.env.HOLDRIM_ADMINS };
  const env = environment(variables);
  for (const key of ['HOLDRIM_OWNER', 'HOLDRIM_ADMINS']) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  try {
    const roles = rolesOf(ofProject(dir));
    const threads = cycle.threadsOf(events);
    const states = Object.fromEntries(Object.entries(ids).map(([who, id]) =>
      [who, cycle.currentState(id, threads.get(id) ?? [], roles.can('triage', who))]));
    return { owner: roles.owner, states };
  } catch (e) {
    return { refused: e.message };
  } finally {
    if (before.owner === undefined) delete process.env.HOLDRIM_OWNER; else process.env.HOLDRIM_OWNER = before.owner;
    if (before.admins === undefined) delete process.env.HOLDRIM_ADMINS; else process.env.HOLDRIM_ADMINS = before.admins;
  }
}

/**
 * The same questions put to the CLI, read off what it does: every request's state from `list --all
 * --json`, and the owner from whose ✓ `sync` locked. `sync` also says, in words, whom it took for
 * the owner and from where — which has to be the person whose ✓ it locked.
 */
function cliView({ dir, db, ids }, variables) {
  const env = environment(variables);
  const list = cli(['list', '--all', '--json', '--db', db], dir, env);
  const sync = cli(['sync', '--db', db], dir, env);
  if (list.code !== 0 || sync.code !== 0) {
    assert.notEqual(list.code, 0, `list ran while sync refused:\n${list.out}`);
    assert.notEqual(sync.code, 0, `sync ran while list refused:\n${sync.out}`);
    return { refused: list.out, syncRefused: sync.out };
  }
  const byId = Object.fromEntries(JSON.parse(list.out).requests.map((r) => [r.id, r.state]));
  const states = Object.fromEntries(Object.entries(ids).map(([who, id]) => [who, byId[id]]));
  const registry = JSON.parse(readFileSync(join(dir, 'approvals.json'), 'utf8'));
  const lockedBy = Object.keys(ids).filter((who) => registry[BLOCK_OF[who]]);
  assert.equal(lockedBy.length, 1, `exactly one person's ✓ locks, got: ${lockedBy.join(', ') || 'nobody'}`);
  assert.match(sync.out, new RegExp(`owner: ${lockedBy[0]} \\(from HOLDRIM_OWNER\\)`),
    'sync names the owner it locked for, and where that came from');
  return { owner: lockedBy[0], states };
}

test('the CLI and the server name the same owner: HOLDRIM_OWNER', async (t) => {
  const p = await project(t);
  const expected = { owner: OWNER, states: { [OWNER]: ADMIN_START, [OTHER]: STRANGER_START, [ADMIN]: STRANGER_START } };
  assert.deepEqual(serverView(p, { owner: OWNER }), expected, 'the server');
  assert.deepEqual(cliView(p, { owner: OWNER }), expected, 'the CLI');
});

test('an admin named in HOLDRIM_ADMINS alone: their request starts approved, on both sides', async (t) => {
  // Not the owner, so only HOLDRIM_ADMINS can have made it skip triage — and a CLI that ignored the
  // variable would leave it open for the owner to triage while the server shows it approved.
  const p = await project(t);
  const variables = { owner: OWNER, admins: ADMIN };
  const expected = { owner: OWNER, states: { [OWNER]: ADMIN_START, [OTHER]: STRANGER_START, [ADMIN]: ADMIN_START } };
  assert.deepEqual(serverView(p, variables), expected, 'the server');
  assert.deepEqual(cliView(p, variables), expected, 'the CLI');
});

const fileRefusals = [
  // The attack the refusal exists for: a branch that names somebody else. With a fallback, sync
  // would lock OTHER's ✓, and the server would boot with them as the owner.
  { name: 'the owner only in holdrim.json', variables: {}, file: { owner: OTHER } },
  // The variable does not excuse the key: left there, the file lies about who owns the project.
  { name: 'the owner in holdrim.json and in HOLDRIM_OWNER', variables: { owner: OWNER }, file: { owner: OTHER } },
  // A revoked admin, still listed in the file: their requests would read as approved.
  { name: 'an admin named only in holdrim.json', variables: { owner: OWNER }, file: { admins: [ADMIN] } },
  { name: 'lock-holders named in holdrim.json', variables: { owner: OWNER }, file: { locks: `${OTHER}:A01` } },
];

for (const c of fileRefusals) {
  test(`the CLI and the server both refuse: ${c.name}`, async (t) => {
    const p = await project(t, c.file);
    const [key] = Object.keys(c.file);
    const server = serverView(p, c.variables);
    assert.match(server.refused ?? `booted with ${server.owner}`, AUTHORITY, 'the server');
    assert.match(server.refused, new RegExp(`names "${key}"`), 'and names the key');
    const cliAnswer = cliView(p, c.variables);
    assert.match(cliAnswer.refused ?? `ran with ${cliAnswer.owner}`, AUTHORITY, 'the CLI, list');
    assert.match(cliAnswer.syncRefused, AUTHORITY, 'the CLI, sync');
    assert.equal(readFileSync(join(p.dir, 'approvals.json'), 'utf8').trim(), '{}', 'and sync locked nothing');
  });
}

const ownerRefusals = [
  { name: 'no owner anywhere', variables: {}, got: 0 },
  { name: 'two owners in the variable', variables: { owner: `${OWNER},${OTHER}` }, got: 2 },
];

for (const c of ownerRefusals) {
  test(`the CLI and the server both refuse: ${c.name}`, async (t) => {
    const p = await project(t);
    const needs = new RegExp(`exactly one e-mail \\(got ${c.got}\\).*HOLDRIM_OWNER, set where Holdrim runs`);
    const server = serverView(p, c.variables);
    assert.match(server.refused ?? `booted with ${server.owner}`, needs, 'the server');
    const cliAnswer = cliView(p, c.variables);
    assert.match(cliAnswer.refused ?? `ran with ${cliAnswer.owner}`, needs, 'the CLI, list');
    assert.match(cliAnswer.syncRefused, needs, 'the CLI, sync');
  });
}
