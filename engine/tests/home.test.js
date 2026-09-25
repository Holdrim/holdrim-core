/**
 * The project home: the lights per page, the requests still in progress, and what the screen does
 * with text somebody else typed.
 *
 * The HTTP contract proves the route is guarded and runs no script; this file proves what the
 * screen SAYS — a home that miscounts is worse than none, because it is the one place a person who
 * never opens a terminal decides whether the documentation can be trusted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  summarisePages, requestsInProgress, renderHomePage, pageTitle, SETTLED, HOME_KEYS,
} from '../api/home-page.ts';
import { createI18n } from '../core/i18n.js';
import { ENGINE_THEME } from '../api/theme.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const SITE = '/site';

/** A block as readBlocks would hand it over, with only what the home reads. */
function block(id, fingerprint, extra = {}) {
  const page = id.split('.')[0];
  return [id, { id, page, path: `${SITE}/pages/${page}.html`, fingerprint, kind: 'text', text: id,
    dependsOn: [], ...extra }];
}

const blocks = new Map([
  block('Y01.1.1', 'f-y1'),            // an earlier folder first, whatever its letter
  block('A01.1.1', 'f-a1'),            // validated, unchanged   → valid
  block('A01.1.2', 'f-a2-new'),        // validated, text moved  → stale
  block('A01.1.3', 'f-a3'),            // unchanged, ground moved → broken
  block('A02.1.1', 'f-b1'),            // nobody looked           → none
  block('A9.1.1', 'f-d1'),             // as readBlocks hands them over: A9 before A10, by number
  block('A10.1.1', 'f-c1'),
]);
const registry = {
  'A01.1.1': { file: 'pages/A01.html', date: '2026-09-20', fingerprint: 'f-a1' },
  'A01.1.2': { file: 'pages/A01.html', date: '2026-09-20', fingerprint: 'f-a2-old' },
  'A01.1.3': { file: 'pages/A01.html', date: '2026-09-20', fingerprint: 'f-a3', dependsOn: { 'A01.1.1': 'f-a1-before' } },
};
const noHeading = () => '<main></main>';

test('every page is tallied by the same traffic light the CLI prints, in the project\'s order', () => {
  const pages = summarisePages(blocks, registry, SITE, [], noHeading);
  assert.deepEqual(pages.map((p) => p.page), ['Y01', 'A01', 'A02', 'A9', 'A10'],
    'the order the pages arrive in, not their letters');
  assert.deepEqual(pages[1].tally, { valid: 1, stale: 1, broken: 1, none: 0 });
  assert.deepEqual(pages[2].tally, { valid: 0, stale: 0, broken: 0, none: 1 });
  assert.equal(pages[1].href, '/pages/A01.html', 'the link is the path the server serves');
});

test('an owner ✓ on the site counts as waiting, once, only for the text it approved, and never as a lock', () => {
  const approval = (block, fingerprint) => ({ type: 'approval', page: block.split('.')[0], block, fingerprint });
  const pages = summarisePages(blocks, registry, SITE, [
    approval('A02.1.1', 'f-b1'),
    approval('A02.1.1', 'f-b1'),         // the same ✓ twice
    approval('A10.1.1', 'f-c1-older'),   // for a text that is gone: expired
    approval('A01.1.1', 'f-a1'),         // already in the registry
  ], noHeading);
  const byPage = Object.fromEntries(pages.map((p) => [p.page, p]));
  assert.equal(byPage.A02.awaitingSync, 1);
  assert.equal(byPage.A10.awaitingSync, 0, 'an approval of an older text does not hold');
  assert.equal(byPage.A01.awaitingSync, 0, 'what the registry already locks is not waiting');
  assert.equal(byPage.A02.tally.none, 1, 'the light still says nobody locked it: the registry is the lock');
});

test('a page is called by its own heading, without its code, and by its code when it has none', () => {
  assert.equal(pageTitle('<h1 class="doc-title"><span class="doc-title__code">A01</span> What &amp; why</h1>', 'A01'),
    'What & why');
  assert.equal(pageTitle('<h1 class="doc-title"> <span class="doc-title__code">A01</span> </h1>', 'A01'), 'A01');
  assert.equal(pageTitle('<main><h2>not the title</h2></main>', 'A01'), 'A01');
  assert.equal(pageTitle('<h1 class="doc-title">Say &amp;lt; literally</h1>', 'A01'), 'Say &lt; literally',
    'decoded once: text that asked for "&lt;" keeps it');
  const example = readFileSync(`${ROOT}examples/hello-world/pages/A01.html`, 'utf8');
  assert.equal(pageTitle(example, 'A01'), 'What Holdrim demands of a page');
});

test('only requests someone is still waiting on are listed, the oldest first, linked to their block', () => {
  const request = (id, when, block = 'A01.1.1') => ({ id, type: 'request', page: 'A01', block, author: 'r@x.org', when, text: id, data: { category: 'text' } });
  const events = [request('late', '2026-09-22'), request('early', '2026-09-20'), request('done', '2026-09-19'),
    request('refused', '2026-09-18')];
  const states = { late: 'open', early: 'approved', done: 'applied', refused: 'rejected' };
  const rows = requestsInProgress(events, (r) => states[r.id], new Map([['A01', '/pages/A01.html']]));
  assert.deepEqual(rows.map((r) => r.id), ['early', 'late']);
  assert.equal(rows[0].href, '/pages/A01.html#A01.1.1');
  assert.equal(rows[0].state, 'approved');
});

test('requestsInProgress shows the address by default — every caller from before people.show existed', () => {
  const request = (id) => ({ id, type: 'request', page: 'A01', block: 'A01.1.1', author: 'r@x.org', when: '2026-09-22', text: id, data: {} });
  const rows = requestsInProgress([request('r1')], () => 'open', new Map([['A01', '/pages/A01.html']]));
  assert.equal(rows[0].author, 'r@x.org');
});

test('requestsInProgress shows whatever authorOf resolves the address to — docs/ROLES.md, "How a person appears"', () => {
  const request = (id, author) => ({ id, type: 'request', page: 'A01', block: 'A01.1.1', author, when: '2026-09-22', text: id, data: {} });
  const rows = requestsInProgress(
    [request('r1', 'ana@example.org'), request('r2', 'bea@example.org')],
    () => 'open', new Map([['A01', '/pages/A01.html']]),
    (email) => (email === 'ana@example.org' ? 'Ana Silva' : email),
  );
  assert.deepEqual(rows.map((r) => r.author), ['Ana Silva', 'bea@example.org']);
});

test('the states the home treats as settled are states the cycle has', () => {
  const cycle = JSON.parse(readFileSync(`${ROOT}engine/cycle.json`, 'utf8'));
  for (const state of SETTLED) assert.ok(cycle.states[state], `${state} is not a state in cycle.json`);
});

test('every dictionary has every sentence the home reads', () => {
  // HOME_KEYS is written by hand, so the source is read to hold it complete: otherwise a key added
  // to the screen and not to the list would be checked by nothing that says it checks the home.
  const source = readFileSync(`${ROOT}engine/api/home-page.ts`, 'utf8');
  const quoted = [...new Set([...source.matchAll(/'(home\.[\w.]+)'/g)].map((m) => m[1]))];
  assert.ok(quoted.length >= 20, `only ${quoted.length} keys found: the scan is not reading the home`);
  assert.deepEqual(quoted.filter((k) => !HOME_KEYS.includes(k)), [], 'a key the home reads is missing from HOME_KEYS');
  for (const lang of ['en', 'pt-BR', 'es']) {
    const dictionary = JSON.parse(readFileSync(`${ROOT}engine/locales/${lang}.json`, 'utf8'));
    const missing = HOME_KEYS.filter((k) => typeof dictionary[k] !== 'string');
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});

test('text somebody else typed is shown, never run', () => {
  const dictionaries = Object.fromEntries(['en', 'pt-BR', 'es'].map((l) =>
    [l, JSON.parse(readFileSync(`${ROOT}engine/locales/${l}.json`, 'utf8'))]));
  const i18n = createI18n(dictionaries, 'en');
  const html = renderHomePage(i18n, 'en', {
    projectName: '<img src=x onerror=alert(1)>',
    pages: [{ page: 'A01', href: '/pages/A01.html', title: '</a><script>alert(1)</script>',
      tally: { valid: 1, stale: 0, broken: 0, none: 0 }, awaitingSync: 0 }],
    requests: [{ id: 'r', page: 'A01', block: 'A01.1.1', href: '/pages/A01.html#A01.1.1', state: 'open',
      category: 'text', author: '"><svg onload=alert(1)>', when: '2026-09-23T00:00:00Z',
      text: '<script>alert("typed by a reviewer")</script>' }],
  }, ENGINE_THEME, 'n0nce');
  assert.doesNotMatch(html, /<script/i, 'no script tag reaches the page, whoever typed it');
  assert.doesNotMatch(html, /<img src=x|<svg/i);
  assert.match(html, /&lt;script&gt;alert\(&quot;typed by a reviewer&quot;\)&lt;\/script&gt;/);
  assert.match(html, /<style nonce="n0nce">/, 'the one style block carries the response nonce');
});

test('the lights at the top add up every page, not the last one', () => {
  const html = renderHomePage(createI18n({ en: JSON.parse(readFileSync(`${ROOT}engine/locales/en.json`, 'utf8')) }, 'en'), 'en', {
    projectName: 'P', requests: [],
    pages: [
      { page: 'A01', href: '/a', title: 'a', tally: { valid: 2, stale: 1, broken: 0, none: 4 }, awaitingSync: 0 },
      { page: 'A02', href: '/b', title: 'b', tally: { valid: 3, stale: 0, broken: 1, none: 5 }, awaitingSync: 0 },
    ],
  }, ENGINE_THEME, 'n');
  const top = Object.fromEntries([...html.matchAll(/<li class="home-light"><span aria-hidden="true">(\S+)<\/span> <strong>(\d+)<\/strong>/g)]
    .map(([, light, count]) => [light, Number(count)]));
  assert.deepEqual(top, { '🔴': 1, '🟡': 1, '⚪': 9, '🟢': 5 });
});

test('the home asks for a page near an existing one, keeps a refused text, and asks nothing when there is no page', () => {
  const i18n = createI18n({ en: JSON.parse(readFileSync(`${ROOT}engine/locales/en.json`, 'utf8')) }, 'en');
  const pages = [
    { page: 'A01', href: '/a', title: 'First', tally: { valid: 0, stale: 0, broken: 0, none: 1 }, awaitingSync: 0 },
    { page: 'A02', href: '/b', title: 'Second', tally: { valid: 0, stale: 0, broken: 0, none: 1 }, awaitingSync: 0 },
  ];
  const plain = renderHomePage(i18n, 'en', { projectName: 'P', pages, requests: [] }, ENGINE_THEME, 'n');
  assert.match(plain, /<form method="post" action="\/engine\/home"/, 'a plain form: the home stays script-free');
  assert.match(plain, /<option value="A02">A02 · Second<\/option>/);

  const refused = renderHomePage(i18n, 'en', { projectName: 'P', pages, requests: [],
    ask: { problem: 'the text <b>is</b> required', draft: '</textarea><script>x</script>', near: 'A02' } }, ENGINE_THEME, 'n');
  assert.match(refused, /role="alert">the text &lt;b&gt;is&lt;\/b&gt; required/);
  assert.match(refused, /&lt;\/textarea&gt;&lt;script&gt;x&lt;\/script&gt;<\/textarea>/, 'the draft comes back, escaped');
  assert.match(refused, /<option value="A02" selected>/, 'and so does the page it was asked near');
  assert.doesNotMatch(refused, /<script/);
  // Drawn again at the address the form posted to, so no fragment leads there: the field does.
  assert.match(refused, /<textarea [^>]*required autofocus>/, 'the text to fix takes the focus');
  assert.doesNotMatch(plain, /autofocus/, 'and nothing does when nothing went wrong');

  assert.match(renderHomePage(i18n, 'en', { projectName: 'P', pages, requests: [], ask: { asked: true } }, ENGINE_THEME, 'n'),
    /role="status">Your request is recorded/);
  assert.doesNotMatch(renderHomePage(i18n, 'en', { projectName: 'P', pages: [], requests: [] }, ENGINE_THEME, 'n'), /<form/,
    'a request hangs on a page: with none, there is nothing to ask near');
});

// ---------------------------------------------------------------- the pageRequests toggle (docs/ROLES.md §7)

test('features.pageRequests OFF hides the "ask for a page" form; on, or unset, it is there', () => {
  const i18n = createI18n({ en: JSON.parse(readFileSync(`${ROOT}engine/locales/en.json`, 'utf8')) }, 'en');
  const pages = [{ page: 'A01', href: '/a', title: 'First', tally: { valid: 0, stale: 0, broken: 0, none: 1 }, awaitingSync: 0 }];

  const off = renderHomePage(i18n, 'en', { projectName: 'P', pages, requests: [], pageRequestsEnabled: false }, ENGINE_THEME, 'n');
  assert.doesNotMatch(off, /<form method="post" action="\/engine\/home"/, 'the toggle hides the form entirely, not merely disables it');
  assert.doesNotMatch(off, /home\.ask\.heading|Ask for a page/);

  // The server always passes the toggle, but a caller from before it existed — and every other test
  // in this file — passes none at all, and has to keep seeing the form it always saw.
  const unset = renderHomePage(i18n, 'en', { projectName: 'P', pages, requests: [] }, ENGINE_THEME, 'n');
  assert.match(unset, /<form method="post" action="\/engine\/home"/, 'no value at all means on, same as today');

  const on = renderHomePage(i18n, 'en', { projectName: 'P', pages, requests: [], pageRequestsEnabled: true }, ENGINE_THEME, 'n');
  assert.match(on, /<form method="post" action="\/engine\/home"/);
});

test('whoever may decide gets one plain form per request, with the cycle\'s destinations and nothing run', () => {
  const i18n = createI18n({ en: JSON.parse(readFileSync(`${ROOT}engine/locales/en.json`, 'utf8')) }, 'en');
  const row = (extra = {}) => ({ id: 'r1', page: 'A01', block: 'A01.1.1', href: '/a#A01.1.1', state: 'open', category: 'text',
    author: 'r@x.org', when: '2026-09-23T00:00:00Z', text: 'change it', ...extra });
  const base = { projectName: 'P', pages: [], canManagePeople: false };

  const reader = renderHomePage(i18n, 'en', { ...base, requests: [row()] }, ENGINE_THEME, 'n');
  assert.doesNotMatch(reader, /name="action" value="triage"/, 'nobody is offered a form the server refuses');
  assert.doesNotMatch(reader, /<th scope="col">Decide<\/th>/);

  const owner = renderHomePage(i18n, 'en', { ...base, requests: [
    row({ triage: ['approved', 'rejected', 'question'], requiresReason: ['rejected', 'question'] }),
    row({ id: 'r2', state: 'approved', triage: [] }),
    // A reason is needed here too, so the id reaches the hint's `id` and the field's `aria-describedby`.
    row({ id: '"><script>x</script>', block: '"><img src=x>', triage: ['approved', 'rejected'], requiresReason: ['rejected'] }),
    row({ id: 'r3', triage: ['approved'] }),
  ] }, ENGINE_THEME, 'n');
  const forms = [...owner.matchAll(/<form method="post" action="\/engine\/home" class="home-triage">[\s\S]*?<\/form>/g)];
  assert.equal(forms.length, 3, 'a request with nowhere to go gets no form');
  assert.doesNotMatch(owner, /name="request" value="r2"/);
  assert.match(forms[0][0], /name="request" value="r1"/);
  assert.match(forms[0][0], /name="block" value="A01\.1\.1"/);
  assert.deepEqual([...forms[0][0].matchAll(/<option value="(\w+)">/g)].map((m) => m[1]), ['approved', 'rejected', 'question']);
  assert.match(forms[0][0], /<select [^>]*required[^>]*><option value="" selected disabled>/,
    'nothing is decided until somebody chooses: no destination arrives preselected');
  assert.match(forms[0][0], /<p class="holdrim-faint home-triage__hint" id="why-r1">Why — needed for: Rejected, Question for the requester<\/p>/,
    'the hint names the decisions the cycle says need a reason, and only those, where it can be read whole');
  assert.match(forms[0][0], /name="reason"[^>]*placeholder="Why" aria-label="Why" aria-describedby="why-r1"/,
    'and the field, short now that the sentence lives beside it, points at it');
  assert.doesNotMatch(forms[2][0], /home-triage__hint|aria-describedby/, 'no hint where no decision needs a reason');
  assert.match(forms[2][0], /placeholder="A note, if you want"/);
  assert.match(forms[1][0], /id="why-&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/, 'an id somebody else chose stays inside the hint\'s id');
  assert.match(forms[1][0], /aria-describedby="why-&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/, 'and inside the field\'s pointer to it');
  assert.match(forms[0][0], /maxlength="4000"/, 'the server\'s own limit on a text');
  assert.match(forms[1][0], /name="request" value="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/,
    'an id somebody else chose stays inside its attribute');
  assert.match(forms[1][0], /name="block" value="&quot;&gt;&lt;img src=x&gt;"/);
  assert.doesNotMatch(owner, /<script|<img/, 'and nothing of it runs');

  const refused = renderHomePage(i18n, 'en', { ...base, requests: [row({ id: 'r0', triage: ['approved'] }), row({ triage: ['approved'] })],
    ask: { triage: { problem: 'a <b>reason</b> is required', request: 'r1', reason: '"><b>typed</b>' } } }, ENGINE_THEME, 'n');
  const [before, after] = refused.split('name="request" value="r0"');
  assert.doesNotMatch(before + after.split('</tr>')[0], /role="alert"/, 'not on a row it was not about');
  assert.match(after.split('</tr>')[1], /role="alert">a &lt;b&gt;reason&lt;\/b&gt; is required/, 'on the row it was about');
  assert.match(refused, /name="reason"[^>]*value="&quot;&gt;&lt;b&gt;typed&lt;\/b&gt;"/, 'with what was typed kept, escaped');
  assert.equal([...refused.matchAll(/autofocus/g)].length, 1, 'one field takes the focus');
  assert.match(after.split('</tr>')[1], /name="reason"[^>]*autofocus/, 'the one on the row that was refused');
  assert.match(renderHomePage(i18n, 'en', { ...base, requests: [], ask: { decided: true } }, ENGINE_THEME, 'n'),
    /role="status">Decision recorded/);
});
