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
import { readBlocks, sheetFiles, spliceAttributes } from '../cli/pages.ts';
import { orphanMarks, loadRegistry, missingProofs, upwardDependencies, sync, mark, restamp, check, ifITouch } from '../cli/validation.ts';
import { trafficLight, dependentsOf } from '../core/validity.js';
import { setState, requests, queue, list, show } from '../cli/requests.ts';
import { everyToggleFlipped } from '../core/features.js';

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
 * `mark` and `restamp` build a regex, and once did, straight out of the id — page text a
 * documentation author writes, not something the engine controls. A metacharacter in the id used to
 * change what the pattern matched: it could mark the wrong block, miss the right one, or throw on
 * an invalid pattern (holdrim#135). The tag is now found by plain string search, which reads every
 * character of the id literally, so this suite plants each hostile id NEXT TO an innocent neighbour
 * and checks the neighbour never moves.
 */
// `a$&b` is not here: an id with `&` is refused outright (`resolveBlock`), so its `$&` is proved
// where it can still reach a write — as a DEPENDENCY id inside `data-depended-on`, further down.
const HOSTILE_IDS = ['a+b', 'a(b', 'a|b', 'a[b', 'a\\b'];
const OTHER_ID = 'safe-neighbour';

/** Two blocks on one page: the id under test, and an innocent neighbour right after it. */
function hostilePage(id, other = OTHER_ID) {
  return `<main><div data-id="${id}" data-code="1.1">hostile text</div>`
    + `<div data-id="${other}" data-code="1.2">neighbour text</div></main>`;
}

for (const id of HOSTILE_IDS) {
  test(`mark on id ${JSON.stringify(id)} touches only that block, and does not throw`, async (t) => {
    const tmp = project(t);
    const sheet = join(tmp, 'p', 'X01.html');
    writeFileSync(sheet, hostilePage(id));
    const registry = {};

    const fingerprint = await mark(tmp, registry, id, '2026-09-22', 'test');
    assert.ok(fingerprint, `mark must succeed for id ${id}, not throw or silently fail`);

    const after = readFileSync(sheet, 'utf8');
    assert.ok(after.includes(`<div data-id="${OTHER_ID}" data-code="1.2">neighbour text</div>`),
      `the neighbour block must stay byte-identical when marking ${id}`);

    // Found by indexOf, never by a pattern built from the (hostile) id itself.
    const start = after.indexOf(`data-id="${id}"`);
    const tagEnd = after.indexOf('>', start);
    const tag = after.slice(start, tagEnd);
    assert.ok(tag.includes('data-validated="2026-09-22"'), `the hostile block ${id} must carry the seal`);
    assert.ok(tag.includes(`data-validated-fingerprint="${fingerprint}"`),
      `the hostile block ${id} must carry its fingerprint`);
  });

  test(`restamp on id ${JSON.stringify(id)} touches only that block, and does not throw`, async (t) => {
    const tmp = project(t);
    const sheet = join(tmp, 'p', 'X01.html');
    writeFileSync(sheet, hostilePage(id));
    writeFileSync(join(tmp, 'r.json'),
      JSON.stringify({ [id]: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } }));

    await restamp(tmp);

    const after = readFileSync(sheet, 'utf8');
    assert.ok(after.includes(`<div data-id="${OTHER_ID}" data-code="1.2">neighbour text</div>`),
      `the neighbour block must stay byte-identical when restamping ${id}`);
    const start = after.indexOf(`data-id="${id}"`);
    const tagEnd = after.indexOf('>', start);
    assert.ok(after.slice(start, tagEnd).includes('data-validated-fingerprint="ffffffffffffffff"'),
      `restamp must stamp the hostile block ${id}`);
  });
}

/**
 * The dot case is mainly a regression guard: the old code escaped `.` on purpose, so `a.b` never
 * broke it. What it did not guard is ORDER — a neighbour whose id loosely resembles the pattern
 * (`aXb`, where `.` reads as "any character") sitting BEFORE the real target. This plants `aXb`
 * first and confirms marking `a.b` never touches it.
 */
test('mark on "a.b" does not touch an "aXb" neighbour placed before it', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, '<main><div data-id="aXb" data-code="1.1">neighbour text</div>'
    + '<div data-id="a.b" data-code="1.2">hostile text</div></main>');
  const registry = {};

  const fingerprint = await mark(tmp, registry, 'a.b', '2026-09-22', 'test');
  assert.ok(fingerprint);

  const after = readFileSync(sheet, 'utf8');
  assert.ok(after.includes('<div data-id="aXb" data-code="1.1">neighbour text</div>'),
    'the aXb neighbour must stay byte-identical');
  const start = after.indexOf('data-id="a.b"');
  const tagEnd = after.indexOf('>', start);
  assert.ok(after.slice(start, tagEnd).includes(`data-validated-fingerprint="${fingerprint}"`),
    'the a.b block must carry its fingerprint');
});

/**
 * `data-depended-on` carries another block's id inside a JSON blob, written as the VALUE of an
 * attribute. `String.replace` with a string second argument reads `$&`/`$1`/`$$` inside that value
 * as replacement syntax — an id containing `$&` used to corrupt the write by splicing in the whole
 * matched tag a second time. Splicing the html by index instead treats the value as inert text.
 */
test('a dependency id containing $& lands intact in data-depended-on', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const depId = 'a$&b';
  writeFileSync(sheet, `<main><div data-id="target" data-code="1.1" data-depends="${depId}">text</div>`
    + `<div data-id="${depId}" data-code="1.2">dep text</div></main>`);
  const registry = {};
  const fingerprintsNow = new Map([[depId, 'dddddddddddddddd']]);

  const fingerprint = await mark(tmp, registry, 'target', '2026-09-22', 'test', undefined, fingerprintsNow);
  assert.ok(fingerprint);

  const after = readFileSync(sheet, 'utf8');
  const expectedValue = JSON.stringify({ [depId]: 'dddddddddddddddd' }).replace(/"/g, '&quot;');
  assert.ok(after.includes(`data-depended-on="${expectedValue}"`),
    'the dependency id must appear exactly as JSON.stringify produced it, not mangled by $-substitution');
});

/** What `fn` printed through console.log, as one string, and what it returned. */
async function printed(t, fn) {
  const lines = [];
  const log = t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  try {
    return { value: await fn(), out: lines.join('\n') };
  } finally {
    log.mock.restore();
  }
}

/**
 * `"` and `&` reach a page as entities (`&quot;`, `&amp;`), so the literal `data-id="${id}"` a splice
 * starts from is normally not in the file at all. `mark` says so, by that reason, before reading a
 * page — stated policy, not the safety: the whole-page check in `spliceAttributes` is. The page
 * here DOES hold a block with the id, entity-encoded, so the reason is the only thing a mutant that
 * dropped the refusal would change: it would print "could not locate its tag" instead.
 */
const INVALID_IDS = [['a"b', 'a&quot;b'], ['a&b', 'a&amp;b']];
for (const [id, written] of INVALID_IDS) {
  test(`mark refuses id ${JSON.stringify(id)} by that reason, and writes nothing`, async (t) => {
    const tmp = project(t);
    const sheet = join(tmp, 'p', 'X01.html');
    const html = `<main><p data-id="${written}" data-code="1.1">the text</p></main>`;
    writeFileSync(sheet, html);
    const registry = {};

    const { value, out } = await printed(t, () => mark(tmp, registry, id, '2026-09-22', 'test'));

    assert.equal(value, null, `mark must refuse an id containing ${JSON.stringify(id)}`);
    assert.match(out, /an id containing " or & cannot be located safely; nothing written/);
    assert.equal(readFileSync(sheet, 'utf8'), html, 'nothing written');
    assert.equal(registry[id], undefined);
  });
}

/**
 * `<` and `>` are not refused: inside a quoted value they are literal text, the needle finds them as
 * written, and the whole-page check proves the write landed on that block alone.
 */
for (const id of ['a<b', 'a>b']) {
  test(`mark and restamp stamp an id containing ${JSON.stringify(id.slice(1, 2))} on its own block only`, async (t) => {
    const tmp = project(t);
    const sheet = join(tmp, 'p', 'X01.html');
    writeFileSync(sheet, hostilePage(id));

    const fingerprint = await mark(tmp, {}, id, '2026-09-22', 'test');
    assert.ok(fingerprint);
    assert.equal(readFileSync(sheet, 'utf8'),
      `<main><div data-id="${id}" data-validated="2026-09-22" data-code="1.1" data-validated-fingerprint="${fingerprint}">`
      + `hostile text</div><div data-id="${OTHER_ID}" data-code="1.2">neighbour text</div></main>`);

    writeFileSync(sheet, hostilePage(id));
    writeFileSync(join(tmp, 'r.json'),
      JSON.stringify({ [id]: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } }));
    const { written, refused } = await restamp(tmp);
    assert.deepEqual({ written, refused }, { written: 1, refused: 0 });
    assert.equal(readFileSync(sheet, 'utf8'),
      `<main><div data-id="${id}" data-code="1.1" data-validated-fingerprint="ffffffffffffffff">`
      + `hostile text</div><div data-id="${OTHER_ID}" data-code="1.2">neighbour text</div></main>`);
  });
}

/**
 * The MAJOR from round 1: `<main><p data-id="a"b"="">decoy a</p><p data-id="a&quot;b">real</p></main>`
 * — an id containing `"` used to stamp the DECOY block, because the raw text `data-id="a"b"=""`
 * reads, to a needle search, as `data-id="a"` followed by unrelated text. Refusing the id outright
 * (rather than trying to locate it) means this decoy is never even reached.
 */
test('mark refuses the double-quote decoy id from round 1, and leaves both blocks untouched', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="a"b"="">decoy a</p><p data-id="a&quot;b">real</p></main>';
  writeFileSync(sheet, html);
  const registry = {};

  const result = await mark(tmp, registry, 'a"b', '2026-09-22', 'test');

  assert.equal(result, null, 'an id with a `"` cannot be matched by a literal needle');
  assert.equal(readFileSync(sheet, 'utf8'), html, 'nothing written');
});

/**
 * The same decoy on a REPEAT stamp: the real block already carries its seal, so nothing needs
 * inserting — and a restamp that decided "already there" by looking at the raw text past the first
 * needle would find the decoy's tag bare and stamp it. The refusal names its reason, and the page is
 * byte-identical.
 */
test('restamp refuses id a"b by its reason, and never stamps the decoy whose raw text matches it', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="a"b"="">decoy a</p>'
    + '<p data-id="a&quot;b" data-validated-fingerprint="ffffffffffffffff">real</p></main>';
  writeFileSync(sheet, html);
  writeFileSync(join(tmp, 'r.json'),
    JSON.stringify({ 'a"b': { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } }));

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
  assert.match(out, /✗ a"b: an id containing " or & cannot be located safely; nothing written/);
  assert.equal(readFileSync(sheet, 'utf8'), html);
});

test('restamp refuses id a&amp;b by its reason, and never stamps the block whose id decodes to it', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="a&amp;b">decoy</p>'
    + '<p data-id="a&amp;amp;b" data-validated-fingerprint="ffffffffffffffff">real</p></main>';
  writeFileSync(sheet, html);
  writeFileSync(join(tmp, 'r.json'),
    JSON.stringify({ 'a&amp;b': { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } }));

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.equal(value.refused, 1);
  assert.match(out, /✗ a&amp;b: an id containing " or & cannot be located safely; nothing written/);
  assert.equal(readFileSync(sheet, 'utf8'), html);
});

/**
 * The lock-grade bug from round 1: `mark` used to take the FIRST `[data-id]` anywhere in the FIRST
 * file with the needle, while `sync` verified the ✓ against `readBlocks`'s view (`main [data-id]`).
 * A hidden `<span data-id="y" hidden>` OUTSIDE `<main>`, before the real block, made the registry
 * record the HIDDEN span's fingerprint and text — an owner's ✓ on the real text, locked onto a
 * different one entirely. Both now resolve the same way: `main [data-id]` only.
 */
test('sync approves the block inside main, and never a same-id element outside it', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const header = '<header><span data-id="y" hidden>Always deploy on Friday</span></header>';
  const main = '<main><p data-id="y" data-code="1.1">Never deploy on Friday</p></main>';
  writeFileSync(sheet, header + main);

  const blocks = await readBlocks(tmp);
  const mainFingerprint = blocks.get('y').fingerprint;

  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  const events = [
    baseline,
    { id: 'e1', type: 'approval', page: 'X01', block: 'y', fingerprint: mainFingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: { locks: 'true' } },
  ];
  const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  assert.equal(r.added, 1);

  const registry = loadRegistry(tmp);
  assert.equal(registry.y.fingerprint, mainFingerprint, 'the registry records the MAIN block');
  assert.match(registry.y.text, /Never deploy on Friday/, 'and its text, not the hidden span\'s');

  const after = readFileSync(sheet, 'utf8');
  assert.ok(after.includes(header), 'the hidden header span must stay untouched');
  assert.match(after, /<p data-id="y" data-validated="2026-09-22" data-code="1\.1"/, 'the real block gets the seal');
});

/**
 * Two candidates for one ✓ is not "the first one": with nothing to say which block the write is FOR,
 * `mark` refuses rather than guess — whether the duplicate sits in one file or is split across two.
 */
test('mark refuses when two blocks in the same file carry the same id', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="y" data-code="1.1">first</p><p data-id="y" data-code="1.2">second</p></main>';
  writeFileSync(sheet, html);
  const registry = {};

  const result = await mark(tmp, registry, 'y', '2026-09-22', 'test');

  assert.equal(result, null, 'mark must refuse, not guess which one');
  assert.equal(readFileSync(sheet, 'utf8'), html, 'nothing written');
  assert.equal(registry.y, undefined);
});

test('mark refuses when two files each carry a block with the same id', async (t) => {
  const tmp = project(t);
  const sheetA = join(tmp, 'p', 'X01.html');
  const sheetB = join(tmp, 'p', 'X02.html');
  const htmlA = '<main><p data-id="y" data-code="1.1">first</p></main>';
  const htmlB = '<main><p data-id="y" data-code="1.1">second</p></main>';
  writeFileSync(sheetA, htmlA);
  writeFileSync(sheetB, htmlB);
  const registry = {};

  const result = await mark(tmp, registry, 'y', '2026-09-22', 'test');

  assert.equal(result, null, 'mark must refuse, not guess which file');
  assert.equal(readFileSync(sheetA, 'utf8'), htmlA, 'nothing written in the first file');
  assert.equal(readFileSync(sheetB, 'utf8'), htmlB, 'nothing written in the second file');
});

/**
 * `sync` passes the fingerprint it already checked the ✓ against, and `mark` refuses if the block it
 * resolves computes a different one — the two views of the page disagreeing about what the id names
 * is not something either one can safely settle by writing anyway.
 */
test('mark refuses when the expected fingerprint does not match the resolved block', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="y" data-code="1.1">the real text</p></main>';
  writeFileSync(sheet, html);
  const registry = {};

  const result = await mark(tmp, registry, 'y', '2026-09-22', 'test', undefined, undefined,
    'not-the-real-fingerprint');

  assert.equal(result, null);
  assert.equal(readFileSync(sheet, 'utf8'), html, 'nothing written');
  assert.equal(registry.y, undefined);
});

/**
 * The needle `data-id="y"` can sit in another block's own TEXT, inside an HTML comment, or inside a
 * `<script>` — all three BEFORE the real block. A splice that trusted the first textual match would
 * land there instead; verifying against a re-parse is what lets the scan skip past all three and
 * still find the one block that is really named `y`.
 */
test('mark on a page where the needle sits inside another block\'s text stamps only the real block', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const decoy = '<p data-id="z" data-code="1.1">this text mentions data-id="y" in passing</p>';
  const real = '<p data-id="y" data-code="1.2">the real y</p>';
  writeFileSync(sheet, `<main>${decoy}${real}</main>`);
  const registry = {};

  const fingerprint = await mark(tmp, registry, 'y', '2026-09-22', 'test');
  assert.ok(fingerprint, 'mark must succeed, finding the real tag past the decoy text');

  const after = readFileSync(sheet, 'utf8');
  assert.ok(after.includes(decoy), 'the decoy block must stay byte-identical');
  assert.match(after, /data-id="y" data-validated="2026-09-22" data-code="1\.2"/);
});

/**
 * Why checking the target's own attributes is not enough on its own: call `mark` again on the SAME
 * text (as `sync` does whenever the recorded fingerprint already matches — an ordinary idempotent
 * re-run). The real `y` already carries everything the plan asks for, so a check that only asks "does
 * the target have the right attributes" is satisfied trivially, by history, no matter WHERE this
 * second call spliced — and it would accept the decoy occurrence first, stamping the decoy's own text
 * with garbage instead of touching `y` at all. Only comparing every OTHER block's text against
 * `before` catches that the decoy, not `y`, is where this candidate actually landed.
 */
test('marking an already-marked block a second time still leaves an earlier decoy untouched', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const decoy = '<p data-id="z" data-code="1.1">this text mentions data-id="y" in passing</p>';
  const real = '<p data-id="y" data-code="1.2">the real y</p>';
  writeFileSync(sheet, `<main>${decoy}${real}</main>`);
  const registry = {};

  await mark(tmp, registry, 'y', '2026-09-22', 'test');
  const once = readFileSync(sheet, 'utf8');
  await mark(tmp, registry, 'y', '2026-09-22', 'test');
  const twice = readFileSync(sheet, 'utf8');

  assert.equal(twice, once, 'a second, idempotent mark must change nothing at all — the decoy least of all');
});

test('mark on a page where the needle sits inside a comment stamps only the real block', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const comment = '<!-- data-id="y" appears here for documentation -->';
  const real = '<p data-id="y" data-code="1.1">the real y</p>';
  writeFileSync(sheet, `<main>${comment}${real}</main>`);
  const registry = {};

  const fingerprint = await mark(tmp, registry, 'y', '2026-09-22', 'test');
  assert.ok(fingerprint, 'mark must succeed, finding the real tag past the comment');

  const after = readFileSync(sheet, 'utf8');
  assert.ok(after.includes(comment), 'the comment must stay byte-identical');
  assert.match(after, /data-id="y" data-validated="2026-09-22" data-code="1\.1"/);
});

test('mark on a page where the needle sits inside a <script> stamps only the real block', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const script = '<script>// data-id="y" appears here only as a code comment</script>';
  const real = '<main><p data-id="y" data-code="1.1">the real y</p></main>';
  writeFileSync(sheet, `${script}${real}`);
  const registry = {};

  const fingerprint = await mark(tmp, registry, 'y', '2026-09-22', 'test');
  assert.ok(fingerprint, 'mark must succeed, finding the real tag past the script');

  const after = readFileSync(sheet, 'utf8');
  assert.ok(after.includes(script), 'the script must stay byte-identical');
  assert.match(after, /data-id="y" data-validated="2026-09-22" data-code="1\.1"/);
});

/**
 * A `>` sitting inside a quoted attribute value must not end the tag one character early — the
 * quote-aware scan keeps reading past it, to the `>` that really closes the tag.
 */
test('mark on a block whose tag hides a `>` inside a quoted attribute stamps before the real `>`', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, '<main><p data-id="y" title="a>b">real y</p></main>');
  const registry = {};

  const fingerprint = await mark(tmp, registry, 'y', '2026-09-22', 'test');
  assert.ok(fingerprint, 'mark must not end the tag early at the `>` inside title="a>b"');

  const after = readFileSync(sheet, 'utf8');
  assert.match(after,
    new RegExp(`<p data-id="y" data-validated="2026-09-22" title="a>b" data-validated-fingerprint="${fingerprint}">real y</p>`),
    'the seal lands before the real `>`, and the text is unchanged');
});

/**
 * Round 1's review: no fixture had `data-id` as the LAST attribute before `>` — an off-by-one in the
 * needle's own end would slip past unnoticed.
 */
test('mark stamps inside the tag when data-id is its last attribute, never after the `>`', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, '<main><div data-id="X">text</div></main>');
  const registry = {};

  const fingerprint = await mark(tmp, registry, 'X', '2026-09-22', 'test');
  assert.ok(fingerprint);

  const after = readFileSync(sheet, 'utf8');
  assert.match(after,
    new RegExp(`<div data-id="X" data-validated="2026-09-22" data-validated-fingerprint="${fingerprint}">text</div>`));
});

/**
 * Round 1's review: calling `mark` twice on the same id must leave exactly one `data-validated` —
 * the FIRST date, never silently overwritten by a second call — and the second call still succeeds:
 * a block already carrying its seal is recorded, not refused.
 */
test('a second mark on the same block succeeds, writes nothing, and the first date stands', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, '<main><p data-id="y" data-code="1.1">the text</p></main>');
  const registry = {};

  await mark(tmp, registry, 'y', '2026-09-22', 'test');
  const once = readFileSync(sheet, 'utf8');
  assert.ok(await mark(tmp, registry, 'y', '2026-09-23', 'test'), 'the second mark must be recorded, not refused');
  assert.equal(registry.y.date, '2026-09-23');

  const after = readFileSync(sheet, 'utf8');
  assert.equal(after, once, 'nothing on the page changes');
  assert.equal((after.match(/data-validated="/g) ?? []).length, 1, 'data-validated must not be duplicated');
  assert.equal((after.match(/data-validated-fingerprint="/g) ?? []).length, 1);
  assert.match(after, /data-validated="2026-09-22"/, 'the first date wins: mark never overwrites an existing mark');
});

/**
 * Round 1's review: a tag with no closing `>` anywhere in the file is not a block a parser can
 * resolve at all — the same parser `readBlocks` uses never turns it into an element, so
 * `resolveBlock` reports it as not found rather than guessing where an attribute would even go.
 * `mark` has to refuse, and `restamp` must not count it as written.
 */
test('mark refuses a tag that never closes, and writes nothing', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="y" data-code="1.1"never closed here';
  writeFileSync(sheet, html);
  const registry = {};

  const result = await mark(tmp, registry, 'y', '2026-09-22', 'test');

  assert.equal(result, null);
  assert.equal(readFileSync(sheet, 'utf8'), html, 'nothing written');
});

test('restamp counts a tag that never closes as gone, never as written', async (t) => {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<main><p data-id="y" data-code="1.1"never closed here';
  writeFileSync(sheet, html);
  writeFileSync(join(tmp, 'r.json'),
    JSON.stringify({ y: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } }));

  const { written, noSuchBlock } = await restamp(tmp);

  assert.equal(written, 0, 'a tag that cannot be closed safely must not count as written');
  assert.equal(noSuchBlock, 1, 'the parser never made it a block: "no longer exists", the ordinary case');
  assert.equal(readFileSync(sheet, 'utf8'), html, 'nothing written');
});

// ===================================================================== holdrim#135, round 3
// What a stamp inserts is decided from the resolved element's own attributes, and a candidate is
// accepted only if that element carries exactly what was planned and, with it taken off again, the
// whole page serialises as it did. Each test below is a page on which some weaker rule — "already
// there" read from the raw text, a check of the blocks alone, a tag end that loses track of a quote —
// wrote somewhere else, or refused in silence.

/** A project whose one page is `html`, with `registry` as its approvals record. */
function onePage(t, html, registry = {}) {
  const tmp = project(t);
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, html);
  writeFileSync(join(tmp, 'r.json'), JSON.stringify(registry));
  return { tmp, sheet, page: () => readFileSync(sheet, 'utf8') };
}

/** One recorded ✓ for `y`, as `restamp` reads it. */
const Y_RECORDED = { y: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } };

/** The owner's ✓ on each of `ids`, on the text `readBlocks` sees now, after a baseline. */
async function ownersApprovals(root, ids) {
  const blocks = await readBlocks(root);
  return [
    { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: 'owner@example.org',
      when: '2026-09-22T09:00:00Z', data: null },
    ...ids.map((id, i) => ({ id: `e${i}`, type: 'approval', page: 'X01', block: id,
      fingerprint: blocks.get(id).fingerprint, author: 'owner@example.org',
      when: `2026-09-22T1${i}:00:00Z`, data: { locks: 'true' } })),
  ];
}

test('sync counts a ✓ it could not stamp as refused, says so in its summary, and records nothing for it',
  async (t) => {
    const { tmp, page } = onePage(t, '<main><p data-id="a" data-code="1.1">approved a</p>'
      + '<p data-id="y" data-code="1.2">twice</p><p data-id="y" data-code="1.3">twice</p></main>');
    const before = page();
    const events = await ownersApprovals(tmp, ['a', 'y']);

    const { value: r, out } = await printed(t, () =>
      sync(tmp, { events: async () => events }, { owner: 'owner@example.org' }));

    assert.equal(r.added, 1);
    assert.equal(r.refused, 1, 'the duplicate y is a refusal the CLI exits non-zero on, not a silent skip');
    assert.match(out, /✗ y: 2 blocks carry this id; nothing written/);
    assert.match(out, /^1 new · 0 already there · 0 ✓ expired · 1 refused · 1 validated in all$/m);
    assert.match(out, /⚠ 1 ✓ could not be stamped safely/);
    assert.deepEqual(Object.keys(loadRegistry(tmp)), ['a']);
    assert.notEqual(page(), before, 'a is stamped');
    assert.doesNotMatch(page(), /data-id="y" data-validated/);
  });

/**
 * `sync` checks each ✓ against the text `readBlocks` read at the start, and `mark` resolves the block
 * again, later. A page edited in between must not have its NEW text recorded under a ✓ given to the
 * old one: `mark` is handed the fingerprint `sync` checked, and refuses when the text it resolves
 * differs. The edit is made from inside `sync`'s own run, the moment it reports the first block.
 */
test('sync refuses a ✓ whose text changed between reading the blocks and writing the seal', async (t) => {
  const tmp = project(t);
  const a = join(tmp, 'p', 'X01.html');
  const b = join(tmp, 'p', 'X02.html');
  writeFileSync(a, '<main><p data-id="a">approved a</p></main>');
  writeFileSync(b, '<main><p data-id="b">approved b</p></main>');
  const events = await ownersApprovals(tmp, ['a', 'b']);
  const lines = [];
  t.mock.method(console, 'log', (...args) => {
    lines.push(args.join(' '));
    if (String(args[0]).includes('✓ a validated')) writeFileSync(b, '<main><p data-id="b">never approved</p></main>');
  });

  const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  t.mock.restoreAll();

  assert.equal(r.added, 1);
  assert.equal(r.refused, 1);
  assert.ok(lines.some((l) => /✗ b: the text resolved here does not match the ✓ that was checked; nothing written/.test(l)));
  const registry = loadRegistry(tmp);
  assert.ok(registry.a);
  assert.equal(registry.b, undefined, 'b must not be recorded with a text the owner never approved');
  assert.equal(readFileSync(b, 'utf8'), '<main><p data-id="b">never approved</p></main>', 'and b is not stamped');
});

const HIDDEN_Y = '<header><span data-id="y" hidden>other</span></header>';

test('restamp over a stamped block never stamps a same-id element outside main', async (t) => {
  const html = `${HIDDEN_Y}<main><p data-id="y" data-validated-fingerprint="ffffffffffffffff">real</p></main>`;
  const { tmp, page } = onePage(t, html, Y_RECORDED);

  assert.deepEqual(await restamp(tmp), { written: 0, alreadyHad: 1, noSuchBlock: 0, refused: 0 });
  assert.equal(page(), html);
});

test('a second mark never stamps a same-id element outside main, and still succeeds', async (t) => {
  const { tmp, page } = onePage(t, `${HIDDEN_Y}<main><p data-id="y">real</p></main>`);
  const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');
  const once = page();
  assert.equal(once, `${HIDDEN_Y}<main><p data-id="y" data-validated="2026-09-22" `
    + `data-validated-fingerprint="${fingerprint}">real</p></main>`);

  assert.ok(await mark(tmp, {}, 'y', '2026-09-23', 'test'));
  assert.equal(page(), once);
});

test('a re-approval after a text change is recorded with the new text\'s fingerprint', async (t) => {
  const { tmp, sheet, page } = onePage(t, '<main><p data-id="y">old</p></main>');
  const registry = {};
  const first = await mark(tmp, registry, 'y', '2026-09-22', 'test');
  writeFileSync(sheet, page().replace('>old<', '>new<'));
  const edited = page();

  const second = await mark(tmp, registry, 'y', '2026-09-23', 'test');

  assert.ok(second, 'the re-approval must be recorded, not refused because the page already carries a seal');
  assert.notEqual(second, first);
  assert.equal(registry.y.fingerprint, second);
  assert.equal(page(), edited, 'the attributes already on the block are never inserted a second time');
});

test('a re-approval after a text change never stamps a same-id element outside main', async (t) => {
  const { tmp, sheet, page } = onePage(t, `${HIDDEN_Y}<main><p data-id="y">old</p></main>`);
  const registry = {};
  await mark(tmp, registry, 'y', '2026-09-22', 'test');
  writeFileSync(sheet, page().replace('>old<', '>new<'));

  assert.ok(await mark(tmp, registry, 'y', '2026-09-23', 'test'));
  assert.ok(page().startsWith(HIDDEN_Y), 'the hidden span is untouched');
});

test('restamp never stamps a neighbour whose x-data-id attribute holds the needle, fresh or repeated',
  async (t) => {
    const { tmp, page } = onePage(t, '<main><p data-id="z" x-data-id="y">zzz</p><p data-id="y">real</p></main>', Y_RECORDED);

    assert.equal((await restamp(tmp)).written, 1);
    const once = page();
    assert.equal(once, '<main><p data-id="z" x-data-id="y">zzz</p>'
      + '<p data-id="y" data-validated-fingerprint="ffffffffffffffff">real</p></main>');
    assert.equal((await restamp(tmp)).alreadyHad, 1);
    assert.equal(page(), once);
  });

/**
 * The needle in prose, followed by an apostrophe: a tag-end scan starting there reads the `'` as an
 * opening quote and ends up at a `>` inside a comment further down. The real tag is stamped; the
 * prose, both comments and the block after them are byte-identical.
 */
test('restamp stamps the real tag, and leaves prose, comments and later blocks byte-identical', async (t) => {
  const tail = '<!-- it\'s a note --><p data-id="w">w</p><!-- end --></main>';
  const { tmp, page } = onePage(t,
    `<main><p data-id="z">see data-id="y" isn't it</p><p data-id="y">real</p>${tail}`, Y_RECORDED);

  assert.equal((await restamp(tmp)).written, 1);
  assert.equal(page(), '<main><p data-id="z">see data-id="y" isn\'t it</p>'
    + `<p data-id="y" data-validated-fingerprint="ffffffffffffffff">real</p>${tail}`);
});

test('restamp leaves a stamped page untouched when prose, a comment and an apostrophe follow the needle',
  async (t) => {
    const html = '<main><p data-id="z">see data-id="y" isn\'t it</p>'
      + '<p data-id="y" data-validated-fingerprint="ffffffffffffffff">real</p>'
      + '<!-- it\'s a note --><p data-id="w">w</p><!-- end --></main>';
    const { tmp, page } = onePage(t, html, Y_RECORDED);

    assert.deepEqual(await restamp(tmp), { written: 0, alreadyHad: 1, noSuchBlock: 0, refused: 0 });
    assert.equal(page(), html);
  });

/**
 * An apostrophe in the target's own tag (`it's`, an attribute name) sends the tag-end scan past the
 * real `>` into the next comment. Written there, the seal would change the comment and never reach
 * the block: the only safe answer is a refusal, said, with the page untouched.
 */
test('restamp refuses, and writes nothing, when an apostrophe in the tag hides where it ends', async (t) => {
  const html = '<main><p data-id="y" it\'s>real</p><p data-id="w">w</p><!-- it\'s --><p data-id="v">v</p><!-- end --></main>';
  const { tmp, page } = onePage(t, html, Y_RECORDED);

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
  assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
  assert.equal(page(), html);
});

test('restamp never rewrites another block\'s single-quoted id on the way to the real tag', async (t) => {
  const head = '<main><p data-id="z">see data-id="y" isn\'t it</p><p data-id=\'a>b\'>ab</p>';
  const { tmp, page } = onePage(t, `${head}<p data-id="y">real</p></main>`, Y_RECORDED);

  assert.equal((await restamp(tmp)).written, 1);
  assert.equal(page(), `${head}<p data-id="y" data-validated-fingerprint="ffffffffffffffff">real</p></main>`);
});

test('restamp never writes into an end tag when prose before the block mentions its id', async (t) => {
  const head = '<main><p data-id="z">see data-id="y" isn\'t it\'s</p>';
  const { tmp, page } = onePage(t, `${head}<p data-id="y">real</p></main>`, Y_RECORDED);

  assert.equal((await restamp(tmp)).written, 1);
  assert.equal(page(), `${head}<p data-id="y" data-validated-fingerprint="ffffffffffffffff">real</p></main>`);
});

/**
 * The locks lens's case: a block already sealed, a comment carrying the needle and an unbalanced
 * quote, and a neighbour with an apostrophe in an unquoted value. A second ✓ on the same text must
 * write nothing at all — not the comment, not the neighbour — and still be recorded.
 */
test('sync over a pre-stamped block never moves its seal into a comment or onto a neighbour', async (t) => {
  const text = 'Never deploy on Friday';
  const probe = onePage(t, `<main><p data-id="y">${text}</p></main>`);
  const fingerprint = (await readBlocks(probe.tmp)).get('y').fingerprint;
  for (const decoy of ['<!-- data-id="y" data-validated= \' -->',
    '<!-- data-id="y" data-validated= " -->',
    '<p data-id="a" data-code="1.0">Write data-id="y" data-validated= on it, don\'t forget</p>']) {
    const html = `<main>${decoy}<p data-id="z" data-code="1.2" data-validated="2026-09-01" title=it's>Z text</p>`
      + `<p data-id="y" data-code="1.1" data-validated="2026-01-01" data-validated-fingerprint="${fingerprint}">${text}</p></main>`;
    const { tmp, page } = onePage(t, html);
    const events = await ownersApprovals(tmp, ['y']);

    const { value: r } = await printed(t, () => sync(tmp, { events: async () => events }, { owner: 'owner@example.org' }));

    assert.equal(r.added, 1, decoy);
    assert.equal(r.refused, 0, decoy);
    assert.equal(page(), html, `nothing written with ${decoy}`);
  }
});

test('mark skips a needle in prose with an apostrophe after it, and stamps the real block', async (t) => {
  const head = '<main><p data-id="z">see data-id="y" if it\'s here</p>';
  const { tmp, page } = onePage(t, `${head}<p data-id="y">real</p></main>`);

  const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');

  assert.ok(fingerprint);
  assert.equal(page(), `${head}<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="${fingerprint}">real</p></main>`);
});

test('mark stamps past a > inside a single-quoted value in the tag', async (t) => {
  const { tmp, page } = onePage(t, '<main><p data-id="y" title=\'a>b\'>real</p></main>');

  const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');

  assert.ok(fingerprint, 'the > inside the single quotes does not end the tag');
  assert.equal(page(), `<main><p data-id="y" data-validated="2026-09-22" title='a>b' data-validated-fingerprint="${fingerprint}">real</p></main>`);
});

test('mark stamps past a > inside a double-quoted value that holds an apostrophe', async (t) => {
  const tail = '<p data-id="w">it\'s w</p></main>';
  const { tmp, page } = onePage(t, `<main><p data-id="y" title="it's > that">real</p>${tail}`);

  const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');

  assert.ok(fingerprint, 'an apostrophe inside double quotes neither opens nor closes a quote');
  assert.equal(page(), `<main><p data-id="y" data-validated="2026-09-22" title="it's > that" `
    + `data-validated-fingerprint="${fingerprint}">real</p>${tail}`);
});

test('mark skips a needle in a comment whose apostrophe never closes, and stamps the real block', async (t) => {
  const head = '<main><!-- data-id="y" isn\'t it -->';
  const { tmp, page } = onePage(t, `${head}<p data-id="y">real</p></main>`);

  const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');

  assert.ok(fingerprint, 'a candidate whose tag never closes is skipped, not the end of the search');
  assert.equal(page(), `${head}<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="${fingerprint}">real</p></main>`);
});

/**
 * "Already there" read from the raw text asked whether `data-validated` came RIGHT AFTER the needle;
 * one sitting later in the tag was missed, and a second, earlier copy inserted — which the parser
 * reads first, overwriting the date it was never meant to touch. Read from the element, it is there.
 */
test('mark never inserts a second data-validated when the block already carries one later in its tag',
  async (t) => {
    const { tmp, page } = onePage(t, '<main><p data-id="y" data-code="1" data-validated="2020-01-01">real</p></main>');

    const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');

    assert.ok(fingerprint);
    assert.equal(page(), '<main><p data-id="y" data-code="1" data-validated="2020-01-01" '
      + `data-validated-fingerprint="${fingerprint}">real</p></main>`);
  });

/**
 * The other way raw text lies about "already there": a value that merely NAMES the attribute. The
 * element does not carry `data-validated-fingerprint`, so it is written.
 */
test('mark stamps a block whose title merely names data-validated-fingerprint', async (t) => {
  const { tmp, page } = onePage(t, '<main><p data-id="y" title="data-validated-fingerprint">real</p></main>');

  const fingerprint = await mark(tmp, {}, 'y', '2026-09-22', 'test');

  assert.ok(fingerprint);
  assert.equal(page(), '<main><p data-id="y" data-validated="2026-09-22" title="data-validated-fingerprint" '
    + `data-validated-fingerprint="${fingerprint}">real</p></main>`);
});

/**
 * The parser reads `data-id='y'` as the block `y`, but the literal `data-id="y"` a splice starts from
 * is nowhere in the file. Nothing can be written safely, so nothing is — the page, and the record.
 */
test('mark refuses, records nothing and writes nothing when the page holds the id only single-quoted',
  async (t) => {
    const html = '<main><p data-id=\'y\'>real</p></main>';
    const { tmp, page } = onePage(t, html);
    const registry = {};

    const { value, out } = await printed(t, () => mark(tmp, registry, 'y', '2026-09-22', 'test'));

    assert.equal(value, null);
    assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
    assert.deepEqual(registry, {});
    assert.equal(page(), html);
  });

test('restamp refuses a duplicate id, counts it as refused and not as gone', async (t) => {
  const html = '<main><p data-id="y">1</p><p data-id="y">2</p></main>';
  const { tmp, page } = onePage(t, html, Y_RECORDED);

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
  assert.match(out, /✗ y: 2 blocks carry this id; nothing written/);
  assert.match(out, /⚠ 1 entries could not be stamped safely/);
  assert.doesNotMatch(out, /no longer exist/);
  assert.equal(page(), html);
});

test('restamp counts a block that is gone as gone, and not as refused', async (t) => {
  const { tmp } = onePage(t, '<main><p data-id="x">1</p></main>', Y_RECORDED);

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 1, refused: 0 });
  assert.match(out, /⚠ 1 entries in the registry no longer exist/);
  assert.doesNotMatch(out, /could not be stamped|nothing written/);
});

test('restamp refuses a tag it cannot splice safely, counts it as refused and not as written', async (t) => {
  const html = '<main><p data-id=\'y\'>1</p></main>';
  const { tmp, page } = onePage(t, html, Y_RECORDED);

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
  assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
  assert.match(out, /⚠ 1 entries could not be stamped safely/);
  assert.equal(page(), html);
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
 * selection (`radiusOf`, built on `dependentsOf`): the chain here is FOUR long (A→B→C→D) because a
 * version that took only one extra hop past the direct dependents — `dependentsOf` of each
 * dependent, instead of the whole `radiusOf` walk — would still find C from A on a 3-chain and pass;
 * it only stops short, and misses D, once there is a real second hop for it to fail to reach.
 */
test('if-i-touch names the direct hop as red, and the rest of the chain as worth checking', async (t) => {
  const tmp = project(t);
  writeFileSync(join(tmp, 'p', 'X01.html'), '<main>'
    + '<div data-id="X01.1.1" data-code="1.1">A: the rule</div>'
    + '<div data-id="X01.1.2" data-code="1.2" data-depends="X01.1.1">B: stands on A</div>'
    + '<div data-id="X01.1.3" data-code="1.3" data-depends="X01.1.2">C: stands on B, not on A directly</div>'
    + '<div data-id="X01.1.4" data-code="1.4" data-depends="X01.1.3">D: stands on C, three hops from A</div>'
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
  assert.match(out, /2 more, worth checking too — reached through another block/);
  assert.match(out, /X01\.1\.3\s+never validated/);
  assert.match(out, /X01\.1\.4\s+never validated/, 'the radius reaches past the second hop, to D');
  // C and D are worth checking, not red: they are two and three hops away, and the traffic light
  // never claims that.
  assert.doesNotMatch(out.split('worth checking')[0], /X01\.1\.3/);
  assert.doesNotMatch(out.split('worth checking')[0], /X01\.1\.4/);

  // From B, both C and D are left to check — the walk from B has a real second hop too.
  lines.length = 0;
  console.log = (line) => lines.push(line);
  try { await ifITouch(tmp, 'X01.1.2'); } finally { console.log = realLog; }
  const fromB = lines.join('\n');
  assert.match(fromB, /1 block\(s\) will turn 🔴 and need a check/);
  assert.match(fromB, /X01\.1\.3\s+never validated/);
  assert.match(fromB, /1 more, worth checking too — reached through another block/);
  assert.match(fromB, /X01\.1\.4\s+never validated/);

  // From C, only D turns red directly, and nothing lies beyond it, so no second section prints.
  lines.length = 0;
  console.log = (line) => lines.push(line);
  try { await ifITouch(tmp, 'X01.1.3'); } finally { console.log = realLog; }
  const fromC = lines.join('\n');
  assert.match(fromC, /1 block\(s\) will turn 🔴 and need a check/);
  assert.match(fromC, /X01\.1\.4\s+never validated/);
  assert.doesNotMatch(fromC, /worth checking/, 'nothing is left once the one direct hop is named');
});

/**
 * The two lists `if-i-touch` prints — the direct hop, and the rest of the radius — used to come out
 * in different orders: `dependentsOf` walked the blocks in file order, `radiusOf` sorted (#110). Z is
 * declared BEFORE B here so file order and alphabetical order disagree, and both lists print two
 * entries, so a lone item could not hide either fix or its absence.
 */
test('if-i-touch prints both lists in the same order, regardless of file order (#110)', async (t) => {
  const tmp = project(t);
  writeFileSync(join(tmp, 'p', 'X01.html'), '<main>'
    + '<div data-id="X01.1.1" data-code="1.1">the rule</div>'
    + '<div data-id="X01.1.4" data-code="1.4" data-depends="X01.1.1">Z: stands on the rule</div>'
    + '<div data-id="X01.1.2" data-code="1.2" data-depends="X01.1.1">B: stands on the rule too</div>'
    + '<div data-id="X01.1.5" data-code="1.5" data-depends="X01.1.4">further from Z</div>'
    + '<div data-id="X01.1.3" data-code="1.3" data-depends="X01.1.2">further from B</div>'
    + '</main>');

  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(line);
  try { await ifITouch(tmp, 'X01.1.1'); } finally { console.log = realLog; }
  const out = lines.join('\n');

  const direct = out.split('worth checking')[0];
  assert.ok(direct.indexOf('X01.1.2') < direct.indexOf('X01.1.4'), 'direct hop: B before Z, not file order');
  const further = out.split('worth checking')[1];
  assert.ok(further.indexOf('X01.1.3') < further.indexOf('X01.1.5'), 'rest of the radius: same order');
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
  // A baseline dated before every approval below: without one, a written `locks` on an event that
  // predates it (here, every event — there is no baseline at all) is ignored outright (round 2's
  // review, CRITICAL "fields written before this version are trusted"), and none of them would lock.
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  const events = [
    baseline,
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: { locks: 'true' } },
    { id: 'e2', type: 'approval', page: 'A01', block: 'A01.1.2', fingerprint: 'stale-fingerprint',
      author: 'owner@example.org', when: '2026-09-22T10:01:00Z', data: { locks: 'true' } },
    { id: 'e3', type: 'approval', page: 'A02', block: 'A02.1.1', fingerprint: blocks.get('A02.1.1').fingerprint,
      author: 'reviewer@example.org', when: '2026-09-22T10:02:00Z', data: { locks: 'false' } },
  ];
  const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  assert.deepEqual(r, { added: 1, unchanged: 0, expired: 1, refused: 0, offline: false, tampered: false, guardsTampered: false });
  const registry = loadRegistry(tmp);
  assert.ok(registry['A01.1.1'], 'the owner\'s ✓ for the current text locks');
  assert.equal(registry['A01.1.1'].date, '2026-09-22');
  assert.equal(registry['A01.1.1'].event, 'e1');
  assert.equal(registry['A01.1.2'], undefined, 'a ✓ for an earlier text does not hold');
  assert.equal(registry['A02.1.1'], undefined, 'a reviewer\'s ✓ never locks');
  assert.match(readFileSync(join(tmp, 'pages', 'A01.html'), 'utf8'), /data-id="A01\.1\.1" data-validated="2026-09-22"/);
});

/**
 * The filter above (`isLocked(e, baseline)`) is exercised only against `holdrim.json`'s DEFAULT
 * toggles by the test before this one — every toggle this project ships at the value it ships
 * with. A filter that secretly asked something toggle-shaped instead of what the server wrote — the
 * same worry `engine/test-contract.sh`'s "every toggle off" section answers for the SERVER — would
 * have nowhere to show itself there, so this repeats the claim with every toggle at the OPPOSITE of
 * its default, on the CLI's own path (`projectRoles`, real `HOLDRIM_OWNER`/`HOLDRIM_ADMINS`, no
 * `options.owner` standing in for either).
 *
 * `isLocked` never recomputes a role live (decision B, `engine/api/types.ts`): it reads `data.locks`
 * as the SERVER wrote it, at the moment the ✓ was given, against a `lock_baseline`. So each event
 * here carries the `locks` field the server would itself have written for that author's role —
 * `true` only for the owner — the same shape the test above this one (`sync brings in the owner's
 * ✓...`) already seeds; a bare `data: null` with no baseline would fail closed to "not a lock" for
 * every author here, owner included, and prove nothing about the toggles at all.
 */
test('sync\'s owner filter holds with every toggle at its non-default value', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-toggles-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(tmp, 'holdrim.json'), 'utf8'));
  // holdrim.json itself may never name `owner` or `admins` (AGENTS.md — "whoever commits to the
  // file is not whoever deploys"): only `features` is added here, and who is the owner or an admin
  // still comes from the environment, below.
  config.features = everyToggleFlipped();
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify(config));

  const blocks = await readBlocks(tmp);
  // Dated before every approval below, so each one is read against a real baseline instead of
  // falling back to `legacyLock` with none — the same shape `sync brings in the owner's ✓...` uses.
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  const approval = (author, when, locks) => ({
    id: `approval-${author}`, type: 'approval', page: 'A01', block: 'A01.1.1',
    fingerprint: blocks.get('A01.1.1').fingerprint, author, when, data: { locks: String(locks) },
  });

  const before = { owner: process.env.HOLDRIM_OWNER, admins: process.env.HOLDRIM_ADMINS };
  process.env.HOLDRIM_OWNER = 'owner@example.org';
  process.env.HOLDRIM_ADMINS = 'admin@example.org';
  t.after(() => {
    if (before.owner === undefined) delete process.env.HOLDRIM_OWNER; else process.env.HOLDRIM_OWNER = before.owner;
    if (before.admins === undefined) delete process.env.HOLDRIM_ADMINS; else process.env.HOLDRIM_ADMINS = before.admins;
  });

  // No `options.owner`: each call resolves through `projectRoles`, the real HOLDRIM_OWNER/
  // HOLDRIM_ADMINS path `options.owner` exists only to bypass.
  const reviewerRun = await sync(tmp, { events: async () => [baseline, approval('reviewer@example.org', '2026-09-22T10:00:00Z', false)] });
  assert.equal(reviewerRun.added, 0, 'a reviewer\'s ✓ never locks, every toggle at its non-default value or not');

  const adminRun = await sync(tmp, { events: async () => [baseline, approval('admin@example.org', '2026-09-22T10:01:00Z', false)] });
  assert.equal(adminRun.added, 0, 'an admin\'s ✓ never locks either, same toggles');

  const ownerRun = await sync(tmp, { events: async () => [baseline, approval('owner@example.org', '2026-09-22T10:02:00Z', true)] });
  assert.equal(ownerRun.added, 1, 'the owner\'s ✓ still locks with every toggle at its non-default value');
});

// ===================================================================== issue #91: the CLI's own alert
// `list` and `sync` never re-derive WHICH of the three cases it was — that already went out through
// `reportTampered`, wherever `events` was resolved — they only warn and exit non-zero once anything
// in the read comes back tampered.

test('sync warns and reports tampered when a field in the read comes back tampered', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const events = [
    { id: 'e1', type: 'comment', page: 'A01', block: 'A01.1.1', author: 'r@example.org',
      when: '2026-09-22T10:00:00Z', data: null, textTampered: true },
  ];
  const err = console.error;
  const said = [];
  console.error = (line) => said.push(line);
  let r;
  try {
    r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  } finally {
    console.error = err;
  }
  assert.equal(r.tampered, true);
  assert.ok(said.some((line) => /CRITICAL/.test(line)), 'sync printed the warning, not only the flag');
});

test('sync does not warn, and reports tampered: false, when nothing comes back tampered', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const r = await sync(tmp, { events: async () => [] }, { owner: 'owner@example.org' });
  assert.equal(r.tampered, false);
});

test('sync reports tampered: false when the cloud is unreachable, same as an ordinary offline read', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const sourceThatFails = { events: async () => { throw new Error('cloud is down'); } };
  const r = await sync(tmp, sourceThatFails, { owner: 'who@example.org' });
  assert.equal(r.tampered, false, 'offline, there is nothing to have read as tampered');
});

test('queue() names a tampered field with `tampered: true`, for `holdrim list --json` to carry', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const events = [
    { id: 'e1', type: 'comment', page: 'A01', author: 'r@example.org', when: '2026-01-01T00:00:00Z',
      data: null, snapshotTampered: true },
  ];
  const q = await queue(EXAMPLE, { events: async () => events }, true);
  assert.equal(q.tampered, true);
});

test('queue() reports tampered: false when nothing in the read is tampered', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const q = await queue(EXAMPLE, { events: async () => [] }, true);
  assert.equal(q.tampered, false);
});

test('list() prints the warning and its return says whether to exit non-zero', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const tampered = [
    { id: 'e1', type: 'request', page: 'A01', block: 'A01.1.1', text: 'x', author: 'r@example.org',
      when: '2026-01-01T00:00:00Z', data: { category: 'text' }, textTampered: true },
  ];
  const err = console.error;
  const said = [];
  console.error = (line) => said.push(line);
  let exitWorthy;
  try {
    exitWorthy = await list(EXAMPLE, { events: async () => tampered }, {});
  } finally {
    console.error = err;
  }
  assert.equal(exitWorthy, true, 'holdrim.ts turns this into exit code 1');
  assert.ok(said.some((line) => /CRITICAL/.test(line)));
});

test('list() prints no warning and exits clean when nothing is tampered', async () => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const err = console.error;
  const said = [];
  console.error = (line) => said.push(line);
  let exitWorthy;
  try {
    exitWorthy = await list(EXAMPLE, { events: async () => [] }, {});
  } finally {
    console.error = err;
  }
  assert.equal(exitWorthy, false);
  assert.deepEqual(said, []);
});

/**
 * The lock a ✓ carries is read from what the server wrote when it was GIVEN, never recomputed from
 * whoever holds HOLDRIM_OWNER when `sync` happens to run (docs/ROLES.md §3, "written at the moment,
 * read forever after") — the exact bug the issue's own comment names: a contributor with read access
 * to the store running `HOLDRIM_OWNER=<self> holdrim sync` must not lock their own past ✓.
 */
test('sync locks a ✓ from what was written on it, even once somebody else is HOLDRIM_OWNER', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    // Dated before the ✓ below, so the written `locks` on it is trusted at all (round 2's review).
    { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: 'owner@example.org',
      when: '2026-09-22T09:00:00Z', data: null },
    // Given while owner@example.org held HOLDRIM_OWNER, and written as a lock then.
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: { locks: 'true' } },
  ];
  // This process's own HOLDRIM_OWNER has since moved on — a handover, or a stale shell variable.
  // Recomputing "is this the CURRENT owner?" would read the ✓ above as no lock at all.
  const r = await sync(tmp, { events: async () => events }, { owner: 'newowner@example.org' });
  assert.deepEqual(r, { added: 1, unchanged: 0, expired: 0, refused: 0, offline: false, tampered: false, guardsTampered: false });
  assert.ok(loadRegistry(tmp)['A01.1.1'], 'the ✓ locks from what was written, not from today\'s owner');
});

test('sync does not lock a ✓ written as no lock, even once its author becomes the owner', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    // Given by an admin, not a lock at the time — written as such.
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'admin@example.org', when: '2026-09-22T10:00:00Z', data: { locks: 'false' } },
  ];
  // Now, in THIS process, that same address is HOLDRIM_OWNER. A recompute would lock it.
  const r = await sync(tmp, { events: async () => events }, { owner: 'admin@example.org' });
  assert.equal(r.added, 0, 'an admin\'s ✓ does not retroactively lock by becoming the owner later');
});

/**
 * Decision B (round 1's review): a ✓ with nothing written at all is measured against the BASELINE —
 * who HOLDRIM_OWNER was the moment a server of this version first read the store — never against
 * `sync`'s own `--owner`/HOLDRIM_OWNER, which is exactly the value a stale shell or a handover since
 * would get wrong (the bug this whole change exists to close, moved one step earlier if it fell back
 * to live roles here instead).
 */
test('sync measures an unwritten ✓ against the baseline, never against its own --owner', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  const before = { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1',
    fingerprint: blocks.get('A01.1.1').fingerprint, author: 'owner@example.org',
    when: '2026-09-22T08:00:00Z', data: null }; // predates the baseline, same author: locks
  const after = { id: 'e2', type: 'approval', page: 'A01', block: 'A01.1.2',
    fingerprint: blocks.get('A01.1.2').fingerprint, author: 'owner@example.org',
    when: '2026-09-22T10:00:00Z', data: null }; // AFTER the baseline: not a lock, whoever wrote it
  const strangersToo = { id: 'e3', type: 'approval', page: 'A01', block: 'A01.1.3',
    fingerprint: blocks.get('A01.1.3').fingerprint, author: 'somebody-else@example.org',
    when: '2026-09-22T08:30:00Z', data: null }; // predates the baseline, WRONG author: not a lock

  const r = await sync(tmp, { events: async () => [baseline, before, after, strangersToo] },
    { owner: 'somebody-else@example.org' }); // this call's own --owner must not matter at all
  assert.equal(r.added, 1, 'only the one that predates the baseline, by the baseline\'s own author, locks');
  assert.ok(loadRegistry(tmp)['A01.1.1'], 'A01.1.1 (before, same author) locks');
  assert.equal(loadRegistry(tmp)['A01.1.2'], undefined, 'A01.1.2 (after the baseline) does not');
  assert.equal(loadRegistry(tmp)['A01.1.3'], undefined, 'A01.1.3 (a stranger to the baseline) does not');
});

/**
 * M-2 (round 2's review): `legacyLock` compares the ✓'s author against the baseline's own author —
 * a NEW string comparison this version introduces, next to the one every store already normalizes
 * (docs/PRIVACY.md, section 1) — and it has to normalize the same way, both sides, or the same
 * address typed with different case or surrounding space on the ✓ than on the baseline (itself
 * whatever `HOLDRIM_OWNER` was typed as, at boot) reads as two different people.
 */
test('legacyLock normalizes both the baseline\'s author and the ✓\'s, case and whitespace alike', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: ' Owner@Example.org ', when: '2026-09-22T09:00:00Z', data: null };
  const events = [
    baseline,
    // Unwritten, predating the baseline, and typed with different case than the baseline's own author.
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'OWNER@example.org', when: '2026-09-22T08:00:00Z', data: null },
  ];
  const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  assert.equal(r.added, 1, 'the same address, typed differently on each side, still locks via legacyLock');
});

test('sync fails closed with no baseline event in the store at all, and warns exactly once', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    // No baseline anywhere in this store, and nothing written on either ✓ — a store no server of
    // this version has ever started against (read straight from a file, or the cloud). TWO
    // approvals, not one: with only one, "warned once for the run" and "warned once per approval"
    // look identical, and the mutation this test exists to catch would slip through in silence.
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: null },
    { id: 'e2', type: 'approval', page: 'A01', block: 'A01.1.2', fingerprint: blocks.get('A01.1.2').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:01:00Z', data: null },
  ];
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
    assert.equal(r.added, 0, 'no baseline: fails closed, not a lock, whoever the owner is');
  } finally {
    console.log = original;
  }
  // MINOR (round 2's review): `.some` would still pass if `sync` printed the warning on every
  // approval it skips instead of once for the whole run — this only ran ONE ✓ through, so `.some`
  // could not actually tell the two apart. Counted, not merely found.
  const warnings = logged.filter((l) => l.includes('no lock_baseline event'));
  assert.equal(warnings.length, 1, `warned ${warnings.length} time(s), wanted exactly one`);
});

/**
 * Round 4's review, CRITICAL: with no baseline anywhere in the store, `isLocked` must trust NOTHING
 * written, `'true'` included — the previous test only proves this for an unwritten ✓ (`data: null`),
 * which cannot tell "no baseline means nothing written is trusted" apart from "no baseline means an
 * unwritten ✓ never locks" (`legacyLock`'s own `if (!baseline) return false;`). Written here as an
 * admin's ✓ carrying an explicit, forged `locks:"true"`: reverting `isLocked`'s guard from
 * `if (baseline && …)` to `if (!baseline || …)` would trust it the moment there is no baseline to
 * compare against, and this is the one shape that tells the two apart.
 */
test('sync fails closed with no baseline at all, even over an admin\'s forged locks:"true"', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    // No lock_baseline event anywhere in this store — read straight from a file, or the cloud.
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'admin@example.org', when: '2026-09-22T10:00:00Z', data: { locks: 'true' } },
  ];
  const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
  assert.equal(r.added, 0, 'no baseline: a forged locks:"true" is trusted no more than an unwritten ✓ would be');
});

/** The other half of the MINOR above: with a real baseline in the store, sync says nothing about a
 *  missing one — the warning names a gap this run is actually in, not a stock line on every run. */
test('sync prints no baseline warning at all once the store holds one', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const events = [
    { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: 'owner@example.org',
      when: '2026-09-22T09:00:00Z', data: null },
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T08:00:00Z', data: null },
  ];
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    const r = await sync(tmp, { events: async () => events }, { owner: 'owner@example.org' });
    assert.equal(r.added, 1, 'a baseline is there, so the unwritten ✓ locks via legacyLock as usual');
  } finally {
    console.log = original;
  }
  assert.ok(!logged.some((l) => l.includes('no lock_baseline event')), 'nothing warns about a baseline that is there');
});

/**
 * Decision C (round 1's review): a `locks` value that is present but not exactly `'true'`/`'false'`
 * fails closed too, and is never treated as absent — so it must never reach `legacyLock` either, even
 * for a ✓ that would otherwise have locked against it. Dated AFTER the baseline, and from the
 * baseline's own author, so the ONLY thing standing between this ✓ and a lock is decision C itself:
 * `legacyLock` would say yes given the chance (same author, and it would be a fallback for an absent
 * field), but a value this malformed is never absent, so it is never asked.
 */
test('a malformed locks value fails closed, even from the baseline\'s own author, after it', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  for (const malformed of ['TRUE', true, 1, ' true']) {
    const approval = { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1',
      fingerprint: blocks.get('A01.1.1').fingerprint, author: 'owner@example.org',
      when: '2026-09-22T10:00:00Z', data: { locks: malformed } }; // AFTER the baseline: its field is trusted, or not at all
    const r = await sync(tmp, { events: async () => [baseline, approval] }, { owner: 'owner@example.org' });
    assert.equal(r.added, 0, `locks: ${JSON.stringify(malformed)} must fail closed`);
  }
});

/**
 * Round 2's review, CRITICAL "fields written before this version are trusted": a ✓ that PREDATES the
 * baseline is answered by `legacyLock` alone — whatever `data.locks` on it claims, well-formed,
 * malformed or a forgery, since an event that old could not have been written by this mechanism at
 * all. That still holds for `'true'` (round 4's review carves out exactly ONE exception, for a
 * written `'false'` — see the next test, and `isLocked`'s own comment). Written here as an explicit
 * `'true'`, by somebody who is NOT the baseline's own author: if the field were trusted this early, it
 * would read as a lock; `legacyLock` says the opposite (the wrong author, whatever `when` says), and
 * `legacyLock` is what decides for anything this old — the mismatched-author trick proves the field
 * is genuinely ignored, not merely consistent with it by accident.
 */
test('before the baseline, a written "true" is ignored outright — legacyLock alone decides', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  const approval = { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1',
    fingerprint: blocks.get('A01.1.1').fingerprint, author: 'somebody-else@example.org',
    when: '2026-09-22T08:00:00Z', data: { locks: 'true' } }; // predates the baseline, wrong author
  const r = await sync(tmp, { events: async () => [baseline, approval] }, { owner: 'owner@example.org' });
  assert.equal(r.added, 0, 'predating the baseline: the written "true" is ignored, and legacyLock says no (wrong author)');
});

/**
 * Round 4's review, MINOR "clock stepped back": the one exception to the rule above. If a server's
 * clock runs behind, a former owner's brand-new ✓ — given by THIS version, and correctly written
 * `locks:"false"` at the moment it was recorded — can land dated BEFORE the baseline it actually
 * follows in real time. `legacyLock` alone would read it as a lock (same author as the baseline, and
 * `when` says "predates it"), silently reviving a lock its own author just gave up. Written here by
 * the baseline's OWN author, predating it, with an explicit `locks:"false"`: if the field were still
 * ignored this early, `legacyLock` would say yes; trusting the written `"false"` says no instead —
 * proving the exception fires, not merely that nothing here locks by coincidence.
 */
test('a written "false" wins even before the baseline, unlike every other written value', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  const approval = { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1',
    fingerprint: blocks.get('A01.1.1').fingerprint, author: 'owner@example.org',
    // The clock ran behind: dated before the baseline, by the baseline's own author — exactly the
    // shape `legacyLock` would otherwise lock.
    when: '2026-09-22T08:00:00Z', data: { locks: 'false' } };
  const r = await sync(tmp, { events: async () => [baseline, approval] }, { owner: 'owner@example.org' });
  assert.equal(r.added, 0, 'a written "false" fails closed even predating the baseline, clock or not');
});

/**
 * The exception above only fires because `isLocked` asks `writtenBoolean(...) === false`, and
 * `writtenBoolean` already answers `false` for a malformed value too (decision C), not only for the
 * well-formed string `'false'` itself. So a malformed value, dated BEFORE the baseline and from the
 * baseline's own author, must fail closed the same way a real `"false"` does: `legacyLock` would
 * say yes given the chance (same author, predates the baseline), and only that carve-out stands
 * between this ✓ and a lock. Checking `approval.data?.locks === 'false'` instead would miss every
 * malformed value here and fall through to `legacyLock` — exactly the mutation this test is written
 * to catch.
 */
test('a malformed locks value fails closed too, from the baseline\'s own author, before it', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-sync-'));
  cpSync(EXAMPLE, tmp, { recursive: true });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const blocks = await readBlocks(tmp);
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@example.org', when: '2026-09-22T09:00:00Z', data: null };
  for (const malformed of ['TRUE', true, 1, ' true']) {
    const approval = { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1',
      fingerprint: blocks.get('A01.1.1').fingerprint, author: 'owner@example.org',
      // Same author as the baseline, and predates it — the clock-stepped-back shape, but with a
      // malformed value where the exception's own test used a well-formed "false".
      when: '2026-09-22T08:00:00Z', data: { locks: malformed } };
    const r = await sync(tmp, { events: async () => [baseline, approval] }, { owner: 'owner@example.org' });
    assert.equal(r.added, 0, `locks: ${JSON.stringify(malformed)} must fail closed before the baseline too`);
  }
});

/**
 * `people.show` (docs/ROLES.md, "How a person appears"), applied at the one place `list()` prints a
 * person: the default shows the address, exactly as every version before this one did, and a
 * project's own `holdrim.json` can ask for the role instead — proved by what the printed line does
 * and does not contain, not by calling `personLabel` directly, since it is not exported for that.
 */
test('list() shows the address by default, and the role when people.show asks for it', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const events = [
    { id: 'e1', type: 'request', page: 'A01', block: null, text: 'change this', author: 'owner@example.org',
      when: '2026-01-01T00:00:00Z', data: { category: 'text' } },
  ];
  const log = console.log;
  const printed = (root) => {
    const said = [];
    console.log = (line) => said.push(line);
    return list(root, { events: async () => events }, { all: true }).finally(() => { console.log = log; }).then(() => said.join('\n'));
  };

  const byDefault = await printed(EXAMPLE);
  assert.ok(byDefault.includes('owner@example.org'), 'the default keeps today\'s behaviour: the address');

  const byRole = await printed(project(t, { people: { show: 'role' } }));
  assert.ok(/\bowner\b/.test(byRole) && !byRole.includes('@'),
    `people.show: "role" should print the role and never the address: ${byRole}`);
});

/**
 * The same setting, applied to `show()`'s "Who" line and its thread — round 1 of the issue #31
 * review, finding 6: nothing exercised `show()` at all before this, so a `personLabel` call
 * reverted to the raw address in either place would have passed every test in the suite.
 */
test('show() shows the address by default, and the role when people.show asks for it', async (t) => {
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const events = [
    { id: 'req0000001', type: 'request', page: 'A01', block: null, text: 'change this', author: 'reviewer@example.org',
      when: '2026-01-01T00:00:00Z', data: { category: 'text' } },
    { id: 'st00000001', type: 'request_state', page: 'A01', author: 'owner@example.org',
      when: '2026-01-01T00:05:00Z', data: { request: 'req0000001', state: 'approved', from: 'open' } },
  ];
  const log = console.log;
  const printed = (root) => {
    const said = [];
    console.log = (line) => said.push(line);
    return show(root, { events: async () => events }, 'req0').finally(() => { console.log = log; }).then(() => said.join('\n'));
  };

  const byDefault = await printed(EXAMPLE);
  assert.ok(byDefault.includes('reviewer@example.org'), 'the default keeps today\'s behaviour: the address');
  assert.ok(byDefault.includes('owner@example.org'), 'and the thread\'s own author too');

  const byRole = await printed(project(t, { people: { show: 'role' } }));
  assert.ok(/\bmember\b/.test(byRole) && !byRole.includes('reviewer@example.org'),
    `people.show: "role" should print the requester's role, never the address: ${byRole}`);
  assert.ok(/\bowner\b/.test(byRole) && !byRole.includes('owner@example.org'),
    `and the thread's own author's role too, never the address: ${byRole}`);
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
    // Dated before both ✓s below, so their written `locks` is trusted at all (round 2's review).
    { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: 'owner@example.org',
      when: '2026-09-22T09:00:00Z', data: null },
    { id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: blocks.get('A01.1.1').fingerprint,
      author: 'owner@example.org', when: '2026-09-22T10:00:00Z', data: { locks: 'true' } },
    { id: 'e2', type: 'approval', page: 'A02', block: 'A02.1.1', fingerprint: blocks.get('A02.1.1').fingerprint,
      author: ' OWNER@example.org ', when: '2026-09-22T10:01:00Z', data: { locks: 'true' } },
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
  // `authorCouldTriage` is written explicitly, as `recordEvent` would: since decision A, a request
  // with nothing written reads as "at triage" no matter whose it is, so an id claiming to be
  // "approved-by-the-owner" has to carry the field itself to actually read as approved.
  const request = (id, author, authorCouldTriage) => ({
    id, type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'f', text: 'please', snapshot: 's',
    author, when: '2026-09-20T10:00:00.000Z', data: { category: 'text', authorCouldTriage: String(authorCouldTriage) },
  });
  // Dated before every request below: without one, the written `authorCouldTriage` above is ignored
  // outright (round 2's review, CRITICAL "fields written before this version are trusted") and
  // "approved-by-the-owner" would read as open, at triage, like everything else here.
  const baseline = { id: 'lock-baseline', type: 'lock_baseline', page: '_lock_baseline',
    author: 'owner@y.org', when: '2026-09-19T00:00:00.000Z', data: null };
  const all = [
    baseline,
    request('open-by-a-reader', 'reader@y.org', false),
    request('approved-by-the-owner', 'owner@y.org', true),
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
    { id: 'q', type: 'request', page: 'A01', author: 'r@x.org', when: '2026-09-22T10:00:00Z',
      data: { authorCouldTriage: 'false' } },
    move('m3', 'applied', 'applying', '2026-09-22T10:03:00Z'),
    { id: 'other', type: 'request', page: 'A01', author: 'r@x.org', when: '2026-09-22T10:00:30Z',
      data: { authorCouldTriage: 'false' } },
    move('m1', 'approved', 'open', '2026-09-22T10:01:00Z'),
    move('m2', 'applying', 'approved', '2026-09-22T10:02:00Z'),
  ]);
  assert.deepEqual(found.history.map((e) => e.id), ['m1', 'm2', 'm3']);
  assert.equal(found.state, 'applied');
});

/**
 * The state a request starts in is read from what was written on it when it was FILED, never
 * recomputed from whether its author can triage TODAY (docs/ROLES.md §3, "the same holds for a
 * request"): granting or revoking `triage` afterwards must not silently decide, or undecide, a
 * request already filed, with no triage event ever recorded (round 1's review, decision A: there is
 * no live-roles fallback at all any more — see the next test for the absent-field case).
 */
test('a request starts where it was written to start, whatever grants change afterwards', () => {
  const [grantedSince] = requests([
    { id: 'q', type: 'request', page: 'A01', author: 'later-admin@x.org', when: '2026-09-22T10:00:00Z',
      data: { authorCouldTriage: 'false' } },
  ]);
  assert.equal(grantedSince.state, 'open', 'granting triage afterwards must not retroactively approve it');

  const [revokedSince] = requests([
    // Dated before it: without a baseline, the written `authorCouldTriage: 'true'` below is ignored
    // outright (round 2's review, CRITICAL "fields written before this version are trusted") and
    // this would read 'open' regardless of what was written.
    { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: 'owner@y.org', when: '2026-09-22T09:00:00Z', data: null },
    { id: 'q', type: 'request', page: 'A01', author: 'former-admin@x.org', when: '2026-09-22T10:00:00Z',
      data: { authorCouldTriage: 'true' } },
  ]);
  assert.equal(revokedSince.state, 'approved', 'revoking triage afterwards must not retroactively un-approve it');
});

/**
 * Decision A (round 1's review): a request with NOTHING written for `authorCouldTriage` fails closed
 * to "at triage" — it does NOT fall back to asking any roles, live or otherwise. The worst this costs
 * is an old request the owner has to triage once more; the alternative — falling back to whatever
 * this process's own HOLDRIM_ADMINS says — is the exact bug this file exists to close, reappearing
 * for every request that predates the field.
 */
test('a request with no written field at all fails closed to "at triage"', () => {
  const [absent] = requests([
    { id: 'q', type: 'request', page: 'A01', author: 'admin@x.org', when: '2026-09-22T10:00:00Z', data: null },
  ]);
  assert.equal(absent.state, 'open', 'missing entirely: at triage, never pre-approved');
});

/**
 * Decision C (round 1's review): a field that is PRESENT but not exactly `'true'`/`'false'` also
 * fails closed — it is not "absent", so it must never reach the legacy rule either.
 */
test('a malformed authorCouldTriage fails closed, and is never treated as absent', () => {
  for (const malformed of ['TRUE', true, 1, ' true']) {
    const [r] = requests([
      { id: 'q', type: 'request', page: 'A01', author: 'admin@x.org', when: '2026-09-22T10:00:00Z',
        data: { authorCouldTriage: malformed } },
    ]);
    assert.equal(r.state, 'open', `authorCouldTriage: ${JSON.stringify(malformed)} must fail closed`);
  }
});

/**
 * Round 2's review, CRITICAL "fields written before this version are trusted": before this version,
 * `recordEvent` stored whatever `data` a client sent, so a member could POST a request carrying
 * `authorCouldTriage:"true"` straight from their own browser. Read by THIS version, a request that old
 * still reads at triage — `earliestLockBaseline`, computed here from the very `events` `requests()` is
 * given (there is no server process's `LOCK_BASELINE` to ask from the agent's own CLI), gates it the
 * same way the server does.
 */
test('requests() ignores a forged pre-baseline authorCouldTriage, straight into nobody\'s queue', () => {
  const baseline = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: 'owner@x.org',
    when: '2026-09-22T09:00:00Z', data: null };
  const forged = { id: 'q', type: 'request', page: 'A01', author: 'member@x.org',
    when: '2026-09-22T08:00:00Z', data: { authorCouldTriage: 'true' } }; // predates the baseline
  const [r] = requests([baseline, forged]);
  assert.equal(r.state, 'open', 'a forged pre-baseline authorCouldTriage is ignored: still at triage');
});

/**
 * Round 4's review, CRITICAL: with no `lock_baseline` event among the events at all, `authorCouldTriage`
 * must trust NOTHING written — the previous test only proves this for events that predate a REAL
 * baseline, which cannot tell "no baseline exists" apart from "this one predates the baseline that
 * does". Reverting the guard from `if (baseline && …)` to `if (!baseline || …)` would trust a forged
 * `authorCouldTriage:"true"` the moment `earliestLockBaseline(events)` finds none at all — exactly the
 * shape this pins.
 */
test('requests() ignores a forged authorCouldTriage with no baseline in the events at all', () => {
  const forged = { id: 'q', type: 'request', page: 'A01', author: 'member@x.org',
    when: '2026-09-22T10:00:00Z', data: { authorCouldTriage: 'true' } }; // no lock_baseline event anywhere
  const [r] = requests([forged]);
  assert.equal(r.state, 'open', 'no baseline at all: a forged authorCouldTriage is trusted no more than an absent one');
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
  const found = requests(events);
  const took = performance.now() - started;
  assert.equal(found.length, 30000);
  assert.ok(found.every((r) => r.state === 'approved' && r.history.length === 1));
  assert.ok(took < 1500, `took ${Math.round(took)} ms`);
});

/**
 * The only candidate that gives this block its seal splices it in past the `"` that really ends `x`'s
 * value, so the tag re-tokenises: its attribute `y"<` becomes two, `y"` and `<`. The block's id and
 * text are unchanged, and it carries exactly the attributes planned — only comparing the WHOLE page,
 * with those attributes taken off again, sees that something else in the tag moved.
 */
test('mark refuses a write that would re-tokenise the rest of the block\'s own tag', async (t) => {
  const html = '<main><p data-id="y" x="> <p data-id="y"</p>text</main>';
  const { tmp, page } = onePage(t, html);
  const registry = {};

  const { value, out } = await printed(t, () => mark(tmp, registry, 'y', '2026-09-22', 'test'));

  assert.equal(value, null);
  assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
  assert.equal(page(), html);
  assert.deepEqual(registry, {});
});

/**
 * An apostrophe in the block's own tag sends the tag-end scan past its real `>` to the `>` of its END
 * tag. Written there, the seal is dropped by the parser — the page serialises exactly as before, so
 * the whole-page comparison alone would accept it; only asking the block itself whether it now
 * carries the seal refuses it.
 */
test('restamp refuses a write that would land in an end tag, where the parser drops it', async (t) => {
  const html = '<main><p data-id="y" it\'s>real y\'s</p></main>';
  const { tmp, page } = onePage(t, html, Y_RECORDED);

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
  assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
  assert.equal(page(), html);
});

/**
 * `data-depended-on` escapes only `"`, so a dependency id holding `&lt;` is written as text a reader
 * decodes to `<` — a map naming a block that does not exist. The value read back is compared with
 * the value meant, not merely found present, so that write is refused instead of recorded.
 */
test('mark refuses a data-depended-on that would read back naming a different block', async (t) => {
  const depId = 'a&lt;b';
  const html = '<main><p data-id="y" data-depends="a&amp;lt;b">text</p><p data-id="a&amp;lt;b">dep</p></main>';
  const { tmp, page } = onePage(t, html);

  const result = await mark(tmp, {}, 'y', '2026-09-22', 'test', undefined, new Map([[depId, 'dddddddddddddddd']]));

  assert.equal(result, null);
  assert.equal(page(), html);
});

/**
 * Nothing to insert is answered from the element before any splice is tried: a block the parser
 * reads, sealed already, whose tag no literal needle can find (`data-id='y'`), is "already had", not
 * a refusal — there is nothing to write, so there is nothing that could be written wrong.
 */
test('restamp counts a sealed block written with single quotes as already had, not refused', async (t) => {
  const html = '<main><p data-id=\'y\' data-validated-fingerprint="ffffffffffffffff">real</p></main>';
  const { tmp, page } = onePage(t, html, Y_RECORDED);

  assert.deepEqual(await restamp(tmp), { written: 0, alreadyHad: 1, noSuchBlock: 0, refused: 0 });
  assert.equal(page(), html);
});

test('spliceAttributes refuses a page where two blocks carry the id, whoever calls it', () => {
  const html = '<main><p data-id="y">1</p><p data-id="y">2</p></main>';
  const plan = { attributes: [{ attr: 'data-validated-fingerprint', value: 'ffffffffffffffff' }] };

  assert.deepEqual(spliceAttributes(html, 'y', plan), { error: '2 blocks carry this id in this file' });
});
