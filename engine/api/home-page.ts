import { relative, sep } from 'node:path';
import { trafficLight, COLOURS } from '../core/validity.js';
import type { Block } from '../cli/pages.ts';
import type { Registry } from '../cli/validation.ts';
import type { Event } from './types.ts';
import { BASE_CSS, brandmark, forHtml, type Translator } from './login-page.ts';
import { themeCss, type Theme } from './theme.ts';
import { engineNav } from './people-page.ts';
import { HOME_SCREEN } from '../core/screens.js';
import { LIMITS } from '../core/limits.js';

/**
 * The project's home: where the documentation stands, page by page, and every request someone is
 * still waiting on — the first screen after sign-in.
 *
 * Without it, the only way to know either is to open each page and look at each block, or to run
 * `holdrim lights` in a terminal. Neither is something a person who is not a developer does,
 * and they are exactly who has to trust the documentation.
 *
 * ## Why the server renders it, with no script
 *
 * It is mostly a report. Rendered on the server it arrives complete, works with JavaScript off, and
 * runs under a policy that forbids every script (`screenPolicy` with `script: false`). Its two
 * actions — asking for a page, and deciding a request for whoever may — are plain HTML forms posted
 * back to this address, which need no script either, and are recorded by the same function the API
 * uses. Approving a text stays in the panel, on its page: nobody approves what they cannot read.
 *
 * ## Which lights it shows
 *
 * The same ones `holdrim lights` prints, computed by the same function (`trafficLight`) from the same
 * two inputs: the pages on disk and the approvals registry in the repository. That registry is the
 * lock. An owner's ✓ given on the site becomes part of it only when `holdrim sync` brings it in, so
 * until then the home counts it apart, as "approved on the site" — mixing it into the light would
 * show a lock the repository does not hold.
 */

type State = 'valid' | 'stale' | 'broken' | 'none';
const STATES: State[] = ['broken', 'stale', 'none', 'valid'];

export interface PageSummary {
  page: string;
  /** Where the page is served, from the site root: what the row links to. */
  href: string;
  /** The page's own heading (`h1.doc-title`, the code taken out), or the code when it has none. */
  title: string;
  tally: Record<State, number>;
  /** Blocks whose current text the owner approved on the site, not yet in the registry. */
  awaitingSync: number;
}

export interface RequestRow {
  id: string; page: string; block: string | null; href: string | null;
  state: string; category: string | null; author: string; when: string; text: string;
  /** Where the viewer may send it, from the cycle; absent for whoever may not decide. */
  triage?: string[];
  /** The destinations among those that need a reason. */
  requiresReason?: string[];
}

/**
 * States in which nobody is waiting on anybody. Named here, not derived from the cycle table,
 * because "rejected" still has a way out (the owner may approve it later) and yet nobody is waiting
 * on it. `cycle.json` defining both is checked by a test, so a renamed state cannot quietly empty
 * this list.
 */
export const SETTLED = ['applied', 'rejected'];

/**
 * Every page, with its light tallied, in the order the pages arrive: the project's folders as its
 * holdrim.json lists them, and within one, by number. Sorting by code here would override that
 * order, so a project whose folders are arranged to be read in sequence would open on whichever
 * page's letter came first.
 *
 * @param siteRoot       the folder the server serves pages from, to turn a file into a link
 * @param ownerApprovals the owner's approval events from the site, already filtered by the caller
 * @param readPage       the HTML of a page file, for its heading; passed in so a test needs no disk
 */
export function summarisePages(
  blocks: Map<string, Block>, registry: Registry, siteRoot: string, ownerApprovals: Event[],
  readPage: (path: string) => string,
): PageSummary[] {
  const { byBlock } = trafficLight(blocks, registry);
  const pages = new Map<string, PageSummary>();
  for (const [id, block] of blocks) {
    let summary = pages.get(block.page);
    if (!summary) {
      summary = {
        page: block.page,
        href: '/' + relative(siteRoot, block.path).split(sep).join('/'),
        title: pageTitle(readPage(block.path), block.page),
        tally: { valid: 0, stale: 0, broken: 0, none: 0 },
        awaitingSync: 0,
      };
      pages.set(block.page, summary);
    }
    summary.tally[byBlock.get(id)!.state as State]++;
  }

  // Counted once per block: the owner may have clicked ✓ twice on the same text.
  const waiting = new Set<string>();
  for (const e of ownerApprovals) {
    const block = e.block ? blocks.get(e.block) : undefined;
    if (!block || e.fingerprint !== block.fingerprint) continue;      // an older text: it expired
    if (registry[block.id]?.fingerprint === block.fingerprint) continue; // already in the lock
    waiting.add(block.id);
  }
  for (const id of waiting) pages.get(blocks.get(id)!.page)!.awaitingSync++;

  return [...pages.values()];
}

/**
 * What a page calls itself: its `h1.doc-title`, with the `.doc-title__code` inside it taken out —
 * the code already has its own column. The page contract (README, "What your page needs") makes the
 * code mandatory and the heading customary, so a page without one falls back to its code rather
 * than to nothing.
 */
export function pageTitle(html: string, code: string): string {
  const heading = /<h1\b[^>]*class="[^"]*\bdoc-title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (!heading) return code;
  const text = heading
    .replace(/<([a-z0-9]+)\b[^>]*class="[^"]*\bdoc-title__code\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    // `&amp;` last: decoded first, `&amp;lt;` would become `&lt;` and then `<` — a second decoding
    // of text that asked for the literal characters.
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  return text || code;
}

/**
 * Every request someone is still waiting on, the oldest first: the one waiting longest is the one
 * most likely forgotten.
 *
 * @param stateOf  the cycle's verdict on one request — passed in so this file does not rebuild the
 *                 rule of who triages whom
 * @param hrefOf   where each page is served, from `summarisePages`
 * @param authorOf what this reader is sent instead of the address — `server.ts`'s
 *                 `authorDisplaysFor`, docs/ROLES.md, "How a person appears". Defaults to the address
 *                 itself, today's behaviour, so a caller from before this setting existed — every
 *                 test in this file among them — keeps seeing exactly what it always saw.
 */
export function requestsInProgress(
  events: Event[], stateOf: (request: Event) => string, hrefOf: Map<string, string>,
  authorOf: (email: string) => string = (email) => email,
): RequestRow[] {
  const rows: RequestRow[] = [];
  for (const e of events) {
    if (e.type !== 'request') continue;
    const state = stateOf(e);
    if (SETTLED.includes(state)) continue;
    const page = hrefOf.get(e.page) ?? null;
    rows.push({
      id: e.id, page: e.page, block: e.block ?? null,
      href: page && e.block ? `${page}#${encodeURIComponent(e.block)}` : page,
      state, category: typeof e.data?.category === 'string' ? e.data.category : null,
      author: authorOf(e.author), when: e.when, text: e.text ?? '',
    });
  }
  return rows.sort((a, b) => a.when.localeCompare(b.when));
}

/** Everything a request row says, cut to a length a table can hold. The page has the rest. */
const excerpt = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** The keys this screen reads, for the test that checks every dictionary has them. */
export const HOME_KEYS = [
  'home.title', 'home.lede', 'home.light.valid', 'home.light.stale', 'home.light.broken',
  'home.light.none', 'home.pages.heading', 'home.pages.empty', 'home.pages.page',
  'home.pages.awaitingSync', 'home.requests.heading', 'home.requests.empty', 'home.requests.state',
  'home.requests.where', 'home.requests.what', 'home.requests.who', 'home.requests.decide',
  'home.triage.decision', 'home.triage.choose', 'home.triage.reason', 'home.triage.note', 'home.triage.submit', 'home.triage.why', 'home.triage.done', 'home.ask.heading',
  'home.ask.lede', 'home.ask.near', 'home.ask.what', 'home.ask.submit', 'home.ask.done',
] as const;

/**
 * What the home's forms have to say after a submission: that it went through, or the server's
 * refusal — for "ask for a page" with what the person typed kept, so a rejected text is not a lost
 * one; for a triage decision, with the request it was about.
 */
export interface HomeOutcome {
  asked?: boolean; problem?: string; draft?: string; near?: string;
  decided?: boolean; triage?: { problem: string; request: string; reason?: string };
}

/**
 * The ids of the two sections a form's answer lands on. The server redirects to them by fragment,
 * so both read them from here: written twice, a renamed heading would leave the redirect pointing at
 * nothing, and the home reopening at the top, which is the one thing the fragment is there to stop.
 */
export const HOME_SECTION = { ask: 'home-ask', requests: 'home-requests' } as const;

/**
 * The home screen in one language.
 *
 * Every value that came from outside — a page title, a request's text, an author — goes through
 * `forHtml`. A request's text is typed by any reviewer, and this screen shows it to the owner.
 */
export function renderHomePage(
  i18n: Translator, lang: string,
  data: {
    projectName: string; pages: PageSummary[]; requests: RequestRow[]; canManagePeople: boolean;
    /** `features.pageRequests` (docs/ROLES.md, section 7). Off, the form disappears — the server
     *  still refuses a `category: "page"` request posted straight at the API (`server.ts`), so
     *  this is decoration, not the guard. Defaults to true: every caller from before this toggle
     *  existed, and every unit test that does not pass it, keeps seeing the form it always saw. */
    pageRequestsEnabled?: boolean;
    ask?: HomeOutcome;
  },
  theme: Theme, nonce: string,
): string {
  const t = (key: string) => forHtml(i18n.t(lang, key));
  const ask = data.ask ?? {};
  const total = { valid: 0, stale: 0, broken: 0, none: 0 };
  for (const p of data.pages) for (const s of STATES) total[s] += p.tally[s];

  // Red first, then yellow: the states that ask for something, in the order of how badly.
  const lights = STATES.map((s) =>
    `<li class="home-light"><span aria-hidden="true">${COLOURS[s]}</span> <strong>${total[s]}</strong> `
    + `${t(`home.light.${s}`)}</li>`).join('');

  const pageRows = data.pages.map((p) => {
    const cells = STATES.map((s) =>
      `<td class="holdrim-table__num" title="${t(`home.light.${s}`)}">${p.tally[s] ? `${COLOURS[s]} ${p.tally[s]}` : ''}</td>`).join('');
    const awaiting = p.awaitingSync
      ? ` <span class="holdrim-faint">· ${p.awaitingSync} ${t('home.pages.awaitingSync')}</span>` : '';
    return `<tr><td><a href="${forHtml(p.href)}"><span class="holdrim-code">${forHtml(p.page)}</span> `
      + `${forHtml(p.title)}</a>${awaiting}</td>${cells}</tr>`;
  }).join('\n');

  // Triage from here, for whoever may decide: one plain form per request, script-free like the rest
  // of this screen. The destinations are the cycle's (`status.triage`, the list the panel draws its
  // buttons from), and the server checks the decision again as if it came from the API — the reason
  // a refusal needs, whether the request can still go there, who is deciding.
  const deciding = data.requests.some((r) => r.triage?.length);
  const triageForm = (r: RequestRow) => {
    if (!r.triage?.length) return '';
    // A refusal shows on the row it was about, with what was typed kept: in a long queue, a
    // banner at the top leaves the owner guessing which decision did not go through.
    const refused = ask.triage?.request === r.id ? ask.triage : null;
    const options = r.triage.map((s) => `<option value="${forHtml(s)}">${t(`cycle.${s}`)}</option>`).join('');
    // Which decisions need a reason is the cycle's to say (`requires_reason`), so the hint names
    // them from it rather than repeating the list in a sentence that would drift from it.
    const needing = (r.requiresReason ?? []).map((s) => i18n.t(lang, `cycle.${s}`));
    // Said beside the field, not inside it: as a placeholder it would be cut off at "Why — needed
    // for: R" on every screen, and a placeholder is gone the moment somebody starts typing.
    const hintId = `why-${forHtml(r.id)}`;
    const hint = needing.length
      ? `<p class="holdrim-faint home-triage__hint" id="${hintId}">`
        + `${forHtml(i18n.t(lang, 'home.triage.reason', { states: needing.join(', ') }))}</p>`
      : '';
    const field = t(needing.length ? 'home.triage.why' : 'home.triage.note');
    return (refused ? `<p class="holdrim-alert holdrim-alert--danger" role="alert">${forHtml(refused.problem)}</p>` : '')
      + `<form method="post" action="${forHtml(HOME_SCREEN)}" class="home-triage">`
      + `<input type="hidden" name="action" value="triage">`
      + `<input type="hidden" name="request" value="${forHtml(r.id)}">`
      + `<input type="hidden" name="page" value="${forHtml(r.page)}">`
      + `<input type="hidden" name="block" value="${forHtml(r.block ?? '')}">`
      // No decision preselected: a form that arrives saying "Approved" approves on one careless
      // click. `required` on an empty first choice stops that in the browser, with no script.
      + `<select class="holdrim-input" name="state" required aria-label="${t('home.triage.decision')}">`
      + `<option value="" selected disabled>${t('home.triage.choose')}</option>${options}</select>`
      // A refusal is answered by drawing the home again at the address the form posted to, so no
      // fragment can carry the person to it: the field that needs fixing takes the focus instead,
      // and the browser scrolls it into view. Only one outcome is ever shown, so only one field.
      + `<input class="holdrim-input" name="reason" maxlength="${LIMITS.text}" placeholder="${field}" aria-label="${field}" `
      + `${refused ? 'autofocus ' : ''}`
      + `${hint ? `aria-describedby="${hintId}" ` : ''}value="${forHtml(refused?.reason ?? '')}">`
      + `<button class="holdrim-button" type="submit">${t('home.triage.submit')}</button>${hint}</form>`;
  };
  const requestRows = data.requests.map((r) => {
    const where = `${forHtml(r.block ?? r.page)}`;
    const link = r.href ? `<a href="${forHtml(r.href)}">${where}</a>` : where;
    const category = r.category ? ` <span class="holdrim-faint">· ${t(`cycle.category.${r.category}`)}</span>` : '';
    return `<tr><td>${t(`cycle.${r.state}`)}${category}</td><td>${link}</td>`
      + `<td>${forHtml(excerpt(r.text))}</td>`
      + `<td class="holdrim-muted">${forHtml(r.author)}<br>${forHtml(r.when.slice(0, 10))}</td>`
      + `${deciding ? `<td>${triageForm(r)}</td>` : ''}</tr>`;
  }).join('\n');

  // A plain form, posted to this same address: the page stays script-free, and the request is
  // recorded through the same function the API uses (`recordEvent` in server.ts). It hangs on an
  // existing page because a request needs one, and "near which page" is a question anybody can answer.
  const options = data.pages.map((p) =>
    `<option value="${forHtml(p.page)}"${p.page === ask.near ? ' selected' : ''}>${forHtml(p.page)} · ${forHtml(p.title)}</option>`).join('');
  const askForm = !data.pages.length || data.pageRequestsEnabled === false ? '' : `<section aria-labelledby="${HOME_SECTION.ask}">
    <h2 id="${HOME_SECTION.ask}">${t('home.ask.heading')}</h2>
    <p class="holdrim-muted">${t('home.ask.lede')}</p>
    ${ask.asked ? `<p class="holdrim-alert holdrim-alert--ok" role="status">${t('home.ask.done')}</p>` : ''}
    ${ask.problem ? `<p class="holdrim-alert holdrim-alert--danger" role="alert">${forHtml(ask.problem)}</p>` : ''}
    <form method="post" action="${forHtml(HOME_SCREEN)}" class="holdrim-stack home-ask">
      <label class="holdrim-field"><span class="holdrim-label">${t('home.ask.near')}</span>
        <select class="holdrim-input" name="page">${options}</select></label>
      <label class="holdrim-field"><span class="holdrim-label">${t('home.ask.what')}</span>
        <textarea class="holdrim-input" name="text" rows="4" required${ask.problem ? ' autofocus' : ''}>${forHtml(ask.draft ?? '')}</textarea></label>
      <p><button class="holdrim-button holdrim-button--primary" type="submit">${t('home.ask.submit')}</button></p>
    </form>
  </section>`;

  const head = STATES.map((s) => `<th class="holdrim-table__num" scope="col"><span aria-hidden="true">${COLOURS[s]}</span>`
    + `<span class="holdrim-visually-hidden">${t(`home.light.${s}`)}</span></th>`).join('');

  return `<!doctype html>
<html lang="${forHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${t('home.title')} · ${forHtml(data.projectName)}</title>
<style nonce="${forHtml(nonce)}">
${BASE_CSS}
${themeCss(theme)}
.home-ask { margin-top: var(--holdrim-space-4); }
.home-triage { display: flex; flex-wrap: wrap; gap: var(--holdrim-space-2); align-items: center; }
.home-triage .holdrim-input { width: auto; min-width: 10rem; }
.home-triage input.holdrim-input { flex: 1 1 16rem; }
.home-triage__hint { flex-basis: 100%; margin: 0; font-size: .85rem; }
.home-lights { display: flex; flex-wrap: wrap; gap: var(--holdrim-space-4); list-style: none; padding: 0; margin: var(--holdrim-space-4) 0 0; }
.home-light { background: var(--holdrim-surface-raised); border: 1px solid var(--holdrim-line); border-radius: var(--holdrim-radius-md); padding: var(--holdrim-space-3) var(--holdrim-space-4); }
/* Two by two on a phone: one card per row would push the pages, the reason anybody opens this
   screen, below the fold. The width is base.css's phone breakpoint, which cannot be a custom
   property. */
@media (max-width: 40rem) { .home-lights { display: grid; grid-template-columns: 1fr 1fr; gap: var(--holdrim-space-3); } }
</style>
</head>
<body class="holdrim-screen">
<main class="holdrim-screen__main">
  <header class="holdrim-screen__head">
    <div class="holdrim-brandmark">${brandmark(theme)}</div>
    ${engineNav(i18n, lang, 'home', data.canManagePeople)}
  </header>
  <h1 class="holdrim-title">${t('home.title')}</h1>
  <p class="holdrim-lede">${t('home.lede')}</p>
  <ul class="home-lights">${lights}</ul>

  <section aria-labelledby="home-pages">
    <h2 id="home-pages">${t('home.pages.heading')}</h2>
    ${data.pages.length ? `<table class="holdrim-table">
      <thead><tr><th scope="col">${t('home.pages.page')}</th>${head}</tr></thead>
      <tbody>
${pageRows}
      </tbody>
    </table>` : `<p class="holdrim-muted">${t('home.pages.empty')}</p>`}
  </section>

  ${askForm}

  <section aria-labelledby="${HOME_SECTION.requests}">
    <h2 id="${HOME_SECTION.requests}">${t('home.requests.heading')}</h2>
    ${ask.decided ? `<p class="holdrim-alert holdrim-alert--ok" role="status">${t('home.triage.done')}</p>` : ''}
    ${data.requests.length ? `<table class="holdrim-table holdrim-table--stack">
      <thead><tr><th scope="col">${t('home.requests.state')}</th><th scope="col">${t('home.requests.where')}</th>`
      + `<th scope="col">${t('home.requests.what')}</th><th scope="col">${t('home.requests.who')}</th>`
      + `${deciding ? `<th scope="col">${t('home.requests.decide')}</th>` : ''}</tr></thead>
      <tbody>
${requestRows}
      </tbody>
    </table>` : `<p class="holdrim-muted">${t('home.requests.empty')}</p>`}
  </section>
</main>
</body>
</html>
`;
}
