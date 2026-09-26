/**
 * A new ✓ replaces the seal on its block (holdrim#140), and `check` holds the seal to the registry.
 *
 * The seal — `data-validated`, `data-validated-fingerprint`, `data-depended-on` — is the copy of the
 * registry the browser paints the traffic light from. A ✓ that updated the registry and kept the old
 * seal left a block just approved painted 🟡, and `check`, comparing only the date, said so for the
 * date alone; a fingerprint or a dependency snapshot out of step passed. A browser also lowercases
 * attribute names and keeps the first copy, where linkedom keeps the case: a `DATA-VALIDATED-FINGERPRINT`
 * ahead of the real one is what a reader sees, and what every case-sensitive read here missed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { readBlocks, SEAL_NAMES } from '../cli/pages.ts';
import { loadRegistry, sync, mark, restamp, check } from '../cli/validation.ts';
import { fingerprintOfText } from '../core/fingerprint.js';
import { trafficLightOf, blockState } from '../web/src/state.js';

const OWNER = 'owner@example.org';
const BASELINE = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: OWNER,
  when: '2026-01-01T09:00:00Z', data: null };

/** A throwaway project whose one page is `html`, with `registry` as its approvals record. */
function onePage(t, html, registry = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-reseal-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'p'));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['p'], registry: 'r.json' } }));
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, html);
  writeFileSync(join(tmp, 'r.json'), JSON.stringify(registry));
  return { tmp, sheet, page: () => readFileSync(sheet, 'utf8') };
}

/** A second page, `X02.html`, beside the one `onePage` wrote; returns a reader for it. */
function secondPage(tmp, html) {
  const sheet = join(tmp, 'p', 'X02.html');
  writeFileSync(sheet, html);
  return () => readFileSync(sheet, 'utf8');
}

/** The fingerprint of a block whose text is `text` — every block in this file reads `real` unless it says otherwise. */
const fingerprintOf = (text = 'real') => fingerprintOfText(text);

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

/** The owner's ✓ on each of `ids`, on the text `readBlocks` sees now, given on `day`. */
async function approvedOn(root, ids, day) {
  const blocks = await readBlocks(root);
  return ids.map((id, i) => ({ id: `${day}-${id}`, type: 'approval', page: 'X01', block: id,
    fingerprint: blocks.get(id).fingerprint, author: OWNER, when: `${day}T1${i}:00:00Z`, data: { locks: 'true' } }));
}

const syncing = (t, tmp, events) =>
  printed(t, () => sync(tmp, { events: async () => [BASELINE, ...events] }, { owner: OWNER }));

/** The seal attributes of the block `id` on `html`, names as written, in source order. */
function sealOn(html, id) {
  const el = parseHTML(html).document.querySelector(`[data-id="${id}"]`);
  return Array.from(el.attributes).filter((a) => SEAL_NAMES.includes(a.name.toLowerCase())).map((a) => [a.name, a.value]);
}

// ---------------------------------------------------------------- a new ✓ replaces the seal

test('approve, edit, approve again and sync: the new seal is on the page once, the panel paints it green, and check passes',
  async (t) => {
    const { tmp, sheet, page } = onePage(t, '<main><p data-id="y" data-code="1.1" data-depends="d">the deadline is 24 hours</p>'
      + '<p data-id="d" data-code="1.2">the ground</p></main>');
    const first = await approvedOn(tmp, ['d', 'y'], '2026-09-22');
    await syncing(t, tmp, first);
    writeFileSync(sheet, page().replace('24 hours', '48 hours').replace('the ground', 'the new ground'));
    const second = await approvedOn(tmp, ['d', 'y'], '2026-09-23');

    const { value: r } = await syncing(t, tmp, [...first, ...second]);

    assert.equal(r.added, 2);
    assert.equal(r.refused, 0);
    const blocks = await readBlocks(tmp);
    const registry = loadRegistry(tmp);
    const now = blocks.get('y').fingerprint;
    const snapshot = JSON.stringify({ d: blocks.get('d').fingerprint });
    assert.deepEqual(sealOn(page(), 'y'), [['data-validated', '2026-09-23'], ['data-validated-fingerprint', now],
      ['data-depended-on', snapshot]], 'the three seal attributes carry the new ✓, once each');
    assert.equal(registry.y.fingerprint, now);
    assert.deepEqual(registry.y.dependsOn, JSON.parse(snapshot));

    // The panel's own rule, fed the way engine/web/src/entry.jsx feeds it from the page.
    const el = parseHTML(page()).document.querySelector('[data-id="y"]');
    const situation = blockState([...first, ...second].map((e) => ({ ...e, locks: true })), 'y', now);
    const light = trafficLightOf({ validated: el.getAttribute('data-validated'), fingerprint: now,
      validatedFingerprint: el.getAttribute('data-validated-fingerprint'),
      dependedOn: JSON.parse(el.getAttribute('data-depended-on')) },
    situation, new Map([...blocks].map(([id, b]) => [id, b.fingerprint])));
    assert.equal(light.color, 'valid', 'a block just approved is green, not 🟡');

    const { value: problems, out } = await printed(t, () => check(tmp));
    assert.equal(problems, 0, out);
  });

/**
 * Wherever and however the old seal sits in the tag, a re-approval leaves exactly one lower-case copy
 * of each name with the new value — rewritten where the first copy was, the rest removed — and the
 * rest of the page byte-identical. The neighbour `z` carries a seal and names `y` in its text, so a
 * rewrite that landed anywhere but y's own tag shows. `y` declares no dependency, so a
 * `data-depended-on` it carries is removed, not kept.
 */
const OLD_SEALS = [
  ['sitting before data-id',
    '<p data-validated="2026-01-01" data-validated-fingerprint="0000" data-id="y" data-code="1.1">',
    '<p data-validated="2026-09-22" data-validated-fingerprint="FP" data-id="y" data-code="1.1">'],
  ['sitting after data-id, apart',
    '<p data-id="y" data-validated="2026-01-01" data-code="1.1" data-validated-fingerprint="0000">',
    '<p data-id="y" data-validated="2026-09-22" data-code="1.1" data-validated-fingerprint="FP">'],
  ['single-quoted, a space inside one value',
    '<p data-id="y" data-validated=\'2026-01-01\' data-depended-on=\'{"x": "1"}\' data-validated-fingerprint=\'0000\'>',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  ['unquoted',
    '<p data-id="y" data-validated=2026-01-01 data-validated-fingerprint=0000 data-code="1.1">',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP" data-code="1.1">'],
  ['with no value at all',
    '<p data-id="y" data-validated data-validated-fingerprint>',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  ['with spaces around its =',
    '<p data-id="y" data-validated = "2026-01-01" data-validated-fingerprint="0000">',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  ['in upper case, ahead of a lower-case copy',
    '<p DATA-VALIDATED-FINGERPRINT="0000" data-id="y" data-validated="2026-01-01" data-validated-fingerprint="1111">',
    '<p data-validated-fingerprint="FP" data-id="y" data-validated="2026-09-22">'],
  ['in mixed case, with no lower-case copy',
    '<p data-id="y" Data-Validated="2026-01-01" Data-Validated-Fingerprint="0000" Data-Depended-On="{}">',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  ['as a second copy running into data-id with no space between',
    '<p data-validated-fingerprint="0000" DATA-VALIDATED-FINGERPRINT="1111"data-id="y">',
    '<p data-validated-fingerprint="FP" data-id="y" data-validated="2026-09-22">'],
  // An unquoted value runs to whitespace or `>`, `/` included: stopping at the `/` leaves `/01/01`
  // behind as attributes the browser never sees.
  ['unquoted, with a / inside its value',
    '<p data-id="y" data-validated=2026/01/01 data-validated-fingerprint=0000>',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  // A `/` ends the tag name and separates attributes, as whitespace does.
  ['right behind the tag name, after a /',
    '<p/data-validated="2026-01-01" data-id="y">',
    '<p/data-validated="2026-09-22" data-id="y" data-validated-fingerprint="FP">'],
  // A no-break space is not HTML whitespace: `\u00a0data-validated` is one name, not the seal's, and
  // it stays where it is.
  ['beside a name that starts with a no-break space',
    '<p data-id="y" data-validated-fingerprint="0000"\u00a0data-validated="2026-01-01">',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP"\u00a0data-validated="2026-01-01">'],
  // A lone `=` where a name should start is itself a name, and the attribute after it is the seal's.
  ['after a lone = the browser reads as a name',
    '<p data-id="y" = data-validated="2026-01-01">',
    '<p data-id="y" = data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  // What the seal lacks goes where a first ✓ puts it: the date right after data-id, the rest at the end.
  ['that lacks only data-validated',
    '<p data-id="y" data-code="1.1" data-validated-fingerprint="0000">',
    '<p data-id="y" data-validated="2026-09-22" data-code="1.1" data-validated-fingerprint="FP">'],
  ['that lacks only its fingerprint',
    '<p data-id="y" data-validated="2026-01-01" data-code="1.1">',
    '<p data-id="y" data-validated="2026-09-22" data-code="1.1" data-validated-fingerprint="FP">'],
];

for (const [where, tag, rewritten] of OLD_SEALS) {
  test(`a re-approval replaces an old seal ${where}: one of each, the new values, the rest byte-identical`,
    async (t) => {
      const around = (open) => '<main><p data-id="z" data-code="1.0" data-validated="2026-01-01" '
        + `data-validated-fingerprint="0000">see data-id="y" here</p>${open}real</p><!-- data-validated="x" --></main>`;
      const { tmp, page } = onePage(t, around(tag));
      const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

      assert.equal(r.refused, 0, out);
      const fingerprint = loadRegistry(tmp).y.fingerprint;
      assert.equal(page(), around(rewritten.replace('FP', fingerprint)));
      const names = sealOn(page(), 'y').map(([name]) => name);
      assert.deepEqual(names, [...new Set(names.map((n) => n.toLowerCase()))], 'lower case, and never twice');
    });
}

/**
 * The start tag is found from the `<` nearest before `data-id`. A `<` inside an earlier quoted value
 * hides whatever sits before it — here a seal copy the browser reads first. In upper case, or spelt
 * exactly like the one after it, which the parser drops as a duplicate so that nothing reading the
 * parsed block can count it: either way a rewrite from that `<` leaves it on the page, a second copy
 * of the seal. The write is refused, with the reason, and nothing is recorded.
 */
for (const [what, html] of [
  ['in upper case', '<main><p DATA-VALIDATED-FINGERPRINT="0000" title="a<b" data-id="y" data-validated="2026-01-01">real</p></main>'],
  ['spelt exactly like the copy the ✓ writes', '<main><p data-validated-fingerprint="FP" title="a<b" data-id="y" '
    + 'data-validated="2026-01-01">real</p></main>'],
]) {
  test(`a re-approval refuses, and writes nothing, when a seal copy ${what} sits behind a < it cannot see past`,
    async (t) => {
      const page0 = html.replace('FP', await fingerprintOf());
      const { tmp, page } = onePage(t, page0);

      const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

      assert.equal(r.refused, 1);
      assert.match(out, /✗ y: a "<" inside one of its attribute values hides where its start tag begins/);
      assert.equal(page(), page0);
      assert.equal(loadRegistry(tmp).y, undefined);
    });
}

/**
 * A `<` that starts no tag at all (`x < y`) before data-id: the start tag cannot be found from it,
 * and finding it further back would be a guess, so a re-approval is refused — said, and the page kept.
 */
test('a re-approval refuses, and writes nothing, when a < that starts no tag sits in an earlier value', async (t) => {
  const html = '<main><p title="x < y" data-id="y" data-validated="2026-01-01">real</p></main>';
  const { tmp, page } = onePage(t, html);

  const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

  assert.equal(r.refused, 1);
  assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
  assert.equal(page(), html);
});

/**
 * A block with no seal takes the first-✓ path whatever `sync` asks, and that path reads from the
 * needle on: the `<` inside `title` and the apostrophe after it, which would lead a reading from the
 * nearest `<` into an unclosed value, never come into it. Exactly what holdrim#141 writes.
 */
test('a first ✓ through sync stamps a block whose earlier value holds a < and an apostrophe, as #141 does', async (t) => {
  const { tmp, page } = onePage(t, '<main><p title="a<b c=\'" data-id="y" data-code="1.1">real</p></main>');

  const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

  assert.equal(r.added, 1, out);
  assert.equal(page(), '<main><p title="a<b c=\'" data-id="y" data-validated="2026-09-22" data-code="1.1" '
    + `data-validated-fingerprint="${await fingerprintOf()}">real</p></main>`);
});

/**
 * A ✓ the page already shows needs no write — but only when the page carries exactly that seal: each
 * name once, in lower case, and nothing the ✓ leaves out. A registry with no entry for `y` is what
 * lets `sync` reach the block at all.
 */
const ALREADY = [
  ['keeps no stale data-depended-on beside a date and fingerprint that already match',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP" '
      + 'data-depended-on="{&quot;gone&quot;:&quot;1&quot;}">',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  ['keeps no upper-case name whose value already matches',
    '<p data-id="y" DATA-VALIDATED="2026-09-22" data-validated-fingerprint="FP">',
    '<p data-id="y" data-validated="2026-09-22" data-validated-fingerprint="FP">'],
  ['leaves a single-quoted seal that is already exact untouched, quotes and all',
    '<p data-id="y" data-validated=\'2026-09-22\' data-validated-fingerprint=\'FP\'>',
    '<p data-id="y" data-validated=\'2026-09-22\' data-validated-fingerprint=\'FP\'>'],
];

for (const [what, tag, after] of ALREADY) {
  test(`a ✓ the page already shows ${what}`, async (t) => {
    const fp = await fingerprintOf();
    const { tmp, page } = onePage(t, `<main>${tag.replace('FP', fp)}real</p></main>`);

    const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

    assert.equal(r.added, 1, out);
    assert.equal(page(), `<main>${after.replace('FP', fp)}real</p></main>`);
  });
}

test('a first ✓ on a block with no seal writes it exactly where it always has', async (t) => {
  const { tmp, page } = onePage(t, '<main><p data-id="y" data-code="1.1" title="a>b">real</p></main>');

  await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

  assert.equal(page(), '<main><p data-id="y" data-validated="2026-09-22" data-code="1.1" title="a>b" '
    + `data-validated-fingerprint="${loadRegistry(tmp).y.fingerprint}">real</p></main>`);
});

// ---------------------------------------------------------------- restamp keeps what is there

for (const [what, tag] of [['its only fingerprint is in upper case', '<p data-id="y" DATA-VALIDATED-FINGERPRINT="0000">'],
  ['an upper-case copy sits ahead of the lower-case one',
    '<p data-id="y" DATA-VALIDATED-FINGERPRINT="0000" data-validated-fingerprint="ffffffffffffffff">']]) {
  test(`restamp refuses, and writes nothing, when ${what}`, async (t) => {
    const html = `<main>${tag}real</p></main>`;
    const { tmp, page } = onePage(t, html, { y: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } });

    const { value, out } = await printed(t, () => restamp(tmp));

    assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
    assert.match(out, /✗ y: it carries DATA-VALIDATED-FINGERPRINT, which a browser reads as data-validated-fingerprint/);
    assert.equal(page(), html);
  });
}

test('mark without a new ✓ to replace the seal refuses an upper-case copy too, and records nothing', async (t) => {
  const html = '<main><p data-id="y" Data-Validated="2026-01-01">real</p></main>';
  const { tmp, page } = onePage(t, html);
  const registry = {};

  const { value } = await printed(t, () => mark(tmp, registry, 'y', '2026-09-22', 'test'));

  assert.equal(value, null);
  assert.deepEqual(registry, {});
  assert.equal(page(), html);
});

// ---------------------------------------------------------------- check holds the seal to the registry

/** `y`, depending on `d`, sealed by `seal(fingerprint of y, fingerprint of d)`, recorded as `entry` says. */
async function recorded(t, seal, entry = (fy, fd) => ({ fingerprint: fy, dependsOn: { d: fd } })) {
  const text = '<p data-id="d" data-code="1.2">ground</p>';
  const probe = onePage(t, `<main><p data-id="y" data-code="1.1" data-depends="d">real</p>${text}</main>`);
  const blocks = await readBlocks(probe.tmp);
  const [fy, fd] = [blocks.get('y').fingerprint, blocks.get('d').fingerprint];
  const { tmp } = onePage(t, `<main><p data-id="y" data-code="1.1" data-depends="d" ${seal(fy, fd)}>real</p>${text}</main>`,
    { y: { file: 'X01.html', date: '2026-09-22', ...entry(fy, fd) } });
  return printed(t, () => check(tmp));
}

const snapshotOf = (deps) => JSON.stringify(deps).replace(/"/g, '&quot;');

test('check passes a seal whose fingerprint and dependencies are the registry\'s', async (t) => {
  const { value, out } = await recorded(t, (fy, fd) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="${snapshotOf({ d: fd })}"`);
  assert.equal(value, 0, out);
});

test('check counts a page fingerprint that is not the registry\'s as a problem', async (t) => {
  const { value, out } = await recorded(t, (fy, fd) =>
    `data-validated="2026-09-22" data-validated-fingerprint="0000000000000000" data-depended-on="${snapshotOf({ d: fd })}"`);
  assert.equal(value, 1, out);
  assert.match(out, /✗ y: the page's data-validated-fingerprint \(0000000000000000\) is not the registry's/);
});

test('check counts a missing data-validated-fingerprint as a problem', async (t) => {
  const { value, out } = await recorded(t, (fy, fd) =>
    `data-validated="2026-09-22" data-depended-on="${snapshotOf({ d: fd })}"`);
  assert.equal(value, 1, out);
  assert.match(out, /✗ y: the page carries no data-validated-fingerprint/);
});

test('check counts a data-depended-on that is not the registry\'s dependsOn as a problem', async (t) => {
  const { value, out } = await recorded(t, (fy) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="${snapshotOf({ d: '0000000000000000' })}"`);
  assert.equal(value, 1, out);
  assert.match(out, /✗ y: the page's data-depended-on \(\{"d":"0000000000000000"\}\) is not the registry's dependsOn/);
});

test('check counts a data-depended-on that is not a JSON object as a problem', async (t) => {
  const { value, out } = await recorded(t, (fy) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="[]"`);
  assert.equal(value, 1, out);
  assert.match(out, /✗ y: the page's data-depended-on is not a JSON object/);
});

test('check counts a data-depended-on the registry does not record as a problem, and passes an empty one', async (t) => {
  const none = (fy) => ({ fingerprint: fy });
  const extra = await recorded(t, (fy, fd) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="${snapshotOf({ d: fd })}"`, none);
  assert.equal(extra.value, 1, extra.out);
  const empty = await recorded(t, (fy) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="{}"`, none);
  assert.equal(empty.value, 0, empty.out);
});

test('check counts a seal attribute name that is not lower case as a problem, even where its value matches',
  async (t) => {
    const { value, out } = await recorded(t, (fy, fd) =>
      `data-validated="2026-09-22" DATA-VALIDATED-FINGERPRINT="${fy}" data-depended-on="${snapshotOf({ d: fd })}"`);
    assert.equal(value, 1, out);
    assert.match(out, /✗ y: carries DATA-VALIDATED-FINGERPRINT, which a browser reads as data-validated-fingerprint/);
  });

test('check counts an upper-case seal on a block the registry never recorded, which orphanMarks cannot see',
  async (t) => {
    const { tmp } = onePage(t, '<main><p data-id="y" DATA-VALIDATED="2026-09-22">real</p></main>');
    const { value, out } = await printed(t, () => check(tmp));
    assert.equal(value, 1, out);
    assert.match(out, /✗ y: carries DATA-VALIDATED/);
  });

test('check counts a data-depended-on missing a dependency the registry records as a problem', async (t) => {
  const { value, out } = await recorded(t, (fy, fd) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="${snapshotOf({ d: fd })}"`,
  (fy, fd) => ({ fingerprint: fy, dependsOn: { d: fd, e: '1111111111111111' } }));
  assert.equal(value, 1, out);
  assert.match(out, /✗ y: the page's data-depended-on \(\{"d":"[0-9a-f]+"\}\) is not the registry's dependsOn/);
});

test('check passes a data-depended-on whose keys are written in another order than the registry\'s', async (t) => {
  const { value, out } = await recorded(t, (fy, fd) =>
    `data-validated="2026-09-22" data-validated-fingerprint="${fy}" data-depended-on="${snapshotOf({ e: '1111111111111111', d: fd })}"`,
  (fy, fd) => ({ fingerprint: fy, dependsOn: { d: fd, e: '1111111111111111' } }));
  assert.equal(value, 0, out);
});

test('check names the fingerprint a browser reads — the first copy, in upper case — not the later lower-case one',
  async (t) => {
    const { value, out } = await recorded(t, (fy, fd) => 'data-validated="2026-09-22" '
      + `DATA-VALIDATED-FINGERPRINT="0000000000000000" data-validated-fingerprint="${fy}" data-depended-on="${snapshotOf({ d: fd })}"`);
    assert.equal(value, 2, out);
    assert.match(out, /✗ y: the page's data-validated-fingerprint \(0000000000000000\) is not the registry's/);
  });

// ---------------------------------------------------------------- check sees every block a browser sees

/**
 * A browser reads an attribute name in any case, and selects `main [data-id]` whatever the case of
 * the name. linkedom, and so every sweep of `check` built on `readBlocks`, reads the lower-case name
 * only. Each page below shows a reader a block, or a seal, that no other line of `check` reports.
 */
test('check counts a block whose every name is in upper case, seal included, though it is on no other list',
  async (t) => {
    const { tmp } = onePage(t, '<main><p DATA-ID="z" DATA-CODE="1.2" DATA-VALIDATED="2026-01-01" '
      + `DATA-VALIDATED-FINGERPRINT="${await fingerprintOf()}">real</p></main>`);
    const { value, out } = await printed(t, () => check(tmp));
    assert.equal(value, 4, out);
    for (const name of ['DATA-ID', 'DATA-CODE', 'DATA-VALIDATED', 'DATA-VALIDATED-FINGERPRINT']) {
      assert.match(out, new RegExp(`✗ z: carries ${name}, which a browser reads as ${name.toLowerCase()} `));
    }
  });

test('check names a block by the id a browser reads — the first, whatever its case — and an element with none by its page',
  async (t) => {
    const { tmp } = onePage(t, '<main><div DATA-DEPENDS="x"><p Data-Id="q" data-id="y">real</p></div></main>');
    const { value, out } = await printed(t, () => check(tmp));
    assert.equal(value, 2, out);
    assert.match(out, /✗ p\/X01\.html: carries DATA-DEPENDS, which a browser reads as data-depends/);
    assert.match(out, /✗ q: carries Data-Id, which a browser reads as data-id/);
  });

/**
 * `readBlocks` files blocks by id and keeps the last, so a second block under a registered id, sealed
 * against its own text, passes every sweep that reads the map — while the browser paints both.
 */
const Y_SEALED = async () => `<p data-id="y" data-code="1.1" data-validated="2026-09-22" data-validated-fingerprint="${await fingerprintOf()}">real</p>`;
const Y_ENTRY = async () => ({ y: { file: 'X01.html', date: '2026-09-22', fingerprint: await fingerprintOf() } });

test('check counts an id carried by two blocks on one page as a problem', async (t) => {
  const { tmp } = onePage(t, `<main>${await Y_SEALED()}${await Y_SEALED()}</main>`, await Y_ENTRY());
  const { value, out } = await printed(t, () => check(tmp));
  assert.equal(value, 1, out);
  assert.match(out, /✗ y: carried by 2 blocks \(p\/X01\.html, p\/X01\.html\)/);
});

test('check counts an id carried by blocks on two pages, one of them in upper case, as a problem', async (t) => {
  const { tmp } = onePage(t, `<main>${await Y_SEALED()}</main>`, await Y_ENTRY());
  secondPage(tmp, `<main>${(await Y_SEALED()).replace('data-id', 'DATA-ID')}</main>`);
  const { value, out } = await printed(t, () => check(tmp));
  // Three lines: the twin, its upper-case name, and — from `orphanMarks` — its lower-case seal on a
  // block that sweep finds no data-id on.
  assert.equal(value, 3, out);
  assert.match(out, /✗ y: carried by 2 blocks \(p\/X01\.html, p\/X02\.html\)/);
  assert.match(out, /✗ y: carries DATA-ID/);
  assert.match(out, /a validated mark on a block with NO data-id/);
});

// ---------------------------------------------------------------- no seal on a page a browser reads otherwise

test('sync refuses a ✓, and writes nothing, when another page carries the same id in upper case', async (t) => {
  const html = '<main><p data-id="y" data-code="1.1">real</p></main>';
  const { tmp, page } = onePage(t, html);
  const other = secondPage(tmp, '<main><p DATA-ID="y">real</p></main>');

  const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

  assert.equal(r.refused, 1);
  assert.match(out, /✗ y: p\/X02\.html carries DATA-ID, which a browser reads as data-id and this engine does not, so no seal is written on that page; nothing written/);
  assert.equal(page(), html);
  assert.equal(other(), '<main><p DATA-ID="y">real</p></main>');
  assert.equal(loadRegistry(tmp).y, undefined);
});

test('restamp refuses, and writes nothing, on a page where the block\'s id is not the one a browser reads', async (t) => {
  const html = '<main><p Data-Id="q" data-id="y">real</p></main>';
  const { tmp, page } = onePage(t, html, { y: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' } });

  const { value, out } = await printed(t, () => restamp(tmp));

  assert.deepEqual(value, { written: 0, alreadyHad: 0, noSuchBlock: 0, refused: 1 });
  assert.match(out, /✗ y: p\/X01\.html carries Data-Id/);
  assert.equal(page(), html);
});

test('a page where no block reads as the id is no reason to refuse it', async (t) => {
  const { tmp, page } = onePage(t, '<main><p data-id="y" data-code="1.1">real</p></main>');
  secondPage(tmp, '<main><p DATA-ID="z">other</p></main>');

  const { value: r, out } = await syncing(t, tmp, await approvedOn(tmp, ['y'], '2026-09-22'));

  assert.equal(r.added, 1, out);
  assert.match(page(), /data-validated="2026-09-22"/);
});
