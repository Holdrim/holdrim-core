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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Comments and the insides of strings and template literals, blanked to spaces — never removed, so
 * a real offense keeps the line number it was found on. A doc comment that SAYS `features.voice`,
 * or a path like `'./features.js'`, is prose and an import target, not a read reaching a guard, and
 * must not force an allow-list entry for every sentence that happens to name the toggle.
 *
 * A smaller version of the stripper `engine/tests/roles-boundary.test.js` writes for the same
 * reason — copied in shape, not imported: the two files scan for different patterns, and sharing
 * the helper would make one depend on the other staying correct for a job it does not have.
 * Unlike that one, this does not need to walk a template literal's `${…}` interpolation back into
 * code: nothing this scan looks for currently sits inside one, and the day it does, a self-test
 * below is where that gets fixed, not a silent gap here.
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
      while (j < n && text[j] !== '`') j += (text[j] === '\\' && j + 1 < n) ? 2 : 1;
      if (j < n) j++;
      out += text.slice(i, j).replace(/[^\n]/g, ' ');
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
    if (text.slice(i, i + 2) === '//') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every tracked or new `.ts`/`.js`/`.jsx` file under the given paths — a file nobody committed yet
 *  is still a place a read could be hiding the moment it exists, the same reasoning
 *  `engine/tests/surface.test.js` uses for a variable. The bundle is left out: it is BUILT from
 *  `engine/web/src`, so scanning it would only repeat those reads, or, stale, report ones the
 *  sources no longer have. */
function sourceFiles(...paths) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths],
    { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(ts|js|jsx)$/.test(f) && f !== 'engine/web/panel-react.js');
}

/** Everywhere the engine's SOURCE is allowed to look at a project's toggles at all: `engine/tests`
 *  is excluded on purpose — a test reads `project.features` to set up its own fixture, and that is
 *  not a guard a toggle could reach, it is the toggle being tested. */
const SCANNED = ['engine/api', 'engine/cli', 'engine/core', 'engine/web/src'];

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
 * @param {string} text
 * @param {string|null} file  a path from `ALLOWED`, or null for a synthetic snippet with no allowance
 */
function offendersIn(text, file = null) {
  let scanned = withoutComments(text);
  for (const entry of ALLOWED.filter((a) => a.file === file)) {
    scanned = scanned.replaceAll(entry.text, entry.text.replace(/[^\n]/g, ' '));
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

test('the boundary itself: the scanned paths hold real reads, and nothing is stale', () => {
  const files = sourceFiles(...SCANNED);
  assert.ok(files.includes('engine/api/server.ts'), 'the file scan read the wrong files');
  assert.ok(!files.includes('engine/tests/features.test.js'), 'this file scans, but is not scanned');
  assert.deepEqual(staleEntries(), [], 'an ALLOWED entry no longer matches its file — the code it ' +
    'named moved or was reworded, and the exception it granted may now be hiding something else');
});

test('every real read of features, across the engine, is on the allow-list', () => {
  const offenders = [];
  for (const file of sourceFiles(...SCANNED)) {
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
