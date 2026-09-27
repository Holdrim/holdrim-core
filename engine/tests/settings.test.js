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
import { createRoles, parseLocks, capabilitiesOf, SHIPPED_ROLES, PROJECT_CAPABILITIES } from '../core/roles.js';
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
  // Made only of characters the line carries, and still not an address: `parseLocks` refuses a
  // trailing dot that `isEmailAddress` lets through — the composer refuses what start refuses.
  for (const email of ['', 'not-an-address', 'bea@example.org.', '@example.org']) {
    assert.deepEqual(compose(email, 'A01'), { error: 'settings.compose.error.email' }, email);
  }
});

test('an address with a character the line cannot carry safely is refused, before any other check', () => {
  for (const email of ['b`id`ea@example.org', 'bea$(id)@example.org', 'be\\a@example.org', 'bea!@example.org',
    "o'bea@example.org", 'bea@exa$mple.org', 'bea@exam_ple.org', '<bea@example.org>', '"bea"@example.org',
    'bea @example.org', 'bea@example.org;eve@example.org', 'a:b@example.org', 'bea@example.org:A01; cat@example.org']) {
    assert.deepEqual(compose(email, 'A01'), { error: 'settings.compose.error.characters' }, email);
    assert.deepEqual(compose(email, 'not a scope'), { error: 'settings.compose.error.characters' },
      `${email}: the characters are asked first, whatever else is wrong`);
  }
  assert.equal(compose('bea.o+x_1%y-z@mail-1.example.org', 'A01').entry.email, 'bea.o+x_1%y-z@mail-1.example.org',
    'every character the rule allows, on its side of the @, still composes');
});

test('an entry already set with a single quote is never handed out inside the quoted line', () => {
  // `parseLocks` accepts `'` in an address, so the deployment may hold one; the typed address never can.
  const quoted = [{ email: "o'ana@example.org", scope: 'A0*' }];
  assert.deepEqual(compose('bea@example.org', 'B07', quoted), { error: 'settings.compose.error.quote' });
});

test('an entry already present is refused, and the same address with another scope is a second entry', () => {
  assert.deepEqual(compose(' ANA@Example.org ', 'A0*'),
    { error: 'settings.compose.error.present', params: { email: 'ana@example.org', scope: 'A0*' } },
    'normalized the way start normalizes it, so a change of case is not a new grant');
  const second = compose('ana@example.org', 'B07');
  assert.equal(second.line, "HOLDRIM_LOCKS='ana@example.org:A0*; ana@example.org:B07'");
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

test('the answer is the whole line, single-quoted: every entry already set, then the new one, in the shape start parses', () => {
  const answer = compose('Bea@Example.org', 'A0*');
  assert.equal(answer.line, "HOLDRIM_LOCKS='ana@example.org:A0*; bea@example.org:A0*'");
  assert.deepEqual(answer.entry, { email: 'bea@example.org', scope: 'A0*' });
  assert.deepEqual(answer.reaches, ['A01', 'A02'], 'a family reaches its pages, never B07');
  // Round trip: what is between the quotes is exactly what `parseLocks` reads back.
  assert.deepEqual(parseLocks(answer.line.slice("HOLDRIM_LOCKS='".length, -1)), [ANA, answer.entry]);
  assert.equal(answer.line.split("'").length, 3, 'the two quotes around the value, and no third');
  assert.equal(compose('bea@example.org', 'A01.1.2', []).line, "HOLDRIM_LOCKS='bea@example.org:A01.1.2'",
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
  projectRoles: { roles: [], grants: [], ended: 0 },
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
  assert.ok(composer.includes('HOLDRIM_LOCKS=&#39;ana@example.org:A0*; bea@example.org:A0*&#39;'));
  assert.ok(composer.includes(dictionaries.en['settings.compose.restart']));
  assert.doesNotMatch(composer, /holdrim\.json/, 'holdrim.json refuses `locks`: the composer never suggests it');
});

test('what was typed into the composer is shown back, never run', () => {
  const hostile = '"><script>alert(1)</script>';
  const html = render({ compose: { email: hostile, scope: hostile, result: compose(hostile, hostile) } });
  assert.doesNotMatch(html, /<script/, 'the screen carries no script, and nothing typed opens one');
  assert.match(html, /name="email" type="email" required autocomplete="off" value="&quot;&gt;&lt;script&gt;/);
  assert.match(html, /name="scope" required autocomplete="off" spellcheck="false" value="&quot;&gt;&lt;script&gt;/);
  assert.ok(html.includes(dictionaries.en['settings.compose.error.characters']), 'refused, in words');
});

test('the composer posts, so the address typed never travels in the URL', () => {
  // A GET would leave it in the browser's history and in any proxy's access log.
  assert.match(section(render(), 'settings-compose'), /<form method="post" action="\/engine\/settings#settings-compose"/);
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

// ---------------------------------------------------------------- the project's roles (#36, PR 2)
const LEAD = { role: 'clinical lead', capabilities: ['triage', 'approve'], when: '2026-09-27T10:00:00.000Z' };
const GRANT = { id: 'g_1', who: 'Bea', role: 'clinical lead', scope: 'A0*', when: '2026-09-27T10:01:00.000Z', ignored: false };
const withRoles = (projectRoles, extra = {}) => render({ projectRoles: { roles: [], grants: [], ended: 0, ...projectRoles }, ...extra });

test('a role is defined with the capabilities a project role may hold, and never with lock or people', () => {
  const roles = section(render(), 'settings-project-roles');
  const offered = [...roles.matchAll(/name="capability" value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, [...PROJECT_CAPABILITIES], 'one box per capability PROJECT_CAPABILITIES names, in its order');
  assert.deepEqual(offered.filter((c) => c === 'lock' || c === 'people'), [], 'no box for lock or people');
  assert.match(roles, /<form method="post" action="\/engine\/settings#settings-project-roles"[^>]*>\s*<input type="hidden" name="action" value="define">/);
  assert.ok(roles.includes(dictionaries.en['settings.projectRoles.none']), 'no role yet, said so');
});

test('each role shows its latest definition, and a grant form offers only the roles that hold something', () => {
  const html = withRoles({ roles: [LEAD, { role: 'unread', capabilities: [], when: LEAD.when }] });
  assert.match(section(html, 'settings-project-roles'),
    /<td><code class="holdrim-code">clinical lead<\/code><\/td><td><code class="holdrim-code">triage<\/code> <code class="holdrim-code">approve<\/code><\/td>/);
  const grants = section(html, 'settings-grants');
  assert.deepEqual([...grants.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), ['clinical lead'],
    'a definition that did not read holds nothing, and is not offered');
  assert.doesNotMatch(section(render(), 'settings-grants'), /name="action" value="grant"/, 'no role, no grant form');
  assert.ok(section(render(), 'settings-grants').includes(dictionaries.en['settings.grants.defineFirst']));
});

test('a grant in force shows who, the role, the scope and a revoke form naming it; one naming an agent says it is ignored', () => {
  const grants = section(withRoles({ roles: [LEAD], grants: [GRANT, { ...GRANT, id: 'g_2', who: BOT, scope: null, ignored: true }], ended: 2 }),
    'settings-grants');
  assert.match(grants, /<td>Bea<\/td><td><code class="holdrim-code">clinical lead<\/code><\/td><td><code class="holdrim-code">A0\*<\/code><\/td>/);
  assert.match(grants, /<input type="hidden" name="action" value="revoke"><input type="hidden" name="grant" value="g_1">/);
  assert.match(grants, new RegExp(`<td>${BOT} <span[^>]*>${dictionaries.en['settings.grants.ignored']}</span></td><td><code class="holdrim-code">clinical lead</code></td><td>everywhere</td>`));
  assert.equal((grants.match(/settings-ignored/g) ?? []).length, 1, 'only the grant naming an agent is marked');
  assert.ok(grants.includes('2 revoked, each still in the trail.'));
});

test('a refused write is drawn with its reason and what was typed, escaped, and never run', () => {
  const hostile = '"><script>alert(1)</script>';
  const html = withRoles({ roles: [LEAD] }, { edit: { action: 'grant', key: 'api.grants.roleUnknown', params: { role: hostile },
    values: { role: hostile, email: hostile, scope: hostile, capabilities: [] } } });
  assert.doesNotMatch(html, /<script/);
  const grants = section(html, 'settings-grants');
  assert.ok(grants.includes('no role is defined as &quot;&quot;&gt;&lt;script&gt;'), 'the reason, with the typed role escaped inside it');
  assert.match(grants, /name="email" type="email" required autocomplete="off" value="&quot;&gt;&lt;script&gt;/);
  const defined = withRoles({}, { edit: { action: 'define', key: 'api.roles.capabilitiesInvalid', params: { capabilities: 'x' },
    values: { role: 'lead', email: '', scope: '', capabilities: ['approve'] } } });
  const roles = section(defined, 'settings-project-roles');
  assert.match(roles, /name="role" required[^>]*value="lead"/, 'the name typed is put back');
  assert.match(roles, /value="approve" checked/, 'and the boxes ticked');
  assert.doesNotMatch(roles, /value="triage" checked/);
  assert.doesNotMatch(section(defined, 'settings-grants'), /holdrim-alert--danger/, 'the refusal is drawn on its own form only');
});

test('a write that went through is confirmed where its form is', () => {
  assert.ok(section(withRoles({}, { done: 'define' }), 'settings-project-roles').includes('Role defined.'));
  assert.ok(section(withRoles({}, { done: 'revoke' }), 'settings-grants').includes('Grant revoked.'));
  assert.doesNotMatch(section(withRoles({}, { done: 'revoke' }), 'settings-project-roles'), /holdrim-alert--ok/);
});
