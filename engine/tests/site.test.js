/**
 * Holdrim's own site, `site/`, is a Holdrim project, and the one strangers read first.
 *
 * `holdrim check` holds only what was validated, and a page nobody has approved yet passes it
 * whatever is wrong with it — a block id written twice, a dependency on a block that is gone, a
 * menu link to a page that was renamed. Those are the mistakes a site makes while it is being
 * written, which is exactly when nobody has approved anything. So they are held here.
 *
 * The site also carries a Portuguese and a Spanish translation of every page (issue #56), each
 * block depending on the English original through `data-depends` — the same mechanism any two
 * blocks on the site already use (`S02.1.3` on `S02.1.2`), not a second one built for translations.
 * `readBlocks` reads all three languages because `site/holdrim.json`'s `content.folders` names all
 * three: a translation that is not in that list is never scanned, never fingerprinted, and its ✓
 * would never turn red — so the folder list is read from there, not hard-coded here, and a language
 * added to the config without a matching folder fails the very first test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readBlocks, sheetFolders } from '../cli/pages.ts';
import { pageOfBlock } from '../core/roles.js';
import { trafficLight } from '../core/validity.js';
import { exportSite } from '../cli/export.ts';

const SITE = join(new URL('../../', import.meta.url).pathname, 'site');

/** Every content folder `site/holdrim.json` names, resolved exactly as the engine resolves them —
 *  never a second, hand-written list that could name three languages while the config names two. */
const FOLDERS = sheetFolders(SITE);

/** `{folder, files}` for each configured folder: its own `.html` pages, in the order a person reads
 *  them (`localeCompare` with `numeric: true`, the same order `sheetFiles` itself sorts by). */
const BY_FOLDER = FOLDERS.map((folder) => ({
  folder,
  files: readdirSync(folder).filter((f) => f.endsWith('.html'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
}));

const read = (folder, file) => readFileSync(join(folder, file), 'utf8');

test('the three languages are exactly the folders site/holdrim.json configures', () => {
  // Not a tautology: FOLDERS already comes from the config, so this instead pins the SHAPE anyone
  // reading this file would expect — one English folder and one per translation — so a folder that
  // silently stopped resolving (a typo in holdrim.json, caught nowhere else in this file) fails here
  // first, with a clear count, rather than as a mysteriously smaller total further down.
  assert.equal(FOLDERS.length, 3, 'expected the English pages plus one folder per translation');
  assert.ok(FOLDERS.every((f) => existsSync(f)), 'a configured language folder is missing on disk');
});

for (const { folder, files } of BY_FOLDER) {
  const label = relative(SITE, folder) || '.';

  test(`${label}: every block is written once, under its own page code`, async () => {
    const written = files.flatMap((file) => [...read(folder, file).matchAll(/data-id="([^"]+)"/g)]
      .map(([, id]) => ({ file, id })));
    const blocks = await readBlocks(SITE);
    const inThisFolder = written.map(({ id }) => id);
    for (const { file, id } of written) {
      assert.ok(id.startsWith(`${file.replace('.html', '')}.`), `${id} in ${label}/${file}`);
    }
    for (const id of inThisFolder) assert.ok(blocks.has(id), `${id} did not survive readBlocks`);
    // "Once" checked explicitly, not inferred from `blocks.has` above: `readBlocks` COLLAPSES a
    // repeated id into a single entry, so every check that only asks "is this id there?" stays green
    // even when it was written twice in the same file — the exact case this test exists to catch.
    // Comparing set size against array length here, per folder, still points at the right file when
    // the other two languages' own ids are not in scope to blur the count.
    const distinct = new Set(inThisFolder);
    assert.equal(distinct.size, inThisFolder.length,
      `${label}: an id is written twice (${inThisFolder.filter((id, i) => inThisFolder.indexOf(id) !== i).join(', ')})`);
  });

  test(`${label}: the menu on every page lists every page here, and marks the one it is on`, () => {
    for (const file of files) {
      const nav = read(folder, file).match(/<nav class="site-nav">([\s\S]*?)<\/nav>/)?.[1] ?? '';
      const links = [...nav.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);
      assert.deepEqual(links, files, `${label}/${file}: a link to a page that is not there, or one missing from the menu`);
      assert.match(nav, new RegExp(`href="${file}" aria-current="page"`), `${label}/${file} does not mark itself`);
    }
  });

  test(`${label}: the language switch on every page reaches a real file, and marks the one it is on`, () => {
    for (const file of files) {
      const html = read(folder, file);
      const nav = html.match(/<nav class="lang-nav">([\s\S]*?)<\/nav>/)?.[1];
      assert.ok(nav, `${label}/${file} carries no language switch`);
      const links = [...nav.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);
      assert.equal(links.length, 3, `${label}/${file}: the language switch should offer all three languages`);
      for (const href of links) {
        assert.ok(existsSync(join(folder, href)), `${label}/${file}: language switch link "${href}" leads nowhere`);
      }
      // Exactly one of the three is this very page, marked the way `site-nav` marks itself.
      const current = [...nav.matchAll(/href="([^"]+)" aria-current="page"/g)].map(([, href]) => href);
      assert.deepEqual(current, [file], `${label}/${file}: the language switch should mark itself, not another language`);
    }
  });
}

test('no id is written twice across the whole site, not only within one folder', async () => {
  // The per-folder test above catches a duplicate a person is most likely to make — repeating an id
  // inside one page or one language — by comparing a Set against an array's length. This one closes
  // the gap that leaves open: the SAME id written in two different folders (an English page and a
  // translation, say) never fails either folder's own check on its own, since each looks only at
  // what it wrote itself.
  const written = BY_FOLDER.flatMap(({ folder, files }) =>
    files.flatMap((file) => [...read(folder, file).matchAll(/data-id="([^"]+)"/g)].map(([, id]) => id)));
  const blocks = await readBlocks(SITE);
  // `readBlocks` collapses a repeated id into one entry (docs/GLOSSARY.md never promises otherwise),
  // so a shrunk `blocks.size` against everything written is the one signal that something collided.
  assert.equal(blocks.size, written.length, 'an id written twice is read once, and one block disappears');
});

test('every dependency points at a block that exists', async () => {
  const blocks = await readBlocks(SITE);
  const dangling = [...blocks.values()].flatMap((b) => b.dependsOn.filter((d) => !blocks.has(d))
    .map((d) => `${b.id} → ${d}`));
  assert.deepEqual(dangling, []);
});

/**
 * The block a translated id names as its own original: `S01-pt.1.1` → `S01.1.1`. `null` for a block
 * that is not a translation at all (its page code carries no `-pt`/`-es`), so the tests below only
 * ever look at blocks the site actually translates.
 */
function originalOf(id) {
  const page = pageOfBlock(id);
  const m = page.match(/^(.+)-(pt|es)$/);
  if (!m) return null;
  return m[1] + id.slice(page.length);
}

test('every translated block depends on exactly the block it translates', async () => {
  const blocks = await readBlocks(SITE);
  const translated = [...blocks.values()].filter((b) => originalOf(b.id));
  assert.ok(translated.length > 0, 'no translated block was found — did content.folders lose a language?');
  for (const block of translated) {
    assert.deepEqual(block.dependsOn, [originalOf(block.id)],
      `${block.id} should depend on exactly ${originalOf(block.id)} and nothing else`);
  }
});

/**
 * The point of `data-depends`, proved rather than assumed: with every block "approved" at its
 * current text (the `records` built below, standing in for the registry a real ✓ would write), an
 * edit to an ENGLISH original — simulated by swapping only its fingerprint, the way a real text
 * change would — turns its translations 🔴 `broken` through `trafficLight`, the exact function the
 * server and `holdrim lights` both call. The original itself reads 🟡 `stale`, never 🔴: yellow is
 * about a block's OWN text, and always outranks a dependency (docs/GLOSSARY.md, "Yellow beats red").
 *
 * MUTATION: delete a `data-depends="…"` from any translated block in `site/pages/{pt-BR,es}` and
 * this test fails, because `stateOf` then finds nothing recorded for that block to have moved.
 */
test('a change to the English original turns its translations broken, not the other way round', async () => {
  const blocks = await readBlocks(SITE);

  // The registry a ✓ on every block, right now, would write: `stateOf` reads a dependency's
  // fingerprint from the moment of approval, not from the live text — that is what makes 🔴
  // possible at all (docs/IMPACT.md, "the ground at ✓ time").
  const records = {};
  for (const [id, block] of blocks) {
    const dependsOn = {};
    for (const dep of block.dependsOn) dependsOn[dep] = blocks.get(dep).fingerprint;
    records[id] = { fingerprint: block.fingerprint, dependsOn };
  }

  // Sanity check on the fixture itself: before anything changes, every block reads valid. A test
  // that starts from a state it does not understand cannot trust what it reads after the edit.
  const before = trafficLight(blocks, records);
  assert.equal(before.tally.stale, 0, 'the fixture should start with nothing stale');
  assert.equal(before.tally.broken, 0, 'the fixture should start with nothing broken');

  // Every English original, and the translated ids that name it as their own (`originalOf`, from
  // the ID ALONE — never from `dependsOn`, or a translation that lost its `data-depends` would
  // silently drop out of its own expected set instead of being caught missing it).
  const translationsOf = new Map();
  for (const block of blocks.values()) {
    const originalId = originalOf(block.id);
    if (!originalId) continue;
    if (!translationsOf.has(originalId)) translationsOf.set(originalId, []);
    translationsOf.get(originalId).push(block.id);
  }
  assert.ok(translationsOf.size > 0, 'no original block has a translation naming it');

  for (const [originalId, translationIds] of translationsOf) {
    // Simulate editing ONLY this one original: its fingerprint moves, every other block's does not.
    const edited = new Map(blocks);
    edited.set(originalId, { ...blocks.get(originalId), fingerprint: 'edited0000000000' });

    const after = trafficLight(edited, records);
    assert.equal(after.byBlock.get(originalId).state, 'stale',
      `${originalId} itself should read stale — its own text is what changed`);

    for (const translationId of translationIds) {
      assert.equal(after.byBlock.get(translationId).state, 'broken',
        `${translationId} should turn broken when ${originalId}, the block it translates, changes`);
    }
  }
});

test('published, every page — English and both translations — is readable, and nothing of the engine', (t) => {
  const out = join(mkdtempSync(join(tmpdir(), 'holdrim-site-')), 'public');
  t.after(() => rmSync(join(out, '..'), { recursive: true, force: true }));
  exportSite(SITE, out);

  // Every page path, relative to `site/pages`, across all three languages — built the same way the
  // per-folder tests above build `files`, so this list changes automatically with them.
  const expected = BY_FOLDER.flatMap(({ folder, files }) =>
    files.map((f) => join(relative(join(SITE, 'pages'), folder), f)));

  // A plain recursive walk of the exported `pages/`, paths relative to it — so a translation's own
  // subfolder is walked exactly like the top-level English one, with no separate case for either.
  const pagesOut = join(out, 'pages');
  const collect = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? collect(full, base) : [relative(base, full)];
  });

  assert.deepEqual(collect(pagesOut).sort(), expected.sort());
  assert.deepEqual(readdirSync(out).sort(), ['index.html', 'pages', 'style'], 'no holdrim.json, no approvals.json');
  for (const rel of expected) assert.doesNotMatch(readFileSync(join(pagesOut, rel), 'utf8'), /\/engine\//);
});
