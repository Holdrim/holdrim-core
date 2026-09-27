import { BASE_CSS, brandmark, forHtml, type Translator } from './login-page.ts';
import { themeCss, type Theme } from './theme.ts';
import { engineNav } from './people-page.ts';
import { SETTINGS_SCREEN } from '../core/screens.js';
import {
  CAPABILITIES, AGENT_NEVER, SHIPPED_ROLES, capabilitiesOf, isValidScope, parseLocks, lockCoverage,
  refuseGrantsToAgents, type createRoles,
} from '../core/roles.js';
import { PEOPLE_SHOW_VALUES } from '../core/people-show.js';

/**
 * The settings screen (`/engine/settings`, issue #36): who holds what in this deployment, where each
 * answer comes from, and what to set to change it. The owner's alone, and READ-ONLY on purpose.
 *
 * Every source of authority it shows is the deployment's — `HOLDRIM_OWNER`, `HOLDRIM_ADMINS`,
 * `HOLDRIM_AGENTS`, `HOLDRIM_LOCKS` — and none of them may be set from a screen (docs/ROLES.md,
 * "Authority comes from the deployment only"). So the one form here, the lock-grant composer, writes
 * nothing: it answers with the line to set where Holdrim runs, checked by the same functions start
 * runs on that variable, so a line this screen hands out is one the service boots with. A composer
 * that stored the grant instead would be a second source of `lock`, reachable by whoever gets a
 * session as the owner — the forgery docs/ROLES.md section 3 exists to close.
 *
 * ## No script
 *
 * The composer is a plain form posted back to this address, and the page carries no script at
 * all: its policy (`screenPolicy(nonce, { script: false })`) runs nothing, and the one style block
 * carries the response's nonce. A POST although composing changes nothing: as a GET, the address
 * typed would travel in the URL, and stay in the browser's history and in any proxy's access log.
 */

type Roles = ReturnType<typeof createRoles>;

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
