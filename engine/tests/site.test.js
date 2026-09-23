/**
 * Holdrim's own site, `site/`, is a Holdrim project, and the one strangers read first.
 *
 * `holdrim check` holds only what was validated, and a page nobody has approved yet passes it
 * whatever is wrong with it — a block id written twice, a dependency on a block that is gone, a
 * menu link to a page that was renamed. Those are the mistakes a site makes while it is being
 * written, which is exactly when nobody has approved anything. So they are held here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBlocks } from '../cli/pages.ts';
import { exportSite } from '../cli/export.ts';

const SITE = join(new URL('../../', import.meta.url).pathname, 'site');
const PAGES = readdirSync(join(SITE, 'pages')).filter((f) => f.endsWith('.html')).sort();
const read = (file) => readFileSync(join(SITE, 'pages', file), 'utf8');

test('every block is written once, under its own page code', async () => {
  const written = PAGES.flatMap((file) => [...read(file).matchAll(/data-id="([^"]+)"/g)]
    .map(([, id]) => ({ file, id })));
  const blocks = await readBlocks(SITE);
  assert.equal(blocks.size, written.length, 'an id written twice is read once, and one block disappears');
  for (const { file, id } of written) assert.ok(id.startsWith(`${file.replace('.html', '')}.`), `${id} in ${file}`);
});

test('every dependency points at a block that exists', async () => {
  const blocks = await readBlocks(SITE);
  const dangling = [...blocks.values()].flatMap((b) => b.dependsOn.filter((d) => !blocks.has(d))
    .map((d) => `${b.id} → ${d}`));
  assert.deepEqual(dangling, []);
});

test('the menu on every page lists every page, and marks the one it is on', () => {
  for (const file of PAGES) {
    const nav = read(file).match(/<nav class="site-nav">([\s\S]*?)<\/nav>/)?.[1] ?? '';
    const links = [...nav.matchAll(/href="([^"]+)"/g)].map(([, href]) => href);
    assert.deepEqual(links, PAGES, `${file}: a link to a page that is not there, or a page missing from the menu`);
    assert.match(nav, new RegExp(`href="${file}" aria-current="page"`), `${file} does not mark itself`);
  }
});

test('published, it is five pages anyone can read, and nothing of the engine', (t) => {
  const out = join(mkdtempSync(join(tmpdir(), 'holdrim-site-')), 'public');
  t.after(() => rmSync(join(out, '..'), { recursive: true, force: true }));
  exportSite(SITE, out);
  assert.deepEqual(readdirSync(join(out, 'pages')).sort(), PAGES);
  assert.deepEqual(readdirSync(out).sort(), ['index.html', 'pages', 'style'], 'no holdrim.json, no approvals.json');
  for (const file of PAGES) assert.doesNotMatch(readFileSync(join(out, 'pages', file), 'utf8'), /\/engine\//);
});
