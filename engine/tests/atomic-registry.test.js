/**
 * `saveRegistry` writes approvals.json atomically (holdrim#150): a temp file beside it, fsynced, then
 * renamed over the real name. Before this, a plain `writeFileSync` truncated the real file the moment
 * the write started — a process killed mid-write left every owner ✓ it ever recorded gone until
 * somebody recovered it from git. A reader now sees the old file or the new one, never a partial one.
 *
 * Round 2 (correctness lens): the rename must not silently drop the target's mode or overwrite a
 * registry this process cannot write to, a directory-fsync failure after a successful rename must
 * not be read as a failed save, and a registry that is a symlink must be refused rather than replaced.
 *
 * Round 3: `existsSync` FOLLOWS a link, so a DANGLING one (its target gone — an unmounted shared
 * volume, say) used to slip past both the save's and the load's guard — the save's rename replaced
 * the link with a plain file, and `loadRegistry` read it as "no registry", the same as a project never
 * synced before. `saveRegistry` must also keep the registry's owner and group, not only its mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync, chmodSync, statSync, symlinkSync,
  readFileSync, lstatSync, constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRegistry, loadRegistry, sync } from '../cli/validation.ts';
import { readBlocks } from '../cli/pages.ts';

/** A throwaway project whose registry (`r.json`) already holds `previous`. */
function project(t, previous) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-atomic-registry-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'r.json' } }));
  writeFileSync(join(tmp, 'r.json'), JSON.stringify(previous, null, 1) + '\n');
  return tmp;
}

/** Everything in `tmp` besides the project's own two files — what a save left behind. */
function leftovers(tmp) {
  return readdirSync(tmp).filter((name) => name !== 'holdrim.json' && name !== 'r.json');
}

/** Replaces `fs[name]` with `impl(real, ...args)` for the life of the test, through the ESM binding too. */
function spy(t, name, impl) {
  const real = fs[name];
  fs[name] = (...args) => impl(real, ...args);
  syncBuiltinESMExports();
  t.after(() => { fs[name] = real; syncBuiltinESMExports(); });
}

test('a write interrupted before the rename leaves the previous registry intact, with no temp file left', (t) => {
  const tmp = project(t, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
  const boom = () => { throw new Error('killed between the write and the rename'); };

  assert.throws(() => saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } }, boom),
    { message: 'killed between the write and the rename' });

  // Still the OLD registry, and still valid JSON — not truncated, not half the new one.
  assert.deepEqual(loadRegistry(tmp), { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });

  // Nothing named after the registry is left behind for the next run, or a person, to trip over.
  assert.deepEqual(leftovers(tmp), [], `left files behind: ${leftovers(tmp).join(', ')}`);
});

test('with nothing interrupting it, the new registry lands under the real name', (t) => {
  const tmp = project(t, {});
  saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-03-03', fingerprint: 'zzz' } });
  assert.deepEqual(loadRegistry(tmp), { z: { file: 'p/X01.html', date: '2026-03-03', fingerprint: 'zzz' } });
  assert.deepEqual(readdirSync(tmp).sort(), ['holdrim.json', 'r.json']);
});

test('a save keeps the mode already on approvals.json, rather than the temp file\'s fresh one', (t) => {
  const tmp = project(t, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
  const path = join(tmp, 'r.json');
  chmodSync(path, 0o440); // "do not touch by hand" — an operator's own choice, not this call's to override
  saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } });
  assert.equal(statSync(path).mode & 0o777, 0o440, 'the rename must not quietly reset the mode to a new file\'s default');
});

test('a registry this process cannot write to is refused with EACCES, and nothing is written', (t) => {
  const tmp = project(t, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
  const path = join(tmp, 'r.json');
  // The suite may run as root, for whom a real chmod 0444 refuses nothing — `accessSync` is stubbed
  // instead, exactly as `failingWrites` in sync-linear.test.js stubs `writeFileSync` for the same
  // reason: to drive the refusal branch on its own terms, not on whichever uid happens to run this.
  //
  // `mode` is only RECORDED here, not asserted on: `saveRegistry`'s own `catch` around this call
  // swallows whatever it throws and replaces it with a fresh EACCES, so an assertion thrown from
  // inside the spy would never reach the test as a failure — it would be caught there instead, same
  // as any other error the check raises.
  let calledWithMode;
  spy(t, 'accessSync', (real, p, mode) => {
    if (p === path) {
      calledWithMode = mode;
      throw Object.assign(new Error(`EACCES: permission denied, access '${p}'`), { code: 'EACCES' });
    }
    return real(p, mode);
  });

  assert.throws(() => saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } }), { code: 'EACCES' });

  // Checking readability (R_OK) here would pass on a file this process can read but not write — a
  // registry chmod 0444 for anyone but its owner, say — and the save would go on to overwrite it.
  assert.equal(calledWithMode, constants.W_OK, 'the refusal must check the WRITE bit, not merely readability');
  assert.deepEqual(loadRegistry(tmp), { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } },
    'the old registry, unwritten');
  assert.deepEqual(leftovers(tmp), [], `left files behind: ${leftovers(tmp).join(', ')}`);
});

test('a registry that is a symlink is refused, and the file it points at is left exactly as it was', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-atomic-registry-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const real = join(tmp, 'real.json');
  const before = JSON.stringify({ a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } }, null, 1) + '\n';
  writeFileSync(real, before);
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'link.json' } }));
  const link = join(tmp, 'link.json');
  symlinkSync(real, link);

  assert.throws(() => saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-09-09', fingerprint: 'zzz' } }),
    /it is a link/);

  // The link itself was not replaced by a plain file …
  assert.ok(lstatSync(link).isSymbolicLink(), 'the registry path is no longer a link — it was overwritten');
  // … and what it points at was never touched.
  assert.equal(readFileSync(real, 'utf8'), before);
  assert.deepEqual(readdirSync(tmp).sort(), ['holdrim.json', 'link.json', 'real.json']);
});

test('a directory-fsync failure after a successful rename is a warning, not a failed save', (t) => {
  const tmp = project(t, {});
  spy(t, 'openSync', (real, p, ...rest) => {
    if (p === tmp) throw Object.assign(new Error(`EIO: i/o error, open '${p}'`), { code: 'EIO' });
    return real(p, ...rest);
  });
  const errors = [];
  const error = t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  try {
    // Must not throw: the rename already landed the new registry under its real name.
    saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-04-04', fingerprint: 'zzz' } });
  } finally {
    error.mock.restore();
  }
  assert.deepEqual(loadRegistry(tmp), { z: { file: 'p/X01.html', date: '2026-04-04', fingerprint: 'zzz' } },
    'the save itself must have gone through');
  assert.ok(errors.some((l) => l.includes('could not be flushed') && l.includes('EIO')), errors.join('\n'));
});

test('two saves in the same process choose two different temp names', (t) => {
  const tmp = project(t, {});
  const seen = [];
  spy(t, 'writeFileSync', (real, p, ...rest) => { seen.push(String(p)); return real(p, ...rest); });

  saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'a' } });
  saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'a' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'b' } });

  // Only ever a temp file is passed to `writeFileSync` — the real name is only ever a rename target —
  // so both entries here are temp names, one per call. This proves the two calls picked different
  // names; it is not a proof that a collision between two PROCESSES is impossible, only that the
  // pid-and-random naming is actually exercised and does what it claims for two calls that overlap
  // in every other way (same process, same registry, back to back).
  assert.equal(seen.length, 2, seen.join('\n'));
  assert.notEqual(seen[0], seen[1], 'two saves must never write the same temp name');
});

test('the temp file is fsynced before it is renamed over the registry', (t) => {
  const tmp = project(t, {});
  const opened = new Map();
  const order = [];
  spy(t, 'openSync', (real, p, ...rest) => {
    const fd = real(p, ...rest);
    opened.set(fd, String(p));
    return fd;
  });
  spy(t, 'fsyncSync', (real, fd) => { order.push({ op: 'fsync', path: opened.get(fd) }); return real(fd); });
  spy(t, 'renameSync', (real, from, to) => { order.push({ op: 'rename', from: String(from), to: String(to) }); return real(from, to); });

  saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-05-05', fingerprint: 'zzz' } });

  const renamed = order.find((e) => e.op === 'rename');
  assert.ok(renamed, `no rename observed: ${JSON.stringify(order)}`);
  const fsyncedTemp = order.findIndex((e) => e.op === 'fsync' && e.path === renamed.from);
  assert.ok(fsyncedTemp !== -1 && fsyncedTemp < order.indexOf(renamed),
    `expected the temp file (${renamed.from}) fsynced before the rename; saw: ${JSON.stringify(order)}`);
});

/** A throwaway project whose registry (`link.json`) is a symlink to `target`, created or not. */
function linkedProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-atomic-registry-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['p'], registry: 'link.json' } }));
  const link = join(tmp, 'link.json');
  const target = join(tmp, 'nowhere.json'); // never created — the link dangles
  symlinkSync(target, link);
  return { tmp, link, target };
}

test('a dangling registry link (its target absent) is refused on save, not replaced by a plain file', (t) => {
  const { tmp, link } = linkedProject(t);
  assert.throws(() => saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-09-09', fingerprint: 'zzz' } }),
    /it is a link/);
  // `existsSync` would have read the dangling link as "no registry" and let the rename through,
  // silently replacing the link with a fresh file holding only what this one call wrote.
  assert.ok(lstatSync(link).isSymbolicLink(), 'the dangling link must not be replaced by a plain file');
});

test('a dangling registry link is refused on load, not silently read as an empty registry', (t) => {
  const { tmp } = linkedProject(t);
  assert.throws(() => loadRegistry(tmp), /link pointing at nothing/);
});

test('a working registry link is read straight through on load, never refused', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-atomic-registry-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'link.json' } }));
  const real = join(tmp, 'real.json');
  writeFileSync(real, JSON.stringify({ a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } }, null, 1) + '\n');
  symlinkSync(real, join(tmp, 'link.json'));
  assert.deepEqual(loadRegistry(tmp), { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
});

test('a dangling registry link makes sync refuse before it writes a single page', async (t) => {
  const { tmp } = linkedProject(t);
  mkdirSync(join(tmp, 'p'));
  const sheet = join(tmp, 'p', 'X01.html');
  const html = '<html><head><title>x</title></head><body><main>\n<p data-id="X01.1">some text</p>\n</main></body></html>';
  writeFileSync(sheet, html);
  const OWNER = 'owner@example.org';
  const blocks = await readBlocks(tmp);
  const block = blocks.get('X01.1');
  const events = [
    { id: 'b1', type: 'lock_baseline', page: '_lock_baseline', author: OWNER, when: '2026-01-01T09:00:00Z', data: null },
    { id: 'a1', type: 'approval', page: 'X01', block: block.id, fingerprint: block.fingerprint, author: OWNER,
      when: '2026-09-09T10:00:00Z', data: { locks: 'true' } },
  ];

  await assert.rejects(() => sync(tmp, { events: async () => events }, { owner: OWNER }), /link pointing at nothing/);
  // The refusal must land before `markAll` ever touches the page — a seal written, then a run that
  // cannot record it, is exactly the "stamped but unrecorded" case holdrim#148 already fixed once.
  assert.equal(readFileSync(sheet, 'utf8'), html, 'no page may be stamped once the registry cannot be read');
});

test('a save keeps the registry\'s owner and group on the temp file, before the rename', (t) => {
  const tmp = project(t, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
  const path = join(tmp, 'r.json');
  const original = statSync(path);
  let calledWith = null;
  spy(t, 'chownSync', (real, p, uid, gid) => { calledWith = { p: String(p), uid, gid }; return real(p, uid, gid); });

  saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } });

  assert.ok(calledWith, 'chownSync was never called');
  assert.equal(calledWith.uid, original.uid);
  assert.equal(calledWith.gid, original.gid);
  assert.notEqual(calledWith.p, path, 'the owner must be copied onto the TEMP file, before the rename, never the real name');
});

test('a process that cannot give the registry away prints a warning, and the save still lands', (t) => {
  const tmp = project(t, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
  spy(t, 'chownSync', (real, p) => {
    throw Object.assign(new Error(`EPERM: operation not permitted, chown '${p}'`), { code: 'EPERM' });
  });
  const errors = [];
  const error = t.mock.method(console, 'error', (...args) => { errors.push(args.join(' ')); });
  try {
    saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
      b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } });
  } finally {
    error.mock.restore();
  }
  assert.deepEqual(loadRegistry(tmp), { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } }, 'an EPERM on chown must not fail the save');
  assert.ok(errors.some((l) => l.includes('owner could not be kept')), errors.join('\n'));
});
