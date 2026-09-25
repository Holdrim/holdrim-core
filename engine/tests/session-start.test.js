/**
 * The session-start hook, checked.
 *
 * `.claude/hooks/session-start.sh` runs before every session — cloud and local, fresh and
 * `/clear`ed — and nothing else runs it, so each of its guards could be deleted with all five
 * proofs still green. It is driven here the way Claude Code starts it, with `npm`, `npx`, `git` and
 * `node` replaced by stubs on the PATH: the real ones would reinstall `node_modules`, rewrite this
 * repository's git config, and reach an actual `origin` this test does not control.
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
  fetchOk = true, behind = 0, dirty = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-hook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The test owns its floor: with the repository's own package.json, bumping engines.node would
  // turn every default run into a warning and break tests that are not about the version.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: engines } }));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  stub(dir, 'npm', `echo "npm $*" >> '${log}'`);
  // Most git subcommands the hook runs (config, add, ...) only need to be logged. The three the
  // staleness check depends on are given fake but controllable answers, because the real fetch,
  // rev-list and status would need a real `origin` this throwaway directory does not have.
  stub(dir, 'git', [
    `echo "git $*" >> '${log}'`,
    'case "$1" in',
    `  fetch) ${fetchOk ? 'exit 0' : "echo 'fatal: could not resolve host' >&2; exit 1"} ;;`,
    `  rev-list) echo ${behind} ;;`,
    `  status) ${dirty ? "echo ' M some-file'" : 'true'} ;;`,
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'));
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
    code: r.status, out: r.stderr, stdout: r.stdout,
    calls: readFileSync(log, 'utf8'), sessionEnv: readFileSync(sessionEnv, 'utf8'),
  };
}

test('on a developer machine the heavy setup does not run', (t) => {
  const { code, calls } = run(t, { remote: '' });
  assert.equal(code, 0);
  assert.doesNotMatch(calls, /^npm ci/m);
  assert.doesNotMatch(calls, /^git config core\.hooksPath/m);
  assert.doesNotMatch(calls, /^npx /m);
});

test('the handoff note reaches the session on stdout, cloud or local', (t) => {
  for (const remote of ['true', '']) {
    const { stdout } = run(t, { remote });
    assert.match(stdout, /handoff/, remote || 'local');
    assert.match(stdout, /\/crew/, remote || 'local');
  }
});

test('the handoff note still prints when an earlier optional step warns', (t) => {
  const { out, stdout } = run(t, { emulator: false });
  assert.match(out, /WARNING: no Firestore emulator/);
  assert.match(stdout, /handoff/);
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

test('a checkout already at origin/main gets no staleness warning', (t) => {
  assert.doesNotMatch(run(t, { behind: 0 }).out, /behind origin\/main/);
});

test('a checkout behind origin/main is said out loud, naming how far', (t) => {
  const { out } = run(t, { behind: 3 });
  assert.match(out, /WARNING: this checkout is 3 commit\(s\) behind origin\/main/);
});

test('the staleness warning runs on a developer machine too', (t) => {
  const { out } = run(t, { remote: '', behind: 5 });
  assert.match(out, /WARNING: this checkout is 5 commit\(s\) behind origin\/main/);
});

test('a clean checkout behind origin/main is offered the fast-forward', (t) => {
  const { out } = run(t, { behind: 1, dirty: false });
  assert.match(out, /git merge --ff-only origin\/main/);
});

test('a dirty checkout behind origin/main is warned, not told to merge', (t) => {
  const { out } = run(t, { behind: 1, dirty: true });
  assert.match(out, /WARNING: this checkout is 1 commit/);
  assert.doesNotMatch(out, /git merge --ff-only/);
});

test('a fetch that fails is said out loud, and the session still starts', (t) => {
  const { code, out } = run(t, { fetchOk: false });
  assert.equal(code, 0);
  assert.match(out, /WARNING: could not fetch origin\/main/);
});

test('the staleness check never merges or switches branches itself', (t) => {
  const { calls } = run(t, { behind: 2, dirty: false });
  assert.doesNotMatch(calls, /^git merge/m);
  assert.doesNotMatch(calls, /^git checkout/m);
  assert.doesNotMatch(calls, /^git switch/m);
});
