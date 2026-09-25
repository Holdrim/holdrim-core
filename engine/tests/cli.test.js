/**
 * Tests for the agent's tool — for the ENGINE, against `examples/hello-world`.
 *
 * A test that demands a specific block code is not an engine test, it is a content test: it passes
 * only inside the project whose sheets it names. The proof of the content lives in the project that
 * has content, and stays away where there is none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { readBlocks, sheetFiles } from '../cli/pages.ts';
import { orphanMarks, loadRegistry, missingProofs, upwardDependencies, sync, mark, check, ifITouch } from '../cli/validation.ts';
import { trafficLight, dependentsOf } from '../core/validity.js';
import { setState, requests } from '../cli/requests.ts';
import { createRoles } from '../core/roles.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const EXAMPLE = join(ROOT, 'examples', 'hello-world');

/** A throwaway project with one folder of pages and the smallest config that works. */
function project(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-cli-'));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'holdrim.json'),
    JSON.stringify({ content: { folders: ['p'], registry: 'r.json' }, ...config }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('reads the blocks of any project, from the folders it declares', async () => {
  const blocks = await readBlocks(EXAMPLE);
  assert.equal(blocks.size, 8, 'the hello world has 8 blocks');
  assert.ok(blocks.has('A01.1.1'));
  assert.equal(blocks.get('A01.1.1')?.page, 'A01', 'the page comes out of the block code');
  assert.equal(blocks.get('A01.1.1')?.file, 'A01.html', 'the short name honours `trimPrefix`');
  assert.equal(blocks.get('A02.1.2')?.numbered, true);
});

test('the fingerprint ignores whatever is marked as review interface', async (t) => {
  // It is the easiest rule to forget while building a page, and the one that drops every approval
  // on it at once. See examples/hello-world/pages/A01.html, block A01.1.4.
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');

  writeFileSync(sheet, '<main><div data-id="X01.1.1" data-code="1.1">text</div></main>');
  const clean = (await readBlocks(tmp)).get('X01.1.1').fingerprint;

  writeFileSync(sheet, '<main><div data-id="X01.1.1" data-code="1.1">text' +
    '<button data-review-ui>1.1</button></div></main>');
  assert.equal((await readBlocks(tmp)).get('X01.1.1').fingerprint, clean,
    'a marked button must NOT enter the fingerprint');

  writeFileSync(sheet, '<main><div data-id="X01.1.1" data-code="1.1">text' +
    '<button>1.1</button></div></main>');
  assert.notEqual((await readBlocks(tmp)).get('X01.1.1').fingerprint, clean,
    'an unmarked button DOES enter the fingerprint — this is the accident the contract prevents');
});

test('check catches a forged approval', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const reg = { 'A.1.1': { file: 'X01.html', date: '2026-09-16', fingerprint: 'x' } };

  writeFileSync(sheet, '<main><div data-id="A.1.1" data-validated="2026-09-16">x</div></main>');
  assert.equal(await orphanMarks(tmp, reg, [sheet]), 0, 'a seal with a record and the right date passes');

  writeFileSync(sheet, '<main><div data-id="A.9.9" data-validated="2026-09-18">x</div></main>');
  assert.equal(await orphanMarks(tmp, reg, [sheet]), 1, 'a seal with NO record gets caught');

  writeFileSync(sheet, '<main><div data-id="A.1.1" data-validated="2026-09-18">x</div></main>');
  assert.equal(await orphanMarks(tmp, reg, [sheet]), 1, 'a tampered date gets caught');

  writeFileSync(sheet, '<main><div data-validated="2026-09-18">x</div></main>');
  assert.equal(await orphanMarks(tmp, reg, [sheet]), 1, 'a mark with no data-id gets caught');
});

/**
 * The lock, end to end: mark a block, change its text, and `check` has to say so. This is the
 * one claim the whole method makes, and it is proved through the registry file on disk rather
 * than through an object in memory.
 */
test('a validated block whose text changed is caught by check, and intact otherwise', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, '<main><div data-id="X01.1.1" data-code="1.1">the deadline is 24 hours</div></main>');
  const registry = {};
  const fingerprint = await mark(tmp, registry, 'X01.1.1', '2026-09-22', 'test');
  assert.ok(fingerprint);
  writeFileSync(join(tmp, 'r.json'), JSON.stringify(registry));

  const marked = readFileSync(sheet, 'utf8');
  assert.match(marked, /data-validated="2026-09-22"/, 'the seal is on the page');
  assert.match(marked, new RegExp(`data-validated-fingerprint="${fingerprint}"`), 'and so is the fingerprint the browser paints from');
  assert.equal(await check(tmp), 0, 'nothing changed: all intact');

  writeFileSync(sheet, marked.replace('24 hours', '48 hours'));
  assert.equal(await check(tmp), 1, 'the text changed after the ✓ — this is what the lock exists to say');
});

/**
 * The rule's proof is the only demand satisfied by something OUTSIDE the documentation, so it is
 * the only one that can stop being true without anybody touching the page. Deleting a test is the
 * ordinary way it happens, and the block goes on looking defended.
 */
test('check catches a data-proof whose file is gone', async (t) => {
  const tmp = project(t);
  mkdirSync(join(tmp, 'tests'));
  const proof = join(tmp, 'tests', 'deadline.test.js');
  writeFileSync(proof, '// the test that defends the rule\n');

  const sheet = join(tmp, 'p', 'X01.html');
  const rule = (path) => '<main><div data-id="X01.1.1" data-code="1.1" data-kind="rule"'
    + ` data-proof="${path}">an answer is owed within 24 hours</div></main>`;

  writeFileSync(sheet, rule('tests/deadline.test.js::responds within 24h'));
  const withProof = await readBlocks(tmp);
  assert.deepEqual(withProof.get('X01.1.1').missing, [], 'the kind is satisfied: the attribute is there');
  assert.equal(missingProofs(tmp, withProof), 0, 'a proof that is on disk is not accused');

  rmSync(proof);
  assert.equal(missingProofs(tmp, await readBlocks(tmp)), 1,
    'delete the test and the rule stops being defended — that is the whole point of the check');

  // The `::` and everything after it are informative for now, so a path with no test name is
  // still a path that has to exist.
  writeFileSync(sheet, rule('tests/nowhere.test.js'));
  assert.equal(missingProofs(tmp, await readBlocks(tmp)), 1, 'no `::` does not mean no check');

  writeFileSync(sheet, rule('::responds within 24h'));
  assert.equal(missingProofs(tmp, await readBlocks(tmp)), 1, 'a test name with no file is not a proof');

  // Blocks that declare nothing are none of this check's business: a `rule` with no `data-proof`
  // is already reported by the kind, and any other kind never had a proof to lose.
  writeFileSync(sheet, '<main><div data-id="X01.1.1" data-code="1.1">plain text</div></main>');
  assert.equal(missingProofs(tmp, await readBlocks(tmp)), 0, 'no data-proof, nothing to check');
});

/**
 * The Fundamental is the bottom an agent reads down to when it implements. An edge pointing the
 * other way — a rule depending on a screen — means there is no bottom, and nothing else catches
 * it: the fingerprint and the traffic light both compute fine on either endpoint alone.
 */
test('check catches a Fundamental block depending on an Application one', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const block = (id, kind, dependsOn) => `<div data-id="${id}" data-code="1.1" data-kind="${kind}"`
    + (dependsOn ? ` data-depends="${dependsOn}"` : '') + `>text of ${id}</div>`;

  // Fundamental (rule) depending on Application (text): the violation this check exists for.
  writeFileSync(sheet, '<main>' + block('F01.1.1', 'rule', 'A01.1.1') + block('A01.1.1', 'text') + '</main>');
  assert.equal(upwardDependencies(await readBlocks(tmp)), 1,
    'a Fundamental block depending on an Application one is a defect');

  // Application (decision) depending on Fundamental (config): the allowed direction, silent.
  writeFileSync(sheet, '<main>' + block('A01.1.1', 'decision', 'F01.1.1') + block('F01.1.1', 'config') + '</main>');
  assert.equal(upwardDependencies(await readBlocks(tmp)), 0,
    'the Application may depend on the Fundamental — that is the whole point of the layers');

  // Within the same layer, either direction, is fine.
  writeFileSync(sheet, '<main>' + block('F01.1.1', 'contract', 'F02.1.1') + block('F02.1.1', 'model') + '</main>');
  assert.equal(upwardDependencies(await readBlocks(tmp)), 0, 'a within-layer edge is nobody\'s business here');

  // A dangling data-depends — the target does not exist at all — is reported once, elsewhere in
  // the funnel, not accused twice here.
  writeFileSync(sheet, '<main>' + block('F01.1.1', 'rule', 'GHOST.1.1') + '</main>');
  assert.equal(upwardDependencies(await readBlocks(tmp)), 0, 'a dangling target is not this function\'s business');
});

/**
 * The traffic light over blocks read from disk, with no adapter in between. If the CLI's vocabulary
 * differed from the core's and a cast bridged them, every validated block would read as stale,
 * forever, while `check` said all intact. One vocabulary prevents it; this is the proof.
 */
test('the traffic light reads the blocks the CLI reads, green when nothing moved', async (t) => {
  const tmp = project(t);
  writeFileSync(join(tmp, 'p', 'X01.html'), '<main>'
    + '<div data-id="X01.1.1" data-code="1.1">the rule</div>'
    + '<div data-id="X01.1.2" data-code="1.2" data-depends="X01.1.1">stands on the rule</div>'
    + '</main>');
  const blocks = await readBlocks(tmp);
  const fp = (id) => blocks.get(id).fingerprint;
  const registry = {
    'X01.1.1': { file: 'X01.html', date: '2026-09-22', fingerprint: fp('X01.1.1') },
    'X01.1.2': { file: 'X01.html', date: '2026-09-22', fingerprint: fp('X01.1.2'), dependsOn: { 'X01.1.1': fp('X01.1.1') } },
  };
  assert.deepEqual(trafficLight(blocks, registry).tally, { none: 0, valid: 2, stale: 0, broken: 0 });
  assert.deepEqual(dependentsOf('X01.1.1', blocks), ['X01.1.2'], 'if-i-touch sees the declared edge');

  // The ground moves: the same registry, the rule rewritten.
  writeFileSync(join(tmp, 'p', 'X01.html'), '<main>'
    + '<div data-id="X01.1.1" data-code="1.1">the rule, changed</div>'
    + '<div data-id="X01.1.2" data-code="1.2" data-depends="X01.1.1">stands on the rule</div>'
    + '</main>');
  const moved = trafficLight(await readBlocks(tmp), registry);
  assert.equal(moved.byBlock.get('X01.1.1').state, 'stale');
  assert.equal(moved.byBlock.get('X01.1.2').state, 'broken', 'the text is the same, the ground moved: red');
});

/**
 * `if-i-touch` names the direct dependents as what will turn 🔴 — one hop, the same as the traffic
 * light itself (docs/IMPACT.md, "One hop, not the transitive closure") — and THEN the rest of the
 * radius as worth checking too. Both lists come from the one walk the panel also lights on
 * selection (`radiusOf`, built on `dependentsOf`): a version that swapped it back for a second hop
 * of `dependentsOf` would print the same one-hop list twice and never name C.
 */
test('if-i-touch names the direct hop as red, and the rest of the chain as worth checking', async (t) => {
  const tmp = project(t);
  writeFileSync(join(tmp, 'p', 'X01.html'), '<main>'
    + '<div data-id="X01.1.1" data-code="1.1">A: the rule</div>'
    + '<div data-id="X01.1.2" data-code="1.2" data-depends="X01.1.1">B: stands on A</div>'
    + '<div data-id="X01.1.3" data-code="1.3" data-depends="X01.1.2">C: stands on B, not on A directly</div>'
    + '</main>');

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  let code;
  try { code = await ifITouch(tmp, 'X01.1.1'); } finally { console.log = realLog; }
  const out = lines.join('\n');

  assert.equal(code, 0);
  assert.match(out, /1 block\(s\) will turn 🔴 and need a check/, 'the red count stays ONE hop');
  assert.match(out, /X01\.1\.2\s+never validated/);
  assert.match(out, /1 more, worth checking too — reached through another block/);
  assert.match(out, /X01\.1\.3\s+never validated/);
  // C is worth checking, not red: it is two hops away, and the traffic light never claims that.
  assert.doesNotMatch(out.split('worth checking')[0], /X01\.1\.3/);

  // From B, only C is left to check — and there is nothing further, so no second section prints.
  lines.length = 0;
  console.log = (line) => lines.push(line);
  try { await ifITouch(tmp, 'X01.1.2'); } finally { console.log = realLog; }
  const fromB = lines.join('\n');
  assert.match(fromB, /1 block\(s\) will turn 🔴 and need a check/);
  assert.match(fromB, /X01\.1\.3\s+never validated/);
  assert.doesNotMatch(fromB, /worth checking/, 'nothing is left once the one direct hop is named');
});

/**
 * Picking the work back up cannot depend on the cloud. A `sync` that built the Source with no
 * project would send `projects//databases/…`, the cloud would answer with a 400 that says
 * nothing, and the session would open blind, with no scoreboard.
 */
test('sync carries on with the local record when the cloud fails', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sourceThatFails = { events: async () => { throw new Error('cloud is down'); } };
  const before = Object.keys(loadRegistry(tmp)).length;

  const r = await sync(tmp, sourceThatFails, { owner: 'who@example.org' });

  assert.equal(r.offline, true, 'it has to say it read a frozen snapshot');
  assert.equal(r.added, 0);
  assert.equal(Object.keys(loadRegistry(tmp)).length, before, 'it must not touch the record');
});

test('sync brings in the owner\'s ✓ and nobody else\'s, and only for the current text', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: null },
    { id: 'e2', type: 'approval', page: 'A01', block: 'A01.1.2', fingerprint: 'stale-fingerprint',
      author: 'owner@example.org', when: '2026-09-22T10:01:00Z', data: null },
    { id: 'e3', type: 'approval', page: 'A02', block: 'A02.1.1', fingerprint: blocks.get('A02.1.1').fingerprint,
      author: 'reviewer@example.org', when: '2026-09-22T10:02:00Z', data: null },
  ];
  const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  assert.deepEqual(r, { added: 1, unchanged: 0, expired: 1, offline: false });
  const registry = loadRegistry(tmp);
  assert.ok(registry['A01.1.1'], 'the owner\'s ✓ for the current text locks');
  assert.equal(registry['A01.1.1'].date, '2026-09-22');
  assert.equal(registry['A01.1.1'].event, 'e1');
  assert.equal(registry['A01.1.2'], undefined, 'a ✓ for an earlier text does not hold');
  assert.equal(registry['A02.1.1'], undefined, 'a reviewer\'s ✓ never locks');
  assert.match(readFileSync(join(tmp, 'pages', 'A01.html'), 'utf8'), /data-id="A01\.1\.1" data-validated="2026-09-22"/);
});

/**
 * `sync` asks the server's rule who the owner is. Two addresses read as one owner nobody matches
 * would sync nothing and say nothing, and the session would go on believing no ✓ was ever given.
 * The refusal has to come before the cloud is asked: the count proves it did.
 */
test('sync refuses two owners, or none, before it asks the cloud for a single event', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  let asked = 0;
  const source = { events: async () => { asked++; return []; } };

  await assert.rejects(sync(tmp, source, { owner: 'a@example.org,b@example.org' }),
    /HOLDRIM_OWNER needs exactly one e-mail \(got 2\)/);
  await assert.rejects(sync(tmp, source, { owner: ' ' }), /HOLDRIM_OWNER needs exactly one e-mail \(got 0\)/);
  assert.equal(asked, 0, 'the cloud is not asked while there is no single owner');
});

test('sync knows the owner however the address is typed, in the configuration or on the event', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: null },
    { id: 'e2', type: 'approval', page: 'A02', block: 'A02.1.1', fingerprint: blocks.get('A02.1.1').fingerprint,
      author: ' OWNER@example.org ', when: '2026-09-22T10:01:00Z', data: null },
  ];
  const r = await sync(tmp, { events: async () => events }, { owner: '  Owner@Example.org ' });
  const registry = loadRegistry(tmp);
  assert.ok(registry['A01.1.1'], "the owner's ✓ locks with spaces and capitals around the configured address");
  assert.ok(registry['A02.1.1'], "and with spaces and capitals around the event's author");
  assert.equal(r.added, 2);
});

test('the Source refuses a cloud with no project, instead of sending an invalid URL', async () => {
  const { Source } = await import('../cli/remote.ts');
  await assert.rejects(() => new Source({}).events(), /cloud\.project|HOLDRIM_PROJECT/);
});

/**
 * Two blocks with the same `data-id` is the quietest bug a sheet can carry: the second overwrites
 * the first in the record, and a human approval starts standing for the wrong block. Nothing warns
 * — not the browser, not the server.
 */
test('a repeated block code on the same page gets caught', async (t) => {
  const tmp = project(t);
  writeFileSync(join(tmp, 'p', 'X01.html'),
    '<main>' +
    '<div data-id="X01.1.1" data-code="1.1">one</div>' +
    '<div data-id="X01.1.1" data-code="1.1">another</div>' +
    '</main>');

  // readBlocks returns a Map: the repeat disappears, and the count gives it away.
  const read = await readBlocks(tmp);
  const onDisk = (readFileSync(join(tmp, 'p', 'X01.html'), 'utf8').match(/data-id="/g) ?? []).length;
  assert.equal(onDisk, 2, 'the file has two');
  assert.equal(read.size, 1, 'and the engine only sees one — this is the loss this test exists to show');
});

test('pages are read in the project\'s order: its folders as listed, then by number', (t) => {
  // The home lists pages in this order, so it is the reading order a newcomer meets first.
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-order-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ content: { folders: ['b-first', 'a-second'] } }));
  for (const [folder, name] of [['b-first', 'A10'], ['b-first', 'A9'], ['a-second', 'B01']]) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, `${name}.html`), '<main></main>');
  }
  assert.deepEqual(sheetFiles(dir).map((f) => f.split('/').pop()), ['A9.html', 'A10.html', 'B01.html']);
});

test('a page read again is parsed again only when its text changed, even by one letter', async (t) => {
  // The server reads every page on every request, and keeps what it parsed; a change it failed to
  // see would keep an approval green over text nobody approved. Same length, same second: only the
  // text itself tells the two versions apart.
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ content: { folders: ['pages'] } }));
  mkdirSync(join(dir, 'pages'));
  const page = join(dir, 'pages', 'A01.html');
  writeFileSync(page, '<main><p data-id="A01.1.1" data-code="1.1">The limit is 24 hours.</p></main>');
  const before = (await readBlocks(dir)).get('A01.1.1');
  assert.equal((await readBlocks(dir)).get('A01.1.1'), before, 'unchanged: the same block, not parsed again');
  writeFileSync(page, '<main><p data-id="A01.1.1" data-code="1.1">The limit is 48 hours.</p></main>');
  const after = (await readBlocks(dir)).get('A01.1.1');
  assert.equal(after.text, 'The limit is 48 hours.');
  assert.notEqual(after.fingerprint, before.fingerprint, 'and a new text is a new fingerprint');
  assert.throws(() => { after.text = 'changed by a caller'; }, TypeError, 'shared, so it cannot be changed');
  assert.throws(() => { after.dependsOn.push('A99.1.1'); }, TypeError, 'nor can the lists inside it');
  assert.throws(() => { after.missing.push('something'); }, TypeError);
  // The page untouched, the project's config changed: the name the block is filed under follows it.
  assert.equal(after.file, 'A01.html', 'the default trimPrefix, pages/');
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ content: { folders: ['pages'], trimPrefix: '' } }));
  assert.equal((await readBlocks(dir)).get('A01.1.1').file, 'pages/A01.html', 'a new trimPrefix reaches a page nobody edited');
});

/** The examples are what every adopter copies. None of them can carry the defect just described. */
test('no example has a repeated block code', async () => {
  const examples = readdirSync(join(ROOT, 'examples'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => join(ROOT, 'examples', d.name));
  assert.ok(examples.length >= 2, 'the hello world and the template, at least');
  for (const example of examples) {
    const blocks = await readBlocks(example);
    const onDisk = sheetFiles(example)
      .flatMap((f) => readFileSync(f, 'utf8').match(/data-id="[^"]+"/g) ?? []);
    assert.ok(onDisk.length > 0, `${example}: no page read — a folder in holdrim.json is wrong`);
    assert.equal(blocks.size, onDisk.length,
      `${example}: ${onDisk.length} data-id on disk, ${blocks.size} read: there is a repeated code`);
  }
});

/**
 * `setState` is the one door through which the agent writes to the trail, so its guards are the
 * product's: an agent that could move an OPEN request to "applying" would be triaging in the
 * owner's place, and an "applied" without a commit would be a closed request nobody can audit.
 */
function trail(t, ...events) {
  // The owner is named in HOLDRIM_OWNER, the way a deployment names it, and set for the test alone,
  // so a HOLDRIM_OWNER exported in the shell running it does not decide who the owner is.
  const root = mkdtempSync(join(tmpdir(), 'holdrim-trail-'));
  writeFileSync(join(root, 'holdrim.json'), JSON.stringify({}));
  const before = { owner: process.env.HOLDRIM_OWNER, admins: process.env.HOLDRIM_ADMINS };
  process.env.HOLDRIM_OWNER = 'owner@y.org';
  delete process.env.HOLDRIM_ADMINS;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (before.owner === undefined) delete process.env.HOLDRIM_OWNER; else process.env.HOLDRIM_OWNER = before.owner;
    if (before.admins === undefined) delete process.env.HOLDRIM_ADMINS; else process.env.HOLDRIM_ADMINS = before.admins;
  });
  const added = [];
  const request = (id, author) => ({
    id, type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'f', text: 'please', snapshot: 's',
    author, when: '2026-09-20T10:00:00.000Z', data: { category: 'text' },
  });
  const all = [
    request('open-by-a-reader', 'reader@y.org'),
    request('approved-by-the-owner', 'owner@y.org'),
    ...events,
  ];
  return { root, added, source: { events: async () => all, add: async (e) => { added.push(e); } } };
}

test('the agent only moves a request the owner APPROVED, and never into the owner\'s states', async (t) => {
  const { root, source, added } = trail(t);
  await assert.rejects(() => setState(root, source, 'open-by', 'applying', 'starting'), /only applies requests the owner APPROVED/);
  await assert.rejects(() => setState(root, source, 'approved-by', 'rejected', 'no'), /the agent only uses/);
  assert.equal(added.length, 0, 'a refusal writes nothing');

  await setState(root, source, 'approved-by', 'applying', 'starting');
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'request_state');
  assert.deepEqual(added[0].data, { request: 'approved-by-the-owner', state: 'applying', from: 'approved' },
    '`from` is what lets the server refuse a stale write');
});

test('a request already in the agent\'s hands is refused by where it can go, not by "the owner APPROVED"', async (t) => {
  const moved = (id, state, from) => ({ id: `st-${id}`, type: 'request_state', page: 'A01', block: 'A01.1.1',
    author: 'agent@y.org', when: '2026-09-20T11:00:00.000Z', data: { request: 'approved-by-the-owner', state, from } });
  const applied = trail(t, moved(1, 'applying', 'approved'), moved(2, 'applied', 'applying'));
  await assert.rejects(() => setState(applied.root, applied.source, 'approved-by', 'applied', 'again', { commit: 'abc1234' }),
    /no: the request is "Applied": nothing is left to do on it\.$/);
  const waiting = trail(t, moved(1, 'waiting', 'approved'));
  await assert.rejects(() => setState(waiting.root, waiting.source, 'approved-by', 'waiting', 'still asking'),
    /no: the request is "Being applied · query"; from there it goes to: Being applied, Applied\.$/);
  assert.equal(applied.added.length + waiting.added.length, 0, 'a refusal writes nothing');
});

test('"applied" without a commit is refused: the trail ties request to commit', async (t) => {
  const { root, source, added } = trail(t);
  await assert.rejects(() => setState(root, source, 'approved-by', 'applied', 'done'), /--commit/);
  assert.equal(added.length, 0);
  await setState(root, source, 'approved-by', 'applied', 'done', { commit: 'abc1234567', blocks: 'A01.1.1' });
  assert.equal(added[0].data.commit, 'abc1234567');
  assert.match(added[0].text, /commit abc1234 · blocks: A01\.1\.1/);
});

test('a local server that answers but refuses says why, not "is it running?"', async (t) => {
  const { createServer } = await import('node:http');
  const { Source } = await import('../cli/remote.ts');
  // Up, behind a sign-in: every read is a 401. A write the cycle refuses is a 403 with a reason.
  const server = createServer((req, res) => {
    // And something that is not Holdrim at all, on the port it was pointed at, answers in plain text.
    if (req.url.startsWith('/elsewhere')) return res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway from the proxy');
    if (req.url.startsWith('/silent')) return res.writeHead(500).end();
    const [status, error] = req.method === 'GET' ? [401, 'not signed in'] : [403, 'only owner and admin triage'];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const localUrl = `http://127.0.0.1:${server.address().port}`;
  const source = new Source({ local: true, localUrl });

  await assert.rejects(source.events(), (e) => {
    assert.match(e.message, /is up, but does not take the agent's development identity/);
    assert.match(e.message, /run-local\.sh|--db/);
    assert.doesNotMatch(e.message, /running\?/, 'it answered: whether it runs is not the question');
    return true;
  });
  await assert.rejects(source.add({ type: 'request_state' }), (e) => {
    assert.match(e.message, /refused it \(403\): only owner and admin triage$/, 'the server\'s own reason, not its raw body');
    return true;
  });
  await assert.rejects(new Source({ local: true, localUrl: `${localUrl}/elsewhere` }).events(),
    /refused it \(502\): Bad Gateway from the proxy$/, 'a body that is not JSON is still what it said');
  // And a refusal that says nothing ends at its number, not at ": " or ": null".
  await assert.rejects(new Source({ local: true, localUrl: `${localUrl}/silent` }).events(), /refused it \(500\)$/);
});

test('a request\'s history comes from its own thread, oldest first, whatever order it was stored in', () => {
  const move = (id, state, from, when) => ({ id, type: 'request_state', page: 'A01', author: 'owner@y.org', when,
    data: { request: 'q', state, from } });
  const [found] = requests([
    { id: 'q', type: 'request', page: 'A01', author: 'r@x.org', when: '2026-09-22T10:00:00Z' },
    move('m3', 'applied', 'applying', '2026-09-22T10:03:00Z'),
    { id: 'other', type: 'request', page: 'A01', author: 'r@x.org', when: '2026-09-22T10:00:30Z' },
    move('m1', 'approved', 'open', '2026-09-22T10:01:00Z'),
    move('m2', 'applying', 'approved', '2026-09-22T10:02:00Z'),
  ], createRoles('owner@y.org', ''));
  assert.deepEqual(found.history.map((e) => e.id), ['m1', 'm2', 'm3']);
  assert.equal(found.state, 'applied');
});

test('the request list is linear in its history: 30 000 requests read in well under a second', () => {
  // Computing each request's state by filtering every event, once per request, costs the square
  // of the history, which at this size is minutes. The bound is loose on purpose — a quadratic
  // version does not come near it, and a slow runner still does.
  const events = [];
  for (let i = 0; i < 30000; i++) {
    const id = `r${i}`;
    events.push({ id, type: 'request', page: `P${i % 50}`, author: 'r@x.org', when: '2026-09-22T10:00:00Z' });
    events.push({ id: `s${i}`, type: 'request_state', page: `P${i % 50}`, author: 'o@x.org',
      when: '2026-09-22T10:01:00Z', data: { request: id, state: 'approved', from: 'open' } });
  }
  const started = performance.now();
  const found = requests(events, createRoles('owner@y.org', ''));
  const took = performance.now() - started;
  assert.equal(found.length, 30000);
  assert.ok(found.every((r) => r.state === 'approved' && r.history.length === 1));
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});
