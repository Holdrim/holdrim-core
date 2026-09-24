/**
 * No caller outside `engine/core/roles.js` compares a role's NAME.
 *
 * `roles.js` is the one place that is allowed to know that a role is called `owner`, `admin` or
 * `member`: everywhere else asks `roles.can(capability, email)` or `roles.isOwner(email)`, so that a
 * check keeps working the day a project renames a role, or gets its answer from a grant in
 * `holdrim.json` (#29) instead of the three names this version ships. A caller that wrote
 * `role === 'admin'` instead would silently stop working the day either of those lands, with
 * nothing here to say so — which is exactly the bug this file exists to catch before it is written.
 *
 * Read as text, like `engine/tests/surface.test.js` reads for `HOLDRIM_*` variables: there is no
 * single function every such comparison calls, so nothing can be imported and inspected instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

/** Every tracked or new file under the given paths — a file nobody committed yet is still a caller
 *  the moment it exists, exactly as `surface.test.js`'s own `filesUnder` reasons. */
function filesUnder(...paths) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.(ts|js|jsx)$/.test(f));
}

/** A role's name, quoted, next to a strict (in)equality — on either side of it. */
const ROLE_NAMES = ['owner', 'admin', 'member', 'other'];
const COMPARISON = new RegExp(
  `(?:===|!==)\\s*['"](${ROLE_NAMES.join('|')})['"]|['"](${ROLE_NAMES.join('|')})['"]\\s*(?:===|!==)`);

/** Comments are prose about the code, not the code — this file's own comments say the pattern it
 *  looks for, and must not trip over themselves. Stripped the same way `surface.test.js` strips
 *  them to read `holdrim.json`'s keys out of `config.js`. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the boundary itself: engine/api, engine/cli and engine/web/src hold callers to check', () => {
  const files = filesUnder('engine/api', 'engine/cli', 'engine/web/src');
  assert.ok(files.some((f) => f.endsWith('server.ts')), 'the file scan read the wrong files');
});

test('no caller outside engine/core/roles.js compares a role name — it asks `can` or `isOwner`', () => {
  const files = filesUnder('engine/api', 'engine/cli', 'engine/web/src');
  const offenders = [];
  for (const file of files) {
    const text = withoutComments(readFileSync(join(ROOT, file), 'utf8'));
    for (const [lineNumber, line] of text.split('\n').entries()) {
      if (COMPARISON.test(line)) offenders.push(`${file}:${lineNumber + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], [
    'a role\'s name is compared outside engine/core/roles.js — ask a capability instead:',
    ...offenders,
  ].join('\n  '));
});
