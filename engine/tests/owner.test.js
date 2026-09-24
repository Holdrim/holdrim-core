/**
 * The CLI and the server agree on who the owner is.
 *
 * The owner decides whose ✓ becomes a lock, and whose request needs no triage. The server reads it
 * from HOLDRIM_OWNER or, when the variable is not set, from `owner` in holdrim.json; a CLI that read
 * only the variable would, in a project that names its owner in the file, lock nothing the owner
 * approved and treat the owner's own requests as a stranger's — with no error, just an empty sync.
 *
 * The server side is the two calls server.ts makes at boot, `ofProject` then `rolesOf`, in this
 * process. The CLI side is the real binary, spawned with the same environment against the same
 * project, and asked the two questions the owner answers: `list` (does the owner's own request skip
 * triage?) and `sync` (does the owner's ✓ lock?). Every case runs both, and both must answer alike.
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

const ROOT = new URL('../../', import.meta.url).pathname;
const CLI = join(ROOT, 'engine', 'cli', 'holdrim.ts');
const EXAMPLE = join(ROOT, 'examples', 'hello-world');

const FROM_VARIABLE = 'variable@example.org';
const FROM_FILE = 'file@example.org';
/** Each candidate asks about, and approves, a block of their own, so a lock says whose ✓ it was. */
const BLOCK_OF = { [FROM_VARIABLE]: 'A01.1.1', [FROM_FILE]: 'A01.1.2' };

/**
 * A copy of the hello world whose holdrim.json names `owner` (or no owner, when undefined), and an
 * events file holding, for each candidate, one request they made and one ✓ they gave.
 */
async function project(t, owner) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-owner-'));
  cpSync(EXAMPLE, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(dir, 'holdrim.json'), 'utf8'));
  delete config.owner;
  if (owner !== undefined) config.owner = owner;
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify(config));

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
  await store.close();
  return { dir, db, ids };
}

/** The environment with HOLDRIM_OWNER exactly as the case says: set to `value`, or absent. */
function environment(value) {
  const env = { ...process.env };
  delete env.HOLDRIM_OWNER;
  if (value !== undefined) env.HOLDRIM_OWNER = value;
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

/** What the server would boot with: server.ts's own two calls, under the case's environment. */
function serverOwner(dir, variable) {
  const before = process.env.HOLDRIM_OWNER;
  delete process.env.HOLDRIM_OWNER;
  if (variable !== undefined) process.env.HOLDRIM_OWNER = variable;
  try {
    return { owner: rolesOf(ofProject(dir)).owner };
  } catch (e) {
    return { refused: e.message };
  } finally {
    if (before === undefined) delete process.env.HOLDRIM_OWNER; else process.env.HOLDRIM_OWNER = before;
  }
}

/**
 * Who the CLI takes for the owner, read off what it does: the only request that skips triage is
 * the owner's, and the only ✓ that locks is the owner's. Both have to name the same person, or the
 * CLI itself holds two answers.
 */
function cliOwner({ dir, db, ids }, variable) {
  const env = environment(variable);
  const list = cli(['list', '--all', '--json', '--db', db], dir, env);
  const sync = cli(['sync', '--db', db], dir, env);
  if (list.code !== 0 || sync.code !== 0) {
    assert.notEqual(list.code, 0, `list ran while sync refused:\n${list.out}`);
    assert.notEqual(sync.code, 0, `sync ran while list refused:\n${sync.out}`);
    return { refused: list.out, syncRefused: sync.out };
  }
  const states = Object.fromEntries(JSON.parse(list.out).requests.map((r) => [r.id, r.state]));
  const approvedBy = Object.keys(ids).filter((who) => states[ids[who]] === 'approved');
  const registry = JSON.parse(readFileSync(join(dir, 'approvals.json'), 'utf8'));
  const lockedBy = Object.keys(ids).filter((who) => registry[BLOCK_OF[who]]);
  assert.deepEqual(approvedBy, lockedBy, 'list and sync disagree about the owner inside the CLI');
  assert.equal(approvedBy.length, 1, `exactly one person is the owner, got: ${approvedBy.join(', ') || 'nobody'}`);
  return { owner: approvedBy[0] };
}

const cases = [
  { name: 'the variable only', variable: FROM_VARIABLE, file: undefined, owner: FROM_VARIABLE },
  { name: 'holdrim.json only', variable: undefined, file: FROM_FILE, owner: FROM_FILE },
  // The server's precedence, kept: one repository serves more than one deployment, and the
  // deployment's variable is what says who owns THIS one.
  { name: 'both, and the variable wins', variable: FROM_VARIABLE, file: FROM_FILE, owner: FROM_VARIABLE },
];

for (const c of cases) {
  test(`the CLI and the server name the same owner: ${c.name}`, async (t) => {
    const p = await project(t, c.file);
    const server = serverOwner(p.dir, c.variable);
    assert.deepEqual(server, { owner: c.owner }, 'the server');
    assert.deepEqual(cliOwner(p, c.variable), { owner: c.owner }, 'the CLI');
  });
}

const refusals = [
  { name: 'no owner anywhere', variable: undefined, file: undefined, got: 0 },
  { name: 'two owners in the variable', variable: `${FROM_VARIABLE},${FROM_FILE}`, file: undefined, got: 2 },
  { name: 'two owners in holdrim.json', variable: undefined, file: `${FROM_VARIABLE},${FROM_FILE}`, got: 2 },
];

for (const c of refusals) {
  test(`the CLI and the server both refuse: ${c.name}`, async (t) => {
    const p = await project(t, c.file);
    const needs = new RegExp(`exactly one e-mail \\(got ${c.got}\\)`);
    const server = serverOwner(p.dir, c.variable);
    assert.match(server.refused ?? `booted with ${server.owner}`, needs, 'the server');
    const cliAnswer = cliOwner(p, c.variable);
    assert.match(cliAnswer.refused ?? `ran with ${cliAnswer.owner}`, needs, 'the CLI, list');
    assert.match(cliAnswer.syncRefused, needs, 'the CLI, sync');
  });
}
