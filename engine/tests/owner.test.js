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
import { rolesOf, createRoles } from '../core/roles.js';
import { createCycle } from '../core/cycle.js';
import { authorCouldTriage, earliestLockBaseline } from '../api/types.ts';

/** Order within one millisecond is not part of the contract (events-conformance.test.js): the
 *  baseline `project` seeds has to land strictly BEFORE the events that follow it, or `authorCouldTriage`
 *  and `isLocked` would read their written fields as predating the baseline and ignore them (round 2's
 *  review) — the exact thing this file means to seed past, not test. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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
const AUTHORITY = /authority is set by the deployment, never by the repository/;

/** Where each authority key actually lives (docs/ROLES.md, "Where everything lives", section 5) —
 *  checked per key, since the refusal names the actual destination and not the same two variables
 *  for every key alike (#29's rework: `roles` and `grants` have no variable at all yet). */
const HOME_OF = {
  owner: 'HOLDRIM_OWNER', admins: 'HOLDRIM_ADMINS', locks: 'HOLDRIM_LOCKS', agents: 'HOLDRIM_AGENTS',
  roles: 'the settings screen', grants: 'the settings screen',
};

/** Each variable `environment` sets, by the name a case gives it. */
const VARIABLES = { owner: 'HOLDRIM_OWNER', admins: 'HOLDRIM_ADMINS', locks: 'HOLDRIM_LOCKS', agents: 'HOLDRIM_AGENTS' };

/**
 * A copy of the hello world with `extra` merged into its holdrim.json, and an events file holding a
 * `lock_baseline` (round 2's review: without one, every written field below predates it — there is
 * none — and both `authorCouldTriage` and `isLocked` ignore what was written entirely), then, for
 * each person, one request they made and one ✓ they gave — written exactly as `recordEvent` would,
 * from `variables`: `authorCouldTriage` and `locks` are baked in at creation, never left for a reader
 * to recompute (docs/ROLES.md §3). `variables` defaults to plain `{ owner: OWNER }` for the callers
 * that never read either field (the file/owner refusal cases, which refuse before reaching them) —
 * the two cases that DO read them pass the exact environment they mean to test both readers against,
 * so what is written here is what `serverView`/`cliView` later compare against each other.
 */
async function project(t, extra = {}, variables = { owner: OWNER }) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-owner-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Read before `extra` is written: a file claiming authority refuses to load, even for this.
  const blocks = await readBlocks(dir);
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  const roles = createRoles(variables.owner, variables.admins);
  await store.append({ type: 'lock_baseline', page: '_lock_baseline', data: null }, variables.owner ?? OWNER);
  await tick();
  const ids = {};
  for (const [who, block] of Object.entries(BLOCK_OF)) {
    const request = await store.append({ type: 'request', page: 'A01', block, fingerprint: 'x',
      text: `asked by ${who}`, snapshot: null, data: { authorCouldTriage: String(roles.can('triage', who)) } }, who);
    ids[who] = request.id;
    await store.append({ type: 'approval', page: 'A01', block,
      fingerprint: blocks.get(block).fingerprint, text: null, data: { locks: String(roles.can('lock', who)) } }, who);
  }
  const events = await store.list();
  await store.close();
  const config = JSON.parse(readFileSync(join(dir, 'holdrim.json'), 'utf8'));
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ ...config, ...extra }));
  return { dir, db, ids, events };
}

/** The environment with the authority variables exactly as the case says: set, or absent. */
function environment(variables) {
  const env = { ...process.env };
  for (const [key, name] of Object.entries(VARIABLES)) {
    delete env[name];
    if (variables[key] !== undefined) env[name] = variables[key];
  }
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
 * each request's state as server.ts derives it — `cycle.currentState` with `authorCouldTriage`
 * (types.ts), which reads what was WRITTEN on the request, never a live `roles.can('triage', …)`.
 * `roles` is still built here, and still what refuses an invalid environment before either field is
 * ever read — that refusal is what this function's `try` still proves.
 */
function serverView({ dir, ids, events }, variables) {
  const names = Object.values(VARIABLES);
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const env = environment(variables);
  for (const key of names) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  try {
    const roles = rolesOf(ofProject(dir));
    const threads = cycle.threadsOf(events);
    const baseline = earliestLockBaseline(events);
    const states = Object.fromEntries(Object.entries(ids).map(([who, id]) =>
      [who, cycle.currentState(id, threads.get(id) ?? [], authorCouldTriage(events.find((e) => e.id === id), baseline))]));
    return { owner: roles.owner, states };
  } catch (e) {
    return { refused: e.message };
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
    }
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

/**
 * `show`, `impact`, `summary` and `state` (requests.ts) all call `checkAuthority` before doing
 * anything else, exactly as `list` and `sync` do above — but through `projectRoles` directly, not
 * through the `ofProject` call every command already goes through in `holdrim.ts`'s `main` (round 2's
 * review, M-6). That top-level call alone catches a holdrim.json that CLAIMS authority (the
 * `fileRefusals` cases below): it never asks whether HOLDRIM_OWNER resolves to exactly one address,
 * which is `ownerRefusals`' whole point. So `checkAuthority` removed from any of these four would
 * still refuse under `fileRefusals`, by accident, but run in SILENCE against a project with no owner
 * at all, or two, under `ownerRefusals` — exactly where this drives them. `state` is included because
 * it, alone of the four, WRITES an event once past the check.
 *
 * `state` targets `applying`, not `rejected` (round 4's review, MINOR r5): OWNER's own request is
 * seeded already `approved` (ADMIN_START), so `applying` is a transition the agent MAY make and
 * `setState` accepts — right up to the actual `source.add` write. `rejected` is not an agent state at
 * all, so `setState` would refuse it on that ground ALONE, with `checkAuthority` never in question:
 * a `checkAuthority` removed from `setState` would still throw before the write (a different message,
 * from the `cycle.agentStates.includes` check further down), and the probe would never reach the one
 * thing worth proving here — that no event gets written to a project with no real owner.
 */
function otherCommandsRefuse(p, env, needs) {
  const id = p.ids[OWNER];
  for (const args of [['show', id], ['impact', id], ['summary'], ['state', id, 'applying', 'no']]) {
    const r = cli([...args, '--db', p.db], p.dir, env);
    assert.notEqual(r.code, 0, `${args[0]} ran without refusing:\n${r.out}`);
    assert.match(r.out, needs, args[0]);
  }
}

test('the CLI and the server name the same owner: HOLDRIM_OWNER', async (t) => {
  const variables = { owner: OWNER };
  const p = await project(t, {}, variables);
  const expected = { owner: OWNER, states: { [OWNER]: ADMIN_START, [OTHER]: STRANGER_START, [ADMIN]: STRANGER_START } };
  assert.deepEqual(serverView(p, variables), expected, 'the server');
  assert.deepEqual(cliView(p, variables), expected, 'the CLI');
});

test('an admin named in HOLDRIM_ADMINS alone: their request starts approved and their ✓ never locks, on both sides', async (t) => {
  // Not the owner, so only HOLDRIM_ADMINS can have made it skip triage — and a CLI that ignored the
  // variable would leave it open for the owner to triage while the server shows it approved.
  // `cliView` also runs `sync` and asserts exactly one person's ✓ locks: this is the one test that
  // catches an admin's ✓ locking too, so its name says both things it proves, not only the first.
  const variables = { owner: OWNER, admins: ADMIN };
  const p = await project(t, {}, variables);
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
  // The edit the agent applying a request could make to stop being one: refused like the rest.
  { name: 'agents named in holdrim.json', variables: { owner: OWNER }, file: { agents: [] } },
  // #29's rework: a project's own roles and grants refuse exactly like the three above — they are
  // events from the settings screen, by the owner, never a key in the file (docs/ROLES.md,
  // "Authority comes from the deployment only").
  { name: 'a project role named only in holdrim.json', variables: { owner: OWNER },
    file: { roles: { 'clinical-lead': ['triage'] } } },
  { name: 'a grant named only in holdrim.json', variables: { owner: OWNER },
    file: { grants: { [OTHER]: [{ role: 'clinical-lead' }] } } },
];

for (const c of fileRefusals) {
  test(`the CLI and the server both refuse: ${c.name}`, async (t) => {
    const p = await project(t, c.file);
    const [key] = Object.keys(c.file);
    const home = new RegExp(HOME_OF[key]);
    const server = serverView(p, c.variables);
    assert.match(server.refused ?? `booted with ${server.owner}`, AUTHORITY, 'the server');
    assert.match(server.refused, new RegExp(`names "${key}"`), 'and names the key');
    assert.match(server.refused, home, 'and says where it actually lives');
    const cliAnswer = cliView(p, c.variables);
    assert.match(cliAnswer.refused ?? `ran with ${cliAnswer.owner}`, AUTHORITY, 'the CLI, list');
    assert.match(cliAnswer.syncRefused, AUTHORITY, 'the CLI, sync');
    assert.equal(readFileSync(join(p.dir, 'approvals.json'), 'utf8').trim(), '{}', 'and sync locked nothing');
    otherCommandsRefuse(p, environment(c.variables), AUTHORITY);
  });
}

/**
 * A grant that names an agent (docs/ROLES.md, section 4): the service and every CLI command refuse to
 * start, from `rolesOf`, the one resolution both share. Each variable is its own case, since each is
 * its own branch of `refuseGrantsToAgents` (engine/core/roles.js).
 */
const agentGrants = [
  { name: 'HOLDRIM_OWNER', variables: { owner: OTHER, agents: OTHER } },
  { name: 'HOLDRIM_ADMINS', variables: { owner: OWNER, admins: OTHER, agents: OTHER } },
  { name: 'HOLDRIM_LOCKS', variables: { owner: OWNER, locks: `${OTHER}:A01`, agents: OTHER } },
];

for (const c of agentGrants) {
  test(`the CLI and the server both refuse: ${c.name} naming an agent`, async (t) => {
    const p = await project(t);
    const needs = new RegExp(`${c.name} names ${OTHER}, which HOLDRIM_AGENTS marks as an agent`);
    const server = serverView(p, c.variables);
    assert.match(server.refused ?? `booted with ${server.owner}`, needs, 'the server');
    const cliAnswer = cliView(p, c.variables);
    assert.match(cliAnswer.refused ?? `ran with ${cliAnswer.owner}`, needs, 'the CLI, list');
    assert.match(cliAnswer.syncRefused, needs, 'the CLI, sync');
    assert.equal(readFileSync(join(p.dir, 'approvals.json'), 'utf8').trim(), '{}', 'and sync locked nothing');
    otherCommandsRefuse(p, environment(c.variables), needs);
  });
}

test('an agent granted nothing runs like anyone else, on both sides', async (t) => {
  // The refusal above is about a grant, not about HOLDRIM_AGENTS being set at all.
  const variables = { owner: OWNER, agents: OTHER };
  const p = await project(t, {}, variables);
  const expected = { owner: OWNER, states: { [OWNER]: ADMIN_START, [OTHER]: STRANGER_START, [ADMIN]: STRANGER_START } };
  assert.deepEqual(serverView(p, variables), expected, 'the server');
  assert.deepEqual(cliView(p, variables), expected, 'the CLI');
});

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
    otherCommandsRefuse(p, environment(c.variables), needs);
  });
}
