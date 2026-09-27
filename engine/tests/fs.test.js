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
import { sheetFiles } from '../cli/pages.ts';

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
// A missing registry reads as "never written" only when nothing further up stops it from ever being
// written. It is wrong when an ANCESTOR is a dangling symlink (an unmounted shared volume, say),
// which gives `existsSync` the exact same "nothing here" a fresh project's approvals file gives it —
// left unchecked, `sync` starts from an empty registry and stamps seals with no entry to show for
// them. Round 1 of this fix asked one `statSync(dirname(path))`, which cannot tell "not created yet"
// from "a dangling ancestor" apart — both fail it with ENOENT — and wrongly refused a project that
// had simply never run sync. Round 2 walks the ancestors from the project root instead, component by
// component, so the two read differently.

/** A project whose registry is nested one folder down, never created before the test builds it. */
function nestedProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'docs/approvals.json' } }));
  return tmp;
}

test('loadRegistry reads a nested registry as {} when its subfolder was simply never created', (t) => {
  const tmp = nestedProject(t);
  // No `docs` folder at all — a project that has never run sync, the case round 1 broke.
  assert.deepEqual(loadRegistry(tmp), {}, 'a project that has never run sync keeps working');
});

test('loadRegistry refuses when the IMMEDIATE parent folder is a dangling symlink', (t) => {
  const tmp = nestedProject(t);
  // `docs` points at a path that was never created (the shape of an unmounted volume) — dangling from
  // the moment it is made, not merely emptied afterwards.
  symlinkSync(join(tmp, 'never-mounted'), join(tmp, 'docs'));

  assert.throws(() => loadRegistry(tmp), /its folder, .*docs, cannot be reached/);
});

test('loadRegistry refuses when an ancestor TWO LEVELS UP is a dangling symlink', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'docs/sub/approvals.json' } }));
  // `docs` itself is the dangling link; `sub` is never reached — the walk refuses at the first
  // component it cannot resolve, without needing to know anything about what is below it.
  symlinkSync(join(tmp, 'never-mounted'), join(tmp, 'docs'));

  assert.throws(() => loadRegistry(tmp), /its folder, .*docs, cannot be reached/);
});

test('loadRegistry reads normally through a WORKING symlinked folder, registry not yet written', (t) => {
  const tmp = nestedProject(t);
  mkdirSync(join(tmp, 'real-docs')); // the real target: mounted content, no approvals.json in it yet
  symlinkSync(join(tmp, 'real-docs'), join(tmp, 'docs'));

  assert.deepEqual(loadRegistry(tmp), {}, 'a working symlinked folder is a legitimate way to mount content');
});

test('loadRegistry propagates a real lstat error while walking the ancestors, rather than reading the path as absent', (t) => {
  const tmp = nestedProject(t);
  const dir = join(tmp, 'docs');
  spy(t, 'lstatSync', (real, p, ...rest) => {
    if (p === dir) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => loadRegistry(tmp), { code: 'EACCES' });
});

test('loadRegistry propagates a real stat error resolving a symlinked ancestor, rather than reading it as dangling', (t) => {
  const tmp = nestedProject(t);
  mkdirSync(join(tmp, 'real-docs'));
  const dir = join(tmp, 'docs');
  symlinkSync(join(tmp, 'real-docs'), dir);
  spy(t, 'statSync', (real, p, ...rest) => {
    if (p === dir) throw Object.assign(new Error(`EACCES: permission denied, stat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => loadRegistry(tmp), { code: 'EACCES' });
});

test('loadRegistry refuses, never reads {}, when the registry\'s folder is actually a plain file', (t) => {
  const tmp = nestedProject(t);
  writeFileSync(join(tmp, 'docs'), 'not a folder'); // `docs` resolves, but to a file, not a folder

  // `refuseLink`'s own `lstatSync` on the full registry path fails with ENOTDIR before
  // `refuseUnreachableFolder` is ever reached — a different, earlier refusal for the same reason,
  // never a read of `{}`.
  assert.throws(() => loadRegistry(tmp), { code: 'ENOTDIR' });
});

// ===================================================================== holdrim#161, round 2
// `refuseLink` only ever looks at the registry's own LAST component, never an ancestor, and
// `refuseUnreachableFolder` only ever refuses a DANGLING ancestor, never a WORKING one — so
// `content.registry: "mnt/approvals.json"`, with `mnt` a committed, resolving symlink to somewhere
// OUTSIDE the project, passes both, and `readConfig`'s own containment check (holdrim#161, round 1)
// is lexical, on the string as written, so it cannot see a symlink either. `refuseEscapedFolder`
// closes that: it resolves the registry's REAL location, and the project's REAL root, with
// `fs.realpathSync`, and refuses when the first is not strictly inside the second.

/** A project whose registry sits behind `mnt`, plus a folder OUTSIDE the project for `mnt` to link
 *  to — two unrelated temp directories, never nested inside one another. */
function escapingProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  const outside = mkdtempSync(join(tmpdir(), 'holdrim-fs-outside-'));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(tmp, 'holdrim.json'),
    JSON.stringify({ content: { folders: [], registry: 'mnt/approvals.json' } }));
  symlinkSync(outside, join(tmp, 'mnt'));
  return { tmp, outside };
}

test('loadRegistry refuses a working symlinked folder that resolves OUTSIDE the project, registry not yet written', (t) => {
  const { tmp } = escapingProject(t);
  assert.throws(() => loadRegistry(tmp), /outside the project root/);
});

test('loadRegistry refuses a working symlinked folder that resolves OUTSIDE the project, registry already there', (t) => {
  const { tmp, outside } = escapingProject(t);
  // Written straight into the REAL folder — exactly what an owner's `holdrim sync` would have done
  // through the link, had this gone unrefused.
  writeFileSync(join(outside, 'approvals.json'), '{}');
  assert.throws(() => loadRegistry(tmp), /outside the project root/);
});

test('saveRegistry refuses a working symlinked folder that resolves OUTSIDE the project', (t) => {
  const { tmp } = escapingProject(t);
  assert.throws(() => saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'zzz' } }),
    /outside the project root/);
});

test('loadRegistry accepts a working symlinked folder that resolves INSIDE the project, written or not', (t) => {
  const tmp = nestedProject(t);
  mkdirSync(join(tmp, 'real-docs'));
  symlinkSync(join(tmp, 'real-docs'), join(tmp, 'docs'));

  assert.deepEqual(loadRegistry(tmp), {}, 'registry not yet written, and the link resolves inside');
  writeFileSync(join(tmp, 'real-docs', 'approvals.json'), '{}');
  assert.deepEqual(loadRegistry(tmp), {}, 'registry now present, still through a link that resolves inside');
});

test('saveRegistry accepts a working symlinked folder that resolves INSIDE the project', (t) => {
  const tmp = nestedProject(t);
  mkdirSync(join(tmp, 'real-docs'));
  symlinkSync(join(tmp, 'real-docs'), join(tmp, 'docs'));

  const entry = { z: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'zzz' } };
  saveRegistry(tmp, entry);
  assert.deepEqual(loadRegistry(tmp), entry, 'written through the link, and read back through it');
});

test('loadRegistry still works when the PROJECT ROOT ITSELF is reached through a symlink', (t) => {
  // A checkout at a symlinked path (`~/work -> /real/project`, say) must not be refused for
  // resolving "outside" its own literal root: `refuseEscapedFolder` resolves ROOT with
  // `realpathSync` too, exactly like the registry's own location, so the two are compared as the
  // same real path either way.
  const real = mkdtempSync(join(tmpdir(), 'holdrim-fs-real-'));
  const alias = join(tmpdir(), `holdrim-fs-alias-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  symlinkSync(real, alias);
  t.after(() => { rmSync(alias, { force: true }); rmSync(real, { recursive: true, force: true }); });
  writeFileSync(join(real, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'approvals.json' } }));

  assert.deepEqual(loadRegistry(alias), {}, 'registry not yet written, root itself is the symlink');
  writeFileSync(join(real, 'approvals.json'), '{}');
  assert.deepEqual(loadRegistry(alias), {}, 'registry present, root itself is the symlink');
});

// ===================================================================== holdrim#161, round 3
// `refuseEscapedFolder`'s own walk up to the deepest existing ancestor propagates any error but
// ENOENT (`if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;`) — deleting that line still
// leaves the whole suite green, because every EACCES test above spies on a path `refuseLink` or
// `refuseUnreachableFolder` already probes, and one of THOSE throws first, before this walk ever
// runs. When neither the registry's own path nor its immediate parent folder exists yet, the walk
// climbs past both — each already probed, harmlessly, by the earlier guards — up to the PROJECT
// ROOT itself, which nothing before `refuseEscapedFolder` ever calls `lstatSync` on: `readConfig`
// reads `holdrim.json` with `readFileSync`, never stats the folder that holds it. So an EACCES there
// is seen only by this walk's own catch, and only a working `throw e` surfaces it.

test('loadRegistry propagates a real lstat error on the project root, seen only by refuseEscapedFolder\'s own walk', (t) => {
  const tmp = nestedProject(t);
  // No `docs` folder either — the walk climbs past the registry path and its parent, both already
  // probed (harmlessly) by `refuseLink` and `refuseUnreachableFolder`, up to `tmp` itself.
  spy(t, 'lstatSync', (real, p, ...rest) => {
    if (p === tmp) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => loadRegistry(tmp), { code: 'EACCES' });
});

test('saveRegistry propagates a real lstat error on the project root, seen only by refuseEscapedFolder\'s own walk', (t) => {
  const tmp = nestedProject(t);
  spy(t, 'lstatSync', (real, p, ...rest) => {
    if (p === tmp) throw Object.assign(new Error(`EACCES: permission denied, lstat '${p}'`), { code: 'EACCES' });
    return real(p, ...rest);
  });
  assert.throws(() => saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'zzz' } }),
    { code: 'EACCES' });
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

// ===================================================================== holdrim#164
// `content.folders` (`sheetFolders`, engine/cli/pages.ts) has the exact same shape as
// `content.registry`, and the same gap #161 closed there: `readConfig`'s own check is lexical, on
// the string as written, so a committed, WORKING symlink standing in for a configured folder —
// `content.folders: ["mnt"]`, `mnt` pointing outside the project — reads as an ordinary nested path.
// `sheetFiles` is the one place a configured folder is actually opened; it now runs
// `refuseEscapedFolder` on each one first, exactly as `loadRegistry`/`saveRegistry` do for the
// registry.

/** A project whose one page folder (`mnt`) is a working symlink to somewhere OUTSIDE the project,
 *  with a page sitting in the real, outside location. */
function escapingPagesProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  const outside = mkdtempSync(join(tmpdir(), 'holdrim-fs-outside-'));
  t.after(() => { rmSync(tmp, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['mnt'], registry: 'r.json' } }));
  writeFileSync(join(outside, 'X01.html'), '<main></main>');
  symlinkSync(outside, join(tmp, 'mnt'));
  return { tmp, outside };
}

test('sheetFiles refuses a configured folder that is a working symlink resolving OUTSIDE the project', (t) => {
  const { tmp } = escapingPagesProject(t);
  assert.throws(() => sheetFiles(tmp), /outside the project root/);
});

test('sheetFiles accepts a configured folder that is a working symlink resolving INSIDE the project', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['mnt'], registry: 'r.json' } }));
  mkdirSync(join(tmp, 'real-pages'));
  writeFileSync(join(tmp, 'real-pages', 'X01.html'), '<main></main>');
  symlinkSync(join(tmp, 'real-pages'), join(tmp, 'mnt'));

  assert.deepEqual(sheetFiles(tmp), [join(tmp, 'mnt', 'X01.html')],
    'a working symlinked folder is a legitimate way to mount content, exactly like the registry\'s own');
});

/**
 * Round 1 of #164's review: a configured folder that was never created at all must still read as
 * empty, exactly as it did before this issue — the ordinary "nobody has run sync yet" case, not an
 * error. Nothing in the fixture above pins this: every one of them `mkdirSync`s its folder first,
 * so a mutant that made `refuseUnreachableFolder`'s own ENOENT walk-up throw unconditionally passed
 * every existing #164 test and was only caught by this one.
 */
test('sheetFiles reads a configured folder as empty when it was simply never created', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['pages'], registry: 'r.json' } }));
  assert.deepEqual(sheetFiles(tmp), [], 'no `pages` folder at all — a project that has never run sync');
});

/**
 * Round 1 of #164's review, finding 1: `refuseEscapedFolder`'s own walk to the "deepest existing
 * ancestor" stops AT a dangling symlink — its `lstatSync` succeeds, the link itself is there — and
 * the `realpathSync` that follows then throws the filesystem's raw `ENOENT`, not a message naming
 * what happened. `refuseUnreachableFolder` runs first now, in the order `loadRegistry` already
 * uses, and tells the two apart. `docs/sheets` is the ancestor-dangling shape (`nestedProject`-style,
 * holdrim#155); the configured folder itself being the dangling link is the shape `escapingPagesProject`
 * above already builds for the escape case, so this reuses that name for a dangling target instead.
 */
test('sheetFiles refuses a configured folder that is ITSELF a dangling symlink, "cannot be reached"', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['mnt'], registry: 'r.json' } }));
  symlinkSync(join(tmp, 'never-mounted'), join(tmp, 'mnt'));

  assert.throws(() => sheetFiles(tmp), /its folder, .*mnt, cannot be reached/);
});

test('sheetFiles refuses a configured folder whose ANCESTOR is a dangling symlink, "cannot be reached"', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['docs/sheets'], registry: 'r.json' } }));
  // `docs` itself is the dangling link; `sheets` is never reached — the same shape holdrim#155
  // already pins for the registry, one level up from a configured folder instead of a file.
  symlinkSync(join(tmp, 'never-mounted'), join(tmp, 'docs'));

  assert.throws(() => sheetFiles(tmp), /its folder, .*docs, cannot be reached/);
});
