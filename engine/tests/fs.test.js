/**
 * `refuseLink` (engine/cli/fs.ts): its own `catch` around `lstatSync` treats only `ENOENT` — "there
 * is genuinely nothing at this path" — as "not a link, carry on"; anything else is a surprise the
 * caller needs to see, not a path silently read as absent. Making the `catch` return unconditionally
 * (dropping the `code === 'ENOENT'` test, or the `throw e` after it) still leaves the whole suite
 * green: every other test's `lstatSync` either succeeds or genuinely finds nothing, so a real error —
 * a permissions problem on the directory, an unreadable mount — reaching `lstatSync` never comes up
 * on its own. These tests manufacture that error and check it survives through each of `refuseLink`'s
 * three callers, rather than being swallowed and read as "the path is absent, go ahead".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRegistry, loadRegistry } from '../cli/validation.ts';
import { exportSite } from '../cli/export.ts';

/** Replaces `fs[name]` with `impl(real, ...args)` for the life of the test, through the ESM binding too. */
function spy(t, name, impl) {
  const real = fs[name];
  fs[name] = (...args) => impl(real, ...args);
  syncBuiltinESMExports();
  t.after(() => { fs[name] = real; syncBuiltinESMExports(); });
}

/** A throwaway project whose registry (`r.json`) already holds an empty registry. */
function project(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'r.json' } }));
  writeFileSync(join(tmp, 'r.json'), '{}');
  return tmp;
}

test('loadRegistry propagates a real lstat error, rather than reading the path as absent', (t) => {
  const tmp = project(t);
  const path = join(tmp, 'r.json');
  spy(t, 'lstatSync', (real, p, ...rest) => {
    if (p === path) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => loadRegistry(tmp), { code: 'EACCES' });
});

test('saveRegistry propagates a real lstat error, rather than reading the path as absent', (t) => {
  const tmp = project(t);
  const path = join(tmp, 'r.json');
  spy(t, 'lstatSync', (real, p, ...rest) => {
    if (p === path) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'zzz' } }),
    { code: 'EACCES' });
});

// ===================================================================== holdrim#155
// A missing registry reads as "never written" only when its own folder genuinely holds nothing under
// that name. It is wrong when the folder itself does not resolve: a PARENT that is a dangling symlink
// (an unmounted shared volume, say) gives `existsSync` the very same "nothing here" a fresh project's
// approvals file gives it — and, left unchecked, `sync` starts from an empty registry and stamps
// seals with no entry to show for them.

test('loadRegistry refuses when an ANCESTOR of the registry is a dangling symlink, rather than reading it as an empty registry', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'docs/approvals.json' } }));
  // `docs` points at a path that was never created (the shape of an unmounted volume) — dangling from
  // the moment it is made, not merely emptied afterwards.
  symlinkSync(join(tmp, 'never-mounted'), join(tmp, 'docs'));

  assert.throws(() => loadRegistry(tmp), /its folder, .*docs, cannot be reached/);
});

test('loadRegistry still reads an absent registry as {} when its folder genuinely resolves', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'docs/approvals.json' } }));
  mkdirSync(join(tmp, 'docs')); // the folder is real; only the file under it was never written

  assert.deepEqual(loadRegistry(tmp), {}, 'a project that has never run sync keeps working');
});

test('loadRegistry refuses, never reads {}, when the registry\'s folder is actually a plain file', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'docs/approvals.json' } }));
  writeFileSync(join(tmp, 'docs'), 'not a folder'); // `docs` resolves, but to a file, not a folder

  // `refuseLink`'s own `lstatSync` on the full registry path fails with ENOTDIR before
  // `refuseUnreachableFolder` is ever reached — a different, earlier refusal for the same reason,
  // never a read of `{}`.
  assert.throws(() => loadRegistry(tmp), { code: 'ENOTDIR' });
});

test('loadRegistry propagates a real stat error on the registry\'s folder, rather than reading it as absent', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'docs/approvals.json' } }));
  const dir = join(tmp, 'docs');
  mkdirSync(dir);
  spy(t, 'statSync', (real, p, ...rest) => {
    if (p === dir) throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => loadRegistry(tmp), { code: 'EACCES' });
});

test('exportSite propagates a real lstat error on `out`, rather than reading it as absent', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'pages'));
  writeFileSync(join(tmp, 'holdrim.json'), '{}');
  const out = join(tmp, 'public');
  spy(t, 'lstatSync', (real, p, ...rest) => {
    if (p === out) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => exportSite(tmp, out), { code: 'EACCES' });
});
