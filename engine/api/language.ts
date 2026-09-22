/**
 * The language the person chose, and the route that changes it.
 *
 * `engine/core/i18n.js` already knows how to pick a language out of three candidates — the
 * person's own preference, `Accept-Language`, the project's default — and says why the first one
 * wins: it is the only one somebody decided on purpose, while the header is usually whatever the
 * laptop shipped with. What the core has no place for is KEEPING that decision. Without this file
 * `choose()` would be called without `person` on every request, so the first candidate would
 * always be empty and the browser header would always win. The preference would exist in the core
 * and could not be expressed by a human being.
 *
 * Nothing here renders HTML. The selector the person clicks is drawn in `engine/api/login-page.ts`,
 * next to the template and the escaping it needs; what travels between the two is this route's
 * name and this cookie's name, so neither side has to remember a string the other one owns.
 * @module
 */

/**
 * ⚠️ Not a secret, and deliberately not hidden.
 *
 * No `HttpOnly`: the session cookie hides from JavaScript because stealing it is stealing the
 * session. This one holds the word `es`. The person chose it, they can see it in the interface,
 * and the review panel may well want to read it without asking the server — hiding it would cost
 * something and buy nothing.
 *
 * `SameSite=Lax`, not `Strict`: people reach the documentation from a link in a chat or an e-mail.
 * With `Strict` that first navigation from outside carries no cookie, so the arrival that matters
 * most — someone opening the tool for the first time in their day — renders in the wrong language
 * and only corrects itself on the second click.
 */
export const LANGUAGE_COOKIE = 'holdrim_language';

/** Where the selector submits. Named here so the markup and the server cannot drift apart. */
export const LANGUAGE_ROUTE = '/language';

/** A year. A language preference does not expire in a session; it is not a login. */
const A_YEAR_IN_SECONDS = 31_536_000;

/**
 * The language in the cookie, or null when there is none.
 *
 * It returns whatever is written there, without judging it — validating is `choose()`'s job, and
 * it does it by matching against the dictionaries that actually exist. A cookie edited by hand to
 * `klingon` therefore matches nothing and falls through to `Accept-Language`, which is the right
 * outcome and needs no special case.
 */
export function chosenLanguage(cookieHeader: string | string[] | undefined): string | null {
  const text = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!text) return null;
  for (const part of text.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== LANGUAGE_COOKIE) continue;
    const raw = rest.join('=');
    // A cookie is anything the client cares to send, and `%` on its own makes decodeURIComponent
    // throw. A malformed preference is not worth a 500 on every page.
    try { return decodeURIComponent(raw) || null; } catch { return raw || null; }
  }
  return null;
}

/** The `set-cookie` value that stores the choice. */
export function languageCookie(language: string, secure: boolean): string {
  const parts = [
    `${LANGUAGE_COOKIE}=${encodeURIComponent(language)}`,
    'Path=/', `Max-Age=${A_YEAR_IN_SECONDS}`, 'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Back to where the person was standing when they switched.
 *
 * ⚠️ Resolved as a URL and checked by origin, not matched against a pattern. A pattern that blocks
 * `//evil.example` still lets an open redirect through, because a value starting with a tab is
 * stripped by the browser before it parses. Letting the parser resolve it leaves no spelling left
 * to outguess. Anything that lands outside goes home instead — a language switch is not a way to
 * send someone to another site with our domain in the address bar.
 */
function backTo(asked: string | null): string {
  if (!asked) return '/';
  const here = 'http://internal.invalid';
  try {
    const resolved = new URL(asked, here);
    return resolved.origin === here ? resolved.pathname + resolved.search : '/';
  } catch {
    return '/';
  }
}

/**
 * The headers that answer `GET /language?lang=…&next=…`: always a redirect, and a cookie only when
 * the language asked for is one this engine actually has.
 *
 * ⚠️ Exact tags only, unlike `choose()`. `choose()` matches a prefix on purpose, so that a browser
 * announcing `pt-PT` lands on `pt-BR` — a near dialect beats the wrong language. Here the value
 * did not come from a browser, it came from OUR selector, which can only offer what is in
 * `engine/locales/`. So anything else was invented by whoever typed the address, and an invented
 * value gets exactly one outcome: ignored, with the page reloading in the language already in
 * force. Case is forgiven, because `pt-br` typed by hand is the same decision; spelling is not.
 *
 * @param known  the language tags that have a dictionary — `i18n.languages`
 * @param secure whether to mark the cookie `Secure` (everywhere but development)
 */
export function languageSwitch(
  url: URL, known: readonly string[], secure: boolean,
): Record<string, string> {
  const asked = url.searchParams.get('lang');
  const match = asked ? known.find((tag) => tag.toLowerCase() === asked.toLowerCase()) : undefined;
  const headers: Record<string, string> = { location: backTo(url.searchParams.get('next')) };
  if (match) headers['set-cookie'] = languageCookie(match, secure);
  return headers;
}
