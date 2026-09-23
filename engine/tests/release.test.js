/**
 * The release guard refuses every tag that would publish something other than what it claims.
 *
 * The guard is the one thing between a pushed tag and an image adopters pin, and nothing else runs
 * it before a tag exists — so each refusal is proved here, in a repository built for the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loneDirectory, run, isolatedEnv } from './helpers/git-sandbox.js';

const SCRIPT = new URL('../../scripts/check-release-tag.sh', import.meta.url).pathname;

/**
 * A repository on `main` whose package.json says `version`, with one commit. `changelog` is the
 * whole CHANGELOG.md, or null for none; by default it has the section the guard asks for.
 */
function repository(version = '0.1.0', changelog = `# Changelog\n\n## [${version}] — 2026-09-23\n\n- first\n`) {
  const dir = loneDirectory();
  run(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  run(dir, 'add', 'package.json');
  if (changelog !== null) {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    run(dir, 'add', 'CHANGELOG.md');
  }
  run(dir, 'commit', '-q', '-m', 'release');
  return dir;
}

/**
 * Runs the guard for `tag` inside `dir`, against `main` unless told otherwise. `said` is stdout
 * alone, the guard's own sentences; `out` adds whatever git printed.
 */
function guard(dir, tag, main = 'main') {
  const r = spawnSync('bash', [SCRIPT, tag], { cwd: dir, encoding: 'utf8', env: isolatedEnv({ MAIN_REF: main }) });
  return { code: r.status, out: r.stdout + r.stderr, said: r.stdout };
}

test('a version tag on main that matches package.json passes', () => {
  const dir = repository('0.1.0');
  run(dir, 'tag', 'v0.1.0');
  const r = guard(dir, 'v0.1.0');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /matches package\.json, has a changelog entry, and is on main/);
});

test('a tag that is not vMAJOR.MINOR.PATCH is refused', () => {
  const dir = repository();
  for (const tag of ['v0.1', '0.1.0', 'v01.0.0', 'v0.1.0-rc1', '']) {
    const r = guard(dir, tag);
    assert.equal(r.code, 1, `${JSON.stringify(tag)} was accepted`);
    assert.match(r.out, /is not vMAJOR\.MINOR\.PATCH/);
  }
});

test('a tag that disagrees with package.json is refused, and says which version is in the file', () => {
  const dir = repository('0.1.0');
  run(dir, 'tag', 'v0.2.0');
  const r = guard(dir, 'v0.2.0');
  assert.equal(r.code, 1);
  assert.match(r.out, /the tag is v0\.2\.0 but package\.json says 0\.1\.0/);
});

test('a tag on a commit that never reached main is refused', () => {
  const dir = repository('0.1.0');
  run(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'unreviewed.txt'), 'nobody looked at this');
  run(dir, 'add', 'unreviewed.txt');
  run(dir, 'commit', '-q', '-m', 'side work');
  run(dir, 'tag', 'v0.1.0');
  const r = guard(dir, 'v0.1.0');
  assert.equal(r.code, 1);
  assert.match(r.out, /is not on main — a release is cut from main only/);
});

test('a main that was never fetched is named, not taken for a tag off main', () => {
  const dir = repository('0.1.0');
  run(dir, 'tag', 'v0.1.0');
  const r = guard(dir, 'v0.1.0', 'origin/main');
  assert.equal(r.code, 1);
  assert.match(r.said, /origin\/main is not here to compare against — fetch it first/);
  assert.doesNotMatch(r.out, /is not on/);
});

test('a tag that does not exist is named, with a sentence of its own', () => {
  const dir = repository('0.1.0');
  const r = guard(dir, 'v0.1.0');
  assert.equal(r.code, 1);
  // The guard's own words, not the merged output: otherwise git's "fatal:" on stderr would be the
  // only one.
  assert.match(r.said, /there is no tag v0\.1\.0 here/);
});

test('a release with no changelog section for its version is refused', () => {
  const cases = {
    'no CHANGELOG.md at all': null,
    'a changelog that stops at the release before': '# Changelog\n\n## [0.0.9]\n\n- older\n',
    'the version only mentioned in passing': '# Changelog\n\n- see [0.1.0] later\n',
    // The dots are literal: an unescaped pattern would take `0x1x0` for `0.1.0`.
    'a heading that only looks like the version': '# Changelog\n\n## [0x1x0]\n',
  };
  for (const [name, changelog] of Object.entries(cases)) {
    const dir = repository('0.1.0', changelog);
    run(dir, 'tag', 'v0.1.0');
    const r = guard(dir, 'v0.1.0');
    assert.equal(r.code, 1, `${name}: accepted`);
    assert.match(r.out, /CHANGELOG\.md has no '## \[0\.1\.0\]' section/, name);
  }
});
