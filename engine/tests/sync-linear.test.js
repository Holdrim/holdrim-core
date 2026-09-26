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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { readBlocks, spliceAll } from '../cli/pages.ts';
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

/**
 * A page of `n` blocks, each depending on the one before it, the way a long specification reads — and,
 * half-way down, one more block whose `it's` makes its seal land in the next block's end tag, where
 * the parser drops it. That block is refused on every run, so the page is never accepted whole and
 * the halving that isolates it is part of what is timed: split one stamp at a time instead, the page
 * goes back to a verification per block.
 */
const pageOf = (n) => '<html><head><title>x</title></head><body><main>\n' + Array.from({ length: n }, (_, i) =>
  (i === Math.floor(n / 2) ? '<p data-id="X01.odd" it\'s>refused on every run</p>\n' : '')
  + `<p data-id="X01.1.${i}" data-code="1.${i}"${i ? ` data-depends="X01.1.${i - 1}"` : ''}>block ${i}'s text</p>\n`)
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
        assert.equal(first.value.refused, 1, first.out.slice(-500));
        writeFileSync(join(tmp, 'r.json'), '{}');
        const again = await syncing(t, tmp, await everyBlockApproved(tmp, '2026-09-23'));
        assert.equal(again.value.added, n, again.out.slice(-500));
        assert.equal(again.value.refused, 1, again.out.slice(-500));
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

/**
 * The value half of (a). `y`'s seal is replaced from the `<` inside its own `title`, whose names line
 * up with the parser's: the rewrite of `data-validated` lands in the title, spelling the very text it
 * replaces, so (b) sees nothing change, and the new fingerprint lands at the real end of the tag. The
 * parser then reads a `data-validated` that is there — and says 2020-01-01, not the date of this ✓.
 * Only comparing the value refuses it; a check that the name is present writes a new fingerprint
 * beside the old date. `carriesExactly` is that check for the batch and for the block alone, so `y`
 * is refused on a page of its own, and between two blocks that are stamped around it.
 */
test('sync refuses a re-approval whose date the parser would not read, alone and between two blocks', async (t) => {
  const y = '<p data-validated="2020-01-01" title=\'<b data-validated="2026-09-22" title=z\' data-id="y">real</p>';
  for (const [before, after] of [['', ''], ['<p data-id="a">approved a</p>', '<p data-id="c">approved c</p>']]) {
    const { tmp, page } = onePage(t, `<main>${before}${y}${after}</main>`);
    const events = await everyBlockApproved(tmp, '2026-09-22');

    const { value: r, out } = await syncing(t, tmp, events);

    assert.equal(r.refused, 1, out);
    assert.equal(r.added, before ? 2 : 0, out);
    assert.match(out, /✗ y: could not locate its tag without risking another block; nothing written/);
    const fp = Object.fromEntries((await readBlocks(tmp)).entries().map(([id, block]) => [id, block.fingerprint]));
    const stamped = (id, text) => `<p data-id="${id}" data-validated="2026-09-22" data-validated-fingerprint="${fp[id]}">${text}</p>`;
    assert.equal(page(), before ? `<main>${stamped('a', 'approved a')}${y}${stamped('c', 'approved c')}</main>` : `<main>${y}</main>`,
      'y is byte-identical, and the others carry their seal');
    assert.deepEqual(Object.keys(loadRegistry(tmp)), before ? ['a', 'c'] : []);
  }
});

/**
 * Two current ✓ on one block in one run. Written in turn, the first stamps and records it, and the
 * second finds the registry already holding that fingerprint: "already there", with the first ✓'s
 * date and event kept. Stamped in one batch, both would be written and the second would win — so
 * the second waits a round and sees the registry the first left.
 */
test('sync stamps the first of two ✓ on one unchanged block and counts the second as already there', async (t) => {
  const { tmp, page } = onePage(t, '<main><p data-id="y">approved y</p></main>');
  const [once] = await everyBlockApproved(tmp, '2026-09-20');
  const events = [{ ...once, id: 'e1' }, { ...once, id: 'e2', when: '2026-09-22T10:00:00Z' }];

  const { value: r, out } = await syncing(t, tmp, events);

  assert.match(out, /1 new · 1 already there · 0 ✓ expired · 0 refused/);
  assert.equal(r.added, 1);
  assert.equal(r.unchanged, 1);
  assert.equal(page(), `<main><p data-id="y" data-validated="2026-09-20" data-validated-fingerprint="${once.fingerprint}">approved y</p></main>`);
  const registry = loadRegistry(tmp);
  assert.equal(registry.y.date, '2026-09-20');
  assert.equal(registry.y.event, 'e1');
});

/** A throwaway project with the pages in `pages` (`X01.html` → its html), with an empty approvals record. */
function pages(t, files) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-linear-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'p'));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['p'], registry: 'r.json' } }));
  writeFileSync(join(tmp, 'r.json'), '{}');
  for (const [name, html] of Object.entries(files)) writeFileSync(join(tmp, 'p', name), html);
  return tmp;
}

/** The owner's ✓ on each of `ids`, in that order, an hour apart. */
async function approvedInOrder(root, ids) {
  const blocks = await readBlocks(root);
  return ids.map((id, i) => ({ id: `e${i}`, type: 'approval', page: blocks.get(id).page, block: id,
    fingerprint: blocks.get(id).fingerprint, author: OWNER, when: `2026-09-22T1${i}:00:00Z`, data: { locks: 'true' } }));
}

/**
 * A page is located at the start of the run and stamped when its turn comes, so the page read then
 * has to be the page located. An edit that keeps the length is an edit: to `b`'s own text, which the
 * block's fingerprint refuses on its own, and to a name elsewhere on the page — `DATA-ID`, which a
 * browser reads as `data-id` and this engine does not, so the page takes no seal at all — which only
 * comparing the whole page's text sees.
 */
test('sync refuses a ✓ whose page changed, keeping its length, between locating the blocks and writing the seal',
  async (t) => {
    const edits = [
      ['<main><p data-id="b">approved b</p></main>', '<main><p data-id="b">approved c</p></main>',
        /✗ b: the text resolved here does not match the ✓ that was checked; nothing written/],
      ['<main><p data-id="b">approved b</p><i data-xy="1">z</i></main>',
        '<main><p data-id="b">approved b</p><i DATA-ID="1">z</i></main>',
        /✗ b: p\/X02\.html carries DATA-ID, which a browser reads as data-id and this engine does not, so no seal is written on that page; nothing written/],
    ];
    for (const [was, now, why] of edits) {
      assert.equal(now.length, was.length);
      const tmp = pages(t, { 'X01.html': '<main><p data-id="a">approved a</p></main>', 'X02.html': was });
      const events = await approvedInOrder(tmp, ['a', 'b']);
      const lines = [];
      const log = t.mock.method(console, 'log', (...args) => {
        lines.push(args.join(' '));
        if (String(args[0]).includes('✓ a validated')) writeFileSync(join(tmp, 'p', 'X02.html'), now);
      });
      let r;
      try {
        r = await sync(tmp, { events: async () => [BASELINE, ...events] }, { owner: OWNER });
      } finally {
        log.mock.restore();
      }

      assert.equal(r.added, 1, lines.join('\n'));
      assert.equal(r.refused, 1, lines.join('\n'));
      assert.ok(lines.some((l) => why.test(l)), lines.join('\n'));
      assert.equal(readFileSync(join(tmp, 'p', 'X02.html'), 'utf8'), now, 'and b is not stamped');
      assert.deepEqual(Object.keys(loadRegistry(tmp)), ['a']);
    }
  });

/**
 * Pages are stamped one after another, so the ✓ settle page by page; what `sync` prints still follows
 * the order they were given in, which is the order a person reads the run against the site.
 */
test('sync prints each ✓ in the order it was given, not the order its page was stamped', async (t) => {
  const tmp = pages(t, {
    'X01.html': '<main><p data-id="X01.a">first</p><p data-id="X01.b">third</p></main>',
    'X02.html': '<main><p data-id="X02.a">second</p><p data-id="X02.b">fourth</p></main>',
  });
  const events = await approvedInOrder(tmp, ['X01.a', 'X02.a', 'X01.b', 'X02.b']);

  const { value: r, out } = await syncing(t, tmp, events);

  assert.equal(r.added, 4, out);
  assert.deepEqual(out.split('\n').filter((l) => l.includes('✓') && l.includes('validated by you')),
    ['X01.a', 'X02.a', 'X01.b', 'X02.b'].map((id) => `  ✓ ${id} validated by you on the site on 2026-09-22`));
});

/**
 * A page can vanish between `locateBlocks` reading it and its own turn in `markAll`'s per-page loop
 * (holdrim#144, round 3): here `X02.html` is deleted right after `X01`'s page settles, so `markAll`'s
 * own read of it throws ENOENT. The run has to finish rather than abort mid-page — `a` sealed on disk
 * AND recorded, `b` refused cleanly as "not found" through `mark`'s own path, which re-lists the
 * sheet files and sees it is really gone — where a plain `readFileSync` failing here would leave `a`
 * sealed on disk with nothing in the registry, because `saveRegistry` never runs.
 */
test('sync completes when a page is deleted mid-run, sealing and recording the others and refusing the missing one',
  async (t) => {
    const tmp = pages(t, {
      'X01.html': '<main><p data-id="a">approved a</p></main>',
      'X02.html': '<main><p data-id="b">approved b</p></main>',
    });
    const events = await approvedInOrder(tmp, ['a', 'b']);
    const lines = [];
    const log = t.mock.method(console, 'log', (...args) => {
      lines.push(args.join(' '));
      if (String(args[0]).includes('✓ a validated')) unlinkSync(join(tmp, 'p', 'X02.html'));
    });
    let r;
    try {
      r = await sync(tmp, { events: async () => [BASELINE, ...events] }, { owner: OWNER });
    } finally {
      log.mock.restore();
    }

    assert.equal(r.added, 1, lines.join('\n'));
    assert.equal(r.refused, 1, lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('✗ b: not found; nothing written')), lines.join('\n'));
    assert.deepEqual(Object.keys(loadRegistry(tmp)), ['a']);
  });

/**
 * The halving verifies each stamp inside its own half only. Here a verifier accepts every stamp alone
 * and refuses any two together, and it is the real check's opposite on `b`, whose seal the parser
 * would drop: written as the halves said, `b` would be stamped where the parser cannot see it. The
 * stamps the halving accepted have to be verified together before the page is written, and, refused
 * together, go block by block through the real check — which stamps `a` and refuses `b`.
 */
test('spliceAll verifies the stamps the halving accepted together, and goes block by block when they are refused together',
  () => {
    const html = '<main><p data-id="a">approved a</p><p data-id="b" it\'s>approved b</p><p data-id="c">c\'s text</p></main>';
    const plan = { validatedAt: '2026-09-22', attributes: [{ attr: 'data-validated-fingerprint', value: 'f' }] };
    const asked = [];
    const onlyAlone = (_page, entries) => {
      asked.push(entries.map((e) => e.id).join(' '));
      return entries.length > 1 ? null : _page;
    };

    const { html: out, results } = spliceAll(html, parseHTML(html).document, [{ id: 'a', plan }, { id: 'b', plan }], onlyAlone);

    assert.deepEqual(asked, ['a b', 'a', 'b', 'a b'], 'the pair, each half, then the pair the halving accepted');
    assert.deepEqual(results, [{ ok: true }, { error: 'could not locate its tag without risking another block' }]);
    assert.equal(out, html.replace('<p data-id="a">',
      '<p data-id="a" data-validated="2026-09-22" data-validated-fingerprint="f">'), 'a stamped, and b left as it was');
  });
