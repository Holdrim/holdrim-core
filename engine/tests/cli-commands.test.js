/**
 * The real CLI, end to end, against a throwaway copy of the hello world.
 *
 * Unit tests import the functions; this runs `engine/cli/holdrim.ts` the way a person or a hook
 * does, and reads what comes out. It is what catches a command that fell out of the switch, a
 * usage line that names the wrong tool, or an option parseArgs stopped accepting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteEventStore, GUARDS } from '../api/store-sqlite.ts';
import { TEXT_REMOVED } from '../api/texts.ts';
import { readBlocks } from '../cli/pages.ts';
import { outside } from './helpers/sqlite.js';
import { stub } from './helpers/stub.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const CLI = join(ROOT, 'engine', 'cli', 'holdrim.ts');

/**
 * Runs the CLI and returns what the user would see plus the exit code. The owner is set the way a
 * deployment sets it, in HOLDRIM_OWNER: holdrim.json cannot name one. Set here rather than inherited,
 * so an owner exported in the shell running the suite does not decide whose triage counts.
 */
function run(args, cwd, env = {}) {
  const r = runApart(args, cwd, env);
  return { out: r.code === 0 ? r.stdout : r.stdout + r.stderr, code: r.code };
}

/**
 * `run`, with stdout and stderr kept apart — for a command that warns and still exits 0, whose
 * warning `run` would not show, and for `list --json`, whose stdout has to parse as JSON on its own.
 */
function runApart(args, cwd, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOLDRIM_OWNER: 'you@example.org', HOLDRIM_ADMINS: '', ...env } });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

/** A disposable copy of the hello world, so a command that writes cannot dirty the repository. */
function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-cli-'));
  cpSync(join(ROOT, 'examples', 'hello-world'), dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('--help and -h print the help, and it names the tool', (t) => {
  const dir = project(t);
  const help = run(['--help'], dir);
  assert.equal(help.code, 0);
  assert.equal(run(['-h'], dir).out, help.out);
  assert.equal(run([], dir).out, help.out, 'no command at all is a request for help');
  assert.match(help.out, /^holdrim — the agent's tool/);
  assert.match(help.out, /^\s*apply <id> \[--agent x\]/m);
});

test('a command nobody wrote is rejected by name', (t) => {
  const r = run(['listar'], project(t));
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown command: listar/);
});

test('a --root that is not a folder is an error, not an empty documentation', (t) => {
  const dir = project(t);
  for (const root of [join(dir, 'no-such-folder'), join(dir, 'holdrim.json')]) {
    for (const command of ['lights', 'check']) {
      const r = run([command, '--root', root], ROOT);
      assert.equal(r.code, 2, `${command} --root ${root}`);
      assert.match(r.out, /no such folder: /);
    }
  }
  assert.equal(run(['lights', '--root', dir], ROOT).code, 0, 'and a real one still works');
});

test('a filter that does not exist is refused, not ignored', (t) => {
  const r = run(['lights', '--only', 'purple'], project(t));
  assert.equal(r.code, 2);
  assert.match(r.out, /--only takes one value, red; got: purple/);
  assert.equal(run(['lights', '--only', 'red'], project(t)).code, 0);
});

test('a local server that is not there is named, with what to do', (t) => {
  // Port 9 has nothing listening: the error has to say where it looked, not just "fetch failed".
  const r = run(['list', '--local'], project(t), { HOLDRIM_LOCAL_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing answered at http:\/\/127\.0\.0\.1:9\. Is the server running\?/);
});

test('a command that needs an argument says so, naming this tool', (t) => {
  const dir = project(t);
  for (const command of ['show', 'impact', 'state', 'if-i-touch', 'apply', 'export']) {
    const r = run([command], dir);
    assert.equal(r.code, 2, `${command} without an argument`);
    assert.match(r.out, new RegExp(`missing argument. Usage: holdrim ${command} `));
  }
});

test('export says how many pages and other files it wrote, and where', (t) => {
  const dir = project(t);
  const out = join(dir, 'public');
  const r = run(['export', out, '--root', dir], ROOT);
  assert.equal(r.code, 0, r.out);
  const pages = readdirSync(join(out, 'pages')).length;
  const others = readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith('.html')).length;
  assert.ok(pages > 0 && others > 0, 'the hello world has both');
  assert.match(r.out, new RegExp(`✓ ${pages} page\\(s\\) and ${others} other file\\(s\\) in ${out}`));
});

test('check and lights read the project they are pointed at, from anywhere', (t) => {
  const dir = project(t);
  const check = run(['check', '--root', dir], ROOT);
  assert.equal(check.code, 0);
  assert.match(check.out, /0 validated · all intact/);

  const lights = run(['lights', '--root', dir], ROOT);
  assert.equal(lights.code, 0);
  assert.match(lights.out, /Documentation: 8 block\(s\)/, 'it really read the project it was pointed at');
  assert.match(lights.out, /⚪\s+8\s+nobody has validated it yet/);
});

test('kinds lists the catalogue', (t) => {
  const r = run(['kinds'], project(t));
  assert.equal(r.code, 0);
  assert.match(r.out, /^\s+rule\s+domain rule/m);
});

test('if-i-touch answers for a block, and refuses one that is not there', (t) => {
  const dir = project(t);
  assert.match(run(['if-i-touch', 'A01.1.1'], dir).out, /nothing declares a dependency on this block/);
  const missing = run(['if-i-touch', 'Z99.9.9'], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /no such block: Z99\.9\.9/);
});

test('graph refuses to guess a format, and refuses two at once', (t) => {
  const dir = project(t);
  const none = run(['graph'], dir);
  assert.equal(none.code, 2);
  assert.match(none.out, /graph needs exactly one of --json, --mermaid, --dot; got none/);

  const both = run(['graph', '--json', '--dot'], dir);
  assert.equal(both.code, 2);
  assert.match(both.out, /got json, dot/);
});

test('features.graph OFF refuses the command; on, or unset, it runs — the "graph" toggle', (t) => {
  const dir = project(t);
  // On by default: a project with no "features" block at all sees today's behaviour, unchanged.
  assert.equal(run(['graph', '--json'], dir).code, 0);

  const configPath = join(dir, 'holdrim.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, features: { graph: false } }));
  const off = run(['graph', '--json'], dir);
  assert.equal(off.code, 2, 'a turned-off command is a config refusal, like a bad --root or --only');
  assert.match(off.out, /graph is turned off/);
  assert.doesNotMatch(off.out, /"nodes"|"edges"/, 'no graph JSON leaks out when the command refuses to run at all');

  writeFileSync(configPath, JSON.stringify({ ...config, features: { graph: true } }));
  assert.equal(run(['graph', '--json'], dir).code, 0,
    'set explicitly to true, it runs exactly as it did with no toggle at all');
});

test('graph prints the SAME dependencies and states `lights` and `if-i-touch` read', () => {
  // cash-register has real data-depends edges and a mix of validated and broken blocks — hello
  // world alone would only prove the command runs, not that it reads the graph correctly.
  const cashRegister = join(ROOT, 'examples', 'cash-register');

  const json = JSON.parse(run(['graph', '--root', cashRegister, '--json'], ROOT).out);
  const edge = json.edges.find((e) => e.from === 'R02.2.2' && e.to === 'R02.2.1');
  assert.ok(edge, 'the edge data-depends="R02.2.1" on R02.2.2 is in the graph');
  const node = json.nodes.find((n) => n.id === 'R02.2.2');
  assert.ok(node && ['valid', 'stale', 'broken', 'none', 'missing'].includes(node.state));
  assert.ok(json.edges.length > 0);

  // Mermaid never uses the real id as ITS id (engine/cli/graph.ts), so the edge is found by tracing
  // the synthetic ids the two labels were given, not by grepping for the block ids themselves.
  const mermaid = run(['graph', '--root', cashRegister, '--mermaid'], ROOT).out;
  assert.match(mermaid, /^flowchart TD/);
  const from = mermaid.match(/(n\d+)\["[^"]*R02\.2\.2"\]/)?.[1];
  const to = mermaid.match(/(n\d+)\["[^"]*R02\.2\.1"\]/)?.[1];
  assert.ok(from && to, 'both ends of the edge got a labelled node');
  assert.match(mermaid, new RegExp(`${from} --> ${to}`));

  const dot = run(['graph', '--root', cashRegister, '--dot'], ROOT).out;
  assert.match(dot, /^digraph holdrim \{/);
  assert.match(dot, /"R02\.2\.2" -> "R02\.2\.1";/);
});

test('graph is byte-identical across two runs of the same project', () => {
  const cashRegister = join(ROOT, 'examples', 'cash-register');
  const a = run(['graph', '--root', cashRegister, '--mermaid'], ROOT).out;
  const b = run(['graph', '--root', cashRegister, '--mermaid'], ROOT).out;
  assert.equal(a, b);
});

test('list, show, impact, summary and apply --dry-run read the events file with no cloud', async (t) => {
  const dir = project(t);
  const blocks = await readBlocks(dir);
  const block = blocks.get('A01.1.2');
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  const request = await store.append({ type: 'request', page: 'A01', block: 'A01.1.2', fingerprint: block.fingerprint,
    text: 'say header, not menu', snapshot: block.text, data: { category: 'term' } }, 'reviewer@example.org');
  await store.append({ type: 'request_state', page: 'A01', block: 'A01.1.2', text: 'yes',
    data: { request: request.id, state: 'approved', from: 'open' } }, 'you@example.org');
  await store.append({ type: 'request', page: 'A02', block: 'A02.1.1', fingerprint: 'x',
    text: 'still open', snapshot: null, data: null }, 'reviewer@example.org');
  await store.close();

  // The owner comes from HOLDRIM_OWNER (you@example.org, set by `run`), so their triage counts.
  const list = run(['list', '--db', db], dir);
  assert.equal(list.code, 0);
  assert.match(list.out, new RegExp(`${request.id.slice(0, 8)}\\s+Approved\\s+A01\\.1\\.2`));
  assert.doesNotMatch(list.out, /still open/, 'an open request is not the agent\'s yet');

  const json = JSON.parse(run(['list', '--db', db, '--json'], dir).out);
  assert.equal(json.toTriage, 1);
  assert.equal(json.requests.length, 1);
  assert.equal(json.requests[0].state, 'approved');
  assert.equal(json.requests[0].file, 'A01.html');
  assert.equal(json.requests[0].textNow, block.text);
  assert.equal(json.requests[0].blockChanged, false);

  const show = run(['show', request.id.slice(0, 6), '--db', db], dir);
  assert.match(show.out, /State\s+Approved/);
  assert.match(show.out, /Asked for:\n\s+say header, not menu/);

  assert.match(run(['impact', request.id.slice(0, 6), '--db', db, '--term', 'header'], dir).out,
    /"header" shows up in \d+ block\(s\)/);
  assert.match(run(['summary', '--db', db], dir).out, /A01\s+0 approval\(s\) · 1 request\(s\) · 0 open/);

  const dry = run(['apply', request.id.slice(0, 6), '--db', db, '--dry-run'], dir);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /# Holdrim request/);
  assert.match(dry.out, /Request: /);
  assert.doesNotMatch(dry.out, /Requested-by/);
});

// ===================================================================== issue #91, round 1: exit codes
// Round 1 of the #91 review, items 6 and 7: nothing had run `main()` itself against a tampered store —
// every proof so far called `requests.list`/`validation.sync` directly, never through the `? 1 : 0`
// in holdrim.ts's own switch, which a mutant there could break unseen. Spawning the real CLI is the
// only proof that sees that line.
async function tamperedDb(dir) {
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  const kept = await store.append({ type: 'comment', page: 'A01', text: 'redact me' }, 'r@example.org');
  await store.removeText(kept.id, 'text', 'owner@example.org');
  // A duplicate, forged removal — `removeText` itself can never produce a second one — reads as
  // tampered without needing to touch the file directly (round 3, finding 6 in engine/api/texts.ts).
  await store.append({ type: TEXT_REMOVED, page: 'A01', data: { event: kept.id, field: 'text' } }, 'forger@example.org');
  await store.close();
  return db;
}

/**
 * The same forgery as `tamperedDb`, but on a `request` the owner already approved — so it sits in
 * `holdrim list`'s default TABLE, not only in `--all` or `--json`. Round 1 of the #91 review, item
 * 7: `list()`'s final `return q.tampered`, after the loop that prints the table, had nothing proving
 * it — `tamperedDb`'s own event is a plain `comment`, never shown at all, so every proof so far of
 * "list exits non-zero" happened to take the EARLIER, "no requests" return instead.
 */
async function tamperedApprovedRequest(dir) {
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  const request = await store.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'x',
    text: 'redact me', data: { category: 'text' } }, 'reviewer@example.org');
  await store.append({ type: 'request_state', page: 'A01', block: 'A01.1.1',
    text: 'yes', data: { request: request.id, state: 'approved', from: 'open' } }, 'you@example.org');
  await store.removeText(request.id, 'text', 'owner@example.org');
  await store.append({ type: TEXT_REMOVED, page: 'A01', data: { event: request.id, field: 'text' } }, 'forger@example.org');
  await store.close();
  return db;
}

test('list exits non-zero and prints the warning for a tampered field on a request the TABLE actually shows',
  async (t) => {
    const dir = project(t);
    const db = await tamperedApprovedRequest(dir);
    const r = run(['list', '--db', db], dir); // no --all: this request has to be approved to show at all
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Approved/, 'the request itself did print');
    assert.match(r.out, /CRITICAL/);
  });

test('list exits non-zero and prints the warning when a field reads as tampered, on the "no requests" path',
  async (t) => {
    const dir = project(t);
    const db = await tamperedDb(dir);
    const r = run(['list', '--all', '--db', db], dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no requests/, 'the plain comment above is not a request: this is the OTHER early return');
    assert.match(r.out, /CRITICAL/);
  });

test('list --json exits non-zero and carries `tampered: true`, even where the table would print nothing',
  async (t) => {
    const dir = project(t);
    const db = await tamperedDb(dir);
    // No request in this store at all: the JSON path is reached with an EMPTY `requests`, so this
    // also proves `tampered` does not depend on there being a row to show it next to.
    const r = run(['list', '--db', db, '--json'], dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /"tampered": true/);
    assert.match(r.out, /CRITICAL/);
  });

test('list exits 0 and carries `tampered: false` when nothing is tampered, on both paths', async (t) => {
  const dir = project(t);
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  await store.append({ type: 'comment', page: 'A01', text: 'an ordinary remark' }, 'r@example.org');
  await store.close();
  const table = run(['list', '--all', '--db', db], dir);
  assert.equal(table.code, 0, table.out);
  assert.doesNotMatch(table.out, /CRITICAL/);
  const json = run(['list', '--db', db, '--json'], dir);
  assert.equal(json.code, 0, json.out);
  assert.match(json.out, /"tampered": false/);
});

test('sync exits non-zero and prints the warning when a field reads as tampered', async (t) => {
  const dir = project(t);
  const db = await tamperedDb(dir);
  const r = run(['sync', '--db', db], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /CRITICAL/);
});

// ===================================================================== holdrim#135: a refused ✓ fails the run
// A ✓ the CLI could not stamp safely leaves the registry without it, and a later rewrite of that text
// passes `check`. Only the exit code makes the refusal reach a CI run that does not read the log, and
// only spawning the CLI proves the `? 1 : 0` in holdrim.ts's switch.

/** The hello world's A01.1.1, carried a second time by a hidden copy placed before it. */
function duplicateA0111(dir) {
  const page = join(dir, 'pages', 'A01.html');
  const html = readFileSync(page, 'utf8');
  const tag = '<p class="lead" data-id="A01.1.1" data-code="1.1">';
  assert.ok(html.includes(tag), 'the hello world still opens A01.1.1 this way');
  writeFileSync(page, html.replace(tag, '<p data-id="A01.1.1" hidden>copy</p>' + tag));
}

/** An events file holding the owner's ✓ on A01.1.1's current text, after the store's baseline. */
async function approvedA0111(dir) {
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  await store.append({ type: 'lock_baseline', page: '_lock_baseline', data: null }, 'you@example.org');
  // `append` stamps its own time: without a gap, the ✓ could share the baseline's millisecond and
  // read as predating it, which is a different rule (`legacyLock`) than the one this is about.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fingerprint = (await readBlocks(dir)).get('A01.1.1').fingerprint;
  await store.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint, data: { locks: 'true' } },
    'you@example.org');
  await store.close();
  return db;
}

test('sync exits 0 when the ✓ it brings in is stamped, and non-zero when it has to refuse one', async (t) => {
  const clean = project(t);
  const ok = run(['sync', '--db', await approvedA0111(clean)], clean);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /1 new · 0 already there · 0 ✓ expired · 0 refused/);

  const dir = project(t);
  duplicateA0111(dir);
  const r = runApart(['sync', '--db', await approvedA0111(dir)], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ A01\.1\.1: 2 blocks carry this id; nothing written/);
  assert.match(r.stdout, /0 new · 0 already there · 0 ✓ expired · 1 refused/);
});

test('restamp exits 0 when every entry is stamped, and non-zero when it has to refuse one', async (t) => {
  const registry = JSON.stringify({ 'A01.1.1': { file: 'A01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } });
  const clean = project(t);
  writeFileSync(join(clean, 'approvals.json'), registry);
  const ok = run(['restamp'], clean);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /1 block\(s\) got the mark they were missing/);

  const dir = project(t);
  writeFileSync(join(dir, 'approvals.json'), registry);
  duplicateA0111(dir);
  const r = runApart(['restamp'], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ A01\.1\.1: 2 blocks carry this id; nothing written/);
  assert.match(r.stdout, /⚠ 1 entries could not be stamped safely/);
});

// ===================================================================== issue #108: the guards, through --db
// `Source#fromFile` opens the file read-only and never compared its triggers with GUARDS: only the
// server's next boot did. So for the CLI, dropping a guard was enough — nobody had to put it back
// for a row forged in the meantime to read in silence. Every guard in GUARDS is dropped in turn, and
// changed in turn, so a guard added later is covered by these without anyone writing a test for it.

/** A file the store made — every guard in place — holding one approved request, and its id. */
async function guardedDb(dir) {
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  const request = await store.append({ type: 'request', page: 'A01', block: 'A01.1.2', fingerprint: 'x',
    text: 'say header, not menu', data: { category: 'term' } }, 'reviewer@example.org');
  await store.append({ type: 'request_state', page: 'A01', block: 'A01.1.2', text: 'yes',
    data: { request: request.id, state: 'approved', from: 'open' } }, 'you@example.org');
  await store.close();
  return { db, id: request.id };
}

const triggerNames = (path) => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((r) => r.name).sort(); }
  finally { db.close(); }
};

/** The structured lines on stderr, `time` left out: it is the only field no test can know. */
const guardLines = (stderr) => stderr.split('\n')
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((l) => l?.event === 'sqlite_guard_missing')
  .map((l) => { const rest = { ...l }; delete rest.time; return rest; });

/**
 * What every mismatch has to come out as: `list --json` still parses — every warning went to
 * stderr — with `guardsTampered` set and `tampered` not, since no text was touched; a non-zero exit;
 * the server's own words for it, and one structured line naming it, and nothing else named. The
 * file is left exactly as found: this reader warns, it never repairs.
 */
function assertNamed(db, dir, name, kind, words) {
  const before = triggerNames(db);
  const r = runApart(['list', '--db', db, '--json'], dir);
  assert.equal(r.code, 1, r.stderr);
  const q = JSON.parse(r.stdout);
  assert.equal(q.guardsTampered, true);
  assert.equal(q.tampered, false, 'no text was touched: the two flags say different things');
  assert.equal(q.requests.length, 1, 'the file is still read: this warns, it does not refuse');
  assert.match(r.stderr, words);
  assert.deepEqual(guardLines(r.stderr), [{ severity: 'WARNING', event: 'sqlite_guard_missing', guard: name, kind }]);
  assert.deepEqual(triggerNames(db), before, 'nothing repaired: the file is opened read-only');
}

for (const name of Object.keys(GUARDS)) {
  test(`list --db exits non-zero and names ${name} when it is dropped`, async (t) => {
    const dir = project(t);
    const { db } = await guardedDb(dir);
    outside(db, `DROP TRIGGER ${name}`);
    assertNamed(db, dir, name, 'missing', new RegExp(`the database's guard "${name}" is missing; read as it is, nothing repaired`));
  });

  test(`list --db exits non-zero and names ${name} when it is changed, not dropped`, async (t) => {
    const dir = project(t);
    const { db } = await guardedDb(dir);
    // Same name, same table, same moment — and it lets the write through in silence instead of
    // refusing it: the swap `CREATE TRIGGER IF NOT EXISTS` alone would never see.
    const neutered = GUARDS[name].replace(/RAISE\(ABORT, '[^']*'\)/, 'RAISE(IGNORE)');
    assert.notEqual(neutered, GUARDS[name], 'the substitute has to differ from the guard for this to prove anything');
    outside(db, `DROP TRIGGER ${name}; CREATE TRIGGER ${name} ${neutered}`);
    assertNamed(db, dir, name, 'changed',
      new RegExp(`the database's guard "${name}" was not the one this version installs; read as it is, nothing repaired`));
  });
}

test('list --db exits non-zero and names a trigger that is not a guard at all', async (t) => {
  const dir = project(t);
  const { db } = await guardedDb(dir);
  // Every guard intact, and still no ✓ would ever land.
  outside(db, "CREATE TRIGGER x_ignore BEFORE INSERT ON events WHEN NEW.type = 'approval' BEGIN SELECT RAISE(IGNORE); END");
  assertNamed(db, dir, 'x_ignore', 'foreign', /the database holds a trigger this version does not install, "x_ignore"/);
});

test('list --db with every guard in place: guardsTampered false, exit 0, and nothing said about a guard', async (t) => {
  const dir = project(t);
  const { db } = await guardedDb(dir);
  const r = runApart(['list', '--db', db, '--json'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).guardsTampered, false);
  assert.doesNotMatch(r.stderr, /guard|trigger/);
});

test('sync --db exits non-zero and names a dropped guard', async (t) => {
  const dir = project(t);
  const { db } = await guardedDb(dir);
  outside(db, 'DROP TRIGGER events_no_delete');
  const r = runApart(['sync', '--db', db], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the database's guard "events_no_delete" is missing/);
});

test('show, impact and summary --db name a dropped guard and keep their exit code', async (t) => {
  const dir = project(t);
  const { db, id } = await guardedDb(dir);
  outside(db, 'DROP TRIGGER events_no_delete');
  for (const args of [['show', id.slice(0, 6)], ['impact', id.slice(0, 6), '--term', 'header'], ['summary']]) {
    const r = runApart([...args, '--db', db], dir);
    assert.equal(r.code, 0, `${args[0]}: ${r.stderr}`);
    assert.match(r.stderr, /the database's guard "events_no_delete" is missing/, args[0]);
    assert.deepEqual(guardLines(r.stderr),
      [{ severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'events_no_delete', kind: 'missing' }], args[0]);
  }
});

test('the locks lens\'s reproduction: a request forged below every hashed row, events_no_low_rowid dropped, is no longer read in silence',
  async (t) => {
    const dir = project(t);
    const db = join(dir, 'events.db');
    const store = new SqliteEventStore(db);
    await store.append({ type: 'comment', page: 'A01', text: 'a real, hashed remark' }, 'r@example.org');
    await store.close();
    // Negative rowids, no hash, the text inline: below `extractionBoundary`, so it reads as a row
    // from before texts were extracted, and nothing about the text itself can say otherwise.
    outside(db, `DROP TRIGGER events_no_low_rowid;
      INSERT INTO events (rowid, id, type, page, block, fingerprint, text, author, happened_at, data) VALUES
        (-7, 'forged', 'request', 'A01', 'A01.1.1', 'x', 'forged inline text', 'reviewer@example.org',
         '2026-01-01T00:00:00.000Z', '{"category":"text"}');
      INSERT INTO events (rowid, id, type, page, block, fingerprint, text, author, happened_at, data) VALUES
        (-6, 'forged-ok', 'request_state', 'A01', 'A01.1.1', NULL, 'yes', 'you@example.org',
         '2026-01-01T00:00:01.000Z', '{"request":"forged","state":"approved","from":"open"}');`);
    const r = runApart(['list', '--db', db, '--json'], dir);
    const q = JSON.parse(r.stdout);
    assert.deepEqual(q.requests.map((x) => [x.id, x.state]), [['forged', 'approved']],
      'the forgery still reads as approved: the text check alone cannot see it');
    assert.equal(q.tampered, false);
    assert.equal(q.guardsTampered, true, 'the dropped guard is what gives it away');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the database's guard "events_no_low_rowid" is missing/);
  });

test('plain list --db (the table) exits non-zero on a dropped guard, with approved requests to show', async (t) => {
  const dir = project(t);
  const { db, id } = await guardedDb(dir);
  outside(db, 'DROP TRIGGER events_no_delete');
  const r = runApart(['list', '--db', db], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`${id.slice(0, 8)}\\s+Approved`), 'the table itself did print: this is its return');
  assert.match(r.stderr, /the database's guard "events_no_delete" is missing/);
});

test('plain list --db exits non-zero on a dropped guard with nothing in the queue, on the "no requests" path', async (t) => {
  const dir = project(t);
  const db = join(dir, 'events.db');
  const store = new SqliteEventStore(db);
  await store.append({ type: 'comment', page: 'A01', text: 'an ordinary remark' }, 'r@example.org');
  await store.close();
  outside(db, 'DROP TRIGGER events_no_delete');
  const r = runApart(['list', '--db', db], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no requests approved/, 'the early return, not the table');
  assert.match(r.stderr, /the database's guard "events_no_delete" is missing/);
});

test('list --db names every mismatch at once — foreign, missing and changed — in guardMismatches order', async (t) => {
  const dir = project(t);
  const { db } = await guardedDb(dir);
  // A foreign trigger first in the output must not be the only one said: the missing guard behind
  // it is the one that lets a forged row in below every hashed one.
  outside(db, `CREATE TRIGGER x_ignore BEFORE INSERT ON events WHEN NEW.type = 'approval' BEGIN SELECT RAISE(IGNORE); END;
    DROP TRIGGER events_no_low_rowid;
    DROP TRIGGER texts_no_update; CREATE TRIGGER texts_no_update BEFORE UPDATE ON texts BEGIN SELECT 1; END;`);
  const r = runApart(['list', '--db', db, '--json'], dir);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).guardsTampered, true);
  assert.deepEqual(guardLines(r.stderr), [
    { severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'x_ignore', kind: 'foreign' },
    { severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'events_no_low_rowid', kind: 'missing' },
    { severity: 'WARNING', event: 'sqlite_guard_missing', guard: 'texts_no_update', kind: 'changed' },
  ]);
  assert.match(r.stderr, /the database holds a trigger this version does not install, "x_ignore"; read as it is/);
  assert.match(r.stderr, /the database's guard "events_no_low_rowid" is missing; read as it is/);
  assert.match(r.stderr, /the database's guard "texts_no_update" was not the one this version installs; read as it is/);
});

test('a foreign trigger\'s name reaches the terminal escaped, never as a raw control character', async (t) => {
  const dir = project(t);
  const { db, id } = await guardedDb(dir);
  // ESC [2K ESC [1A: erase the line and move up — enough to wipe the warning it sits in off the
  // screen of `show`, which exits 0 and has nothing else to say that anything is wrong.
  const name = 'x\x1b[2K\x1b[1A';
  outside(db, `CREATE TRIGGER "${name}" BEFORE INSERT ON events BEGIN SELECT 1; END`);
  const r = runApart(['show', id.slice(0, 6), '--db', db], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stderr.includes('\x1b'), 'no raw ESC byte on stderr');
  assert.ok(r.stderr.includes('"x\\u001b[2K\\u001b[1A"'), 'the name, quoted, with the escapes spelled out');
  assert.deepEqual(guardLines(r.stderr).map((l) => [l.guard, l.kind]), [[name, 'foreign']],
    'and the structured line still carries the name itself, for a program to read');
});

// ------------------------------------------------ acting refuses where reading warns
// `apply` and `state` act on the queue. With `events_no_update` dropped, a rejection can be rewritten
// into an approval in `data`, which no text hash covers: reading such a file warns, acting on it
// would hand a request the owner refused to an agent. So these two refuse, before anything happens.
const REFUSED = /refusing to act on this events file: its guards are not the ones this version installs/;

test('apply --dry-run --db refuses on a dropped guard, and prints no brief', async (t) => {
  const dir = project(t);
  const { db, id } = await guardedDb(dir);
  outside(db, 'DROP TRIGGER events_no_update');
  const r = runApart(['apply', id.slice(0, 6), '--db', db, '--dry-run'], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, REFUSED);
  assert.doesNotMatch(r.stdout, /# Holdrim request/, 'no brief written anywhere');
});

test('apply --db refuses on a dropped guard, and never starts the agent', async (t) => {
  const dir = project(t);
  const { db, id } = await guardedDb(dir);
  const bin = mkdtempSync(join(tmpdir(), 'holdrim-agent-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  stub(bin, 'agent', 'touch "$(dirname "$0")/started"');
  const started = join(bin, 'started');
  // The stub is proved to run first, on the intact file: otherwise "not started" below could only
  // mean the stub never works.
  const intact = runApart(['apply', id.slice(0, 6), '--db', db, '--agent', join(bin, 'agent')], dir);
  assert.equal(intact.code, 0, intact.stderr);
  assert.ok(existsSync(started), 'on an intact file, the agent is started');
  rmSync(started);
  outside(db, 'DROP TRIGGER events_no_update');
  const r = runApart(['apply', id.slice(0, 6), '--db', db, '--agent', join(bin, 'agent')], dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stderr, REFUSED);
  assert.equal(existsSync(started), false, 'the agent was never started');
});

test('state --db refuses on a dropped guard, before anything is recorded', async (t) => {
  const dir = project(t);
  const { db, id } = await guardedDb(dir);
  outside(db, 'DROP TRIGGER events_no_update');
  const r = runApart(['state', id.slice(0, 6), 'applying', 'on it', '--db', db], dir);
  assert.notEqual(r.code, 0, r.stdout + r.stderr);
  // Named, because `state --db` with no cloud configured fails anyway, one step later, at the write:
  // only this sentence says the refusal came first, and for this reason.
  assert.match(r.stderr, REFUSED);
  assert.doesNotMatch(r.stdout + r.stderr, /recorded:|cloud project/);
});

test('the pre-commit lock over every example passes on a clean checkout', () => {
  for (const example of ['hello-world', 'template']) {
    const r = run(['check', '--root', join(ROOT, 'examples', example)], ROOT);
    assert.equal(r.code, 0, `${example}:\n${r.out}`);
    assert.match(r.out, /all intact/);
  }
});

/**
 * Y01.2.4 is the template's example of a rule, and its `data-proof` names a test inside the
 * template. `check` only proves the FILE exists; this proves the test in it passes, run the way an
 * adopter would run it — from the template's own root, with nothing but Node.
 */
test('the template\'s rule is defended by a test that exists and passes', () => {
  const template = join(ROOT, 'examples', 'template');
  const page = readFileSync(join(template, '00-kinds', 'Y01.html'), 'utf8');
  const [file, name] = page.match(/data-proof="([^"]+)"/)[1].split('::');
  // Without the parent's NODE_TEST_CONTEXT the child is a runner of its own, and prints its report
  // instead of streaming it to the runner above it — which left stdout empty the first time.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', file],
    { cwd: template, encoding: 'utf8', env });
  assert.match(out, new RegExp(`^ok \\d+ - ${name}$`, 'm'), 'the test named in data-proof ran and passed');
});
