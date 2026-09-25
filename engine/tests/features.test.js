/**
 * Feature toggles (docs/ROLES.md, section 7).
 *
 * Two different claims are proved here, and they need different kinds of test:
 *
 *   1. `readFeatures`/`readConfig` behave the way an adopter's `holdrim.json` needs them to: today's
 *      behaviour with no `features` block at all, a closed list, boolean values only.
 *   2. NO TOGGLE CAN REACH A GUARD. That is a claim about the SHAPE of the source, not about any one
 *      input/output pair, so it is proved the way `engine/tests/roles-boundary.test.js` proves its
 *      own boundary: by reading the real files and checking that the guard code is exactly what it
 *      should be, with nothing from `features` anywhere near it.
 *
 * What this file's TEXT scan cannot see, and does not try to: `JSON.stringify(project).
 * includes('"peopleScreen":true')` never writes the word `features`, so no scan of the SOURCE can
 * refuse it by name — the read is real, but nothing here names it. That is what
 * `engine/test-contract.sh`'s "every guard, with every built toggle off at once" section is for
 * instead: a BEHAVIOURAL backstop that boots a real server with every toggle off and asserts the
 * guards this file cannot watch — enabling or disabling an access, disabling the owner, triaging —
 * still answer exactly as they do with every toggle on. A text scan proves the shape of the source;
 * that section proves the shape of the ANSWER, which a reflective read cannot change either way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { transformSync } from 'esbuild';
import { readConfig } from '../core/config.js';
import { readFeatures, FEATURE_DEFAULTS, FEATURE_KEYS } from '../core/features.js';
import { CAPABILITIES } from '../core/roles.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const file = (o) => ({ readFile: () => JSON.stringify(o) });

// ============================================================================ readFeatures itself

test('with no "features" at all, every toggle is at its default — today\'s behaviour', () => {
  assert.deepEqual(readFeatures(undefined, '/p'), FEATURE_DEFAULTS);
});

test('a project overrides one toggle and keeps every other default', () => {
  const got = readFeatures({ bugCategory: false }, '/p');
  assert.equal(got.bugCategory, false);
  for (const key of FEATURE_KEYS) if (key !== 'bugCategory') assert.equal(got[key], FEATURE_DEFAULTS[key]);
});

test('every shipped toggle can be set explicitly, on or off', () => {
  const allOff = Object.fromEntries(FEATURE_KEYS.map((k) => [k, false]));
  assert.deepEqual(readFeatures(allOff, '/p'), allOff);
  const allOn = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
  assert.deepEqual(readFeatures(allOn, '/p'), allOn);
});

test('an unknown feature key refuses to start the service', () => {
  assert.throws(() => readFeatures({ comments: true, telemetry: true }, '/p'),
    (e) => e instanceof Error && e.message.includes('/p/holdrim.json names "telemetry"')
      && e.message.includes(FEATURE_KEYS.join(', ')),
    'a misspelled toggle has to say so, and say what it should have been');
});

test('every unknown key is named, not only the first', () => {
  assert.throws(() => readFeatures({ voise: true, sketchpad: false }, '/p'),
    /names "voise", "sketchpad"/);
});

test('a value that is not a plain boolean refuses to start', () => {
  for (const bad of ['yes', 1, null, [], {}]) {
    assert.throws(() => readFeatures({ comments: bad }, '/p'),
      (e) => e instanceof Error && e.message.includes('"features.comments" must be true or false'),
      `comments: ${JSON.stringify(bad)} should have refused to start`);
  }
});

// F3 / F3b: `"features": null` is `typeof null === 'object'`, so a check that tests only `typeof
// configured !== 'object'` waves it through as "no features block" — accepted as the defaults — or,
// one line further, throws a raw TypeError out of `Object.keys(null)` that never mentions
// holdrim.json at all. `readFeatures` checks `configured === null` before it ever asks `typeof`, and
// only `null` in this list can tell a mutant that drops that check apart from one that still refuses
// every other non-object value.
test('"features" itself has to be an object, not null, a list or a string', () => {
  for (const bad of [null, ['comments'], 'comments', 42]) {
    assert.throws(() => readFeatures(bad, '/p'), /"features" must be an object of true\/false/,
      `features: ${JSON.stringify(bad)} should have refused to start, by name, not with a raw TypeError`);
  }
});

// ============================================================================ wired through readConfig

test('readConfig hands back today\'s defaults when the project sets no features', () => {
  const c = readConfig('/p', file({}));
  assert.deepEqual(c.features, FEATURE_DEFAULTS);
});

test('readConfig validates "features" the same way it validates the rest of the file', () => {
  assert.throws(() => readConfig('/p', file({ features: { notAToggle: true } })),
    /names "notAToggle" under "features"/);
});

test('a project can turn a built toggle off through holdrim.json', () => {
  const c = readConfig('/p', file({ features: { peopleScreen: false, graph: false } }));
  assert.equal(c.features.peopleScreen, false);
  assert.equal(c.features.graph, false);
  assert.equal(c.features.comments, true, 'untouched toggles keep their default');
});

// ============================================================================ the closed list itself

test('voice and sketch exist, closed and validated, off by default: not built yet', () => {
  assert.equal(FEATURE_DEFAULTS.voice, false);
  assert.equal(FEATURE_DEFAULTS.sketch, false);
  // Read as English, spelled the way the issue names them — not "Voice" or "voz".
  assert.ok(FEATURE_KEYS.includes('voice') && FEATURE_KEYS.includes('sketch'));
});

test('the first seven toggles are exactly the ones the issue names, no more, no fewer', () => {
  assert.deepEqual([...FEATURE_KEYS].sort(),
    ['bugCategory', 'comments', 'graph', 'pageRequests', 'peopleScreen', 'sketch', 'voice'].sort());
});

// ============================================================================ no toggle reaches a guard
//
// `docs/ROLES.md`: "A toggle never turns off a guard. Locks, the owner's powers, 'nothing is
// erased', the theme validation: none of these is a feature, and none gets a toggle." That is a
// claim about the SHAPE of the source, and needs two different tests, from two different sides:
//
//   1. `engine/core/roles.js` — the one file that decides every capability and the lock
//      (`engine/tests/roles-boundary.test.js` proves nothing else may) — never mentions `features`
//      at all. If a toggle could reach a guard, it would have to reach it FROM HERE.
//   2. Every OTHER read of `features` anywhere under `engine/`'s SOURCE is named, once, on an
//      explicit allow-list, with why it is safe. This is the one that matters: a matching-string
//      check on the guards themselves (what this file used to do) still finds `if (roles.isOwner(…))`
//      sitting right there when a mutant wraps `if (project.features.peopleScreen)` AROUND it — the
//      substring survives, nested inside a new condition it never asked for. Scanning for every
//      READ instead catches the wrapping itself: `project.features.peopleScreen`, wherever it
//      appears, is either on the list below or it is new, and new is exactly what a guard being
//      wrapped looks like.

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('engine/core/roles.js never mentions features: capabilities and the lock cannot be reached by a toggle', () => {
  const roles = read('engine/core/roles.js');
  assert.ok(!/feature/i.test(roles),
    'engine/core/roles.js mentions a feature — capabilities and the lock must come from identity ' +
    '(HOLDRIM_OWNER, HOLDRIM_ADMINS) alone, never from holdrim.json\'s features block');
});

// Comments, blanked to spaces — never removed, so a real offense keeps the line number it was found
// on. A doc comment that SAYS `features.voice`, or a path like `'./features.js'`, is prose and an
// import target, not a read reaching a guard, and must not force an allow-list entry for every
// sentence that happens to name the toggle.
//
// ROUND 3 (D2b): the hand-rolled, character-at-a-time version this replaced walked a slash-star as
// "open a block comment, blank to the next star-slash" with no idea that a `/` can also open a
// REGEX — so a guard written as `if (/backslash-slash-star-slash/.test(email) && !manages() &&
// project.features.peopleScreen) return forbidden();` (a real, demonstrated mutant) had its regex's
// own slash-star read as a comment opener, everything up to the FILE's next star-slash blanked along
// with it, and the guard it wrapped simply vanished from what this scan ever saw. The same version
// blanked a template literal WHOLE, `${…}` interpolation and all (D1: a property written as
// `project` + a backtick-quoted `features` is a read hiding behind the same backtick a real template
// uses for prose), and read a backtick INSIDE that supposed regex as if it opened a template — for
// the same reason each time: it never knew what KIND of token it was looking at, only what character
// started it.
//
// A real JS/TS tokeniser knows the difference, because knowing it is what a `/` or a backtick MEANS
// in the grammar the language actually has — a distinction no amount of cleverness with
// `String.indexOf` reconstructs without becoming that tokeniser's own disambiguation rules by hand,
// worse and unproven. So this walks the file with the `typescript` package's own scanner (a
// devDependency already) instead of a hand-rolled one, and blanks only what the SCANNER calls a
// comment: a regex literal, a template literal and everything inside its `${…}` interpolations, and
// a template used as a property key, are all just ordinary tokens to it, copied through UNCHANGED —
// never blanked, because none of them is a comment, and a read hiding inside one is a read this scan
// must still see.
//
// `reScanSlashToken`, `reScanTemplateToken` and the scanner's own comment-kind tokens are its tools
// for exactly this: distinguishing a regex from division, and stepping back INTO a template's
// literal text after a `${…}` interpolation closes, are the two places a bare "read character by
// character" tokeniser cannot tell what it is looking at without the same grammar the real scanner
// already has. `NO_REGEX_AFTER`, below, is the one piece of context the scanner does not carry for
// us: whether a bare `/` can start a regex depends on what came before it (`(` — yes; an identifier
// — no, it is division), the same "goal symbol" disambiguation every JS engine makes. The set named
// here errs towards TREATING `/` AS DIVISION only where getting it backwards could make a real regex
// swallow the rest of the file looking for a `/` that is not there — the ONE mistake this function
// must not make twice.
const NO_REGEX_AFTER = new Set([
  SyntaxKind.Identifier, SyntaxKind.NumericLiteral, SyntaxKind.BigIntLiteral, SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral, SyntaxKind.TemplateTail, SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.CloseParenToken, SyntaxKind.CloseBracketToken, SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken,
  SyntaxKind.ThisKeyword, SyntaxKind.SuperKeyword, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);
const regexAllowedAfter = (prevKind) => prevKind === undefined || !NO_REGEX_AFTER.has(prevKind);

function withoutComments(text) {
  const out = text.split('');
  // A comment's newlines are kept, everything else in it turned to a space — the same shape the old
  // version produced, so a real offense still reports the line it is actually on.
  const blank = (pos, end) => { for (let i = pos; i < end; i++) if (out[i] !== '\n') out[i] = ' '; };

  const scanner = createScanner(/* skipTrivia */ false);
  scanner.setText(text);
  // Depths of `{`/`}` opened SINCE the innermost `${` still open, one entry per interpolation
  // currently inside — a nested object literal or block inside `${…}` opens and closes its own
  // braces, and only the one that brings its own entry back to zero is the interpolation's actual
  // close, the point at which the scanner has to be told to read TEMPLATE TEXT again, not more code.
  const templateDepths = [];
  let prevKind;

  for (;;) {
    let kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;

    if (kind === SyntaxKind.SingleLineCommentTrivia || kind === SyntaxKind.MultiLineCommentTrivia) {
      blank(scanner.getTokenStart(), scanner.getTokenEnd());
      continue; // trivia is not a token a real read or a real regex ever follows
    }
    if (kind === SyntaxKind.WhitespaceTrivia || kind === SyntaxKind.NewLineTrivia) continue;

    if ((kind === SyntaxKind.SlashToken || kind === SyntaxKind.SlashEqualsToken) && regexAllowedAfter(prevKind)) {
      kind = scanner.reScanSlashToken();
    }

    if (kind === SyntaxKind.OpenBraceToken && templateDepths.length) {
      templateDepths[templateDepths.length - 1]++;
    } else if (kind === SyntaxKind.CloseBraceToken && templateDepths.length) {
      if (templateDepths[templateDepths.length - 1] === 0) {
        // This `}` is the interpolation's own close: re-read from here as template text, not code.
        kind = scanner.reScanTemplateToken(false);
        templateDepths.pop();
        // A `TemplateMiddle` ends in a fresh `${` — one more interpolation is now open.
        if (kind === SyntaxKind.TemplateMiddle) templateDepths.push(0);
      } else {
        templateDepths[templateDepths.length - 1]--;
      }
    } else if (kind === SyntaxKind.TemplateHead) {
      templateDepths.push(0);
    }

    prevKind = kind;
  }
  return out.join('');
}

/**
 * ROUND 3 (D4): the demonstrated mutant was a brand-new `engine/lib/gate.js`, exporting
 * `(project) => project.features.peopleScreen`, wired into `server.ts` — and it passed every gate,
 * because the old scan only ever looked inside FOUR named directories. The Dockerfile copies all of
 * `engine/`, so a fifth one is exactly as real a place for a guard to live as the four this used to
 * trust by name.
 *
 * The fix inverts which list has to be kept up to date: every file under `engine/` is scanned, a
 * file nobody committed yet included — the same reasoning `engine/tests/surface.test.js` uses for a
 * variable — and `DENIED`, below, is the closed, EXPLAINED set of places that are not a guard a
 * toggle could reach. A new directory is scanned the moment it exists; only `DENIED` naming it, on
 * purpose, with why, takes it back out — the opposite of the old shape, where a new directory had to
 * be ADDED to be seen at all.
 *
 * ROUND 5 (MAJOR, MTS): that inversion still ran an ALLOW-list underneath it —
 * `/\.(ts|js|jsx|mjs|cjs)$/` — which is the same mistake at the extension instead of the directory.
 * Node runs `.mts` and `.cts` exactly as it runs `.ts`, and the loader below has always known `.tsx`;
 * none of the three was in that list, so a planted `engine/lib/gate.mts` with a plain
 * `project.features.peopleScreen` read passed every gate the same way `gate.js` in a new directory
 * used to. The fix is the same inversion applied one level down: every tracked or new file under
 * `engine/` is scanned, whatever its extension, unless `DENIED` names it or `NOT_CODE`, below, says
 * why its extension cannot hold a guard at all.
 */
function isSourceFile(f) {
  return !NOT_CODE.test(f) && !DENIED.some((d) => (d.file ? f === d.file : f.startsWith(d.prefix)));
}

/**
 * Extensions that hold no JS/TS/JSX/TSX to scan, ever, by what they ARE rather than by where they
 * live: a config file, translated strings, a page's markup, a stylesheet, an image. None of these
 * can execute a read of `features` or wrap a guard in one, so excluding them here is the shape
 * counterpart to `DENIED` excluding a LOCATION. Image extensions are listed even though `engine/`
 * ships none today, on the same "scanned by default" principle `isSourceFile` argues for the rest:
 * an icon added later must not need this list edited to stay green.
 */
const NOT_CODE = /\.(json|md|css|html?|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot)$/i;

/** Every tracked or new file under `engine/`, minus `DENIED` — see the comment on `isSourceFile`. */
function sourceFiles() {
  // `git ls-files`'s output ends in a newline, so `split('\n')` always trails one empty string —
  // harmless while `isSourceFile` was an ALLOW-list (no extension matches ''), but the inverted rule
  // now scans anything `NOT_CODE` and `DENIED` do not name, and neither names an empty path: without
  // `Boolean` here it reaches `readFileSync(join(ROOT, ''))`, which is the repository root itself, a
  // directory, and every test that reads a "file" fails with EISDIR instead of naming a real offense.
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'engine'],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).filter(isSourceFile);
}

/**
 * Every place under `engine/` that is NOT scanned for a read of `features`, named once with why —
 * the same shape `ALLOWED` gives an individual LINE. Leaving one of these out is a test failure
 * (`the boundary itself`, below, via `sourceFiles`), never a silent gap: the default for anywhere
 * not named here is SCANNED.
 */
const DENIED = [
  { prefix: 'engine/tests/',
    why: 'a test reads project.features to build its own fixture — the toggle being tested, never a ' +
      'guard a toggle could reach. This file lives here too, and scans itself no more than it scans ' +
      'any other fixture-builder next to it.' },
  { file: 'engine/test-browser.js',
    why: 'the same reason as engine/tests/: it writes a features block into a FIXTURE holdrim.json ' +
      'to drive the browser suite, and it is not under engine/tests/ only because it drives an actual ' +
      'browser instead of node:test' },
  { file: 'engine/web/panel-react.js',
    why: 'the BUILT bundle, generated from engine/web/src — scanning it only repeats those reads, or, ' +
      'stale, reports ones the sources no longer have' },
  // ROUND 5 (MTS): `NOT_CODE` excludes an extension by what it holds; these two are excluded by what
  // they ARE — bash, not JS/TS — so esbuild has no loader for either and `stripperMismatch` (below)
  // could never cross-check them. A shell script does not read `project.features` the way a route
  // does, and `engine/test-contract.sh`'s own "every toggle off" section is where a reflective read
  // that hides from every scan of the SOURCE is caught instead (its own header comment says so).
  { file: 'engine/run-local.sh', why: 'a shell script, not JS/TS — no loader parses it, and no guard lives in it' },
  { file: 'engine/test-contract.sh', why: 'same reason: a shell script, and the file that already backstops a reflective read no source scan can see' },
];

/**
 * Any of the ways a toggle is read: `xxx.features` (however the object in front is named —
 * `project`, `who`, `file`, ...), the bare identifier `features` (the panel's own prop and local,
 * carrying the value `/api/me` sent), a call to `readFeatures(`, or the identifiers
 * `peopleScreenOn`/`gatingFeatureOf` — their own definitions included, so a caller of either still
 * has to be named below.
 */
const FEATURE_READ = /\bfeatures\b|\breadFeatures\(|\bpeopleScreenOn\b|\bgatingFeatureOf\b/;

/**
 * Every legitimate read, named once with why — the same shape `roles-boundary.test.js` uses for its
 * own `ALLOWED`. Matched by EXACT TEXT: a mutation that changes the line even slightly — S11
 * rewriting the owner-creation guard, S12 rewriting `forbidden`, S13 adding a brand-new condition —
 * produces text that is not on this list, and `offendersIn` below finds it.
 */
const ALLOWED = [
  { file: 'engine/api/server.ts',
    text: 'function gatingFeatureOf(incoming: NewEvent): keyof typeof project.features | null {',
    why: 'the one function that turns an incoming EVENT into the toggle it needs — a plain lookup, ' +
      'never a question asked of roles' },
  { file: 'engine/api/server.ts', text: 'const gate = gatingFeatureOf(incoming);',
    why: 'refusalOf\'s single call to it, checked before anything role-shaped' },
  { file: 'engine/api/server.ts', text: 'if (gate && !project.features[gate]) {',
    why: 'the gate refusalOf reads to refuse an event — never roles, never a capability' },
  { file: 'engine/api/server.ts', text: 'const peopleScreenOn = () => project.features.peopleScreen;',
    why: 'the ONLY place features.peopleScreen is read; the /api/users* routes ask roles.can, never this' },
  { file: 'engine/api/server.ts', text: 'if (!peopleScreenOn() || !byPassword || !managesPeople(viewer)) {',
    why: 'servePeople: hides the SCREEN with a redirect, decoration in front of routes that never ' +
      'asked this question' },
  { file: 'engine/api/server.ts', text: 'canManagePeople: peopleScreenOn() && managesPeople(viewer),',
    why: 'serveHome\'s nav prop — whether to draw the People link, never whether the routes answer' },
  { file: 'engine/api/server.ts', text: 'pageRequestsEnabled: project.features.pageRequests, ask,',
    why: 'serveHome\'s prop for the "ask for a page" form; the form\'s POST is refused, if at all, ' +
      'by refusalOf like any other request' },
  { file: 'engine/api/server.ts',
    text: 'features: { comments: project.features.comments, pageRequests: project.features.pageRequests, bugCategory: project.features.bugCategory },',
    why: '/api/me telling the PANEL which of its own controls to draw (docs/ROLES.md, "The front ' +
      'end obeys the server") — never peopleScreen or graph, which the panel does not render' },
  { file: 'engine/cli/graph.ts',
    text: 'console.error(\'graph is turned off: this project\\\'s holdrim.json sets "features": { "graph": false }\');',
    why: 'the refusal MESSAGE quoting the key a project would set — text for a person to read, not ' +
      'a read of anything' },
  { file: 'engine/cli/holdrim.ts', text: 'enabled: projectConfig.features.graph });',
    why: 'the one place `graph`\'s toggle is read, resolved from the SAME ofProject every command ' +
      'reads its configuration through, and handed to showGraph as a plain boolean it does not ' +
      'know the name of (graph.ts never mentions features)' },
  { file: 'engine/core/config.js', text: "import { readFeatures } from './features.js';",
    why: 'the import that makes the call below possible' },
  { file: 'engine/core/config.js', text: 'features: readFeatures(file.features, root),',
    why: 'readConfig validating and merging the project\'s features at the one place every reader ' +
      'of holdrim.json already goes through' },
  { file: 'engine/core/features.js', text: 'export function readFeatures(configured, root) {',
    why: 'the closed list\'s own definition — the one file allowed to know every toggle\'s name' },
  { file: 'engine/core/features.js',
    text: '`${root}/holdrim.json\'s "features" must be an object of true/false, one per known toggle: ` +',
    why: 'PROSE for a person reading a boot error, quoting the key they misconfigured — not a read, ' +
      'the same reason engine/cli/graph.ts\'s refusal message is allowed below' },
  { file: 'engine/core/features.js',
    text: '`${root}/holdrim.json names ${unknown.map((k) => `"${k}"`).join(\', \')} under "features", ` +',
    why: 'same reasoning: the boot error naming which key was misspelled, for a person to read' },
  { file: 'engine/core/features.js',
    text: '`${root}/holdrim.json\'s "features.${key}" must be true or false; got ` +',
    why: 'same reasoning: the boot error naming which toggle got a non-boolean value' },
  { file: 'engine/web/src/Panel.jsx',
    text: 'const categoriesOf = (features) => Object.keys(cycle.request_categories)',
    why: 'which categories to offer — filtering, never a guard: the server refuses a category it ' +
      'does not like on its own, in refusalOf' },
  { file: 'engine/web/src/Panel.jsx',
    text: ".filter((key) => (key !== 'bug' || features.bugCategory !== false) && (key !== 'page' || features.pageRequests !== false))",
    why: 'the filter itself, reading the two toggles the panel draws a category for' },
  { file: 'engine/web/src/Panel.jsx',
    text: 'export default function Panel({ block, me, canApprove, features = {}, events, onRecord, onClose }) {',
    why: 'the prop `entry.jsx` passes down; missing reads as on, so an older caller sees every control' },
  { file: 'engine/web/src/Panel.jsx', text: '{features.comments !== false ? (',
    why: 'hides the "Comment" button — the server refuses the event either way, in refusalOf' },
  { file: 'engine/web/src/Panel.jsx',
    text: '{categoriesOf(features).map(([value, label]) => <option key={value} value={value}>{label}</option>)}',
    why: 'drawing only the categories categoriesOf (above) still offers' },
  { file: 'engine/web/src/entry.jsx', text: 'const features = who.features ?? {};',
    why: 'reading what /api/me sent, once, before handing it down to Panel' },
  { file: 'engine/web/src/entry.jsx', text: 'features={features}',
    why: 'handing it to Panel, the one component that reads it' },
];

/**
 * Every offense `text` holds once `file`'s own allow-listed lines are blanked out of it — the same
 * function real files and synthetic self-test snippets both go through, so a fix made only for the
 * real files could not silently stop applying to the cases the self-tests below prove it catches.
 *
 * ROUND 3 (D3): `replaceAll` used to blank EVERY copy of an entry's text, so a real, allow-listed
 * line copied next to a brand-new read exempted that new read too, for free — the copy IS the
 * entry's exact text, byte for byte. An entry is allowed to excuse ONE line, the one it names, so
 * only its FIRST match is blanked; a second copy is left standing, and since every `ALLOWED` text
 * mentions `features` by construction, the line it sits on trips `FEATURE_READ` below like any other
 * unlisted read — no separate "count the copies" check needed, the scan that already runs catches it.
 * @param {string} text
 * @param {string|null} file  a path from `ALLOWED`, or null for a synthetic snippet with no allowance
 */
function offendersIn(text, file = null) {
  let scanned = withoutComments(text);
  for (const entry of ALLOWED.filter((a) => a.file === file)) {
    scanned = scanned.replace(entry.text, entry.text.replace(/[^\n]/g, ' '));
  }
  const found = [];
  scanned.split('\n').forEach((line, i) => {
    if (FEATURE_READ.test(line)) found.push(`${i + 1}: ${line.trim()}`);
  });
  return found;
}

/** Which of `ALLOWED`'s entries no longer match anything in their named file — the way an entry
 *  rots when the code it named moved or was reworded, leaving the exception hiding nothing, or
 *  worse, hiding whatever replaced it. */
function staleEntries() {
  return ALLOWED.filter((entry) => !withoutComments(read(entry.file)).includes(entry.text));
}

// ---------------------------------------------------------------- the regex-vs-division guess can be beaten
//
// ROUND 4 (MAJOR N2): `NO_REGEX_AFTER`, above, is a GUESS — the same "goal symbol" ambiguity every
// JS engine resolves by knowing the whole grammar, reduced here to "what kind of token came right
// before". It is wrong in exactly the cases the comment on `NO_REGEX_AFTER` already owns up to: a
// `/` that starts a fresh STATEMENT right after `if (…)`'s closing `)`, or after a block's closing
// `}`, is a regex — but both `)` and `}` are ALSO how a plain expression ends (`f(x)`, an object
// literal), where the very next `/` really is division. The guess picks division for both, because
// guessing regex there risks a real regex literal reading half the file looking for a `/` that
// never comes — but picking division wrongly has its own failure, just as bad: the misjudged `/`
// leaves the token stream at the WRONG position, and the regex's own embedded `/*` — completely
// ordinary inside a real regex literal — gets read from there as an opening block comment, blanking
// everything up to the file's next `*/`, guard and all.
//
// No amount of tuning `NO_REGEX_AFTER` closes this for good: the ambiguity is real, not a bug in the
// heuristic's edges. So this stops trusting the guess and cross-checks it against a REAL parser
// instead. `esbuild` (already a devDependency, `engine/tests/features.test.js`'s own `package.json`
// entry) parses the ORIGINAL text and the text `withoutComments` blanked, with the loader that
// matches the file's own extension, and the two must come out identical — modulo formatting, which
// is why both are run through `minify: true` rather than compared as `withoutComments`-shaped text:
// esbuild's UN-minified output keeps every comment exactly where it was, so two texts that
// legitimately differ only by comments would still disagree without minifying, telling this check
// nothing. If the blanking took real code with it, the blanked text either fails to parse at all —
// the ordinary outcome, since code deleted mid-statement rarely still balances its braces — or
// parses into something a real one wasn't, and either way this names the file rather than the
// silent pass a text scan alone would give it.
//
// The same trap, for a different token: `//` inside literal JSX TEXT (an URL, most often) is not a
// comment either, and nothing in a plain token scan run with no JSX context knows that — see the
// self-test below. The fix is the same one: a real parser, told the file is JSX, does know.
function loaderFor(file) {
  if (file.endsWith('.tsx')) return 'tsx';
  // `.mts`/`.cts` are `.ts` under Node's own module-kind rule (MAJOR MTS) — esbuild has no loader
  // named after either, so without this a file `isSourceFile` now scans would reach `transformSync`
  // with the DEFAULT loader guessed from an extension esbuild has never heard of, and fail to parse
  // for a reason that has nothing to do with a real mismatch.
  if (file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts')) return 'ts';
  if (file.endsWith('.jsx')) return 'jsx';
  return 'js';
}

/**
 * Why `withoutComments`'s guess disagrees with a real parser about `text` (named as `file`, for the
 * loader and for the message — a synthetic snippet may pass any extension it likes), or `null` when
 * the two agree.
 *
 * MINOR: the ORIGINAL failing to parse used to return `null` too, silently, as if the two agreed —
 * but a file this scan cannot even hand to esbuild is exactly the file whose comment-stripping this
 * check exists to cross-check, and "no mismatch reported" reads as "cross-checked and fine" to
 * anyone running the suite. It never fires today (every scanned file parses), so this is loud with
 * nothing yet to be loud ABOUT; the point is that the day a file stops parsing, this fails BY NAME
 * instead of the check quietly stopping to watch it.
 * @param {string} file
 * @param {string} text
 */
function stripperMismatch(file, text) {
  const opts = { loader: loaderFor(file), minify: true };
  let real;
  try {
    real = transformSync(text, opts).code;
  } catch (error) {
    return `${file}: does not parse at all — the esbuild cross-check has nothing to compare ` +
      `withoutComments's guess against (${String(error.message).split('\n')[0]})`;
  }
  let blanked;
  try {
    blanked = transformSync(withoutComments(text), opts).code;
  } catch (error) {
    return `${file}: withoutComments blanked real code — the result no longer parses ` +
      `(${String(error.message).split('\n')[0]})`;
  }
  return blanked === real ? null
    : `${file}: withoutComments blanked real code — the result parses to something different`;
}

test('every scanned file survives the esbuild cross-check: the regex/division guess never blanks real code', () => {
  const mismatches = sourceFiles().map((file) => stripperMismatch(file, read(file))).filter(Boolean);
  assert.deepEqual(mismatches, [],
    'withoutComments blanked real code in a file this scan cannot trust its own text-matching over — see MAJOR (N2)');
});

test('N2: a regex misguessed as division after a block\'s closing `}` swallows the guard right after it', () => {
  const real = read('engine/api/server.ts');
  const marker = "const manages = () => roles.can('people', email);";
  assert.ok(real.includes(marker), 'the line this test plants a mutant next to moved or was reworded');
  // The demonstrated mutant, verbatim: `/` right after the `}` that closes `if (email) { … }` starts
  // a fresh statement — the regex `/\/*/ ` (matching a literal "/*") — but `CloseBraceToken` is in
  // `NO_REGEX_AFTER`, so the guess reads it as division instead, lands mid-token, and the regex's own
  // `/*` gets read from there as an opening block comment: everything up to the file's next `*/` is
  // blanked, the toggled guard right after it included.
  const planted = real.replace(marker,
    `${marker}\n  if (email) { log('INFO', 'x', {}); }\n  /\\/*/.test(email);\n` +
    '  if (!manages() && project.features.peopleScreen) return forbidden();');
  assert.ok(!offendersIn(planted, 'engine/api/server.ts').some((f) => f.includes('project.features.peopleScreen')),
    'N2 setup — the text scan alone already caught this; the cross-check below would prove nothing');
  const mismatch = stripperMismatch('engine/api/server.ts', planted);
  assert.ok(mismatch && mismatch.startsWith('engine/api/server.ts:'),
    'N2 — a guard hidden behind a misguessed regex after a block\'s closing `}` was not caught, by name');
});

test('N1: a regex misguessed as division right after `if (…)`\'s closing `)` swallows the guard too', () => {
  const real = read('engine/api/server.ts');
  // A route far from N2's and every S/D self-test's own marker, so this is not caught by luck: none
  // of the others plants anything anywhere near the user-list route.
  const marker = "if (route === '/users' && req.method === 'GET') {";
  assert.ok(real.includes(marker), 'the line this test plants a mutant next to moved or was reworded');
  // `if (email) /\/*/.test(email);` is real, valid JS: a single-statement `if` with no braces, whose
  // statement IS the regex literal. `CloseParenToken` is in `NO_REGEX_AFTER` too, so the guess reads
  // this `/` as division as well, with the same runaway "comment" swallowing the toggled guard.
  const planted = real.replace(marker,
    `${marker}\n    if (email) /\\/*/.test(email);\n    if (project.features.peopleScreen) return forbidden();`);
  assert.ok(!offendersIn(planted, 'engine/api/server.ts').some((f) => f.includes('project.features.peopleScreen')),
    'N1 setup — the text scan alone already caught this; the cross-check below would prove nothing');
  const mismatch = stripperMismatch('engine/api/server.ts', planted);
  assert.ok(mismatch && mismatch.startsWith('engine/api/server.ts:'),
    'N1 — a guard hidden behind a misguessed regex right after `if (…)`\'s closing `)` was not caught, by name');
});

test('a JSX-text URL\'s "//" is not a comment either, and the cross-check catches the read it would otherwise hide', () => {
  // `see https://example.org ` is literal JSX TEXT, a child of `<small>`, never code — but nothing
  // in a plain token scan run with no JSX context knows that, and reads the URL's `//` as an
  // ordinary line comment, exactly the "guess with no context" trap `NO_REGEX_AFTER` names for `/`.
  const jsx = "<small>see https://example.org {features.voice ? '' : ''}</small>";
  const found = offendersIn(jsx, 'x.jsx');
  assert.deepEqual(found, [],
    'setup — if the text scan alone already found features.voice here, the cross-check below would prove nothing');
  const mismatch = stripperMismatch('x.jsx', jsx);
  assert.ok(mismatch, 'a read hidden behind a JSX-text URL\'s "//" was not caught by the cross-check either');
});

test('the boundary itself: the scanned paths hold real reads, and nothing is stale', () => {
  const files = sourceFiles();
  assert.ok(files.includes('engine/api/server.ts'), 'the file scan read the wrong files');
  assert.ok(!files.includes('engine/tests/features.test.js'), 'this file scans, but is not scanned');
  assert.ok(!files.includes('engine/web/panel-react.js'), 'the built bundle scans, but is not scanned');
  // D4's own mutant, replayed as a claim about the DISCOVERY rule rather than a fixture on disk: a
  // path in a directory nobody named — `engine/lib/gate.js`, exactly the mutant demonstrated — has
  // to read as scanned BY DEFAULT, the opposite of the old ALLOW-list of four directories, where a
  // fifth directory was invisible until someone added it.
  assert.ok(isSourceFile('engine/lib/gate.js'),
    'D4 — a new directory under engine/ is not scanned by default; only DENIED may take one back out');
  assert.deepEqual(staleEntries(), [], 'an ALLOWED entry no longer matches its file — the code it ' +
    'named moved or was reworded, and the exception it granted may now be hiding something else');
});

// ROUND 4: this used to write a real `engine/lib-self-test/gate.js` onto disk to prove `sourceFiles`
// discovers it, then `rmSync` it in a `finally` — but `engine/tests/*.test.js` all run in the same
// `node --test`, in parallel, and every one of them that calls `sourceFiles()` (this file's own
// "every real read of features" among them) walks the SAME tree while this test's file sits there.
// A file briefly present on disk is briefly present to everyone, and the shared state is exactly
// what a mutation test on a toggle should never depend on. `isSourceFile` and `offendersIn` are
// plain functions of a path and a string — the claim (a new directory is scanned by default; a read
// inside it is recognised) needs neither `git` nor a file on disk to prove, so this proves it that
// way instead.
test('D4: a read planted in a brand-new directory, not only the four the old scan trusted, is caught', () => {
  const path = 'engine/lib-self-test/gate.js';
  assert.ok(isSourceFile(path),
    'D4 — a file in a brand-new directory under engine/ is not scanned by default');
  const text = 'export default (project) => project.features.peopleScreen;\n';
  const offenders = offendersIn(text, path);
  assert.ok(offenders.some((f) => f.includes('project.features.peopleScreen')),
    'D4 — the planted read in the new directory was found but not recognised as an offense');
});

// MAJOR (MTS): the demonstrated mutant was `engine/lib/gate.mts`, exporting the same plain
// `project.features.peopleScreen` read D4 planted in `gate.js` — Node runs `.mts` exactly as it
// runs `.ts`, but the old `isSourceFile` regex named only `ts|js|jsx|mjs|cjs`, so `.mts` (and
// `.cts`) never reached the scan at all. Proved the same way D4 is, from a path and a string alone,
// with nothing written to disk: the shared-tree race that reasoning avoids applies here too.
test('MTS: a read planted in a .mts file, a module kind the old extension list never named, is caught', () => {
  const path = 'engine/lib-self-test/gate.mts';
  assert.ok(isSourceFile(path), 'MTS — a .mts file is not scanned by default');
  const text = 'export default (project: Project) => project.features.peopleScreen;\n';
  const offenders = offendersIn(text, path);
  assert.ok(offenders.some((f) => f.includes('project.features.peopleScreen')),
    'MTS — the planted read in a .mts file was found but not recognised as an offense');
});

test('every real read of features, across the engine, is on the allow-list', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    for (const found of offendersIn(read(file), file)) offenders.push(`${file}:${found}`);
  }
  assert.deepEqual(offenders, [],
    'a read of features exists that is not on ALLOWED above — a NEW way to reach a toggle, which ' +
    'is exactly the shape of a guard silently getting one wrapped around it');
});

// -------------------------------------------------------------------------------- self-tested
// Each of these plants one of the round's own mutants (S11, S12, S13) into the REAL server.ts and
// proves the scan above catches it by name — not a synthetic string standing in for the real code.

test('S11: wrapping the owner-creation guard in a feature check is caught, by name', () => {
  const real = read('engine/api/server.ts');
  const marker = 'if (roles.isOwner(address) && !roles.isOwner(email)) {';
  assert.ok(real.includes(marker), 'the guard this test plants a mutant next to moved or was reworded');
  const planted = real.replace(marker, `if (project.features.peopleScreen) ${marker}`);
  const found = offendersIn(planted, 'engine/api/server.ts');
  assert.ok(found.some((f) => f.includes('project.features.peopleScreen')),
    'S11 — wrapping the owner-creation guard in project.features.peopleScreen — was not caught');
});

test('S12: rewriting forbidden() to read a toggle is caught, by name', () => {
  const real = read('engine/api/server.ts');
  const marker = "const forbidden = () => (json(res, 403, { error: say('api.users.adminOnly') }), true);";
  assert.ok(real.includes(marker), 'the line this test plants a mutant next to moved or was reworded');
  const planted = real.replace(marker,
    "const forbidden = () => (!project.features.peopleScreen ? false : (json(res, 403, { error: say('api.users.adminOnly') }), true));");
  const found = offendersIn(planted, 'engine/api/server.ts');
  assert.ok(found.some((f) => f.includes('project.features.peopleScreen')),
    'S12 — forbidden() rewritten to read a toggle — was not caught');
});

test('S13: a brand-new condition reading a toggle next to a guard is caught, by name', () => {
  const real = read('engine/api/server.ts');
  const marker = "const manages = () => roles.can('people', email);";
  assert.ok(real.includes(marker), 'the line this test plants a mutant next to moved or was reworded');
  const planted = real.replace(marker,
    `${marker}\n  if (!manages() && project.features.peopleScreen) return forbidden();`);
  const found = offendersIn(planted, 'engine/api/server.ts');
  assert.ok(found.some((f) => f.includes('project.features.peopleScreen')),
    'S13 — a new condition reading project.features.peopleScreen — was not caught');
});

test('S14 (D2b): a regex literal containing /* does not blind the scan to the guard right after it', () => {
  const real = read('engine/api/server.ts');
  const marker = "const manages = () => roles.can('people', email);";
  assert.ok(real.includes(marker), 'the line this test plants a mutant next to moved or was reworded');
  // The demonstrated mutant, verbatim: `/\/*/ ` is a real regex (it matches a literal "/*"), and the
  // old hand-rolled stripper read its embedded `/*` as an OPENING block comment instead, blanking
  // everything up to the file's next `*/` — which swallowed this very guard whole.
  const planted = real.replace(marker,
    `${marker}\n  if (/\\/*/.test(email) && !manages() && project.features.peopleScreen) return forbidden();`);
  const found = offendersIn(planted, 'engine/api/server.ts');
  assert.ok(found.some((f) => f.includes('project.features.peopleScreen')),
    'S14 — a guard hidden behind a /* inside a regex literal was not caught');
});

test('D2b: a comment that legitimately follows a real regex literal is still blanked', () => {
  // The other side of S14: fixing the regex must not turn OFF real comment recognition right after
  // one. `/features\//` is a genuine regex (matching a literal "features/"), and what follows it on
  // the same line is a genuine comment that also happens to name the toggle — it must not survive.
  const found = offendersIn('const re = /features\\//; // a real comment naming features too');
  assert.deepEqual(found, ['1: const re = /features\\//;']);
});

test('D2b: a read hidden inside a template literal\'s ${…} interpolation is caught', () => {
  const found = offendersIn('const msg = `blocked: ${project.features.peopleScreen}`;');
  assert.ok(found.length, 'a read inside a template literal\'s interpolation slipped through');
});

test('D1: a template-literal property key (project[`features`]) is not blanked away with the rest of the backtick', () => {
  const found = offendersIn('if (project[`features`].peopleScreen) return forbidden();');
  assert.ok(found.length,
    'D1 — a template literal used as a property key was blanked whole, hiding the read inside it');
});

test('D3: an ALLOWED line copied a second time in the same file is not exempted twice', () => {
  const line = 'const peopleScreenOn = () => project.features.peopleScreen;';
  const planted = `${line}\n// copied here too, on purpose, to see whether the second copy is still watched\n${line}`;
  const found = offendersIn(planted, 'engine/api/server.ts');
  assert.ok(found.some((f) => f.includes('project.features.peopleScreen')),
    'D3 — the ALLOWED line, copied a second time in the same file, was silently exempted both times');
});

test('a comment that merely names a toggle is not mistaken for a read of one', () => {
  assert.deepEqual(offendersIn("// features.voice is not built yet\nconst x = 1;"), []);
  assert.deepEqual(offendersIn("/** reads `file.features` */\nconst y = 2;"), []);
});

test('a synthetic read with no allowance at all is still caught', () => {
  assert.ok(offendersIn('if (project.features.newThing) return forbidden();').length,
    'a read of a toggle with no allow-list entry slipped through');
});

test('a feature key can never collide with, or be mistaken for, a capability', () => {
  assert.deepEqual(FEATURE_KEYS.filter((k) => CAPABILITIES.includes(k)), []);
});
