/**
 * No caller outside `engine/core/roles.js` decides anything from a role's NAME.
 *
 * `roles.js` is the one place allowed to know that a role is called `owner`, `admin` or `member`:
 * everywhere else asks `roles.can(capability, email)` or `roles.isOwner(email)`, so a check keeps
 * working the day a project renames a role, or gets its answer from a grant in `holdrim.json` (#29)
 * instead of the three names this version ships. A caller that wrote `role === 'admin'` instead
 * would silently stop working the day either of those lands, with nothing here to say so — which is
 * exactly the bug this file exists to catch before it is written.
 *
 * Two shapes are refused, neither tied to a particular operator:
 *   - the role's name as a STRING LITERAL, anywhere — `===`, `!==`, `==`, a `switch`'s `case`, an
 *     array's `.includes(...)`, a backtick template, or a comparison split over two lines all put
 *     the same quoted word in the source, and the word is what gives the check away, not the
 *     operator next to it.
 *   - an object literal read with `roleOf(...)` as the key (`{ admin: true }[roleOf(e)]`), which asks
 *     the same question as a string comparison — "is this admin?" — without writing the name inside
 *     quotes at all.
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

/** Every tracked or new file under the given paths, `roles.js` itself left out — a file nobody
 *  committed yet is still a caller the moment it exists, exactly as `surface.test.js`'s own
 *  `filesUnder` reasons. `engine/core` is scanned too, `roles.js` aside: the closed list belongs to
 *  ONE file in there, not to the directory, and a second file inventing its own role check would be
 *  the same bug in a place this test would otherwise not be looking. */
function filesUnder(...paths) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(ts|js|jsx)$/.test(f) && f !== 'engine/core/roles.js');
}

const SCANNED = ['engine/api', 'engine/cli', 'engine/core', 'engine/web/src'];

/** `other` is the display role this version retired (renamed `member`) — kept in the list so a
 *  revert that brings the old name back as something a caller checks is still caught, not only a
 *  live role's name. */
const ROLE_NAMES = ['owner', 'admin', 'member', 'other'];

/** A role's name, in single quotes, double quotes or backticks — whatever holds it, not whatever
 *  sits next to it. `\1` requires the closing mark to match the opening one, so this cannot cross
 *  from one string into a different one that happens to follow it. */
const LITERAL = new RegExp(`(['"\`])(${ROLE_NAMES.join('|')})\\1`);

/** `{ admin: true }[roleOf(e)]`: an object indexed by the very call `can` and `isOwner` exist to
 *  replace. No quoted name is needed for this one — the decision is hiding in the lookup itself. */
const COMPUTED_LOOKUP = /\[[^[\]]*\broleOf\(/;

/**
 * Real, needed uses of one of these words, or this shape, that are not a decision made from a
 * role's name — named ONCE, here, with why, instead of teaching the scan to tell them apart from the
 * inside. That cleverness is exactly what a real offender would hide behind next.
 *
 * Matched by the exact snippet, not by a line number: a line number drifts the moment somebody adds
 * a line above it, and a stale entry that silently stopped matching anything would be a hole nobody
 * could see. `staleEntries`, below, is the test that a snippet still exists somewhere.
 */
const ALLOWED = [
  { file: 'engine/api/people-page.ts', text: "type Role = 'owner' | 'admin' | 'member';",
    why: 'the display role\'s own type — naming the three shipped roles for a column and a sort ' +
      'order is what this type is for; nothing here decides anything from them' },
  { file: 'engine/api/people-page.ts',
    text: 'rank[data.roleOf(a.email)] - rank[data.roleOf(b.email)]',
    why: 'a SORT ORDER, never a decision — the exact shape `COMPUTED_LOOKUP` exists to refuse, which ' +
      'is why this one instance is named here instead of exempting the shape in general' },
  { file: 'engine/cli/remote.ts', text: "this.#token = 'owner'",
    why: '"owner" is the Firestore EMULATOR\'s own word for a caller its security rules do not ' +
      'apply to (see the comment above it), never a Holdrim role' },
  { file: 'engine/core/config.js', text: "const AUTHORITY_KEYS = ['owner', 'admins', 'locks'];",
    why: 'holdrim.json KEY NAMES refused at the door, not a person\'s role' },
  { file: 'engine/core/cycle.js', text: "ownerStates: ownedBy('owner'),",
    why: 'the CYCLE\'s own vocabulary (cycle.json) — which side of a transition owns it, "owner" or ' +
      '"agent" — a different concept than a person\'s role. This, and the two below, are the reason ' +
      'this scan excludes only roles.js and not the whole of engine/core' },
  { file: 'engine/core/cycle.js', text: "const owner = ownedBy('owner');", why: 'same cycle vocabulary as above' },
  { file: 'engine/core/cycle.js', text: "ownedBy: table.states[state]?.owned_by ?? 'owner',",
    why: 'same cycle vocabulary as above' },
];

/** Comments are prose about the code, not the code — this file's own comments say the very patterns
 *  it looks for, and must not trip over themselves. Block comments are blanked, not removed, so a
 *  real offender's line number still points at the real file: deleting the newlines inside one would
 *  shift every line after it. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

/** Blanks out `file`'s allow-listed snippets, leaving their length and any newline they hold — so an
 *  offense on the same line as a blanked one still reports the right line number. A snippet that
 *  matches nothing (`file` unset, as every self-test below passes it) is simply not there to strip. */
function stripAllowed(text, file) {
  let scanned = text;
  for (const entry of ALLOWED.filter((a) => a.file === file)) {
    scanned = scanned.replaceAll(entry.text, entry.text.replace(/[^\n]/g, ' '));
  }
  return scanned;
}

/**
 * Every offense left in `text` once `file`'s own allow-listed snippets are blanked out — used both
 * on real files below and on synthetic snippets in the self-tests, so the two never drift into
 * checking different things.
 * @param {string} text
 * @param {string|null} file  a path from `ALLOWED`, or null for a synthetic snippet with no allowance
 */
function offendersIn(text, file = null) {
  const scanned = stripAllowed(withoutComments(text), file);
  const found = [];
  for (const [lineNumber, line] of scanned.split('\n').entries()) {
    if (LITERAL.test(line)) found.push(`${lineNumber + 1}: ${line.trim()}  (a role's name, quoted)`);
    if (COMPUTED_LOOKUP.test(line)) {
      found.push(`${lineNumber + 1}: ${line.trim()}  (an object indexed by roleOf(), not asked with can)`);
    }
  }
  return found;
}

/**
 * Which of `ALLOWED`'s entries no longer match anything `read` returns for their file — the way an
 * entry rots: the code it named moved or was rewritten, and the exception it granted is now hiding
 * nothing, or worse, hiding whatever replaced it. `read` is injected so a self-test can prove this
 * catches drift without waiting for a real file to drift.
 */
function staleEntries(read) {
  return ALLOWED.filter((entry) => !withoutComments(read(entry.file)).includes(entry.text));
}

test('the boundary itself: the scanned paths hold callers, and a file to allow-list on purpose', () => {
  const files = filesUnder(...SCANNED);
  assert.ok(files.some((f) => f.endsWith('server.ts')), 'the file scan read the wrong files');
  assert.ok(files.includes('engine/core/cycle.js'), 'engine/core must be scanned too, roles.js aside');
  assert.ok(!files.includes('engine/core/roles.js'), 'roles.js is the one file allowed to name a role');
});

// ------------------------------------------------------------------ the scan itself, self-tested
// Each of these is a way a real offender could evade a check tied to one operator. `offendersIn` is
// the SAME function the real scan below calls, so a fix made only for the real files, and not for
// the function every self-test proves, could not silently stop applying to them.

test('catches a role name in a switch\'s case, not only next to ===', () => {
  const found = offendersIn("switch (roles.roleOf(e)) {\n  case 'admin': return true;\n}", null);
  assert.ok(found.length, 'a switch/case on a role name slipped through');
});

test('catches a role name inside .includes(...)', () => {
  const found = offendersIn("if (['owner', 'admin'].includes(roles.roleOf(e))) return true;", null);
  assert.ok(found.length, 'an array literal checked with .includes() slipped through');
});

test('catches a role name compared with loose equality', () => {
  const found = offendersIn("if (roles.roleOf(e) == 'admin') return true;", null);
  assert.ok(found.length, 'a == comparison slipped through');
});

test('catches a role name in a backtick literal', () => {
  const found = offendersIn('const wanted = `admin`; if (roles.roleOf(e) === wanted) return true;', null);
  assert.ok(found.length, 'a template literal holding a role name slipped through');
});

test('catches a comparison whose operator and literal are on different lines', () => {
  const found = offendersIn('if (\n  roles.roleOf(e)\n    === \'owner\'\n) return true;', null);
  assert.ok(found.length, 'a comparison split across lines slipped through the old per-line, next-to-=== check');
});

test('catches a decision hiding behind an object literal keyed by roleOf(), with no literal at all', () => {
  const found = offendersIn('const canManage = ({ owner: true, admin: true, member: false })[roles.roleOf(e)];', null);
  assert.ok(found.length, 'a lookup object indexed by roleOf() slipped through');
});

test('does not flag the one allow-listed instance of the lookup shape it otherwise refuses', () => {
  assert.deepEqual(offendersIn('rank[data.roleOf(a.email)] - rank[data.roleOf(b.email)]',
    'engine/api/people-page.ts'), []);
});

test('a stale allow-list entry — text no longer in its file — is caught, not silently kept', () => {
  const stale = staleEntries(() => 'nothing here matches any entry at all');
  assert.equal(stale.length, ALLOWED.length, 'every entry should read as stale against text holding none of them');
});

test('every allow-listed exception still matches something in its real file', () => {
  const stale = staleEntries((file) => readFileSync(join(ROOT, file), 'utf8'));
  assert.deepEqual(stale, [], [
    'an allow-list entry no longer matches its file — the exception it granted may now be granting',
    'something else. Update or remove it:',
    ...stale.map((e) => `  ${e.file}: ${JSON.stringify(e.text)}`),
  ].join('\n'));
});

// ------------------------------------------------------------------ the real files
test('no caller outside engine/core/roles.js decides anything from a role\'s name', () => {
  const files = filesUnder(...SCANNED);
  const offenders = [];
  for (const file of files) {
    for (const line of offendersIn(readFileSync(join(ROOT, file), 'utf8'), file)) offenders.push(`${file}:${line}`);
  }
  assert.deepEqual(offenders, [], [
    'a role\'s name decides something outside engine/core/roles.js — ask roles.can(...) or',
    'roles.isOwner(...) instead, or add a named, explained entry to ALLOWED if this really is not one:',
    ...offenders,
  ].join('\n  '));
});
