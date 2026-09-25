/**
 * The real CLI, end to end, against a throwaway copy of the hello world.
 *
 * Unit tests import the functions; this runs `engine/cli/holdrim.ts` the way a person or a hook
 * does, and reads what comes out. It is what catches a command that fell out of the switch, a
 * usage line that names the wrong tool, or an option parseArgs stopped accepting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteEventStore } from '../api/store-sqlite.ts';
import { TEXT_REMOVED } from '../api/texts.ts';
import { readBlocks } from '../cli/pages.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const CLI = join(ROOT, 'engine', 'cli', 'holdrim.ts');

/**
 * Runs the CLI and returns what the user would see plus the exit code. The owner is set the way a
 * deployment sets it, in HOLDRIM_OWNER: holdrim.json cannot name one. Set here rather than inherited,
 * so an owner exported in the shell running the suite does not decide whose triage counts.
 */
function run(args, cwd, env = {}) {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOLDRIM_OWNER: 'you@example.org', HOLDRIM_ADMINS: '', ...env } }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? '') + String(e.stderr ?? ''), code: e.status };
  }
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
