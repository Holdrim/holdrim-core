import type { AgentToken, User } from './users.ts';
import { BASE_CSS, brandmark, forHtml, type Translator } from './login-page.ts';
import { themeCss, type Theme } from './theme.ts';
import { HOME_SCREEN, PEOPLE_SCREEN } from '../core/screens.js';

/**
 * Who can get in, managed from the browser: create an access, hand out a new password, take an
 * access away and give it back.
 *
 * The routes behind it (`userRoutes` in server.ts) stand without the screen, and every rule that
 * matters is enforced THERE — nobody but the owner creates or resets the owner's account, the owner
 * cannot be disabled, a password is said once. This screen only decides which buttons to draw, and
 * drawing one too many is harmless: the server answers 409 and the screen shows why. Hiding a button
 * is courtesy; refusing the request is security, and the second one does not live here.
 *
 * ## Why a script here, and not on the home
 *
 * The home's actions are plain forms posted back to it. This screen's routes speak JSON, so the
 * page carries one small script — with this response's nonce, like the sign-in page's, under a
 * policy that runs nothing else. Without JavaScript the list still renders; the buttons do nothing.
 *
 * ## Agent tokens
 *
 * Below the people, the agents holding a token (docs/ROLES.md, section 4): who, and when it was
 * issued. Only the owner is offered to issue or revoke one, because only the owner may (`userRoutes`,
 * server.ts); anybody else who manages people sees the list and no button. A token appears in the
 * same once-box as a password, for the same reason, and is never part of the list: the server has no
 * way to give one back.
 *
 * ## The password, once
 *
 * A generated password comes back in the body of the request that generated it, and nowhere else.
 * The script puts it on the screen, in a box that says so, and never in the URL, the title, storage
 * or the console. A reload loses it, on purpose: that is what "once" means.
 */

type Role = 'owner' | 'admin' | 'member';

/** The keys this screen reads, for the test that checks every dictionary has them. */
export const PEOPLE_KEYS = [
  'people.title', 'people.lede', 'people.name', 'people.email', 'people.role', 'people.state',
  'people.role.owner', 'people.role.admin', 'people.role.member', 'people.state.active',
  'people.state.mustChange', 'people.state.disabled', 'people.create.heading', 'people.create.submit',
  'people.reset', 'people.disable', 'people.enable', 'people.confirm.reset', 'people.confirm.disable',
  'people.onceNew',
  'people.agents.heading', 'people.agents.lede', 'people.agents.address', 'people.agents.issuedAt',
  'people.agents.none', 'people.agents.issue', 'people.agents.revoke', 'people.agents.confirm.revoke',
  'people.agents.once',
  'people.once', 'people.noAnswer', 'people.warn.sessionsNotDropped', 'people.warn.sessionsNotDropped.reset',
  'nav.home', 'nav.people',
] as const;

/**
 * The two engine screens, linked to each other. `People` only for whoever may manage people: a
 * link to a screen that answers "you may not" is a door painted on a wall.
 */
export function engineNav(i18n: Translator, lang: string, current: 'home' | 'people', canManage: boolean): string {
  const link = (key: 'home' | 'people', href: string) => key === current
    ? `<a href="${href}" aria-current="page">${forHtml(i18n.t(lang, `nav.${key}`))}</a>`
    : `<a href="${href}">${forHtml(i18n.t(lang, `nav.${key}`))}</a>`;
  return `<nav class="holdrim-nav">${link('home', HOME_SCREEN)}`
    + `${canManage ? link('people', PEOPLE_SCREEN) : ''}</nav>`;
}

/**
 * What may be offered on one row. The owner's row offers nothing: their password is theirs to change
 * on the sign-in screen, and they cannot be disabled. The server enforces both anyway; see above.
 *
 * Takes `isOwner` as a plain boolean, never the display `Role`: being the owner is an identity, not
 * one of the capabilities a role can hold, and comparing a role's NAME here is exactly the pattern
 * `engine/tests/roles-boundary.test.js` refuses outside `engine/core/roles.js`.
 */
export function actionsFor(person: User, isOwner: boolean): ('reset' | 'disable' | 'enable')[] {
  if (isOwner) return [];
  return ['reset', person.enabled ? 'disable' : 'enable'];
}

/**
 * The screen in one language, for someone who may manage people.
 *
 * @param roleOf  the DISPLAY role each address holds, for the column and the sort order only
 * @param isOwner whether an address is the owner — from `createRoles.isOwner`, never derived by
 *                comparing `roleOf`'s result: see `actionsFor`
 */
export function renderPeoplePage(
  i18n: Translator, lang: string,
  data: {
    projectName: string; people: User[]; roleOf: (email: string) => Role; isOwner: (email: string) => boolean;
    agents: AgentToken[]; viewerIsOwner: boolean;
  },
  theme: Theme, nonce: string,
): string {
  const t = (key: string, params?: Record<string, string | number>) => forHtml(i18n.t(lang, key, params));

  // The owner first, then admins, then everyone else; by name within each.
  const rank: Record<Role, number> = { owner: 0, admin: 1, member: 2 };
  const people = [...data.people].sort((a, b) =>
    rank[data.roleOf(a.email)] - rank[data.roleOf(b.email)] || a.name.localeCompare(b.name));

  const rows = people.map((p) => {
    const role = data.roleOf(p.email);
    const state = !p.enabled ? 'disabled' : p.mustChangePassword ? 'mustChange' : 'active';
    const buttons = actionsFor(p, data.isOwner(p.email)).map((a) =>
      `<button type="button" class="holdrim-button holdrim-button--quiet" data-action="${a}" `
      + `data-email="${forHtml(p.email)}">${t(`people.${a}`)}</button>`).join(' ');
    return `<tr${p.enabled ? '' : ' class="people-off"'}><td>${forHtml(p.name)}</td><td>${forHtml(p.email)}</td>`
      + `<td>${t(`people.role.${role}`)}</td><td>${t(`people.state.${state}`)}</td><td>${buttons}</td></tr>`;
  }).join('\n');

  // When a token was issued, as the store wrote it, to the minute and in UTC: the same instant for
  // every reader whatever their locale, with nothing a browser has to compute.
  const issued = (at: string) => `<time datetime="${forHtml(at)}">${forHtml(at.slice(0, 16).replace('T', ' '))} UTC</time>`;
  const agentRows = data.agents.map((a) => `<tr><td>${forHtml(a.email)}</td><td>${issued(a.issuedAt)}</td><td>`
    + (data.viewerIsOwner
      ? `<button type="button" class="holdrim-button holdrim-button--quiet" data-action="revoke" `
        + `data-email="${forHtml(a.email)}">${t('people.agents.revoke')}</button>`
      : '')
    + '</td></tr>').join('\n');
  const agentList = data.agents.length === 0 ? `<p>${t('people.agents.none')}</p>`
    : `<table class="holdrim-table holdrim-table--stack">
    <thead><tr><th scope="col">${t('people.agents.address')}</th><th scope="col">${t('people.agents.issuedAt')}</th>`
    + `<th scope="col"></th></tr></thead>
    <tbody>
${agentRows}
    </tbody>
  </table>`;
  // Only the owner gets the form; the route refuses everybody else, and a form that can only fail is
  // a form nobody should be shown.
  const issueForm = !data.viewerIsOwner ? '' : `
    <form id="issue" class="people-create">
      <label class="holdrim-field"><span class="holdrim-label">${t('people.agents.address')}</span>
        <input class="holdrim-input" name="email" type="email" required autocomplete="off"></label>
      <button class="holdrim-button holdrim-button--primary" type="submit">${t('people.agents.issue')}</button>
    </form>`;

  // Everything the script says, handed over as data. `<` is escaped so a translation containing
  // `</script>` cannot close the tag it lives in — the same guard the sign-in page uses.
  const texts = Object.fromEntries(['people.confirm.reset', 'people.confirm.disable', 'people.once', 'people.onceNew',
    'people.agents.once', 'people.agents.confirm.revoke',
    'people.noAnswer', 'people.reset', 'people.warn.sessionsNotDropped', 'people.warn.sessionsNotDropped.reset']
    .map((k) => [k, i18n.t(lang, k)]));

  return `<!doctype html>
<html lang="${forHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${t('people.title')} · ${forHtml(data.projectName)}</title>
<style nonce="${forHtml(nonce)}">
${BASE_CSS}
${themeCss(theme)}
.people-off td { color: var(--holdrim-ink-faint); }
.people-create { display: flex; flex-wrap: wrap; gap: var(--holdrim-space-3); align-items: flex-end; }
#once code { font-family: var(--holdrim-font-mono); font-size: var(--holdrim-text-body); user-select: all; }
</style>
</head>
<body class="holdrim-screen">
<main class="holdrim-screen__main">
  <header class="holdrim-screen__head">
    <div class="holdrim-brandmark">${brandmark(theme)}</div>
    ${engineNav(i18n, lang, 'people', true)}
  </header>
  <h1 class="holdrim-title">${t('people.title')}</h1>
  <p class="holdrim-lede">${t('people.lede')}</p>

  <div id="once" class="holdrim-alert holdrim-alert--warn" role="status" hidden></div>
  <p id="error" class="holdrim-alert holdrim-alert--danger" role="alert" hidden></p>

  <table class="holdrim-table holdrim-table--stack">
    <thead><tr><th scope="col">${t('people.name')}</th><th scope="col">${t('people.email')}</th>`
    + `<th scope="col">${t('people.role')}</th><th scope="col">${t('people.state')}</th><th scope="col"></th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <section aria-labelledby="people-create">
    <h2 id="people-create">${t('people.create.heading')}</h2>
    <form id="create" class="people-create">
      <label class="holdrim-field"><span class="holdrim-label">${t('people.name')}</span>
        <input class="holdrim-input" name="name" required maxlength="120" autocomplete="off"></label>
      <label class="holdrim-field"><span class="holdrim-label">${t('people.email')}</span>
        <input class="holdrim-input" name="email" type="email" required autocomplete="off"></label>
      <button class="holdrim-button holdrim-button--primary" type="submit">${t('people.create.submit')}</button>
    </form>
  </section>

  <section aria-labelledby="people-agents">
    <h2 id="people-agents">${t('people.agents.heading')}</h2>
    <p class="holdrim-lede">${t('people.agents.lede')}</p>
  ${agentList}${issueForm}
  </section>
</main>
<script nonce="${forHtml(nonce)}">
(() => {
  const TEXTS = ${JSON.stringify(texts).replace(/</g, '\\u003c')};
  const say = (key, params = {}) => TEXTS[key].replace(/\\{(\\w+)\\}/g, (m, k) => params[k] ?? m);
  const once = document.getElementById('once');
  const error = document.getElementById('error');

  function fail(message) { error.textContent = message; error.hidden = false; return null; }

  // Null unless the server answered AND said something readable. A 200 whose body cannot be parsed
  // is not a success with nothing in it: read as one, it would show a blank password under "shown
  // this once" — the one answer that must never be empty.
  async function post(path, body) {
    error.hidden = true;
    let r, data;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body) });
      data = await r.json();
    } catch {
      return fail(say('people.noAnswer'));
    }
    if (!r.ok) return fail(data.error || say('people.noAnswer'));
    return data;
  }

  // The password goes into a text node, never into markup: it is generated, but it is still text.
  // A new access also says when it joins the list, which stays as it is so the password is not
  // lost to a reload; a reset is for somebody the list already shows, and saying it there is false.
  function showOnce(email, password, created = false, key = 'people.once') {
    once.replaceChildren(document.createTextNode(say(key, { email }) + ' '));
    const code = document.createElement('code');
    code.textContent = password;
    once.append(code);
    if (created) once.append(document.createTextNode(' ' + say('people.onceNew')));
    once.hidden = false;
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, email } = button.dataset;
    // An agent's token, not a person's access: its own route, and a redraw, since the row goes away.
    if (action === 'revoke') {
      if (!confirm(say('people.agents.confirm.revoke', { email }))) return;
      if (await post('/api/agent-tokens/' + encodeURIComponent(email) + '/revoke', {})) location.reload();
      return;
    }
    const path = '/api/users/' + encodeURIComponent(email);
    if (action === 'reset') {
      if (!confirm(say('people.confirm.reset', { email }))) return;
      const data = await post(path + '/password', {});
      if (!data) return;
      data.password ? showOnce(email, data.password) : fail(say('people.noAnswer'));
      // The credential change went through regardless — \`data.password\` above already said so.
      // This is a SEPARATE warning: the old sessions might still be alive, which \`alert\` states
      // plainly rather than folding into the "once" box that is about the new password, not this.
      // Its OWN key, not the disable branch's below: running reset again is exactly how this drop
      // gets retried, so telling somebody to reset again is the right advice here — the wrong one
      // on the other branch, where the equivalent retry is what brings the sessions back.
      if (data.sessionsDropped === false) alert(say('people.warn.sessionsNotDropped.reset', { email }));
    } else {
      if (action === 'disable' && !confirm(say('people.confirm.disable', { email }))) return;
      const data = await post(path + '/enabled', { enabled: action === 'enable' });
      if (!data) return;
      // Not the reset branch's wording above: on a disabled row the obvious retry is
      // enable-then-disable, and the enable half of that is exactly what brings back the sessions
      // this warns about. So this message says not to take that retry, and points at Reset
      // instead — a reset drops them again, the same way the other branch's does.
      if (data.sessionsDropped === false) {
        alert(say('people.warn.sessionsNotDropped', { email, action: TEXTS['people.reset'] }));
      }
      location.reload();
    }
  });

  document.getElementById('create').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    // Through \`form.elements\`: \`form.name\` would work too, because a form lets a field shadow its
    // own \`name\` property, but it reads like the form's name, and the next reader would "fix" it.
    const field = (n) => form.elements.namedItem(n).value;
    const data = await post('/api/users', { email: field('email'), name: field('name') });
    if (!data) return;
    if (!data.password || !data.user) return fail(say('people.noAnswer'));
    // The list is redrawn by the server on the next load; until then the password is what matters.
    form.reset();
    showOnce(data.user.email, data.password, true);
  });

  // Absent for anybody but the owner, like the route behind it.
  document.getElementById('issue')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = await post('/api/agent-tokens', { email: form.elements.namedItem('email').value });
    if (!data) return;
    // The same rule as a password: an answer with no token is reported, never shown as a blank one.
    if (!data.token || !data.agent) return fail(say('people.noAnswer'));
    form.reset();
    // Not redrawn: a reload would lose the token, and this is the only moment it can be copied.
    showOnce(data.agent.email, data.token, false, 'people.agents.once');
  });
})();
</script>
</body>
</html>
`;
}
