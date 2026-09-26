import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, cpSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { restamp } from '../cli/validation.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

/** A throwaway copy of the hello world, with an approvals registry we control. */
function project(t, registry) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-restamp-'));
  cpSync(join(ROOT, 'examples', 'hello-world'), dir, { recursive: true });
  writeFileSync(join(dir, 'approvals.json'), JSON.stringify(registry));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pageOf = (dir) => readFileSync(join(dir, 'pages', 'A01.html'), 'utf8');

test('writes the fingerprint FROM THE REGISTRY, not the one computed now', async (t) => {
  // The whole point. A block whose text changed after the ✓ must be stamped with the OLD
  // fingerprint, so the browser paints it 🟡. Stamping the current text would be a silent
  // re-approval — the command meant to reveal the drift would erase it instead.
  const dir = project(t, { 'A01.1.1': { file: 'A01.html', fingerprint: 'ffffffffffffffff', date: '2026-01-01' } });
  await restamp(dir);
  assert.match(pageOf(dir), /data-id="A01\.1\.1"[^>]*data-validated-fingerprint="ffffffffffffffff"/,
    'stamped what the registry recorded');
  assert.doesNotMatch(pageOf(dir), /data-validated-fingerprint="(?!ffffffffffffffff)/,
    'no block got a freshly computed fingerprint');
});

test('does not touch a block that already carries the mark', async (t) => {
  const dir = project(t, { 'A01.1.1': { file: 'A01.html', fingerprint: 'aaaaaaaaaaaaaaaa', date: '2026-01-01' } });
  await restamp(dir);
  const once = pageOf(dir);
  // The count, not only the bytes: a version that writes the SAME content back and still calls it
  // "written" would pass the byte-comparison below by accident, since re-writing identical content
  // changes nothing on disk either way.
  const second = await restamp(dir);
  assert.equal(second.written, 0, 'the second, idempotent run must report nothing written');
  assert.equal(pageOf(dir), once);
  assert.equal((once.match(/data-validated-fingerprint/g) ?? []).length, 1);
});

test('carries over what the block depended on, when the registry recorded it', async (t) => {
  const dir = project(t, {
    'A01.1.1': { file: 'A01.html', fingerprint: 'bbbbbbbbbbbbbbbb', date: '2026-01-01', dependsOn: { 'A02.1.1': 'cccccccccccccccc' } },
  });
  await restamp(dir);
  assert.match(pageOf(dir), /data-depended-on="[^"]*A02\.1\.1/, 'without this there is no 🔴 in the browser');
});

test('an entry with no recorded fingerprint is skipped, not invented', async (t) => {
  const dir = project(t, { 'A01.1.1': { file: 'A01.html', date: '2026-01-01' } });
  assert.equal((await restamp(dir)).written, 0);
  assert.doesNotMatch(pageOf(dir), /data-validated-fingerprint/);
});

/** A throwaway project whose one page is `html`, with `registry` as its approvals record. */
function onePage(t, html, registry) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-restamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ content: { folders: ['p'], registry: 'r.json' } }));
  writeFileSync(join(dir, 'p', 'X01.html'), html);
  writeFileSync(join(dir, 'r.json'), JSON.stringify(registry));
  return dir;
}

/** `restamp` on `dir`, with what it printed, and how long it took. */
async function restamping(t, dir) {
  const lines = [];
  const log = t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  try {
    const started = performance.now();
    const value = await restamp(dir);
    return { value, out: lines.join('\n'), took: performance.now() - started };
  } finally {
    log.mock.restore();
  }
}

/**
 * A page of `n` recorded blocks, each depending on the one before it, and — half-way down — one more
 * whose `it's` makes its fingerprint land in the next block's end tag, where the parser drops it. That
 * entry is refused on every run, so the page is never accepted whole and the halving that isolates it
 * is part of what is timed.
 */
function recordedPage(n) {
  const html = '<html><head><title>x</title></head><body><main>\n' + Array.from({ length: n }, (_, i) =>
    (i === Math.floor(n / 2) ? '<p data-id="X01.odd" it\'s>refused on every run</p>\n' : '')
    + `<p data-id="X01.1.${i}" data-code="1.${i}"${i ? ` data-depends="X01.1.${i - 1}"` : ''}>block ${i}'s text</p>\n`)
    .join('') + '</main></body></html>';
  const registry = { 'X01.odd': { file: 'X01.html', date: '2026-09-22', fingerprint: 'eeeeeeeeeeeeeeee' } };
  for (let i = 0; i < n; i++) {
    registry[`X01.1.${i}`] = { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff',
      ...(i ? { dependsOn: { [`X01.1.${i - 1}`]: 'cccccccccccccccc' } } : {}) };
  }
  return { html, registry };
}

/**
 * A first restamp of every recorded block on a page, then a second that finds every mark already
 * there, timed for 200 blocks and for 800 (holdrim#147). Resolved and spliced entry by entry, each
 * one re-read, re-parsed and re-verified the whole page, so four times the blocks cost sixteen times as
 * long; per page, about four. The bound is 8×, halfway, and each size is timed
 * twice with its faster run kept, so a busy runner that slows both sizes alike does not move the ratio.
 */
test('restamp is linear in the blocks of a page: 800 blocks, first and second run, well under 8× what 200 take',
  async (t) => {
    const cost = async (n) => {
      let best = Infinity;
      for (let run = 0; run < 2; run++) {
        const { html, registry } = recordedPage(n);
        const dir = onePage(t, html, registry);
        const first = await restamping(t, dir);
        assert.deepEqual(first.value, { written: n, alreadyHad: 0, noSuchBlock: 0, refused: 1 }, first.out.slice(-500));
        assert.match(first.out, /✗ X01\.odd: could not locate its tag without risking another block; nothing written/);
        const again = await restamping(t, dir);
        assert.deepEqual(again.value, { written: 0, alreadyHad: n, noSuchBlock: 0, refused: 1 }, again.out.slice(-500));
        best = Math.min(best, first.took + again.took);
      }
      return best;
    };
    await cost(50); // warm-up: the first parse of anything pays for the JIT, and would count against 200.
    const small = await cost(200);
    const large = await cost(800);

    assert.ok(large / small < 8, `200 blocks took ${Math.round(small)} ms and 800 took ${Math.round(large)} ms: `
      + `${(large / small).toFixed(1)}×, where linear is about 4× and per-block is about 16×`);
  });

/**
 * restamp fills in only what is missing (`MarkPlan.replace` is never set): a fingerprint already on
 * the block stays, even one the registry disagrees with, so `check` reports the disagreement instead
 * of a command nobody reviews the output of settling it in the registry's favour. Batched with a
 * neighbour that does get its mark, the page is written — and this block is still left as it was.
 */
test('restamp keeps a fingerprint the page already carries, even one the registry disagrees with', async (t) => {
  const kept = '<p data-id="y" data-validated-fingerprint="0000000000000000">real</p>';
  const dir = onePage(t, `<main>${kept}<p data-id="z">other</p></main>`, {
    y: { file: 'X01.html', date: '2026-09-22', fingerprint: 'ffffffffffffffff' },
    z: { file: 'X01.html', date: '2026-09-22', fingerprint: 'eeeeeeeeeeeeeeee' },
  });

  const { value } = await restamping(t, dir);

  assert.deepEqual(value, { written: 1, alreadyHad: 1, noSuchBlock: 0, refused: 0 });
  assert.equal(readFileSync(join(dir, 'p', 'X01.html'), 'utf8'),
    `<main>${kept}<p data-id="z" data-validated-fingerprint="eeeeeeeeeeeeeeee">other</p></main>`);
});

/** A throwaway project with the pages in `files` (`X01.html` → its html) and `registry` as its record. */
function pages(t, files, registry) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-restamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'p'));
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ content: { folders: ['p'], registry: 'r.json' } }));
  writeFileSync(join(dir, 'r.json'), JSON.stringify(registry));
  for (const [name, html] of Object.entries(files)) writeFileSync(join(dir, 'p', name), html);
  return dir;
}

/** `restamp` on `dir`, running `meanwhile` on `X02.html` right before that page is read. */
async function restampingWhile(t, dir, meanwhile) {
  const lines = [];
  const log = t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  try {
    const value = await restamp(dir, { beforeRead: (path) => { if (path.endsWith('X02.html')) meanwhile(path); } });
    return { value, out: lines.join('\n') };
  } finally {
    log.mock.restore();
  }
}

const RECORDED = {
  a: { file: 'X01.html', date: '2026-09-22', fingerprint: 'aaaaaaaaaaaaaaaa' },
  b: { file: 'X02.html', date: '2026-09-22', fingerprint: 'bbbbbbbbbbbbbbbb' },
};

/**
 * A page is located at the start of the run and stamped when its turn comes, so the page read then
 * has to be the page located. An edit that keeps the length is an edit: moving `b`'s id off its block,
 * which stamped from what locating decided lands nowhere, and a name elsewhere on the page — `DATA-ID`,
 * which a browser reads as `data-id` and this engine does not, so the page takes no seal at all — which
 * only comparing the whole page's text sees. Either way `b` is resolved afresh, entry by entry, and `a`,
 * on the page that did not change, is stamped as usual.
 */
test('restamp resolves afresh an entry whose page changed, keeping its length, between locating and writing',
  async (t) => {
    const edits = [
      ['<main><p data-id="b">recorded b</p></main>', '<main><p data-id="c">recorded b</p></main>',
        { written: 1, alreadyHad: 0, noSuchBlock: 1, refused: 0 }, null],
      ['<main><p data-id="b">recorded b</p><i data-xy="1">z</i></main>',
        '<main><p data-id="b">recorded b</p><i DATA-ID="1">z</i></main>',
        { written: 1, alreadyHad: 0, noSuchBlock: 0, refused: 1 },
        /✗ b: p\/X02\.html carries DATA-ID, which a browser reads as data-id and this engine does not, so no seal is written on that page; nothing written/],
    ];
    for (const [was, now, counted, why] of edits) {
      assert.equal(now.length, was.length);
      const dir = pages(t, { 'X01.html': '<main><p data-id="a">recorded a</p></main>', 'X02.html': was }, RECORDED);

      const { value, out } = await restampingWhile(t, dir, (path) => writeFileSync(path, now));

      assert.deepEqual(value, counted, out);
      if (why) assert.match(out, why);
      assert.equal(readFileSync(join(dir, 'p', 'X02.html'), 'utf8'), now, 'and nothing is stamped on the edited page');
      assert.equal(readFileSync(join(dir, 'p', 'X01.html'), 'utf8'),
        '<main><p data-id="a" data-validated-fingerprint="aaaaaaaaaaaaaaaa">recorded a</p></main>');
    }
  });

/**
 * A page can vanish between locating its blocks and its own turn to be read. The run has to finish
 * rather than abort: `a` stamped, and `b` counted as gone through the per-block path, which re-lists
 * the sheet files and sees it is really gone — where the read failing here would throw, and every
 * later page would go unstamped with nothing said about them.
 */
test('restamp completes when a page is deleted mid-run, stamping the others and counting the missing one as gone',
  async (t) => {
    const dir = pages(t, {
      'X01.html': '<main><p data-id="a">recorded a</p></main>',
      'X02.html': '<main><p data-id="b">recorded b</p></main>',
    }, RECORDED);

    const { value, out } = await restampingWhile(t, dir, (path) => unlinkSync(path));

    assert.deepEqual(value, { written: 1, alreadyHad: 0, noSuchBlock: 1, refused: 0 }, out);
    assert.match(out, /⚠ 1 entries in the registry no longer exist in the pages/);
    assert.equal(readFileSync(join(dir, 'p', 'X01.html'), 'utf8'),
      '<main><p data-id="a" data-validated-fingerprint="aaaaaaaaaaaaaaaa">recorded a</p></main>');
  });
