/**
 * The settings screen (issue #36): the lock-grant composer's checks, and what the screen draws.
 *
 * That only the owner reaches the screen, that it answers under its own policy, and that composing
 * writes no event are proved against a real server by `engine/test-contract.sh`, and in a browser by
 * `engine/test-browser.js`. This file proves the composer hands out only a line the service would
 * start with, and that nothing typed into it becomes markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  composeLock, locksValue, renderSettingsPage, SETTINGS_KEYS,
} from '../api/settings-page.ts';
import { engineNav } from '../api/people-page.ts';
import { createRoles, parseLocks, capabilitiesOf, SHIPPED_ROLES } from '../core/roles.js';
import { FEATURE_DEFAULTS } from '../core/features.js';
import { readConfig } from '../core/config.js';
import { createI18n } from '../core/i18n.js';
import { ENGINE_THEME } from '../api/theme.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const dictionaries = Object.fromEntries(['en', 'pt-BR', 'es'].map((l) =>
  [l, JSON.parse(readFileSync(`${ROOT}engine/locales/${l}.json`, 'utf8'))]));
const i18n = createI18n(dictionaries, 'en');

const OWNER = 'owner@example.org';
const BOT = 'bot@example.org';
const roles = createRoles(OWNER, '', '', BOT);
const BLOCKS = ['A01.1.1', 'A01.1.2', 'A02.1.1', 'B07.1.1'];
const ANA = { email: 'ana@example.org', scope: 'A0*' };
const compose = (email, scope, existing = [ANA]) => composeLock(existing, { email, scope }, BLOCKS, roles);

// ---------------------------------------------------------------- the composer
test('a scope that is none of the three shapes is refused as a scope, whatever the address', () => {
  for (const scope of ['', 'P*', '*', 'A0**', '<b>A01</b>', 'A01; eve@example.org:B0*']) {
    assert.deepEqual(compose('bea@example.org', scope), { error: 'settings.compose.error.scope' }, scope);
  }
});

test('an address HOLDRIM_LOCKS itself would refuse is refused as an address', () => {
  // The display form, a trailing dot and a quoted local part pass `isEmailAddress` and not
  // `parseLocks` — the composer has to refuse what start refuses, not what sign-up refuses.
  for (const email of ['', 'not-an-address', '<bea@example.org>', 'bea@example.org.', '"bea"@example.org',
    'bea@example.org;eve@example.org', 'a:b@example.org']) {
    assert.deepEqual(compose(email, 'A01'), { error: 'settings.compose.error.email' }, email);
  }
});

test('an address that smuggles a second entry in is refused, never half-granted', () => {
  // `parseLocks` reads this as two good entries, neither of them the one typed: taking the first
  // would hand out a grant over A01 nobody asked the composer for.
  assert.deepEqual(compose('bea@example.org:A01; cat@example.org', 'A02'), { error: 'settings.compose.error.email' });
});

test('an entry already present is refused, and the same address with another scope is a second entry', () => {
  assert.deepEqual(compose(' ANA@Example.org ', 'A0*'),
    { error: 'settings.compose.error.present', params: { email: 'ana@example.org', scope: 'A0*' } },
    'normalized the way start normalizes it, so a change of case is not a new grant');
  const second = compose('ana@example.org', 'B07');
  assert.equal(second.line, 'HOLDRIM_LOCKS="ana@example.org:A0*; ana@example.org:B07"');
});

test('a scope that reaches no page of this site is refused, as start refuses it', () => {
  assert.deepEqual(compose('bea@example.org', 'C0*'),
    { error: 'settings.compose.error.nothing', params: { scope: 'C0*' } });
  assert.deepEqual(compose('bea@example.org', 'A01.9.9'),
    { error: 'settings.compose.error.nothing', params: { scope: 'A01.9.9' } }, 'a block the site does not have');
});

test('an address HOLDRIM_AGENTS marks is refused: the service would not start with it', () => {
  assert.deepEqual(compose(BOT, 'A01'), { error: 'settings.compose.error.agent', params: { email: BOT } });
});

test('the answer is the whole line: every entry already set, then the new one, in the shape start parses', () => {
  const answer = compose('Bea@Example.org', 'A0*');
  assert.equal(answer.line, 'HOLDRIM_LOCKS="ana@example.org:A0*; bea@example.org:A0*"');
  assert.deepEqual(answer.entry, { email: 'bea@example.org', scope: 'A0*' });
  assert.deepEqual(answer.reaches, ['A01', 'A02'], 'a family reaches its pages, never B07');
  // Round trip: what is between the quotes is exactly what `parseLocks` reads back.
  assert.deepEqual(parseLocks(answer.line.slice('HOLDRIM_LOCKS="'.length, -1)), [ANA, answer.entry]);
  assert.equal(compose('bea@example.org', 'A01.1.2', []).line, 'HOLDRIM_LOCKS="bea@example.org:A01.1.2"',
    'with nothing set yet, the line is the one entry');
});

test('locksValue separates entries the way parseLocks splits them', () => {
  assert.equal(locksValue([]), '');
  assert.deepEqual(parseLocks(locksValue([ANA, { email: 'bea@example.org', scope: 'B07' }])),
    [ANA, { email: 'bea@example.org', scope: 'B07' }]);
});

// ---------------------------------------------------------------- the screen
const data = (extra = {}) => ({
  projectName: 'P', canManagePeople: true,
  holders: { owner: 'The Owner', admins: [], agents: [BOT], locks: [{ who: 'Ana', scope: 'A0*', reaches: ['A01', 'A02'] }] },
  features: { ...FEATURE_DEFAULTS }, peopleShow: 'email', namedInFile: { features: [], peopleShow: false },
  ...extra,
});
const render = (extra, lang = 'en') => renderSettingsPage(i18n, lang, data(extra), ENGINE_THEME, 'n0nce');
const section = (html, id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf('</section>', html.indexOf(`id="${id}"`)));

test('every dictionary has every sentence the settings screen reads', () => {
  // SETTINGS_KEYS is written by hand, so the source is read to hold it complete, as the home's is.
  const source = readFileSync(`${ROOT}engine/api/settings-page.ts`, 'utf8');
  const quoted = [...new Set([...source.matchAll(/'(settings\.[\w.]+)'/g)].map((m) => m[1]))];
  assert.ok(quoted.length >= 20, `only ${quoted.length} keys found: the scan is not reading the screen`);
  assert.deepEqual(quoted.filter((k) => !SETTINGS_KEYS.includes(k)), [], 'a key the screen reads is missing from SETTINGS_KEYS');
  for (const [lang, dictionary] of Object.entries(dictionaries)) {
    const missing = [...SETTINGS_KEYS, 'nav.settings'].filter((k) => typeof dictionary[k] !== 'string');
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});

test('the roles table is the one `can` reads, and lock is in no cell of it', () => {
  const html = render();
  const roles = section(html, 'settings-roles');
  const marks = (roles.match(/<span aria-hidden="true">✓<\/span>/g) ?? []).length;
  const expected = SHIPPED_ROLES.reduce((n, r) => n + capabilitiesOf(r).size, 0);
  assert.equal(expected, 6 + 6 + 3, 'setup: the three shipped roles, as docs/ROLES.md lists them');
  assert.equal(marks, expected, 'one ✓ per capability each shipped role holds, read from capabilitiesOf');
  assert.doesNotMatch(roles, /<th scope="row"><code class="holdrim-code">lock<\/code>/, 'lock has no row of cells');
  assert.ok(roles.includes(dictionaries.en['settings.roles.lockNever'].slice(0, 30)), 'and says lock is never granted');
  assert.match(roles, /triage, approve, lock, people/, 'what an agent never holds, from AGENT_NEVER');
});

test('who holds lock, and what each scope reaches, with the honest note that it is not in force', () => {
  const holders = section(render(), 'settings-holders');
  assert.match(holders, /<td>Ana<\/td><td><code class="holdrim-code">A0\*<\/code><\/td><td><code class="holdrim-code">A01<\/code> <code class="holdrim-code">A02<\/code><\/td>/);
  assert.ok(holders.includes('HOLDRIM_LOCKS is checked at start'), 'the note that can(\'lock\') does not read it yet');
});

test('the composer answer is shown, with the restart it needs, and never points at holdrim.json', () => {
  const html = render({ compose: { email: 'bea@example.org', scope: 'A0*', result: compose('bea@example.org', 'A0*') } });
  const composer = section(html, 'settings-compose');
  assert.ok(composer.includes('HOLDRIM_LOCKS=&quot;ana@example.org:A0*; bea@example.org:A0*&quot;'));
  assert.ok(composer.includes(dictionaries.en['settings.compose.restart']));
  assert.doesNotMatch(composer, /holdrim\.json/, 'holdrim.json refuses `locks`: the composer never suggests it');
});

test('what was typed into the composer is shown back, never run', () => {
  const hostile = '"><script>alert(1)</script>';
  const html = render({ compose: { email: hostile, scope: hostile, result: compose(hostile, hostile) } });
  assert.doesNotMatch(html, /<script/, 'the screen carries no script, and nothing typed opens one');
  assert.match(html, /name="email" type="email" required autocomplete="off" value="&quot;&gt;&lt;script&gt;/);
  assert.match(html, /name="scope" required autocomplete="off" spellcheck="false" value="&quot;&gt;&lt;script&gt;/);
  assert.ok(html.includes(dictionaries.en['settings.compose.error.scope']), 'refused, in words');
});

test('a refusal that names the typed scope escapes it inside the sentence', () => {
  // A refusal's params reach the page inside the translated sentence, so the escaping has to happen
  // after the two are joined: escaped before, a translation carrying markup would still get through.
  const hostileIn = createI18n({ ...dictionaries,
    en: { ...dictionaries.en, 'settings.compose.error.nothing': '{scope} <b>' } }, 'en');
  const html = renderSettingsPage(hostileIn, 'en',
    data({ compose: { email: 'x', scope: 'x', result: { error: 'settings.compose.error.nothing', params: { scope: '<i>' } } } }),
    ENGINE_THEME, 'n');
  assert.ok(html.includes('&lt;i&gt; &lt;b&gt;'));
});

test('the screen has one style, with this response\'s nonce, and no script', () => {
  const html = render();
  assert.equal(html.match(/<style/g).length, 1);
  assert.match(html, /<style nonce="n0nce">/);
  assert.doesNotMatch(html, /<script|\son[a-z]+=/i, 'no script and no inline handler');
});

test('features and people.show say where each value comes from, and the snippet to commit', () => {
  const html = render({ features: { ...FEATURE_DEFAULTS, graph: false }, peopleShow: 'role',
    namedInFile: { features: ['graph'], peopleShow: true } });
  const project = section(html, 'settings-project');
  assert.match(project, /features\.graph<\/code><\/td><td><code class="holdrim-code">false<\/code><\/td><td><code class="holdrim-code">holdrim\.json/);
  assert.match(project, /features\.comments<\/code><\/td><td><code class="holdrim-code">true<\/code><\/td><td>the default/);
  assert.match(project, /people\.show<\/code><\/td><td><code class="holdrim-code">role<\/code><\/td><td><code class="holdrim-code">holdrim\.json/);
  assert.ok(project.includes('&quot;graph&quot;: false'), 'the snippet carries the current values');
  assert.ok(project.includes('&quot;show&quot;: &quot;role&quot;'));
});

test('readConfig says which of features and people.show the file itself names', () => {
  const read = (o) => readConfig('/p', { readFile: () => JSON.stringify(o) }).namedInFile;
  assert.deepEqual(read({}), { features: [], peopleShow: false });
  assert.deepEqual(read({ features: { graph: true }, people: { show: 'email' } }), { features: ['graph'], peopleShow: true },
    'named at its default value is still named in the file');
});

test('the Settings link is offered to the owner alone', () => {
  assert.match(engineNav(i18n, 'en', 'home', true, true), /href="\/engine\/settings"/);
  assert.doesNotMatch(engineNav(i18n, 'en', 'home', true), /\/engine\/settings/, 'not unless the caller says owner');
  assert.doesNotMatch(engineNav(i18n, 'en', 'home', true, false), /\/engine\/settings/);
  assert.match(engineNav(i18n, 'en', 'settings', false, true), /href="\/engine\/settings" aria-current="page"/);
});
