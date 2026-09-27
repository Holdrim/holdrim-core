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
import fs, { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRegistry, loadRegistry } from '../cli/validation.ts';
import { exportSite } from '../cli/export.ts';
import { sheetFiles } from '../cli/pages.ts';
import { refuseServedStore, realStoreFolder, insideStoreFolder } from '../cli/fs.ts';
import { eventStoreFile } from '../api/store-sqlite.ts';
import { userStoreFile } from '../api/users.ts';

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

/**
 * Round 3 of #164's review: `docs` an ordinary FILE, not a symlink at all, one level above the
 * configured folder. `refuseUnreachableFolder`'s own walk never calls `refuseLink` on `folder`
 * itself — only `loadRegistry` does that, on the registry's own path, before this walk ever runs —
 * so a file where an ancestor should be a directory reached `lstatSync` here first and threw the
 * filesystem's raw `ENOTDIR`, with no "cannot be reached" message at all, exactly the gap the two
 * dangling-symlink tests above already close for a link instead of a file.
 */
test('sheetFiles refuses a configured folder whose ancestor is an ordinary file, "cannot be reached"', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['docs/sheets'], registry: 'r.json' } }));
  // `docs` is a plain file: nothing can ever sit "inside" it, so `docs/sheets` can never be reached.
  writeFileSync(join(tmp, 'docs'), 'not a folder');

  assert.throws(() => sheetFiles(tmp), /its folder, .*docs.sheets, cannot be reached/);
});

// ===================================================================== a page file that is a link
// `sheetFiles` scans only pages whose REAL location is inside the project. The folder's own check
// above sees the folder, never a page FILE inside it that is a link, and every read downstream
// (readBlocks, fingerprintsByPage, scanBlocks) follows links — so each page that IS a link is
// resolved too, with the same `realContainment` (engine/cli/fs.ts) the server uses before it serves
// a file from the site.

/** A project with one ordinary page folder, `pages`, holding a plain page, `A01.html`. */
function pagesProject(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-fs-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: ['pages'], registry: 'r.json' } }));
  mkdirSync(join(tmp, 'pages'));
  writeFileSync(join(tmp, 'pages', 'A01.html'), '<main></main>');
  return tmp;
}

test('sheetFiles refuses a page file that is a link whose real location is outside the project', (t) => {
  const tmp = pagesProject(t);
  const outside = mkdtempSync(join(tmpdir(), 'holdrim-fs-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'X01.html'), '<main></main>');
  symlinkSync(join(outside, 'X01.html'), join(tmp, 'pages', 'B01.html'));

  assert.throws(() => sheetFiles(tmp), /refusing to scan the page .*B01\.html: .*outside the project root/);
});

test('sheetFiles scans a page file that is a link whose real location is inside the project', (t) => {
  const tmp = pagesProject(t);
  mkdirSync(join(tmp, 'drafts'));
  writeFileSync(join(tmp, 'drafts', 'B01.html'), '<main></main>');
  symlinkSync(join(tmp, 'drafts', 'B01.html'), join(tmp, 'pages', 'B01.html'));

  assert.deepEqual(sheetFiles(tmp), [join(tmp, 'pages', 'A01.html'), join(tmp, 'pages', 'B01.html')],
    'a link that stays inside the project is a page like any other');
});

test('sheetFiles scans a linked page of a project whose ROOT itself is reached through a link', (t) => {
  // The site mounted through a link (`/srv/docs -> /data/docs`): the page's real location has to be
  // compared with the root's REAL location, not with the root as spelled, or every linked page of
  // such a project reads as outside it.
  const real = pagesProject(t);
  symlinkSync('A01.html', join(real, 'pages', 'B01.html'));
  const alias = join(tmpdir(), `holdrim-fs-alias-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  symlinkSync(real, alias);
  t.after(() => rmSync(alias, { force: true }));

  assert.deepEqual(sheetFiles(alias), [join(alias, 'pages', 'A01.html'), join(alias, 'pages', 'B01.html')]);
});

test('sheetFiles fails loudly on a page file that is a link to nothing, rather than listing it', (t) => {
  // Every caller reads each page it is given, and would fail on this one anyway; failing here, with
  // the link's own name, keeps a page with no real location from ever being judged inside or out.
  const tmp = pagesProject(t);
  symlinkSync(join(tmp, 'never-written.html'), join(tmp, 'pages', 'B01.html'));

  assert.throws(() => sheetFiles(tmp), { code: 'ENOENT' });
});


// ===================================================================== a store the site would serve
// The server refuses to start when a store it writes would be served by the site (`refuseServedStore`,
// engine/cli/fs.ts, called from engine/api/server.ts before either store is opened). The contract
// test boots the server to prove the wiring; these hold the rule itself.

/** A throwaway parent holding a site folder, `site`, and nothing else yet. */
function siteParent(t) {
  const parent = mkdtempSync(join(tmpdir(), 'holdrim-store-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  mkdirSync(join(parent, 'site'));
  return parent;
}

const SERVED = /the users store \(HOLDRIM_USERS_PATH\), .* would be served by the site: .* is in the site, /;

test('the server refuses to start when a store it writes would be served by the site: a store inside the site', (t) => {
  const parent = siteParent(t);
  // `data` does not exist yet: the store would create it, inside the site.
  assert.throws(() => refuseServedStore(join(parent, 'site'), join(parent, 'site', 'data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'), SERVED);
});

test('the server refuses to start when a store it writes would be served by the site: its folder IS the site root', (t) => {
  // Strictly inside is the rule for a page; for a store, the root itself holds its files, and
  // the `-wal` and `-shm` beside them, directly under the site. The database file is a link leading
  // out, so the file's own real location is outside and only the folder's answer can refuse it.
  const parent = siteParent(t);
  mkdirSync(join(parent, 'elsewhere'));
  writeFileSync(join(parent, 'elsewhere', 'users.db'), '');
  symlinkSync(join(parent, 'elsewhere', 'users.db'), join(parent, 'site', 'users.db'));
  assert.throws(() => refuseServedStore(join(parent, 'site'), join(parent, 'site', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'), SERVED);
  // …and the plain file there, no link, is refused as well.
  rmSync(join(parent, 'site', 'users.db'));
  assert.throws(() => refuseServedStore(join(parent, 'site'), join(parent, 'site', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'), SERVED);
});

test('the server refuses to start when a store it writes would be served by the site: a linked folder that lands inside it', (t) => {
  // Spelled outside the site, really inside it: judged by where the folder really is.
  const parent = siteParent(t);
  mkdirSync(join(parent, 'site', 'hidden'));
  symlinkSync(join(parent, 'site', 'hidden'), join(parent, 'data'));
  assert.throws(() => refuseServedStore(join(parent, 'site'), join(parent, 'data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'), SERVED);
});

test('the server refuses to start when a store it writes would be served by the site: a database file linked into it', (t) => {
  // The folder is outside; the file is a link whose real location is inside, and the database is
  // written wherever the link leads.
  const parent = siteParent(t);
  mkdirSync(join(parent, 'data'));
  writeFileSync(join(parent, 'site', 'users.db'), '');
  symlinkSync(join(parent, 'site', 'users.db'), join(parent, 'data', 'users.db'));
  assert.throws(() => refuseServedStore(join(parent, 'site'), join(parent, 'data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'), SERVED);
});

test('the server refuses to start when a store it writes would be served by the site: a folder inside it, the file linked out', (t) => {
  // The rule is the folder: whatever the database file itself leads to, a store folder inside the
  // site is refused, since that folder is where the store's other files are made.
  const parent = siteParent(t);
  mkdirSync(join(parent, 'site', 'data'));
  mkdirSync(join(parent, 'elsewhere'));
  writeFileSync(join(parent, 'elsewhere', 'users.db'), '');
  symlinkSync(join(parent, 'elsewhere', 'users.db'), join(parent, 'site', 'data', 'users.db'));
  assert.throws(() => refuseServedStore(join(parent, 'site'), join(parent, 'site', 'data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'), SERVED);
});

test('the server refuses to start when a store it writes would be served by the site: a site that cannot be resolved', (t) => {
  // Nothing can say whether the store is inside a site that is not there, and the store's folder,
  // created first, could become part of it once it is: refused, never waved through.
  const parent = siteParent(t);
  assert.throws(() => refuseServedStore(join(parent, 'not-yet'), join(parent, 'data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'),
  /the users store \(HOLDRIM_USERS_PATH\), .*users\.db, cannot be checked against the site, .*not-yet: ENOENT/);
});

test('a store in a sibling folder whose name starts with the site\'s is not in the site', (t) => {
  // `/x/site-data` passes a raw `startsWith("/x/site")`; it is not inside `/x/site`, and nothing
  // there is served.
  const parent = siteParent(t);
  assert.doesNotThrow(() => refuseServedStore(join(parent, 'site'), join(parent, 'site-data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'));
});

test('a store outside the site is accepted', (t) => {
  const parent = siteParent(t);
  assert.doesNotThrow(() => refuseServedStore(join(parent, 'site'), join(parent, 'data', 'users.db'),
    'the users store (HOLDRIM_USERS_PATH)'));
});

test('a users store that writes no file names none, so no file is checked against the site', () => {
  // The server checks exactly what `userStoreFile` returns, and `openUserStore` opens exactly that:
  // a null here is a store the site cannot serve, whatever HOLDRIM_USERS_PATH says.
  const inSite = '/srv/site/users.db';
  assert.equal(userStoreFile('firestore', inSite), null, 'firestore');
  assert.equal(userStoreFile('postgres://u:p@host/db', inSite), null, 'postgres');
  assert.equal(userStoreFile('sqlite::memory:', inSite), null, 'sqlite in memory');
  assert.equal(userStoreFile('sqlite://:memory:', inSite), null, 'the // form of the same');
  assert.equal(userStoreFile(undefined, ':memory:'), null, 'HOLDRIM_USERS_PATH in memory');
});

test('a users store names its file and the variable that named it, for the refusal to name', () => {
  const inSite = '/srv/site/users.db';
  const byPath = { file: inSite, variable: 'HOLDRIM_USERS_PATH' };
  assert.deepEqual(userStoreFile(undefined, inSite), byPath, 'absent: HOLDRIM_USERS_PATH');
  assert.deepEqual(userStoreFile('sqlite', inSite), byPath, 'bare sqlite: HOLDRIM_USERS_PATH');
  assert.deepEqual(userStoreFile('sqlite:/var/lib/users.db', inSite),
    { file: '/var/lib/users.db', variable: 'HOLDRIM_USERS' }, 'sqlite:<path>');
  assert.deepEqual(userStoreFile('sqlite:///var/lib/users.db', inSite),
    { file: '/var/lib/users.db', variable: 'HOLDRIM_USERS' }, 'sqlite://<path>');
});

test('the server refuses to start on a users store that names an empty file, naming the variable', () => {
  // Taken as a path, `''` would be checked as the working directory while SQLite opened a
  // temporary database elsewhere, and the refusal would name an empty file.
  assert.throws(() => userStoreFile('sqlite:', '/x/users.db'), /^Error: HOLDRIM_USERS="sqlite:" names no file/);
  assert.throws(() => userStoreFile('sqlite://', '/x/users.db'), /^Error: HOLDRIM_USERS="sqlite:\/\/" names no file/);
  assert.throws(() => userStoreFile(undefined, ''), /^Error: HOLDRIM_USERS_PATH is empty and names no file/);
});

test('an events store names its file only when it is SQLite on a file', () => {
  assert.equal(eventStoreFile('memory', '/srv/site/events.db'), null, 'memory');
  assert.equal(eventStoreFile('firestore', '/srv/site/events.db'), null, 'firestore');
  assert.equal(eventStoreFile('sqlite', ':memory:'), null, 'sqlite in memory');
  assert.deepEqual(eventStoreFile('sqlite', '/srv/data/events.db'), { file: '/srv/data/events.db', variable: 'HOLDRIM_EVENTS_PATH' });
  assert.deepEqual(eventStoreFile('sqlite', undefined), { file: './data/events.db', variable: 'HOLDRIM_EVENTS_PATH' },
    'unset: the default, which the site check then judges like any other path');
});

test('the server refuses to start on an events store that names an empty file, naming the variable', () => {
  assert.throws(() => eventStoreFile('sqlite', ''), /^Error: HOLDRIM_EVENTS_PATH is empty and names no file/);
  assert.equal(eventStoreFile('memory', ''), null, 'a store that writes no file does not read the variable');
});

// ===================================================================== a store, on every request
// `serveStatic` answers "not there" for a file inside a store's real folder, resolved once at boot,
// so the server never serves a store it writes even after the site's root is re-pointed. The
// contract test re-points a live server's site; these hold the two pieces it is built from.

test('the server never serves a store it writes: a file inside a store folder is inside it', (t) => {
  const parent = siteParent(t);
  mkdirSync(join(parent, 'data'));
  writeFileSync(join(parent, 'data', 'events.db'), '');
  const folders = [realStoreFolder(join(parent, 'data', 'events.db'))];
  for (const name of ['events.db', 'events.db-wal', 'events.db-shm']) {
    assert.equal(insideStoreFolder(folders, join(folders[0], name)), true, name);
  }
  assert.equal(insideStoreFolder([join(parent, 'elsewhere'), ...folders], join(folders[0], 'events.db')), true,
    'whichever of the store folders it is in');
});

test('the server never serves a store it writes, and serves what is beside it', (t) => {
  const parent = siteParent(t);
  mkdirSync(join(parent, 'data'));
  writeFileSync(join(parent, 'data', 'events.db'), '');
  // Real paths on both sides, as `serveStatic` compares them: the temporary folder may itself be a link.
  const real = realpathSync(parent);
  const folders = [realStoreFolder(join(parent, 'data', 'events.db'))];
  assert.equal(insideStoreFolder(folders, join(real, 'data-old', 'events.db')), false, 'a sibling named like it');
  assert.equal(insideStoreFolder(folders, join(real, 'site', 'index.html')), false, 'a page');
  assert.equal(insideStoreFolder([], join(real, 'data', 'events.db')), false, 'no file-backed store at all');
});

test('the server never serves a store it writes: its folder is where the database REALLY is', (t) => {
  // SQLite follows a database file that is a link and keeps `-wal` and `-shm` beside the real file,
  // so that folder, not the link's, is the one to keep out.
  const parent = siteParent(t);
  mkdirSync(join(parent, 'real'));
  mkdirSync(join(parent, 'linked'));
  writeFileSync(join(parent, 'real', 'events.db'), '');
  symlinkSync(join(parent, 'real', 'events.db'), join(parent, 'linked', 'events.db'));
  assert.equal(realStoreFolder(join(parent, 'linked', 'events.db')), realpathSync(join(parent, 'real')));
});
