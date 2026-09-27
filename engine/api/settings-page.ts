import { BASE_CSS, brandmark, forHtml, type Translator } from './login-page.ts';
import { themeCss, type Theme } from './theme.ts';
import { engineNav } from './people-page.ts';
import { SETTINGS_SCREEN } from '../core/screens.js';
import {
  CAPABILITIES, AGENT_NEVER, SHIPPED_ROLES, PROJECT_CAPABILITIES, MAX_ROLE_NAME, capabilitiesOf, isValidScope,
  parseLocks, lockCoverage, refuseGrantsToAgents, type Roles,
} from '../core/roles.js';
import { PEOPLE_SHOW_VALUES } from '../core/people-show.js';

/**
 * The settings screen (`/engine/settings`, issue #36): who holds what in this deployment, where each
 * answer comes from, what to set to change it, and the project's own roles. The owner's alone.
 *
 * Two kinds of authority, told apart on purpose. The deployment's — `HOLDRIM_OWNER`,
 * `HOLDRIM_ADMINS`, `HOLDRIM_AGENTS`, `HOLDRIM_LOCKS` — is only SHOWN here: none of it may be set from
 * a screen (docs/ROLES.md, "Authority comes from the deployment only"). So the lock-grant composer
 * writes nothing: it answers with the line to set where Holdrim runs, checked by the same functions
 * start runs on that variable, so a line this screen hands out is one the service boots with. A
 * composer that stored the grant instead would be a second source of `lock`, reachable by whoever
 * gets a session as the owner — the forgery docs/ROLES.md section 3 exists to close.
 *
 * The project's own roles are the owner's to define and grant from here (docs/ROLES.md, section 5):
 * each form writes one event on `_roles`, through the function its API route calls, and none of
 * them can reach `lock` or `people` (`PROJECT_CAPABILITIES`).
 *
 * ## No script
 *
 * Every form is a plain form posted back to this address, and the page carries no script at all:
 * its policy (`screenPolicy(nonce, { script: false })`) runs nothing, and the one style block carries
 * the response's nonce. A POST even to compose, which changes nothing: as a GET, the address typed
 * would travel in the URL, and stay in the browser's history and in any proxy's access log.
 */

/** A `HOLDRIM_LOCKS` entry, as `parseLocks` returns it. */
export interface LockEntry { email: string; scope: string }

/** The composer's refusals — each a sentence in every dictionary, so none reaches the page raw. */
const COMPOSE_ERRORS = [
  'settings.compose.error.characters', 'settings.compose.error.quote', 'settings.compose.error.scope', 'settings.compose.error.email', 'settings.compose.error.present',
  'settings.compose.error.nothing', 'settings.compose.error.agent',
] as const;
type ComposeError = typeof COMPOSE_ERRORS[number];

/** What the composer answers: the whole line to set, or which check refused, and why. */
export type Composed =
  | { line: string; entry: LockEntry; reaches: string[] }
  | { error: ComposeError; params?: Record<string, string> };

/** The keys this screen reads, for the test that checks every dictionary has them. */
export const SETTINGS_KEYS = [
  'settings.title', 'settings.lede',
  'settings.roles.heading', 'settings.roles.lede', 'settings.roles.capability', 'settings.roles.yes',
  'settings.roles.no', 'settings.roles.lockNever', 'settings.roles.agents',
  ...CAPABILITIES.map((c: string) => `settings.capability.${c}`),
  'settings.holders.heading', 'settings.holders.lede', 'settings.holders.owner', 'settings.holders.admins',
  'settings.holders.agents', 'settings.holders.locks', 'settings.holders.who', 'settings.holders.source',
  'settings.holders.scope', 'settings.holders.reaches', 'settings.holders.none', 'settings.holders.lockNotRead',
  'settings.compose.heading', 'settings.compose.lede', 'settings.compose.email', 'settings.compose.scope',
  'settings.compose.submit', 'settings.compose.result', 'settings.compose.reaches', 'settings.compose.restart',
  ...COMPOSE_ERRORS,
  'settings.project.heading', 'settings.project.lede', 'settings.project.setting', 'settings.project.value',
  'settings.project.source', 'settings.project.default', 'settings.project.snippet', 'settings.project.peopleShow',
  'people.role.owner', 'people.role.admin', 'people.role.member',
  'settings.projectRoles.heading', 'settings.projectRoles.lede', 'settings.projectRoles.role', 'settings.projectRoles.holds',
  'settings.projectRoles.defined', 'settings.projectRoles.none', 'settings.projectRoles.name', 'settings.projectRoles.nameHint',
  'settings.projectRoles.submit', 'settings.projectRoles.never', 'settings.projectRoles.done',
  'settings.grants.heading', 'settings.grants.lede', 'settings.grants.who', 'settings.grants.role', 'settings.grants.scope',
  'settings.grants.given', 'settings.grants.everywhere', 'settings.grants.none', 'settings.grants.ignored',
  'settings.grants.revoke', 'settings.grants.email', 'settings.grants.scopeHint', 'settings.grants.submit',
  'settings.grants.defineFirst', 'settings.grants.ended', 'settings.grants.granted', 'settings.grants.revoked',
  'api.roles.nameInvalid', 'api.roles.capabilitiesInvalid', 'api.users.emailInvalid', 'api.grants.scopeInvalid',
  'api.grants.notForTheOwner', 'api.grants.notForAnAdmin', 'api.grants.notForAnAgent', 'api.grants.roleUnknown',
  'api.grants.present', 'api.grants.notFound', 'api.grants.alreadyRevoked',
];

/** `HOLDRIM_LOCKS`'s value for these entries: `;`-separated, as `parseLocks` splits it. */
export function locksValue(entries: readonly LockEntry[]): string {
  return entries.map((e) => `${e.email}:${e.scope}`).join('; ');
}

/**
 * The characters an address may carry into the composed line: letters, digits and `._%+-` before the
 * `@`, letters, digits and `.-` after it. Narrower than `parseLocks` on purpose, and only here: the
 * line is meant to be pasted where Holdrim runs, often a file a shell reads, and an address made of
 * these alone reads the same to every shell and every env-file parser. Start itself stays as lenient
 * as it is — this decides what the screen hands out, not what the service accepts.
 */
const LINE_SAFE_LOCAL = /^[A-Za-z0-9._%+-]*$/;
const LINE_SAFE_DOMAIN = /^[A-Za-z0-9.-]*$/;

/**
 * Whether every character of `address` is one the line may carry, on its side of the first `@`. The
 * SHAPE of an address — empty, no `@`, a trailing dot — is not asked here but of `parseLocks` below,
 * so a mistyped address is told it is not one, not that its characters are wrong.
 */
function lineSafe(address: string): boolean {
  const at = address.indexOf('@');
  if (at === -1) return LINE_SAFE_LOCAL.test(address);
  return LINE_SAFE_LOCAL.test(address.slice(0, at)) && LINE_SAFE_DOMAIN.test(address.slice(at + 1));
}

/**
 * The lock-grant composer: the current `HOLDRIM_LOCKS` entries plus the one asked for, as the full
 * line to set — or the reason the service would refuse it. Pure, and it writes nothing.
 *
 * Each check is the one start runs, never a copy of it: the scope by `isValidScope`, the address by
 * `parseLocks` itself (its stricter address rule is not exported, and a second copy of it here would
 * be one more place for the two to drift), a scope that reaches no page of this site by
 * `lockCoverage`, as start refuses one, and an address `HOLDRIM_AGENTS` marks by
 * `refuseGrantsToAgents`, over the whole line, as `rolesOf` does. Without those last two, the screen
 * would hand the owner a line the service then refuses to start with.
 *
 * Before any of those, the address's characters (`lineSafe`), which also keeps `;` and `:` out of it,
 * so `parseLocks` can only ever read one entry back. Then the scope before the address, because
 * `parseLocks` answers both in one throw: once the scope is known good, a throw from it can only be
 * about the address.
 *
 * An entry already present — the same address AND the same scope — is refused rather than repeated.
 * The same address with another scope is a second entry, which `parseLocks` accepts: one person may
 * hold `lock` over two families.
 */
export function composeLock(
  existing: readonly LockEntry[], asked: { email: string; scope: string },
  blockIds: Iterable<string>, roles: Roles,
): Composed {
  const email = asked.email.trim();
  if (!lineSafe(email)) return { error: 'settings.compose.error.characters' };
  const scope = asked.scope.trim();
  if (!isValidScope(scope)) return { error: 'settings.compose.error.scope' };
  let entry: LockEntry;
  try {
    [entry] = parseLocks(`${email}:${scope}`);
  } catch {
    return { error: 'settings.compose.error.email' };
  }
  if (existing.some((e) => e.email === entry.email && e.scope === entry.scope)) {
    return { error: 'settings.compose.error.present', params: { email: entry.email, scope } };
  }
  const [{ reaches }] = lockCoverage([entry], blockIds);
  if (reaches.length === 0) return { error: 'settings.compose.error.nothing', params: { scope } };
  const value = locksValue([...existing, entry]);
  // The line is single-quoted, and a `'` would end the quoting early. The typed address cannot carry
  // one (`lineSafe`), but the entries already set came from the deployment through `parseLocks`,
  // which accepts it — such a line is refused rather than handed out broken.
  if (value.includes("'")) return { error: 'settings.compose.error.quote' };
  try {
    refuseGrantsToAgents(roles, value);
  } catch {
    return { error: 'settings.compose.error.agent', params: { email: entry.email } };
  }
  // Single quotes: inside them a shell expands nothing, whatever the entries already set carry.
  return { line: `HOLDRIM_LOCKS='${value}'`, entry, reaches };
}

/** One of the screen's forms that writes: which, and what was typed into it. */
export type RoleAction = 'define' | 'grant' | 'revoke';

/** Everything the screen shows, resolved by the server; nothing here reads the environment. */
export interface SettingsData {
  projectName: string;
  /** Whether the People link belongs in the nav — `managesPeople`, and the screen switched on. */
  canManagePeople: boolean;
  /** Each person as the rest of the engine shows them to the owner (`personDisplay`, server.ts). */
  holders: {
    owner: string; admins: string[]; agents: string[];
    locks: { who: string; scope: string; reaches: string[] }[];
  };
  /** What was typed into the composer and what it answered, or nothing when nobody asked. */
  compose?: { email: string; scope: string; result: Composed };
  /**
   * The project's own roles as the `_roles` events add up to now (`projectRolesOf`): each role's
   * latest definition, and each grant in force with the person as the owner is shown them — or
   * their id, once forgotten — and whether it is ignored for naming an agent. `ended` counts the
   * revoked ones, which stay in the trail.
   */
  projectRoles: {
    roles: { role: string; capabilities: string[]; when: string }[];
    grants: { id: string; who: string; role: string; scope: string | null; when: string; ignored: boolean }[];
    ended: number;
  };
  /** A write that was refused: which form, the sentence's key, and what was typed, to put back. */
  edit?: {
    action: RoleAction; key: string; params?: Record<string, string | number>;
    values: { role: string; email: string; scope: string; capabilities: string[] };
  };
  /** A write that went through, on the redirect after it. */
  done?: RoleAction;
  features: Record<string, boolean>;
  peopleShow: string;
  /** Which of the two the project's `holdrim.json` names (`namedInFile`, engine/core/config.js). */
  namedInFile: { features: string[]; peopleShow: boolean };
}

/** The screen in one language, for the owner. */
export function renderSettingsPage(
  i18n: Translator, lang: string, data: SettingsData, theme: Theme, nonce: string,
): string {
  const t = (key: string, params?: Record<string, string | number>) => forHtml(i18n.t(lang, key, params));
  const code = (text: string) => `<code class="holdrim-code">${forHtml(text)}</code>`;
  const list = (items: string[]) => items.length
    ? `<ul class="settings-list">${items.map((i) => `<li>${forHtml(i)}</li>`).join('')}</ul>`
    : `<p class="holdrim-muted">${t('settings.holders.none')}</p>`;

  // Rows from `CAPABILITIES`, columns from `SHIPPED_ROLES`, cells from `capabilitiesOf` — the table
  // `can` reads, never a copy of it written here, so a capability or a role added to the engine
  // appears on this screen the same day.
  // `lock` gets no cells: no role holds it, and a row of "no" under the owner would read as though
  // the owner could not lock. What it gets instead is the sentence below the table.
  const shipped = SHIPPED_ROLES;
  const held = Object.fromEntries(shipped.map((r) => [r, capabilitiesOf(r)]));
  const roleRows = CAPABILITIES.filter((c: string) => c !== 'lock').map((c: string) => `<tr><th scope="row">`
    + `${code(c)} <span class="holdrim-muted">${t(`settings.capability.${c}`)}</span></th>`
    + shipped.map((r) => `<td class="settings-mark">${held[r].has(c)
      ? `<span aria-hidden="true">✓</span><span class="holdrim-visually-hidden">${t('settings.roles.yes')}</span>`
      : `<span aria-hidden="true">·</span><span class="holdrim-visually-hidden">${t('settings.roles.no')}</span>`}</td>`)
      .join('') + '</tr>').join('\n');

  const lockRows = data.holders.locks.map((l) => `<tr><td>${forHtml(l.who)}</td><td>${code(l.scope)}</td>`
    + `<td>${l.reaches.map((p) => code(p)).join(' ')}</td></tr>`).join('\n');
  const locks = data.holders.locks.length ? `<table class="holdrim-table holdrim-table--stack">
      <thead><tr><th scope="col">${t('settings.holders.who')}</th><th scope="col">${t('settings.holders.scope')}</th>`
    + `<th scope="col">${t('settings.holders.reaches')}</th></tr></thead>
      <tbody>
${lockRows}
      </tbody>
    </table>` : `<p class="holdrim-muted">${t('settings.holders.none')}</p>`;

  // What was typed goes back into the fields, escaped: a refused scope is the one the owner fixes,
  // and retyping it from nothing is how a second typo gets in.
  const asked = data.compose;
  const result = asked?.result;
  const answer = !result ? '' : 'error' in result
    ? `<p class="holdrim-alert holdrim-alert--danger" role="alert">${t(result.error, result.params)}</p>`
    : `<div class="holdrim-alert holdrim-alert--ok settings-answer" role="status">
      <p>${t('settings.compose.result')}</p>
      <pre class="settings-line"><code>${forHtml(result.line)}</code></pre>
      <p>${t('settings.compose.reaches', { pages: result.reaches.join(', ') })}</p>
      <p>${t('settings.compose.restart')}</p>
    </div>`;

  // The project's own roles. What was typed goes back into a refused form, as the composer's does.
  const edit = data.edit;
  const typed = (action: RoleAction) => (edit?.action === action ? edit.values : undefined);
  const refusal = (action: RoleAction) => (edit?.action === action
    ? `<p class="holdrim-alert holdrim-alert--danger" role="alert">${t(edit.key, edit.params)}</p>` : '');
  const confirmed = (actions: RoleAction[], key: string) => (data.done && actions.includes(data.done)
    ? `<p class="holdrim-alert holdrim-alert--ok" role="status">${t(key)}</p>` : '');
  const { roles: defined, grants, ended } = data.projectRoles;
  const definedRows = defined.map((d) => `<tr><td>${code(d.role)}</td>`
    + `<td>${d.capabilities.map((c) => code(c)).join(' ')}</td><td>${forHtml(d.when)}</td></tr>`).join('\n');
  const definedTable = defined.length ? `<table class="holdrim-table holdrim-table--stack">
      <thead><tr><th scope="col">${t('settings.projectRoles.role')}</th><th scope="col">${t('settings.projectRoles.holds')}</th>`
    + `<th scope="col">${t('settings.projectRoles.defined')}</th></tr></thead>
      <tbody>
${definedRows}
      </tbody>
    </table>` : `<p class="holdrim-muted">${t('settings.projectRoles.none')}</p>`;
  const defining = typed('define');
  const capabilityBoxes = PROJECT_CAPABILITIES.map((c: string) => `<label class="settings-check">`
    + `<input type="checkbox" name="capability" value="${forHtml(c)}"${defining?.capabilities.includes(c) ? ' checked' : ''}> `
    + `${code(c)} <span class="holdrim-muted">${t(`settings.capability.${c}`)}</span></label>`).join('\n');

  const grantRows = grants.map((g) => `<tr><td>${forHtml(g.who)}`
    + (g.ignored ? ` <span class="holdrim-alert holdrim-alert--warn settings-ignored">${t('settings.grants.ignored')}</span>` : '')
    + `</td><td>${code(g.role)}</td><td>${g.scope ? code(g.scope) : t('settings.grants.everywhere')}</td>`
    + `<td>${forHtml(g.when)}</td><td>`
    + `<form method="post" action="${forHtml(SETTINGS_SCREEN)}#settings-grants">`
    + `<input type="hidden" name="action" value="revoke"><input type="hidden" name="grant" value="${forHtml(g.id)}">`
    + `<button class="holdrim-button" type="submit">${t('settings.grants.revoke')}</button></form></td></tr>`).join('\n');
  const grantTable = grants.length ? `<table class="holdrim-table holdrim-table--stack">
      <thead><tr><th scope="col">${t('settings.grants.who')}</th><th scope="col">${t('settings.grants.role')}</th>`
    + `<th scope="col">${t('settings.grants.scope')}</th><th scope="col">${t('settings.grants.given')}</th>`
    + `<th scope="col"><span class="holdrim-visually-hidden">${t('settings.grants.revoke')}</span></th></tr></thead>
      <tbody>
${grantRows}
      </tbody>
    </table>` : `<p class="holdrim-muted">${t('settings.grants.none')}</p>`;
  const granting = typed('grant');
  const roleOptions = defined.filter((d) => d.capabilities.length).map((d) => `<option value="${forHtml(d.role)}"`
    + `${granting?.role === d.role ? ' selected' : ''}>${forHtml(d.role)}</option>`).join('');
  const grantForm = roleOptions ? `<form method="post" action="${forHtml(SETTINGS_SCREEN)}#settings-grants" class="settings-compose settings-grant">
      <input type="hidden" name="action" value="grant">
      <label class="holdrim-field"><span class="holdrim-label">${t('settings.grants.email')}</span>
        <input class="holdrim-input" name="email" type="email" required autocomplete="off" value="${forHtml(granting?.email ?? '')}"></label>
      <label class="holdrim-field"><span class="holdrim-label">${t('settings.grants.role')}</span>
        <select class="holdrim-input" name="role" required>${roleOptions}</select></label>
      <label class="holdrim-field"><span class="holdrim-label">${t('settings.grants.scope')}</span>
        <input class="holdrim-input" name="scope" autocomplete="off" spellcheck="false" aria-describedby="settings-grant-scope" value="${forHtml(granting?.scope ?? '')}"></label>
      <button class="holdrim-button holdrim-button--primary" type="submit">${t('settings.grants.submit')}</button>
    </form>
    <p id="settings-grant-scope" class="holdrim-muted">${t('settings.grants.scopeHint')}</p>`
    : `<p class="holdrim-muted">${t('settings.grants.defineFirst')}</p>`;

  const featureRows = Object.entries(data.features).map(([key, on]) => `<tr><td>${code(`features.${key}`)}</td>`
    + `<td>${code(String(on))}</td><td>${data.namedInFile.features.includes(key) ? code('holdrim.json') : t('settings.project.default')}</td></tr>`)
    .join('\n');
  const peopleRow = `<tr><td>${code('people.show')}</td><td>${code(data.peopleShow)}</td>`
    + `<td>${data.namedInFile.peopleShow ? code('holdrim.json') : t('settings.project.default')}</td></tr>`;
  // The current values, as the keys `holdrim.json` takes them: the owner edits the one that should
  // change and commits it. Every toggle is listed, not only those the file names, since the list is
  // closed and a key left out simply keeps its default.
  const snippet = JSON.stringify({ features: data.features, people: { show: data.peopleShow } }, null, 2);

  return `<!doctype html>
<html lang="${forHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${t('settings.title')} · ${forHtml(data.projectName)}</title>
<style nonce="${forHtml(nonce)}">
${BASE_CSS}
${themeCss(theme)}
.settings-list { margin: 0; padding-left: 1.2rem; }
.settings-mark { text-align: center; }
.settings-compose { display: flex; flex-wrap: wrap; gap: var(--holdrim-space-3); align-items: flex-end; }
.settings-line { margin: var(--holdrim-space-2) 0; padding: var(--holdrim-space-3); overflow-x: auto;
  background: var(--holdrim-surface-raised); border: 1px solid var(--holdrim-line); border-radius: var(--holdrim-radius-md); }
.settings-line code { font-family: var(--holdrim-font-mono); user-select: all; white-space: pre; }
.settings-answer p { margin: var(--holdrim-space-2) 0; }
.settings-caps { border: 0; margin: 0; padding: 0; display: grid; gap: var(--holdrim-space-2); }
.settings-check { display: flex; gap: var(--holdrim-space-2); align-items: baseline; }
.settings-ignored { display: inline-block; margin: var(--holdrim-space-2) 0 0; }
</style>
</head>
<body class="holdrim-screen">
<main class="holdrim-screen__main">
  <header class="holdrim-screen__head">
    <div class="holdrim-brandmark">${brandmark(theme)}</div>
    ${engineNav(i18n, lang, 'settings', data.canManagePeople, true)}
  </header>
  <h1 class="holdrim-title">${t('settings.title')}</h1>
  <p class="holdrim-lede">${t('settings.lede')}</p>

  <section aria-labelledby="settings-roles">
    <h2 id="settings-roles">${t('settings.roles.heading')}</h2>
    <p class="holdrim-muted">${t('settings.roles.lede')}</p>
    <table class="holdrim-table">
      <thead><tr><th scope="col">${t('settings.roles.capability')}</th>`
    + shipped.map((r) => `<th scope="col" class="settings-mark">${t(`people.role.${r}`)}</th>`).join('') + `</tr></thead>
      <tbody>
${roleRows}
      </tbody>
    </table>
    <p>${t('settings.roles.lockNever')}</p>
    <p>${t('settings.roles.agents', { capabilities: AGENT_NEVER.join(', ') })}</p>
  </section>

  <section aria-labelledby="settings-holders">
    <h2 id="settings-holders">${t('settings.holders.heading')}</h2>
    <p class="holdrim-muted">${t('settings.holders.lede')}</p>
    <h3>${t('settings.holders.owner')} · ${code('HOLDRIM_OWNER')}</h3>
    ${list([data.holders.owner])}
    <h3>${t('settings.holders.admins')} · ${code('HOLDRIM_ADMINS')}</h3>
    ${list(data.holders.admins)}
    <h3>${t('settings.holders.agents')} · ${code('HOLDRIM_AGENTS')}</h3>
    ${list(data.holders.agents)}
    <h3 id="settings-locks">${t('settings.holders.locks')} · ${code('HOLDRIM_LOCKS')}</h3>
    ${locks}
    <p class="holdrim-alert holdrim-alert--warn">${t('settings.holders.lockNotRead')}</p>
  </section>

  <section aria-labelledby="settings-project-roles">
    <h2 id="settings-project-roles">${t('settings.projectRoles.heading')}</h2>
    <p class="holdrim-muted">${t('settings.projectRoles.lede')}</p>
    ${confirmed(['define'], 'settings.projectRoles.done')}
    ${definedTable}
    ${refusal('define')}
    <form method="post" action="${forHtml(SETTINGS_SCREEN)}#settings-project-roles" class="settings-define">
      <input type="hidden" name="action" value="define">
      <label class="holdrim-field"><span class="holdrim-label">${t('settings.projectRoles.name')}</span>
        <input class="holdrim-input" name="role" required maxlength="${MAX_ROLE_NAME}" autocomplete="off" spellcheck="false" aria-describedby="settings-role-name" value="${forHtml(defining?.role ?? '')}"></label>
      <p id="settings-role-name" class="holdrim-muted">${t('settings.projectRoles.nameHint', { max: MAX_ROLE_NAME })}</p>
      <fieldset class="settings-caps"><legend class="holdrim-label">${t('settings.projectRoles.holds')}</legend>
${capabilityBoxes}
      </fieldset>
      <p><button class="holdrim-button holdrim-button--primary" type="submit">${t('settings.projectRoles.submit')}</button></p>
    </form>
    <p class="holdrim-muted">${t('settings.projectRoles.never')}</p>
  </section>

  <section aria-labelledby="settings-grants">
    <h2 id="settings-grants">${t('settings.grants.heading')}</h2>
    <p class="holdrim-muted">${t('settings.grants.lede')}</p>
    ${confirmed(['grant'], 'settings.grants.granted')}${confirmed(['revoke'], 'settings.grants.revoked')}
    ${grantTable}
    ${ended ? `<p class="holdrim-muted">${t('settings.grants.ended', { count: ended })}</p>` : ''}
    ${refusal('grant')}${refusal('revoke')}
    ${grantForm}
  </section>

  <section aria-labelledby="settings-compose">
    <h2 id="settings-compose">${t('settings.compose.heading')}</h2>
    <p class="holdrim-muted">${t('settings.compose.lede')}</p>
    ${answer}
    <form method="post" action="${forHtml(SETTINGS_SCREEN)}#settings-compose" class="settings-compose">
      <label class="holdrim-field"><span class="holdrim-label">${t('settings.compose.email')}</span>
        <input class="holdrim-input" name="email" type="email" required autocomplete="off" value="${forHtml(asked?.email ?? '')}"></label>
      <label class="holdrim-field"><span class="holdrim-label">${t('settings.compose.scope')}</span>
        <input class="holdrim-input" name="scope" required autocomplete="off" spellcheck="false" value="${forHtml(asked?.scope ?? '')}"></label>
      <button class="holdrim-button holdrim-button--primary" type="submit">${t('settings.compose.submit')}</button>
    </form>
  </section>

  <section aria-labelledby="settings-project">
    <h2 id="settings-project">${t('settings.project.heading')}</h2>
    <p class="holdrim-muted">${t('settings.project.lede')}</p>
    <table class="holdrim-table holdrim-table--stack">
      <thead><tr><th scope="col">${t('settings.project.setting')}</th><th scope="col">${t('settings.project.value')}</th>`
    + `<th scope="col">${t('settings.project.source')}</th></tr></thead>
      <tbody>
${featureRows}
${peopleRow}
      </tbody>
    </table>
    <p>${t('settings.project.snippet')}</p>
    <pre class="settings-line"><code>${forHtml(snippet)}</code></pre>
    <p class="holdrim-muted">${t('settings.project.peopleShow', { values: PEOPLE_SHOW_VALUES.join(', ') })}</p>
  </section>
</main>
</body>
</html>
`;
}
