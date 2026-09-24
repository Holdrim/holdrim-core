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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stub } from './helpers/stub.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const HOOK = join(ROOT, '.claude', 'hooks', 'session-start.sh');


/**
 * Runs the hook in a throwaway project whose package.json asks for `engines`, with `node` reporting
 * `nodeVersion` (null: not installed), the Chromium download and the Firestore emulator succeeding
 * or not, and Claude Code's CLAUDE_ENV_FILE given or not. Hands back what a person would see, every
 * command the stubs saw, and what reached the session's environment.
 */
function run(t, {
  remote = 'true', nodeVersion = '22.18.0', chromium = true, engines = '>=22.18', emulator = true, envFile = true,
} = {}) {
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
  // The real script downloads a jar and starts Java; its own test is firestore-emulator.test.js.
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'firestore-emulator.sh'),
    emulator ? 'echo "export FIRESTORE_EMULATOR_HOST=127.0.0.1:8433"\n' : 'echo "no Java" >&2; exit 1\n');
  // Other hooks write to the same file before this one: whatever is there must survive.
  const sessionEnv = join(dir, 'session.env');
  writeFileSync(sessionEnv, 'export BEFORE=1\n');
  const env = {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_REMOTE: remote,
    CLAUDE_ENV_FILE: envFile ? sessionEnv : '',
  };
  const r = spawnSync('bash', [HOOK], { env, encoding: 'utf8' });
  return {
    code: r.status, out: r.stderr, calls: readFileSync(log, 'utf8'), sessionEnv: readFileSync(sessionEnv, 'utf8'),
  };
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

test('a running emulator reaches the session through CLAUDE_ENV_FILE', (t) => {
  const { out, sessionEnv } = run(t);
  assert.equal(sessionEnv, 'export BEFORE=1\nexport FIRESTORE_EMULATOR_HOST=127.0.0.1:8433\n');
  assert.doesNotMatch(out, /Firestore/);
});

test('no emulator is said out loud, names the tests that will skip, and the session still starts', (t) => {
  const { code, out, sessionEnv } = run(t, { emulator: false });
  assert.equal(code, 0);
  assert.equal(sessionEnv, 'export BEFORE=1\n');
  assert.match(out, /WARNING: no Firestore emulator in this session\. Its tests will SKIP here/);
});

test('an emulator with nowhere to send its variable says how to use it by hand', (t) => {
  const { out } = run(t, { envFile: false });
  assert.match(out, /WARNING: the Firestore emulator is running.*Run: export FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8433/);
});
