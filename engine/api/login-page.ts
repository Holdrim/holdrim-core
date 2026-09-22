import { readFileSync } from 'node:fs';
import { MIN_PASSWORD_LENGTH } from './users.ts';
import { LANGUAGE_ROUTE } from './language.ts';
import { ENGINE_NAME, ENGINE_THEME, themeCss, type Theme } from './theme.ts';

/**
 * The login screen, with its sentences already inside it.
 *
 * ## Why the server renders, instead of the page fetching its own dictionary
 *
 * The page could have asked for `/api/texts` on load and filled itself in. It does not, for four
 * reasons, in order of how much they cost:
 *
 *   1. **No untranslated flash.** A page that arrives with `login.title` in the heading and fixes
 *      it a moment later shows a raw key to every person on a slow connection — on the one screen
 *      where someone who has never seen this tool decides whether it looks finished.
 *   2. **It works with no JavaScript.** Labels, button and `<title>` are plain HTML by the time
 *      they leave here. Only the change-password step, which is interaction anyway, needs script.
 *   3. **One round trip instead of two**, on the request that is always a cold start.
 *   4. **Less code.** No route, no cache header for it, no second thing that can 500.
 *
 * The cost is that the HTML is no longer a static file. It is one `String.replace` — accepted.
 *
 * ⚠️ The page is served with `cache-control: no-store` (see server.ts). That is not a detail here:
 * a cached login page is a page rendered in somebody else's language.
 */

/**
 * Everything the screen says. One list, and the test in engine/tests/i18n.test.js reads the
 * template to check that it still matches what the file actually uses — a hand-kept list is a list
 * that drifts, and a key that drifted shows up as `login.submit` on the button.
 */
export const LOGIN_KEYS = [
  'login.title',
  'login.subtitle',
  'login.form.label',
  'login.email.label',
  'login.email.placeholder',
  'login.password.label',
  'login.password.placeholder',
  'login.submit',
  'login.change.title',
  'login.change.subtitle',
  'login.change.new.label',
  'login.change.repeat.label',
  'login.change.submit',
  'login.error.signInFailed',
  'login.error.changeFailed',
  'login.error.passwordsDiffer',
  'login.error.noAnswer',
  'language.label',
] as const;

/** Read once: the template does not change while the process lives. */
const TEMPLATE = readFileSync(new URL('./login.html', import.meta.url), 'utf8');

/**
 * The engine's design system, inlined into this page.
 *
 * ⚠️ Inlined, not linked, and the reason is authentication rather than performance: everything
 * under `/engine/web/` is served by `serveStatic()`, which sits BEHIND the guard in server.ts. A
 * `<link href="/engine/web/base.css">` on the one page served without a session would be answered
 * with a redirect to that same page, and the login screen would arrive unstyled. The alternative —
 * opening a route so that the stylesheet can be fetched anonymously — is a second hole in the
 * authentication wall, punched to serve CSS.
 *
 * The same file still IS the shared one: the panel and every screen after it load it over HTTP.
 * There is one design system, read two ways, not two copies.
 */
export const BASE_CSS = readFileSync(new URL('../web/base.css', import.meta.url), 'utf8');

/**
 * Every key the page actually asks for: the double-brace placeholders in the markup, plus the
 * `say('…')` calls the script makes after the page is open. What the test compares against.
 *
 * ⚠️ The two halves both matter. A key only the script uses has no placeholder to find, and a key
 * only the markup uses is never named in the script — checking one half would have let the other
 * rot quietly.
 */
export function keysUsedByTemplate(): string[] {
  const found = new Set<string>();
  for (const [, name] of TEMPLATE.matchAll(/\{\{([^}#][^}]*)\}\}/g)) found.add(name!);
  for (const [, name] of TEMPLATE.matchAll(/\bsay\('([^']+)'\)/g)) found.add(name!);
  return [...found].sort();
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Escaped for HTML, including the quotes: half of these land inside an attribute (`placeholder`,
 * `aria-label`) and a translator who writes `"` in a sentence should not be able to end it.
 * Exported because every screen the engine renders itself uses it (see home-page.ts): one escaper,
 * so there is no second one that forgets the quotes.
 */
export const forHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/**
 * Only what `createI18n` actually offers, so a test can hand in a stub without building a server.
 */
export interface Translator {
  t(lang: string, key: string, params?: Record<string, string | number>): string;
  readonly languages: string[];
}

/**
 * The three buttons of the language selector.
 *
 * ⚠️ **A globe, never a flag.** A flag is a country, not a language. Spanish would have to fly
 * Spain's or Mexico's, English the United Kingdom's or the United States', Portuguese Portugal's
 * or Brazil's — and whichever one is chosen tells everyone who speaks that language somewhere
 * else that the tool was not built with them in mind. It is the classic i18n trap: it turns
 * picking a language into a claim about nationality. A globe belongs to nobody, and the name of
 * the language does the actual work.
 *
 * The name comes from each dictionary's own `language.name` — `es.json` says "Español", not
 * "Spanish". Somebody looking for their language scans for the word they would write themselves,
 * and a person who does not read the current interface language cannot be expected to recognise
 * their own language spelled in it. It also keeps the README's promise that adding a language is
 * copying one file: the list is read from the dictionaries, not kept here.
 *
 * Sorted by tag so the order is the same on every machine — `readdirSync` makes no such promise.
 */
function languageButtons(i18n: Translator, current: string): string {
  return [...i18n.languages].sort().map((tag) => {
    // `aria-current` and not `disabled`: the current language stays reachable by keyboard. A
    // disabled button is skipped by Tab, so someone navigating without a mouse would never find
    // out which language they are already in.
    const here = tag === current ? ' aria-current="true"' : '';
    return `<button type="submit" name="lang" value="${forHtml(tag)}" class="lang"${here}>`
      + `${forHtml(i18n.t(tag, 'language.name'))}</button>`;
  }).join('\n    ');
}

/**
 * Whose documentation this is — the first question the screen has to answer.
 *
 * The logo if the theme has one, the name otherwise. Never both: a logo that already contains the
 * wordmark, printed next to the same words again, is the mark of a template nobody looked at.
 *
 * ⚠️ The logo arrives as a `data:` URI built by `loadTheme`, and it goes in an `<img>` — never
 * inlined as markup. An SVG inside `<img>` cannot run script; the same SVG pasted into the DOM
 * can, and the file it came from is named by a config we did not write. The `alt` is the name, so
 * a screen reader and a broken image both still say where this is.
 *
 * ⚠️ The name is escaped even though it comes from the project's own file. `holdrim.json` is
 * edited by hand, travels in a repository, and ends up in the one page served to anyone who can
 * reach the port — treating it as trusted input is how a `<script>` in a product name becomes a
 * script on the sign-in screen.
 */
export function brandmark(theme: Theme): string {
  const name = theme.name ?? ENGINE_NAME;
  if (theme.logo) {
    return `<img class="holdrim-brandmark__logo" src="${forHtml(theme.logo)}" alt="${forHtml(name)}">`;
  }
  return `<span class="holdrim-brandmark__name">${forHtml(name)}</span>`;
}

/**
 * The login page in one language, ready to write to the socket.
 *
 * @param i18n  the translator built in server.ts from engine/locales/
 * @param lang  the language chosen for THIS request — see `languageOf()` in server.ts
 * @param here  the address being served, so the selector can send the person back to it with the
 *              `next` they were heading for intact. Losing it would drop someone who followed a
 *              link to a page into the home page, as a punishment for changing language.
 * @param theme the project's theme, ALREADY CHECKED by `loadTheme` in engine/api/theme.ts. This
 *              function escapes what it prints, but it does not validate a colour — the default is
 *              the engine's own, so a caller who forgets the theme gets the neutral look rather
 *              than an unchecked one.
 * @param nonce the value this response's Content-Security-Policy allows scripts and styles by —
 *              see `signInPolicy`. It has to be new on every response, or an injected tag could
 *              carry a nonce seen once. The empty default exists for the unit tests that render
 *              the page without serving it; a served page always gets one from server.ts.
 */
export function renderLoginPage(
  i18n: Translator, lang: string, here = '/', theme: Theme = ENGINE_THEME, nonce = '',
): string {
  // `{min}` belongs to the change-password sentence. Handing the same params to every key is
  // harmless: `t` only replaces a placeholder the text actually contains.
  const params = { min: MIN_PASSWORD_LENGTH };
  const texts = Object.fromEntries(LOGIN_KEYS.map((k) => [k, i18n.t(lang, k, params)]));

  return TEMPLATE.replace(/\{\{([^}]+)\}\}/g, (whole, name: string) => {
    if (name === '#lang') return forHtml(lang);
    if (name === '#nonce') return forHtml(nonce);
    if (name === '#minPassword') return String(MIN_PASSWORD_LENGTH);
    if (name === '#languageRoute') return forHtml(LANGUAGE_ROUTE);
    if (name === '#languageButtons') return languageButtons(i18n, lang);
    if (name === '#here') return forHtml(here);
    if (name === '#baseCss') return BASE_CSS;
    if (name === '#themeCss') return themeCss(theme);
    if (name === '#brandmark') return brandmark(theme);
    // The whole set, not a hand-picked subset of what the script happens to need today: a subset
    // is a second list to forget. `<` becomes `<` so a translation containing `</script>`
    // cannot close the tag it lives in.
    if (name === '#texts') return JSON.stringify(texts).replace(/</g, '\\u003c');
    // An unknown `{{…}}` is left visible on purpose, for the same reason `t` returns the key: a
    // page showing `{{login.submit}}` is diagnosable in one second; a blank button is not.
    return name in texts ? forHtml(texts[name]!) : whole;
  });
}

/**
 * The Content-Security-Policy of the sign-in screen, for the nonce its page was rendered with.
 *
 * This is the one page served to anyone who can reach the port, before any session exists, and it
 * is where a password is typed. So it gets the strictest policy the page can live with, and nothing
 * the page does not use: no script and no style but the ones this server wrote into it (they carry
 * the nonce, which is new on every response, so an injected tag cannot guess it); images only from
 * here or a `data:` URI, which is how `loadTheme` hands over the logo; requests only back to this
 * server; forms only to this server; no `<base>` to repoint relative URLs; no framing.
 *
 * The documentation pages do NOT get this policy, and that is not an oversight: they are the
 * adopter's HTML, with the adopter's scripts, and a policy the engine imposes on them would break
 * whoever wrote them an inline script. They keep `frame-ancestors 'none'`, which breaks nobody.
 *
 * `'unsafe-inline'` appears nowhere on purpose. A policy that allows inline script allows the
 * injected kind too, which is the only kind a policy exists to stop.
 */
export function signInPolicy(nonce: string): string {
  return screenPolicy(nonce, { script: true });
}

/**
 * The same policy for any screen the engine renders itself. `script: false` drops `script-src`
 * altogether, so `default-src 'none'` forbids every script: a screen that needs none should not be
 * able to run one, nonce or not.
 */
export function screenPolicy(nonce: string, { script }: { script: boolean }): string {
  return [
    "default-src 'none'",
    ...(script ? [`script-src 'nonce-${nonce}'`] : []),
    `style-src 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
