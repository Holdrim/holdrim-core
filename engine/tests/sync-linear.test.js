/**
 * `sync` stamps a page's ✓ together (holdrim#144): one parse, one verification and one write per page,
 * where it used to re-read, re-parse and re-verify the whole page for every block — 26 s for a first
 * sync of 800 blocks on one page, and 3 000 never finished. Batched, every #141 and #140 guarantee has
 * to hold exactly as it did block by block: a seal lands only on its block, the page is verified whole
 * before it is written, and a block that cannot be stamped safely is refused alone, said and counted,
 * with nothing written onto it — never taking the other blocks of its page down with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { readBlocks } from '../cli/pages.ts';
import { loadRegistry, sync } from '../cli/validation.ts';

const OWNER = 'owner@example.org';
const BASELINE = { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: OWNER,
  when: '2026-01-01T09:00:00Z', data: null };

/** A throwaway project whose one page is `html`, with an empty approvals record. */
function onePage(t, html) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-linear-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'p'));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['p'], registry: 'r.json' } }));
  const sheet = join(tmp, 'p', 'X01.html');
  writeFileSync(sheet, html);
  writeFileSync(join(tmp, 'r.json'), '{}');
  return { tmp, page: () => readFileSync(sheet, 'utf8') };
}

/** The owner's ✓ on every block `readBlocks` sees now, given on `day`, in document order. */
async function everyBlockApproved(root, day) {
  const blocks = await readBlocks(root);
  return [...blocks.values()].map((b, i) => ({ id: `${day}-${i}`, type: 'approval', page: 'X01', block: b.id,
    fingerprint: b.fingerprint, author: OWNER, when: `${day}T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:`
      + `${String(i % 60).padStart(2, '0')}Z`, data: { locks: 'true' } }));
}

/** `sync` over `events`, with what it printed, and how long it took. */
async function syncing(t, root, events) {
  const lines = [];
  const log = t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  try {
    const started = performance.now();
    const value = await sync(root, { events: async () => [BASELINE, ...events] }, { owner: OWNER });
    return { value, out: lines.join('\n'), took: performance.now() - started };
  } finally {
    log.mock.restore();
  }
}

/** A page of `n` blocks, each depending on the one before it, the way a long specification reads. */
const pageOf = (n) => '<html><head><title>x</title></head><body><main>\n' + Array.from({ length: n }, (_, i) =>
  `<p data-id="X01.1.${i}" data-code="1.${i}"${i ? ` data-depends="X01.1.${i - 1}"` : ''}>block ${i} of the page</p>\n`)
  .join('') + '</main></body></html>';

/**
 * The first sync of every block on a page, then a re-approval of every one of them — the path that
 * replaces each seal (holdrim#140) — timed for 400 blocks and for 1 600. Per block, one run re-read
 * the whole page, so four times the blocks cost sixteen times as long; per page, about four. The bound
 * is 8×, halfway, and each size is timed twice and its faster run kept, so a slow or busy runner that
 * slows both sizes alike does not move the ratio, and one pause in one run does not decide it.
 */
test('sync is linear in the blocks of a page: 1600 blocks, first ✓ and re-approval, well under 8× what 400 take',
  async (t) => {
    const cost = async (n) => {
      let best = Infinity;
      for (let run = 0; run < 2; run++) {
        const { tmp } = onePage(t, pageOf(n));
        const first = await syncing(t, tmp, await everyBlockApproved(tmp, '2026-09-22'));
        assert.equal(first.value.added, n, first.out.slice(-500));
        writeFileSync(join(tmp, 'r.json'), '{}');
        const again = await syncing(t, tmp, await everyBlockApproved(tmp, '2026-09-23'));
        assert.equal(again.value.added, n, again.out.slice(-500));
        best = Math.min(best, first.took + again.took);
      }
      return best;
    };
    await cost(50); // warm-up: the first parse of anything pays for the JIT, and would count against 400.
    const small = await cost(400);
    const large = await cost(1600);

    assert.ok(large / small < 8, `400 blocks took ${Math.round(small)} ms and 1600 took ${Math.round(large)} ms: `
      + `${(large / small).toFixed(1)}×, where linear is about 4× and per-block is about 16×`);
  });

/**
 * `b`'s tag carries `it's`, so the scan for its end reads the apostrophe as a quote and lands in `c`'s
 * END tag: the fingerprint spliced there is dropped by the parser, the page otherwise serialises as
 * before, and only (a) — `b` does not carry its planned seal — refuses it. Batched with `a`, `c` and
 * `d`, the page as a whole is refused; `b` must be the only block that is, and must be left exactly as
 * it was, with the other three stamped and recorded.
 */
test('sync stamps the other blocks of a page and refuses only the one whose seal the parser would drop',
  async (t) => {
    const b = '<p data-id="b" it\'s>approved b</p>';
    const { tmp, page } = onePage(t, `<main><p data-id="a">approved a</p>${b}`
      + '<p data-id="c">c\'s text</p><p data-id="d">approved d</p></main>');
    const events = await everyBlockApproved(tmp, '2026-09-22');

    const { value: r, out } = await syncing(t, tmp, events);

    assert.equal(r.added, 3, out);
    assert.equal(r.refused, 1, out);
    assert.match(out, /✗ b: could not locate its tag without risking another block; nothing written/);
    const fp = Object.fromEntries((await readBlocks(tmp)).entries().map(([id, block]) => [id, block.fingerprint]));
    const stamped = (id, text) => `<p data-id="${id}" data-validated="2026-09-22" data-validated-fingerprint="${fp[id]}">${text}</p>`;
    assert.equal(page(), `<main>${stamped('a', 'approved a')}${b}${stamped('c', 'c\'s text')}${stamped('d', 'approved d')}</main>`,
      'a, c and d carry their seal, and b is byte-identical');
    assert.deepEqual(Object.keys(loadRegistry(tmp)), ['a', 'c', 'd']);
  });

/**
 * `y` already carries a seal, so its ✓ replaces it, from the `<` nearest before its `data-id` — which
 * sits inside its own `title`, and the names read from there line up with the parser's. The rewrite
 * lands in the title; the parser still reads the old fingerprint, which is the planned one, and the
 * new date, so (a) passes. Only (b) sees the title changed. Batched with `a` and `c`, `y` alone is
 * refused and left as it was.
 */
test('sync stamps the other blocks of a page and refuses only the one whose rewrite would change a title',
  async (t) => {
    const probe = onePage(t, '<main><p data-id="y">real</p></main>');
    const fingerprint = (await readBlocks(probe.tmp)).get('y').fingerprint;
    const y = `<p data-validated-fingerprint="${fingerprint}" title='<b data-validated-fingerprint=x title=z' `
      + 'data-id="y" data-validated="2026-01-01">real</p>';
    const { tmp, page } = onePage(t, `<main><p data-id="a">approved a</p>${y}<p data-id="c">approved c</p></main>`);
    const events = await everyBlockApproved(tmp, '2026-09-22');

    const { value: r, out } = await syncing(t, tmp, events);

    assert.equal(r.added, 2, out);
    assert.equal(r.refused, 1, out);
    assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
    const fp = Object.fromEntries((await readBlocks(tmp)).entries().map(([id, block]) => [id, block.fingerprint]));
    const stamped = (id, text) => `<p data-id="${id}" data-validated="2026-09-22" data-validated-fingerprint="${fp[id]}">${text}</p>`;
    assert.equal(page(), `<main>${stamped('a', 'approved a')}${y}${stamped('c', 'approved c')}</main>`,
      'a and c carry their seal, and y — title and all — is byte-identical');
    assert.deepEqual(Object.keys(loadRegistry(tmp)), ['a', 'c']);
  });
