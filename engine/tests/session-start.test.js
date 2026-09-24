/**
 * The cloud session hook, checked.
 *
 * `.claude/hooks/session-start.sh` runs before every cloud session and nothing else runs it, so each
 * of its guards could be deleted with all five proofs still green. It is driven here the way Claude
 * Code starts it, with `npm`, `npx`, `git` and `node` replaced by stubs on the PATH: the real ones
 * would reinstall `node_modules` and rewrite this repository's git config.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const HOOK = join(ROOT, '.claude', 'hooks', 'session-start.sh');

function stub(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Runs the hook in a throwaway project whose package.json asks for `engines`, with `node` reporting
 * `nodeVersion` (null: not installed) and the Chromium download succeeding or not. Hands back what
 * a person would see and every command the stubs saw.
 */
function run(t, { remote = 'true', nodeVersion = '22.18.0', chromium = true, engines = '>=22.18' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The test owns its floor: with the repository's own package.json, bumping engines.node would
  // turn every default run into a warning and break tests that are not about the version.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: engines } }));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  stub(dir, 'npm', `echo "npm $*" >> '${log}'`);
  stub(dir, 'git', `echo "git $*" >> '${log}'`);
  stub(dir, 'npx', `echo "npx $*" >> '${log}'; exit ${chromium ? 0 : 1}`);
  stub(dir, 'node', nodeVersion === null ? 'exit 127' : [
    `if [ "$1" = -v ]; then echo v${nodeVersion}; exit 0; fi`,
    `exec '${process.execPath}' -e "Object.defineProperty(process.versions, 'node', { value: '${nodeVersion}' });$2"`,
  ].join('\n'));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_REMOTE: remote };
  const r = spawnSync('bash', [HOOK], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stderr, calls: readFileSync(log, 'utf8') };
}

test('on a developer machine it does nothing at all', (t) => {
  const { code, calls } = run(t, { remote: '' });
  assert.equal(code, 0);
  assert.equal(calls, '');
});

test('it installs what the lockfile says, never re-resolving it', (t) => {
  const { calls } = run(t);
  assert.match(calls, /^npm ci /m);
  assert.doesNotMatch(calls, /^npm install/m);
});

test('it turns on the repository git hooks', (t) => {
  const { calls } = run(t);
  assert.match(calls, /^git config core\.hooksPath \.githooks$/m);
});

test('a Node older than engines.node is said out loud', (t) => {
  const { code, out } = run(t, { nodeVersion: '22.17.9' });
  assert.equal(code, 0);
  assert.match(out, /WARNING: Node v22\.17\.9 does not meet/);
});

test('a Node at or above engines.node passes quietly', (t) => {
  for (const nodeVersion of ['22.18.0', '22.18.1', '23.0.0', '24.1.0']) {
    assert.doesNotMatch(run(t, { nodeVersion }).out, /WARNING: Node/, nodeVersion);
  }
});

test('the floor comes from package.json, not from a copy in the hook', (t) => {
  const { out } = run(t, { nodeVersion: '22.18.0', engines: '>=24.1' });
  assert.match(out, /WARNING: Node v22\.18\.0 does not meet/);
});

test('a missing Node is said out loud too', (t) => {
  const { code, out } = run(t, { nodeVersion: null });
  assert.equal(code, 0);
  assert.match(out, /WARNING: Node is missing/);
});

test('a Chromium download that fails is said out loud, and the session still starts', (t) => {
  const { code, out, calls } = run(t, { chromium: false });
  assert.equal(code, 0);
  assert.match(calls, /^npx --no-install playwright-core install chromium$/m);
  assert.match(out, /WARNING: could not install Chromium/);
});

test('a Chromium download that works says nothing', (t) => {
  assert.equal(run(t).out, '');
});
