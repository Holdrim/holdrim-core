/**
 * Where `holdrim index` puts its database when nobody says otherwise (`defaultIndexPath`,
 * engine/cli/fs.ts, read by `rebuildIndex`, engine/cli/validation.ts).
 *
 * It used to be `<project root>/data/events.db` — generated, and sitting inside the very folder a
 * documentation project usually serves and commits. These tests are the ones that would have
 * caught that: the default has to fall OUTSIDE the project (by real path, not a raw string
 * comparison a symlinked temp dir would fool), two projects must never collide on one index, and
 * `--db` / `HOLDRIM_EVENTS_PATH` must still be the last word, exactly as before this moved.
 *
 * ⚠️ None of this may touch the real `~/.cache`: every test that lets `defaultIndexPath` read
 * `XDG_CACHE_HOME` points it at a throwaway temp folder first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { defaultIndexPath } from '../cli/fs.ts';
import { insideRoot } from '../core/paths.js';
import { rebuildIndex } from '../cli/validation.ts';

/** A throwaway project root. `defaultIndexPath` only ever reads its real path. */
function projectRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-idx-root-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A throwaway `holdrim.json` with nothing to scan, so `rebuildIndex` runs fast and indexes 0 blocks. */
function minimalProject(t) {
  const dir = projectRoot(t);
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'r.json' } }));
  return dir;
}

/** A throwaway `XDG_CACHE_HOME`, never the real one. */
function cacheHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-idx-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Sets `process.env[name]` for the life of the test and restores whatever was there before. */
function withEnv(t, name, value) {
  const saved = process.env[name];
  process.env[name] = value;
  t.after(() => { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; });
}

test('the default index database sits outside the project root, by real path', (t) => {
  const root = projectRoot(t);
  withEnv(t, 'XDG_CACHE_HOME', cacheHome(t));
  const path = defaultIndexPath(root);

  // The folder does not exist yet — `defaultIndexPath` only computes a name, the way `Index`'s own
  // constructor (engine/api/index-store.ts) creates it on first use. Made real here the same way
  // `realContainment` (engine/cli/fs.ts) resolves a target that is not there yet: through its
  // deepest existing ancestor, so a symlinked `$TMPDIR` (common on some platforms) cannot make the
  // comparison pass by accident on a lexical string alone.
  mkdirSync(dirname(path), { recursive: true });
  const realRoot = realpathSync(root);
  const realTarget = join(realpathSync(dirname(path)), basename(path));

  assert.equal(insideRoot(realRoot, realTarget), false,
    `the index database (${realTarget}) must not sit inside the project root (${realRoot})`);
});

test('two different project roots get different default index paths', (t) => {
  withEnv(t, 'XDG_CACHE_HOME', cacheHome(t));
  const a = defaultIndexPath(projectRoot(t));
  const b = defaultIndexPath(projectRoot(t));
  assert.notEqual(a, b, 'one shared index for two projects would let one project overwrite the other\'s');
});

test('the same project root gets the same default index path every time', (t) => {
  withEnv(t, 'XDG_CACHE_HOME', cacheHome(t));
  const root = projectRoot(t);
  assert.equal(defaultIndexPath(root), defaultIndexPath(root));
});

test('XDG_CACHE_HOME is honoured: the default lives under it, never under the real ~/.cache', (t) => {
  const cache = cacheHome(t);
  withEnv(t, 'XDG_CACHE_HOME', cache);
  const path = defaultIndexPath(projectRoot(t));
  assert.ok(path.startsWith(join(cache, 'holdrim') + '/'), `expected ${path} under ${cache}/holdrim`);
});

test('rebuildIndex writes to the default index path when nothing overrides it', async (t) => {
  const root = minimalProject(t);
  withEnv(t, 'XDG_CACHE_HOME', cacheHome(t));
  // A leftover from before this default moved must not read as an override — the env var itself
  // has to be genuinely unset for this to prove `rebuildIndex` reaches `defaultIndexPath` on its own.
  const savedEnvPath = process.env.HOLDRIM_EVENTS_PATH;
  delete process.env.HOLDRIM_EVENTS_PATH;
  t.after(() => { if (savedEnvPath !== undefined) process.env.HOLDRIM_EVENTS_PATH = savedEnvPath; });

  await rebuildIndex(root, undefined);

  const expected = defaultIndexPath(root);
  assert.ok(existsSync(expected), `rebuildIndex should have written its database at ${expected}`);
  assert.ok(!existsSync(join(root, 'data', 'events.db')),
    'the old, inside-the-project default must not be written any more');
});

test('--db still wins over the default, even with a fresh XDG_CACHE_HOME in play', async (t) => {
  const root = minimalProject(t);
  withEnv(t, 'XDG_CACHE_HOME', cacheHome(t));
  const explicit = join(mkdtempSync(join(tmpdir(), 'holdrim-idx-explicit-')), 'chosen.db');
  t.after(() => rmSync(dirname(explicit), { recursive: true, force: true }));

  await rebuildIndex(root, explicit);

  assert.ok(existsSync(explicit), '--db names the file that should have been written');
  assert.ok(!existsSync(join(root, 'data')), 'the project folder must stay untouched when --db is given');
});

test('HOLDRIM_EVENTS_PATH still wins over the default, even with a fresh XDG_CACHE_HOME in play', async (t) => {
  const root = minimalProject(t);
  withEnv(t, 'XDG_CACHE_HOME', cacheHome(t));
  const fromEnv = join(mkdtempSync(join(tmpdir(), 'holdrim-idx-env-')), 'events.db');
  t.after(() => rmSync(dirname(fromEnv), { recursive: true, force: true }));
  withEnv(t, 'HOLDRIM_EVENTS_PATH', fromEnv);

  await rebuildIndex(root, undefined);

  assert.ok(existsSync(fromEnv), 'HOLDRIM_EVENTS_PATH names the file that should have been written');
  assert.ok(!existsSync(join(root, 'data')), 'the project folder must stay untouched when the variable is set');
});
