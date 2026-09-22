/**
 * Text written by a test never reaches the channel the test runner reads its reports from.
 *
 * On Node 22 a line of non-ASCII text on a test file's stdout can be misread as a report and fail
 * the file, or silently drop it — see engine/tests/hooks/console-to-stderr.js. The hook is only as
 * good as the script that loads it, so both halves are checked: what `npm test` runs, and what the
 * hook does in a process that looks like a test file's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname;
const HOOK = './engine/tests/hooks/console-to-stderr.js';

/** Runs `code` the way the runner runs a test file, with whatever `npm test` imports first. A
 * `context` of null runs it as an ordinary process instead. */
function asTestFile(code, context = 'child-v8') {
  const script = JSON.parse(readFileSync(new URL('package.json', `file://${ROOT}`), 'utf8')).scripts.test;
  const imports = [...script.matchAll(/--import\s+(\S+)/g)].flatMap(([, path]) => ['--import', path]);
  const env = { ...process.env, NODE_TEST_CONTEXT: context };
  if (context === null) delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [...imports, '-e', code], { cwd: ROOT, encoding: 'utf8', env });
  return { stdout: r.stdout, stderr: r.stderr };
}

test('npm test loads the hook that keeps console text off the runner\'s channel', () => {
  const script = JSON.parse(readFileSync(new URL('package.json', `file://${ROOT}`), 'utf8')).scripts.test;
  assert.match(script, new RegExp(`--import\\s+${HOOK.replace(/[./]/g, '\\$&')}\\s.*--test`));
});

test('inside a test file, console.log, info and debug land on stderr, even a line starting with ✗', () => {
  const r = asTestFile("console.log('✗ log'); console.info('✗ info'); console.debug('✗ debug')");
  assert.equal(r.stdout, '', 'nothing reached stdout, where the runner reads its frames');
  assert.match(r.stderr, /✗ log\n✗ info\n✗ debug/);
});

test('outside a test file, stdout is left alone', () => {
  const r = asTestFile("console.log('plain')", null);
  assert.equal(r.stdout, 'plain\n', 'a CLI a test spawns still writes its answer to stdout');
});
