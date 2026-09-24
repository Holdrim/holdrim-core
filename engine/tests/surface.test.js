/**
 * The public surface does not move without saying so.
 *
 * An adopter pins a version and builds on its names: the variables in their deployment, the keys of
 * their `holdrim.json`, the `data-*` attributes in their pages, the events and states their scripts
 * match on, the commands and flags their CI runs, the JSON `holdrim list --json` hands their agent,
 * and the routes their proxy lets through. Rename one and nothing in this repository breaks — every
 * caller of the old name lives in somebody else's. The adopter finds out when the next pin stops
 * working, and nothing told them which name went.
 *
 * So `engine/surface.json` lists every one of those names, and each test here derives one set FROM
 * THE CODE and compares. A difference fails by name, both ways: a name that appeared and one that
 * disappeared. The answer is never to loosen the derivation; it is to update the snapshot, and the
 * CHANGELOG, in the same change, so the adopter reading the next version's section learns what to
 * change.
 *
 * Where a module holds the list, it is imported — cycle.json, EVENT_TYPES, the event as stores
 * answer it, the queue as `list --json` prints it. Where nothing holds it, the sources are read, and
 * each such reading says what it would miss.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_COMMANDS, CLI_FLAGS } from './helpers/cli-source.js';
import { EVENT_TYPES, stored } from '../api/types.ts';
import { queue } from '../cli/requests.ts';
import * as screens from '../core/screens.js';
import * as language from '../api/language.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const SURFACE = JSON.parse(read('engine/surface.json'));

/**
 * Every file under the given paths, tracked or new — a variable read in a file nobody committed yet
 * is on the surface the moment the file is. Markdown is prose about the code, not the code.
 */
const filesUnder = (...paths) => execFileSync('git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.endsWith('.md') && existsSync(join(ROOT, f)));

/**
 * What the engine ships. The panel's bundle is left out: it is built from `engine/web/src`, so it
 * would only repeat those names, or — when stale — report ones the sources no longer have.
 */
const PRODUCT = filesUnder('engine/api', 'engine/cli', 'engine/core', 'engine/web',
  'engine/run-local.sh', 'compose.yaml', 'Dockerfile', '.env.example')
  .filter((f) => f !== 'engine/web/panel-react.js');

/** What only proves the engine. This file is left out: it names no variable, only the pattern. */
const PROOFS = filesUnder('engine/tests', 'engine/test-browser.js', 'engine/test-contract.sh',
  'scripts', '.github').filter((f) => f !== 'engine/tests/surface.test.js');

/** Each distinct capture of `pattern`'s first group, across `files`. */
function namesIn(files, pattern) {
  const found = new Set();
  for (const f of files) for (const m of read(f).matchAll(pattern)) found.add(m[1]);
  return found;
}

/**
 * The comparison every test makes. The message names both directions, and says the two things to
 * change: without the second, the snapshot moves and the adopter still hears nothing.
 */
function sameAs(category, derived, recorded) {
  const code = [...new Set(derived)].sort();
  const snapshot = [...recorded].sort();
  const added = code.filter((n) => !snapshot.includes(n));
  const removed = snapshot.filter((n) => !code.includes(n));
  assert.ok(added.length + removed.length === 0, [
    `the public surface changed: ${category}`,
    ...added.map((n) => `  + ${n}   (in the code, not in engine/surface.json)`),
    ...removed.map((n) => `  - ${n}   (in engine/surface.json, no longer in the code)`),
    'Adopters build on these names. If the change is intended, update engine/surface.json AND the',
    'current section of CHANGELOG.md in the same change — under **Breaking**, with what to change,',
    'when a name was renamed or removed.',
  ].join('\n'));
}

// ---------------------------------------------------------------- HOLDRIM_* variables
// Read as text: the variables are read in TypeScript, JavaScript, shell, compose and the Dockerfile,
// and no one module lists them. Any mention counts, a comment included, which errs towards listing.
// It would miss a name built at run time (`process.env['HOLDRIM_' + x]`); nothing does that, and
// nothing should — a name nobody can grep for is a name nobody can find to document.
const VARIABLE = /\b(HOLDRIM_[A-Z0-9_]*[A-Z0-9])\b/g;
const PUBLIC_VARIABLES = namesIn(PRODUCT, VARIABLE);

test('the HOLDRIM_ variables the engine reads are the ones engine/surface.json lists', () => {
  assert.ok(PUBLIC_VARIABLES.has('HOLDRIM_OWNER'), 'the variable scan read the wrong files');
  sameAs('HOLDRIM_ variables (public)', PUBLIC_VARIABLES, SURFACE.variables.public);
});

test('the HOLDRIM_ variables only the proofs read are the ones engine/surface.json lists', () => {
  // Not an adopter's contract, but CI and contributors set them: one renamed in a test and not in the
  // workflow would turn a required check into a skipped one without a word.
  const testOnly = [...namesIn(PROOFS, VARIABLE)].filter((n) => !PUBLIC_VARIABLES.has(n));
  sameAs('HOLDRIM_ variables (test-only)', testOnly, SURFACE.variables['test-only']);
});

// ---------------------------------------------------------------- holdrim.json keys
test('the keys of holdrim.json are the ones engine/surface.json lists', () => {
  // Read as text: `readConfig` answers its own names (`sheetFolders`, `agentCommand`), not the
  // file's, so importing it says nothing about what an adopter writes. The reading follows `file.x`,
  // `file.x.y`, and the sections aliased as `const s = file.x ?? {}` then read as `s.y`. It would
  // miss a key reached by destructuring or by brackets; config.js uses neither.
  const text = read('engine/core/config.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const paths = new Set();
  for (const [, key, sub] of text.matchAll(/\bfile\.(\w+)(?:\??\.(\w+))?/g)) paths.add(sub ? `${key}.${sub}` : key);
  for (const [, alias, section] of text.matchAll(/const (\w+) = file\.(\w+) \?\? \{\}/g)) {
    for (const [, key] of text.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))) paths.add(`${section}.${key}`);
  }
  // A section is not a key of its own: `cloud` is only ever the place `cloud.project` lives.
  const leaves = [...paths].filter((p) => ![...paths].some((q) => q.startsWith(`${p}.`)));
  assert.ok(leaves.includes('owner') && leaves.includes('cloud.project'), 'the config reading found nothing');
  sameAs('holdrim.json keys', leaves, SURFACE['config-keys']);
});

// ---------------------------------------------------------------- data-* attributes
test('the data- attributes the engine reads and writes are the ones engine/surface.json lists', () => {
  // Read as text: they live in HTML templates, JSX, CSS selectors and getAttribute calls alike.
  // It would miss one reached only through `element.dataset.camelCase` — people-page.ts does that,
  // and writes the same attributes out literally, which is where they are found.
  const attributes = namesIn(PRODUCT, /\b(data-[a-z][a-z0-9-]*[a-z0-9])\b/g);
  assert.ok(attributes.has('data-id'), 'the attribute scan read the wrong files');
  sameAs('data- attributes', attributes, SURFACE['data-attributes']);
});

// ---------------------------------------------------------------- events
test('the event types are the ones engine/surface.json lists', () => {
  sameAs('event types', EVENT_TYPES, SURFACE['event-types']);
});

test('the fields of an event are the ones engine/surface.json lists', () => {
  // The event as every store answers it: each field present, so the keys are the whole shape.
  sameAs('event fields', Object.keys(stored({ type: 'comment', page: 'A01' }, 'id', 'a@example.org', 'now')),
    SURFACE['event-fields']);
});

test('the keys inside an event\'s data are the ones engine/surface.json lists', () => {
  // Read as text: `data` is open by design (types.ts), so no type lists its keys. Found as
  // `<event>.data.key` and `<event>.data?.key`, as a one-line `data: { key, … }` literal, and as
  // `data.key = …`. It would miss a key read by brackets or spread in, and a literal written over
  // several lines — a writer that does either has to be added here by hand.
  const files = PRODUCT.filter((f) => /\.(ts|js|jsx)$/.test(f));
  const keys = new Set([
    ...namesIn(files, /\b\w+\.data\??\.([a-z_]+)\b(?!\s*\()/g),
    ...namesIn(files, /\bdata\.([a-z_]+) = /g),
  ]);
  for (const f of files) {
    for (const [, body] of read(f).matchAll(/\bdata(?::\s*Record<[^>\n]*>)?\s*[:=]\s*(?:[^{}\n;]*\?\s*)?\{([^{}\n]*)\}/g)) {
      if (body.includes(';')) continue;          // a type annotation, not a value
      for (const [, key] of body.matchAll(/(?:^|,)\s*(\w+)\s*(?=:|,|$)/g)) keys.add(key);
    }
  }
  assert.ok(keys.has('request') && keys.has('commit'), 'the data-key scan read the wrong files');
  sameAs('event data keys', keys, SURFACE['event-data-keys']);
});

// ---------------------------------------------------------------- the request cycle
const CYCLE = JSON.parse(read('engine/cycle.json'));

test('the request states are the ones engine/surface.json lists', () => {
  sameAs('request states', Object.keys(CYCLE.states), SURFACE['request-states']);
});

test('the request categories are the ones engine/surface.json lists', () => {
  sameAs('request categories', Object.keys(CYCLE.request_categories), SURFACE['request-categories']);
});

// ---------------------------------------------------------------- the CLI
test('the CLI commands are the ones engine/surface.json lists', () => {
  sameAs('CLI commands', CLI_COMMANDS, SURFACE['cli-commands']);
});

test('the CLI flags are the ones engine/surface.json lists', () => {
  sameAs('CLI flags', CLI_FLAGS, SURFACE['cli-flags']);
});

test('the keys `holdrim list --json` prints are the ones engine/surface.json lists', async () => {
  // The queue itself, asked for with a request that has a block and a history, so every key it can
  // print is there. `queue()` is what `--json` prints verbatim.
  const when = '2026-01-01T00:00:00.000Z';
  const events = [
    stored({ type: 'request', page: 'A01', block: 'A01.1.1', text: 'x', data: { category: 'text' } }, 'r1', 'a@example.org', when),
    stored({ type: 'comment', page: 'A01', block: 'A01.1.1', text: 'y', data: { request: 'r1' } }, 'c1', 'a@example.org', when),
  ];
  // A request's state is read against the roles, and the roles refuse to exist without an owner.
  process.env.HOLDRIM_OWNER ??= 'owner@example.org';
  const printed = await queue(join(ROOT, 'examples', 'hello-world'), { events: async () => events }, true);
  assert.equal(printed.requests[0]?.history.length, 1, 'the queue was asked with no history to show');

  /** Every key path, with `[]` for a list, down to the values a script reads. */
  const keysOf = (value, prefix = '') => Object.entries(value).flatMap(([k, v]) => {
    const path = `${prefix}${k}`;
    if (Array.isArray(v)) return [path, ...(v[0] && typeof v[0] === 'object' ? keysOf(v[0], `${path}[].`) : [])];
    return v && typeof v === 'object' ? [path, ...keysOf(v, `${path}.`)] : [path];
  });
  sameAs('`holdrim list --json` keys', keysOf(printed), SURFACE['list-json']);
});

// ---------------------------------------------------------------- HTTP routes
test('the HTTP routes are the ones engine/surface.json lists', () => {
  // Read as text: the server dispatches with `if`s, not a table, so there is no list to import.
  // Each comparison of `route` (the API path with `/api` taken off), `url.pathname` or `path` names
  // a route; the method is the `req.method === '…'` on the same line, or `*` when none is — which
  // is what the server does then, answer whatever came. A route matched by a regular expression is
  // found through the name its match is kept in, and its groups read as `:param`.
  //
  // It would miss a route dispatched any other way — a lookup table, a `switch`, a path built at
  // run time — and a method decided further down, as the home's form is: `/engine/home` answers
  // POST inside its handler, so it is listed as `*`. A new way of dispatching needs teaching here.
  const text = read('engine/api/server.ts').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const constants = { ...screens, ...language };
  for (const [, name, value] of text.matchAll(/^const ([A-Z_]+) = '([^']+)';/gm)) constants[name] = value;
  const pathOf = (token) => (token.startsWith('\'') ? token.slice(1, -1) : constants[token]);
  const fromRegex = (source) => source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\([^)]*\)/g, ':param');
  const methodOf = (line) => /req\.method === '([A-Z]+)'/.exec(line)?.[1] ?? '*';

  const routes = new Set();
  const matched = new Map();
  for (const line of text.split('\n')) {
    for (const [, subject, token] of line.matchAll(/\b(route|url\.pathname|path) === ('[^']*'|[A-Z_]+)/g)) {
      const path = pathOf(token);
      assert.ok(path, `a route compares against ${token}, which this test cannot resolve`);
      routes.add(`${methodOf(line)} ${subject === 'route' ? `/api${path}` : path}`);
    }
    const kept = /const (\w+) = route\.match\(\/(.+)\/\);/.exec(line);
    if (kept) matched.set(kept[1], `/api${fromRegex(kept[2])}`);
    for (const [name, path] of matched) {
      const guard = new RegExp(`\\bif \\((?:req\\.method === '[A-Z]+' && )?${name}(?: && req\\.method === '[A-Z]+')?\\)`);
      if (guard.test(line)) routes.add(`${methodOf(line)} ${path}`);
    }
  }
  // The engine's own files, served under one prefix per folder.
  const folders = /for \(const folder of \[([^\]]+)\]\)/.exec(text)?.[1] ?? '';
  for (const [, folder] of folders.matchAll(/'([a-z]+)'/g)) routes.add(`* /engine/${folder}/*`);

  assert.ok(routes.has('GET /api/me') && routes.has('* /language'), 'the route reading found nothing');
  sameAs('HTTP routes', routes, SURFACE['http-routes']);
});
