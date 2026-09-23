/**
 * `holdrim export`: the documentation as plain files anyone can read, and nothing else.
 *
 * Publishing is the one command that sends files out of the project, to a host anyone can reach.
 * So what it must NOT copy is proved as carefully as what it must: the config and the approvals
 * registry stay home, a secret with an unexpected name stays home, and the text a reader sees is,
 * fingerprint for fingerprint, the text that was approved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSite, withoutPanel } from '../cli/export.ts';
import { readBlocks } from '../cli/pages.ts';

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="../style/s.css">
<link rel="stylesheet" href="/engine/web/panel.css">
</head><body><main>
<h1 class="doc-title"><span class="doc-title__code">A01</span> A page</h1>
<p data-id="A01.1.1" data-code="1.1" data-validated="2026-09-20">The approved text.</p>
</main>
<script type="module" src="/engine/web/panel-react.js"></script>
</body></html>`;

/** A folder that is removed when the test ends, whatever happens in it. */
function scratch(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(t) {
  const root = scratch(t, 'holdrim-export-');
  mkdirSync(join(root, 'pages')); mkdirSync(join(root, 'style')); mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'pages', 'A01.html'), PAGE);
  writeFileSync(join(root, 'style', 's.css'), 'body { color: black }');
  writeFileSync(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'holdrim.json'), '{ "owner": "someone@example.org" }');
  writeFileSync(join(root, 'approvals.json'), '{}');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, 'notes.txt'), 'private notes');
  writeFileSync(join(root, 'data', 'events.db'), 'binary');
  // A page's extension inside a folder that is tooling or data: the folder is not walked at all.
  writeFileSync(join(root, 'data', 'dump.html'), '<p>an export of the events</p>');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.html'), '<p>a dependency</p>');
  // Written by a tool that capitalises: still an image, still published. Its name differs from
  // logo.svg by more than case: on a disk that folds case, macOS's default, the two would be one
  // file, and the test would fail there for a reason no change to the export can fix.
  writeFileSync(join(root, 'Banner.SVG'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}

test('only what a browser renders goes out: never the config, the registry or anything unexpected', (t) => {
  const root = project(t);
  const out = join(scratch(t, 'holdrim-out-'), 'public');
  const counted = exportSite(root, out);
  const files = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]).sort();
  assert.deepEqual(files(out), ['Banner.SVG', 'logo.svg', 'pages/A01.html', 'style/s.css'],
    'an extension in capitals is the same extension; node_modules and data are never walked');
  assert.deepEqual(counted, { pages: 1, files: 3 });
});

test('the panel comes out of every page, and the approved text does not change by a letter', async (t) => {
  const root = project(t);
  const out = join(scratch(t, 'holdrim-out-'), 'public');
  exportSite(root, out);
  const html = readFileSync(join(out, 'pages', 'A01.html'), 'utf8');
  assert.doesNotMatch(html, /\/engine\//, 'nothing asks a static host for the engine');
  assert.match(html, /href="\.\.\/style\/s\.css"/, "the page's own stylesheet stays");
  const before = [...(await readBlocks(root)).values()].map((b) => b.fingerprint);
  const after = [...(await readBlocks(out)).values()].map((b) => b.fingerprint);
  assert.deepEqual(after, before);
});

test('a folder with anything in it is refused, and nothing in it is touched', (t) => {
  const root = project(t);
  const out = scratch(t, 'holdrim-out-');
  writeFileSync(join(out, 'keep.txt'), 'somebody else’s');
  assert.throws(() => exportSite(root, out), /not empty, and nothing is deleted/);
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'somebody else’s');
});

test('an output folder that is a link is refused, and nothing reaches where it points', (t) => {
  const root = project(t);
  const elsewhere = scratch(t, 'holdrim-elsewhere-');
  symlinkSync(elsewhere, join(root, 'public'));
  assert.throws(() => exportSite(root, join(root, 'public')), /it is a link/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('an export written inside the project is not copied into itself', (t) => {
  const root = project(t);
  exportSite(root, join(root, 'public'));
  assert.equal(existsSync(join(root, 'public', 'pages', 'A01.html')), true);
  assert.equal(existsSync(join(root, 'public', 'public')), false);
});

test('a link is not followed: what it points at outside the project stays there', (t) => {
  const root = project(t);
  const elsewhere = scratch(t, 'holdrim-elsewhere-');
  writeFileSync(join(elsewhere, 'private.html'), '<p>not part of the documentation</p>');
  symlinkSync(elsewhere, join(root, 'pages', 'linked'));
  symlinkSync(join(elsewhere, 'private.html'), join(root, 'pages', 'B01.html'));
  const out = join(scratch(t, 'holdrim-out-'), 'public');
  exportSite(root, out);
  assert.equal(existsSync(join(out, 'pages', 'linked')), false, 'a linked folder is not walked');
  assert.equal(existsSync(join(out, 'pages', 'B01.html')), false, 'a linked page is not copied');
});

test('withoutPanel removes the engine\'s tags and only those', () => {
  const kept = '<script src="https://cdn.example.org/x.js"></script>\n<link rel="stylesheet" href="own.css">';
  assert.equal(withoutPanel(`${kept}\n<script type="module" src="/engine/web/panel-react.js"></script>\n`), `${kept}\n`);
});
