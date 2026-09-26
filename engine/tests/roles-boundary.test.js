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
 * Refused, neither tied to a particular operator nor to the line the value sits on:
 *   - the role's name as a STRING LITERAL, anywhere — `===`, `!==`, `==`, a `switch`'s `case`, an
 *     array's `.includes(...)`, a backtick template, or a comparison split over two lines all put
 *     the same quoted word in the source, and the word is what gives the check away, not the
 *     operator next to it.
 *   - an object literal read with `roleOf(...)` as the key (`{ admin: true }[roleOf(e)]`), which asks
 *     the same question as a string comparison — "is this admin?" — without writing the name inside
 *     quotes at all.
 *   - a call to `roleOf(` itself, anywhere it is not one of `ALLOWED`'s named, explained call sites —
 *     because the two shapes above only catch what a DECISION looks like, and a decision made through
 *     a variable (`const role = data.roleOf(p.email)`, then `rank[role] === 0` three lines down, or
 *     `roleOf(e).startsWith('adm')`, with no full literal in sight) puts neither shape on the line that
 *     matters. Closing where the value comes FROM, not only what surrounds it, is what catches those.
 *   - such a variable used, anywhere else in the file, as a lookup key, an (in)equality operand, an
 *     `.includes(...)` argument, a `.startsWith`/`.endsWith` prefix or suffix check, or a regex's
 *     `.test(...)` — `decidesOn`, below — even when the `roleOf(` call that produced it is itself one
 *     of the named, allowed ones.
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
 * A call to `roleOf(` itself, anywhere outside `roles.js`. `LITERAL` and `COMPUTED_LOOKUP` both read
 * what surrounds a value, never where it came from — so `const role = data.roleOf(p.email);` followed,
 * lines later, by `rank[role] === 0` or `return M[role]` puts neither a quoted role name nor a
 * `roleOf(` call inside a bracket on the line that actually decides anything, and both checks above
 * wave it through. The only place the role's name enters a caller's hands AT ALL is this call, so
 * closing the hole means closing THIS, not every shape a later line could hide a decision in: only
 * `ALLOWED`'s named call sites may make it, and any other occurrence — a brand-new call, or one of
 * `roleOf(e).startsWith('adm')`, `/^adm/.test(roleOf(e))`, `roleOf(e) === roleOf(owner)` — is refused
 * by the same rule that refuses a literal, without needing a shape of its own.
 */
const ROLEOF_CALL = /\broleOf\(/;

/**
 * A variable bound, anywhere in the file, to a call whose text contains `roleOf(` — `const role =
 * data.roleOf(p.email)` binds `role`. `ROLEOF_CALL` alone would still miss a decision made on the
 * SAME variable further down the file, at an allow-listed call site's own name (`role`, `rank`, …):
 * this is what `staleEntries`'s reasoning about drift would call the same bug moved one hop away from
 * the call, and it needs its own tracking rather than a cleverer regex on a single line.
 */
function roleOfBindings(text) {
  const names = new Set();
  const bind = /\b(?:const|let|var)\s+(\w+)\s*=[^\n;]*\broleOf\(/g;
  let m;
  while ((m = bind.exec(text))) names.add(m[1]);
  return names;
}

/**
 * A regex matching `name` used the way a role's name decides something: as a computed lookup key
 * (`table[name]`), compared for (in)equality in either order, checked with `.includes(name)`, matched
 * by a prefix or suffix (`name.startsWith(...)`), or handed to a regex's `.test(name)`. The same
 * shapes `LITERAL` and `COMPUTED_LOOKUP` catch for a literal or a direct call, generalised to whatever
 * a caller named the variable it stashed the value in — `'adm' + 'in'` built to dodge `LITERAL`'s
 * quoted match still trips this the moment it sits on either side of `===`.
 */
function decidesOn(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `\\[\\s*${n}\\s*\\]` +
    `|\\b${n}\\s*(===|==|!==|!=)` +
    `|(===|==|!==|!=)\\s*${n}\\b` +
    `|\\.includes\\(\\s*${n}\\s*\\)` +
    `|\\b${n}\\.(startsWith|endsWith)\\(` +
    `|\\.test\\(\\s*${n}\\s*\\)`,
  );
}

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
  { file: 'engine/core/config.js', text: "const AUTHORITY_KEYS = ['owner', 'admins', 'locks', 'agents', 'roles', 'grants'];",
    why: 'holdrim.json KEY NAMES refused at the door, not a person\'s role' },
  { file: 'engine/core/cycle.js', text: "ownerStates: ownedBy('owner'),",
    why: 'the CYCLE\'s own vocabulary (cycle.json) — which side of a transition owns it, "owner" or ' +
      '"agent" — a different concept than a person\'s role. This, and the two below, are the reason ' +
      'this scan excludes only roles.js and not the whole of engine/core' },
  { file: 'engine/core/cycle.js', text: "const owner = ownedBy('owner');", why: 'same cycle vocabulary as above' },
  { file: 'engine/core/cycle.js', text: "ownedBy: table.states[state]?.owned_by ?? 'owner',",
    why: 'same cycle vocabulary as above' },
  { file: 'engine/api/server.ts', text: 'role: roles.roleOf(who),',
    why: 'the /api/me response\'s DISPLAY field, read by nothing this process does — a client may ' +
      'show it, never branch a server decision on it' },
  { file: 'engine/api/server.ts', text: 'roleOf: (e) => roles.roleOf(e), isOwner: (e) => roles.isOwner(e),',
    why: 'handed to the people page for its own display column and sort order only; `isOwner` travels ' +
      'alongside it as the separate boolean `actionsFor` takes, exactly so the page is never left to ' +
      'derive "is this the owner" by comparing the role it was given' },
  { file: 'engine/api/people-page.ts', text: 'const role = data.roleOf(p.email);',
    why: 'the row\'s DISPLAY label and the key into `people.role.*` translations — never compared or ' +
      'looked up by; see `decidesOn`, which would still catch it if a later line started to' },
  { file: 'engine/api/server.ts',
    text: 'role: i18n.t(lang, `people.role.${roles.roleOf(subject)}`), alwaysNamed,',
    why: 'personDisplay\'s own `people.show: "role"` case (docs/ROLES.md, "How a person appears") — ' +
      'a DISPLAY string handed to `personAs`, translated right here since only the server has the ' +
      'reader\'s language; never compared or looked up by' },
  { file: 'engine/cli/requests.ts', text: 'role: roles.roleOf(email), alwaysNamed: false,',
    why: 'the CLI\'s own `people.show: "role"` case — the same DISPLAY use as server.ts\'s, in ' +
      'English since the CLI\'s output never goes through i18n (see the file\'s own header comment)' },
];

/**
 * Comments are prose about the code, not the code — this file's own comments say the very patterns
 * it looks for, and must not trip over themselves. Block comments are blanked, not removed, so a
 * real offender's line number still points at the real file: deleting the newlines inside one would
 * shift every line after it.
 *
 * A string or template literal is walked past whole, its contents never read as a comment opener:
 * the old version read a slash-star inside a path like `'docs/*'` as one anyway, and kept scanning
 * for the matching close mark anywhere later in the file — inside another string, such as one holding
 * a slash-star-star-slash, or inside a real comment — blanking everything in between, including real
 * code with a real offense. Reading a path or a regex source as a comment opener is a much bigger
 * hole than the one this file exists to close, so strings are skipped outright rather than taught to
 * look less like comments. A template literal's interpolation is walked back INTO code, with its
 * brace depth tracked, so a comment marker genuinely inside an interpolated expression is still
 * caught.
 */
function withoutComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += (text[j] === '\\' && j + 1 < n) ? 2 : 1;
      if (j < n && text[j] === c) j++;
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (depth === 0 && text[j] === '`') { j++; break; }
        if (depth === 0 && text[j] === '$' && text[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && text[j] === '}') { depth--; j++; continue; }
        j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (text.slice(i, i + 2) === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/^\s*\/\/.*$/gm, '');
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
  const withoutStrayComments = withoutComments(text);
  const scanned = stripAllowed(withoutStrayComments, file);
  const lines = scanned.split('\n');
  const found = [];
  for (const [lineNumber, line] of lines.entries()) {
    if (LITERAL.test(line)) found.push(`${lineNumber + 1}: ${line.trim()}  (a role's name, quoted)`);
    if (COMPUTED_LOOKUP.test(line)) {
      found.push(`${lineNumber + 1}: ${line.trim()}  (an object indexed by roleOf(), not asked with can)`);
    }
    if (ROLEOF_CALL.test(line)) {
      found.push(`${lineNumber + 1}: ${line.trim()}  (calls roleOf() outside its allowed call sites)`);
    }
  }
  // Bindings are read from BEFORE the allow-list strip: an allow-listed call still stashes the role
  // in a variable, and that variable deciding something two lines later is exactly the gap this
  // closes — stripping the call itself must not also erase the fact that it happened.
  for (const name of roleOfBindings(withoutStrayComments)) {
    const decides = decidesOn(name);
    for (const [lineNumber, line] of lines.entries()) {
      if (decides.test(line)) {
        found.push(`${lineNumber + 1}: ${line.trim()}  (decides something using "${name}", bound from roleOf())`);
      }
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

test('does not flag any of the allow-listed roleOf() call sites themselves', () => {
  assert.deepEqual(offendersIn('role: roles.roleOf(who),', 'engine/api/server.ts'), []);
  assert.deepEqual(offendersIn('roleOf: (e) => roles.roleOf(e), isOwner: (e) => roles.isOwner(e),',
    'engine/api/server.ts'), []);
  assert.deepEqual(offendersIn('const role = data.roleOf(p.email);', 'engine/api/people-page.ts'), []);
});

// -------------------------------------------------- a decision made through a variable, not the call
// `roleOf(` alone, or the surrounding shape alone, misses the case AGENTS.md's finding names: the
// value leaves the call, sits in a variable for a while, and something further down decides on the
// variable instead. Each test below is one way that happens; `decidesOn` and `ROLEOF_CALL` together
// are what closes all of them, not a shape written for each individually.

test('catches a role stashed in a variable and then used as a lookup key, even through the allowed call', () => {
  const found = offendersIn(
    'const role = data.roleOf(p.email);\nconst actions = rank[role] === 0 ? [] : ["reset"];',
    'engine/api/people-page.ts');
  assert.ok(found.some((f) => f.includes('rank[role]')),
    'rank[role] === 0, decided from a role stashed by the ALLOW-LISTED call, slipped through');
});

test('catches a role read into a fresh variable and used as a lookup key on a later line', () => {
  const found = offendersIn('function f(e) {\n  const r = roles.roleOf(e);\n  return M[r];\n}', null);
  assert.ok(found.length, 'a role stashed in a fresh variable and used as a lookup key slipped through');
});

test('catches two roleOf() calls compared to each other, with no variable and no quoted name at all', () => {
  const found = offendersIn('if (roles.roleOf(e) === roles.roleOf(roles.owner)) return true;', null);
  assert.ok(found.length, 'comparing two direct roleOf() calls to each other slipped through');
});

test('catches a role name matched by a prefix instead of a full comparison', () => {
  const found = offendersIn("if (roles.roleOf(e).startsWith('adm')) return true;", null);
  assert.ok(found.length, "a .startsWith('adm') prefix check on a role name slipped through");
});

test('catches a role name matched by a regex instead of a literal comparison', () => {
  const found = offendersIn('if (/^adm/.test(roles.roleOf(e))) return true;', null);
  assert.ok(found.length, 'a regex .test() against a role name slipped through');
});

test('catches a role compared against a name built from concatenated pieces, no full literal in sight', () => {
  const found = offendersIn(
    "const role = data.roleOf(p.email);\nif (role === 'adm' + 'in') return true;",
    'engine/api/people-page.ts');
  assert.ok(found.length,
    "\"adm\" + \"in\", compared against a role stashed in a variable, dodged LITERAL and slipped through");
});

test('planting rank[role] === 0 into the real people-page.ts is caught, by name', () => {
  const real = readFileSync(join(ROOT, 'engine/api/people-page.ts'), 'utf8');
  const marker = 'actionsFor(p, data.isOwner(p.email))';
  assert.ok(real.includes(marker), 'the real line this test plants its evasion next to moved or was reworded');
  const planted = real.replace(marker, 'actionsFor(p, rank[role] === 0)');
  const found = offendersIn(planted, 'engine/api/people-page.ts');
  assert.ok(found.some((f) => f.includes('rank[role]')),
    'planting rank[role] === 0 into the real people-page.ts was not caught');
});

test('planting a new, un-allow-listed roleOf() call into the real server.ts is caught, by name', () => {
  const real = readFileSync(join(ROOT, 'engine/api/server.ts'), 'utf8');
  const marker = 'role: roles.roleOf(who),';
  assert.ok(real.includes(marker), 'the real line this test plants its evasion next to moved or was reworded');
  const planted = real.replace(marker,
    `${marker}\n      impersonatingOwner: roles.roleOf(who) === roles.roleOf(roles.owner),`);
  const found = offendersIn(planted, 'engine/api/server.ts');
  assert.ok(found.some((f) => f.includes('roleOf() outside its allowed call sites')),
    'planting a brand-new roleOf() call into the real server.ts was not caught');
});

// ---------------------------------------------------------- the comment stripper and string literals

test('does not treat a slash-star inside a string literal as an opening comment mark', () => {
  const found = offendersIn(
    "const path = 'docs/*';\nif (roles.roleOf(e) === 'admin') return true;\nconst other = 'x/**/y';",
    null);
  assert.ok(found.length,
    "a real offense after a string holding an unmatched '/*' was hidden by the old comment stripper");
});

test('does not let a template literal\'s contents look like a comment either', () => {
  const found = offendersIn(
    "const path = `docs/*`;\nif (roles.roleOf(e) === 'admin') return true;",
    null);
  assert.ok(found.length,
    "a real offense after a template literal holding an unmatched '/*' was hidden by the old comment stripper");
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

// A role question asked of `email` instead of `who` flattens an agent token to the address it
// carries, and `isOwner` then answers for the owner's address as though the owner had signed in
// (holdrim#138, the tamper routes after #134 merged). Only the TOKEN_READS/TOKEN_WRITES allowlist
// stops such a call today, so no request can reach it; this scan is what fails if one comes back.
// `email` and `addressOf(who)` are the two spellings of the flattened address in server.ts; the last
// alternative is the other shape of the same mistake, deciding "is this the owner?" by comparing
// addresses instead of asking `isOwner(who)`, which a token's address would pass.
const ADDRESS = String.raw`(?:email\b|addressOf\(\s*who\s*\))`;
const ROLE_QUESTION_OF_ADDRESS = new RegExp([
  String.raw`\broles\.(?:isOwner|isLockHolder|isAgent|roleOf)\(\s*` + ADDRESS,
  String.raw`\broles\.can\([^)]*,\s*` + ADDRESS,
  String.raw`\b(?:mayAcknowledge|acknowledgementRefusal)\(\s*roles\s*,\s*` + ADDRESS,
  String.raw`\bisOwner\(\s*(\w+)\s*\)\s*&&\s*\1\s*!==\s*email\b`,
].join('|'));

test('server.ts asks every role question of who, never of the flattened address', () => {
  const real = readFileSync(join(ROOT, 'engine/api/server.ts'), 'utf8');
  const hits = real.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => ROLE_QUESTION_OF_ADDRESS.test(l));
  assert.deepEqual(hits, [], 'a role question of `email` flattens an agent token');
});

test('the address scan catches a role asked of email or addressOf(who), and an owner decided by comparing addresses', () => {
  assert.ok(ROLE_QUESTION_OF_ADDRESS.test('if (!mayAcknowledge(roles, email)) return'));
  assert.ok(ROLE_QUESTION_OF_ADDRESS.test('String(roles.isAgent(email))'));
  assert.ok(ROLE_QUESTION_OF_ADDRESS.test("roles.can('triage', email)"));
  assert.ok(ROLE_QUESTION_OF_ADDRESS.test('if (!mayAcknowledge(roles, addressOf(who))) return'));
  assert.ok(ROLE_QUESTION_OF_ADDRESS.test('if (roles.isOwner(target) && target !== email) {'));
  assert.ok(!ROLE_QUESTION_OF_ADDRESS.test('if (roles.isOwner(target) && !roles.isOwner(who)) {'));
  assert.ok(!ROLE_QUESTION_OF_ADDRESS.test('if (!mayAcknowledge(roles, who)) return'));
});
