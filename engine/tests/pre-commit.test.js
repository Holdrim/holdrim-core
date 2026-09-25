/**
 * .githooks/pre-commit's bundle-freshness loop (section 8, #38), checked directly: nothing else
 * runs the hook itself, so either entry of its `for pair in ...` list could be deleted and every
 * other proof — `npm test`, the contract test, `npm run browser` — would stay green, because none
 * of them stages a commit and watches the hook refuse it.
 *
 * Driven the way session-start.test.js already drives `.claude/hooks/session-start.sh`: a
 * throwaway git repository, `npm` replaced by a stub so no real esbuild runs, and the hook
 * invoked with `bash` exactly as git would invoke it. `git` itself is real — a stub would only
 * prove the stub agrees with itself — and `isolatedEnv` (git-sandbox.js) keeps it from reading
 * this machine's own config, the same guard AGENTS.md asks for around any git repository built
 * for a test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stub } from './helpers/stub.js';
import { isolatedEnv, run as git } from './helpers/git-sandbox.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const HOOK = join(ROOT, '.githooks', 'pre-commit');
const HOOK_SRC = readFileSync(HOOK, 'utf8');

/**
 * A repository with both bundles committed at `panel v1` / `graph v1`, one file staged under
 * `engine/web/src/` — enough to make section 8's `bundled` check fire without also dragging in
 * `node --check` or eslint, which a staged `.js` file would (section 1 and 2 read the same `$js`
 * list) — and `npm` stubbed to write `panelOutput`/`graphOutput` in place of the two real build
 * scripts. Runs `hookSrc` (the real hook by default, or a mutated copy) and hands back its exit
 * code and what it printed.
 */
function run(t, { hookSrc = HOOK_SRC, panelOutput = 'panel v1', graphOutput = 'graph v1' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-pre-commit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(dir, 'init', '-q');
  mkdirSync(join(dir, 'engine', 'web', 'src'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'web', 'panel-react.js'), 'panel v1');
  writeFileSync(join(dir, 'engine', 'web', 'home-graph.js'), 'graph v1');
  git(dir, 'add', 'engine/web/panel-react.js', 'engine/web/home-graph.js');
  git(dir, 'commit', '-q', '-m', 'seed bundles');

  // No extension: a `.js` here would join `$js` too, and pull in node --check and eslint, which
  // this sandbox has no config for — this commit is about section 8 alone.
  writeFileSync(join(dir, 'engine', 'web', 'src', 'marker.txt'), 'touches a bundle input');
  git(dir, 'add', 'engine/web/src/marker.txt');

  const hookPath = join(dir, 'pre-commit-under-test');
  writeFileSync(hookPath, hookSrc);

  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  // `npm run --silent <script>` is the only command section 8 shells out to; standing in for it
  // is standing in for esbuild, not for git — git stays real so the diff it reports is genuine.
  stub(binDir, 'npm', [
    'case "$3" in',
    `  build:web) printf '%s' '${panelOutput}' > engine/web/panel-react.js ;;`,
    `  build:web-graph) printf '%s' '${graphOutput}' > engine/web/home-graph.js ;;`,
    'esac',
  ].join('\n'));

  const env = isolatedEnv({ ...process.env, PATH: `${binDir}:${process.env.PATH}` });
  const r = spawnSync('bash', [hookPath], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a stale home-graph.js fails the commit, naming that file', (t) => {
  const { code, out } = run(t, { graphOutput: 'graph v2' });
  assert.equal(code, 1);
  assert.match(out, /engine\/web\/home-graph\.js was stale/);
  assert.doesNotMatch(out, /panel-react\.js was stale/);
});

test('a stale panel-react.js fails the commit, naming that file', (t) => {
  const { code, out } = run(t, { panelOutput: 'panel v2' });
  assert.equal(code, 1);
  assert.match(out, /engine\/web\/panel-react\.js was stale/);
  assert.doesNotMatch(out, /home-graph\.js was stale/);
});

test('both bundles rebuilding unchanged passes quietly', (t) => {
  const { code, out } = run(t);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /was stale/);
});
