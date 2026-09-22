import { normalize, join, sep, extname } from 'node:path';

/**
 * The project's theme: how a project dresses the engine, in the Keycloak sense.
 *
 * ## The problem this solves
 *
 * A brand colour written inside engine/api/login.html would be one specific customer's colour,
 * hard-coded into an engine whose whole promise is that it names no company, no client and no
 * product — so every stranger who cloned Holdrim would ship somebody else's brand, and the project
 * that owned the colour would have no way to change it except by editing the engine.
 *
 * The answer is the shape Keycloak uses: the ENGINE ships a complete, neutral default, and the
 * deployment overrides the parts it cares about. Here the deployment is `holdrim.json`, the same
 * file that already says where the content lives and who approves it — one file to edit, which is
 * the promise readConfig already makes.
 *
 *     "theme": { "brand": "#2E6E5B", "logo": "theme/logo.svg", "name": "Template · Handbook" }
 *
 * All three are optional. With no theme at all the engine looks like the engine.
 *
 * ## Why this file distrusts its input
 *
 * `holdrim.json` is a file someone else writes, and its values end up inside CSS and inside
 * HTML. A brand colour of `red; } body { display: none } /*` interpolated into a stylesheet closes
 * the rule it was put in and opens another one — the documentation goes blank and nobody can tell
 * why, and a value that can write arbitrary CSS can also position an invisible element over the
 * sign-in button. So nothing here is interpolated raw: the colour is matched against a grammar,
 * the logo is read from disk by us rather than linked to by them, and the name is escaped by the
 * renderer.
 *
 * ⚠️ Rejection is never silent. Every refusal comes back in `warnings`, because a theme that does
 * not apply and does not complain costs an afternoon of someone reloading the page wondering why
 * their colour is not there.
 *
 * @module
 */

/**
 * A brand colour, as written in `holdrim.json`.
 *
 * ⚠️ HEX ONLY, and three or six digits. That is narrower than CSS allows, on purpose:
 *
 *   - It is a grammar with no punctuation in it. `rgb()` and `hsl()` bring parentheses, commas,
 *     spaces, slashes and percentages, and a validator for them is a small parser — the kind of
 *     code that gets one case wrong and lets a `}` through. `#` plus hex digits has no case to get
 *     wrong.
 *   - Named colours would mean shipping the CSS colour list, or accepting a bare identifier, and a
 *     bare identifier is exactly the shape of an injection payload.
 *   - No alpha (`#rgba` / `#rrggbbaa`). A translucent brand makes a translucent primary button,
 *     which looks like a bug rather than a brand, and it breaks the contrast measurement below:
 *     the readable ink depends on what is BEHIND a see-through colour, which we do not know.
 *
 * Anyone who has a brand has it written as hex already.
 */
const BRAND_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The engine's own brand, used when the project sets none.
 *
 * ⚠️ It is deliberately NOT a customer's colour. `#3F4B57` is a slate lifted from the neutral ramp
 * in engine/web/base.css — the ink colour, lightened. It is neutral in the only sense that matters
 * here: it belongs to the engine's own greys rather than to anybody's identity, so a default
 * install says "no brand has been set" instead of asserting a brand that is not theirs. It carries
 * white text at 8.9:1, so the unthemed screen is also an accessible one.
 *
 * Kept in step with `--holdrim-brand` in base.css; the test in engine/tests/theme.test.js checks that
 * the two have not drifted apart.
 */
export const ENGINE_BRAND = '#3F4B57';

/** Near-black rather than pure black: the same ink the rest of the system uses. */
const DARK_INK = '#12263A';
const LIGHT_INK = '#FFFFFF';

/**
 * The name shown when nothing else has one.
 *
 * ⚠️ This is the engine naming ITSELF, which is the one name it is entitled to use. Every other
 * name on the screen comes from the project. A sign-in screen with no name at all is worse than a
 * generic one: it answers "what place is this?" with silence.
 */
export const ENGINE_NAME = 'Holdrim';

/** What the engine looks like with no project theme at all. */
export const ENGINE_THEME: Theme = {
  brand: ENGINE_BRAND,
  brandInk: LIGHT_INK,
  name: ENGINE_NAME,
  logo: null,
};

/** The theme as `readConfig` reports it: straight from the file, nothing checked yet. */
export interface ConfiguredTheme {
  brand?: string | null;
  logo?: string | null;
  name?: string | null;
}

/** The theme after checking: every field is safe to put on a page. */
export interface Theme {
  /** `#rgb` or `#rrggbb`, always. Never the raw string from the file. */
  brand: string;
  /** White or near-black, measured against `brand` — never assumed. */
  brandInk: string;
  /** The product name to show, or null to fall back to the project name. Still needs escaping. */
  name: string | null;
  /** A `data:` URI the page can inline, or null. Never a path the browser has to fetch. */
  logo: string | null;
}

/** Injected so the theme can be tested without a disk. */
export interface ThemeIO {
  readBinary(path: string): Uint8Array;
}

/** True for a value this engine is willing to write into a stylesheet. */
export function isBrandColor(value: unknown): value is string {
  return typeof value === 'string' && BRAND_PATTERN.test(value);
}

/** One sRGB channel, 0–255, linearised the way WCAG defines it. */
function channel(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a validated hex colour. */
export function luminance(hex: string): number {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? digits.split('').map((d) => d + d).join('') : digits;
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two validated hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * What to write ON the brand colour.
 *
 * Measured, not chosen. A themeable button with hard-coded white text is the commonest way a
 * white-label interface becomes unreadable: the first three brands are dark blues and it works,
 * the fourth is a yellow and the primary button turns into a blank rectangle. Whichever of the two
 * inks has more contrast wins, and if the better one still falls below 4.5:1 the brand itself is
 * the problem — `loadTheme` says so rather than shipping it quietly.
 */
export function readableInk(brand: string): string {
  return contrast(brand, LIGHT_INK) >= contrast(brand, DARK_INK) ? LIGHT_INK : DARK_INK;
}

/**
 * Image types allowed as a logo, and what to call them in the data URI.
 *
 * A closed list because the extension decides the `content-type`, and a `content-type` the project
 * chooses is a `content-type` the project can use to make the browser treat their bytes as
 * something else. SVG is on the list and safe HERE only because the page renders it inside an
 * `<img>`: a browser will not run script inside an SVG loaded that way. It would not be safe
 * inlined into the DOM, which is why this returns a data URI and not markup.
 */
const LOGO_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

/**
 * How big a logo may be, inlined.
 *
 * 64 KiB. The login page is the one request that is always a cold start, often on a phone on
 * mobile data, and base64 adds a third to whatever this is. A logo above this is not a logo, it is
 * a photograph, and the right answer is to tell whoever configured it rather than to make every
 * sign-in slower for a mistake nobody can see.
 */
const MAX_LOGO_BYTES = 64 * 1024;

/**
 * Reads the project's logo and turns it into a `data:` URI.
 *
 * ⚠️ We read the file; the browser never fetches the path. Two reasons, and the second is the one
 * that would have bitten:
 *
 *   1. The login screen is the only page served WITHOUT a session. Everything else, including
 *      `/engine/web/`, sits behind the guard in server.ts — so a `<img src="/theme/logo.svg">`
 *      would be redirected to the sign-in page and render as a broken image ON the sign-in page.
 *      Opening a route for it would mean punching a second hole in the authentication wall to
 *      serve decoration.
 *   2. The path comes from a file we did not write. Resolved here, `../../etc/passwd` is caught;
 *      handed to the browser as a URL it would just be another request the server has to defend.
 *
 * @param warnings  appended to, never thrown: a bad logo must not stop anyone from signing in.
 */
function loadLogo(root: string, configured: string, io: ThemeIO, warnings: string[]): string | null {
  const base = normalize(root);
  const target = normalize(join(base, configured));
  // The same prefix check the static server uses. `theme/../../secrets.png` normalises to somewhere
  // outside the project, and a project's config file should not be able to read the disk.
  if (!target.startsWith(base + sep)) {
    warnings.push(`theme logo "${configured}" resolves outside the project; ignored`);
    return null;
  }

  const type = LOGO_TYPES[extname(target).toLowerCase()];
  if (!type) {
    warnings.push(`theme logo "${configured}" is not one of ${Object.keys(LOGO_TYPES).join(', ')}; ignored`);
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = io.readBinary(target);
  } catch {
    warnings.push(`theme logo "${configured}" could not be read; the name will be shown instead`);
    return null;
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    warnings.push(`theme logo "${configured}" is ${Math.round(bytes.byteLength / 1024)} KiB, over the ${MAX_LOGO_BYTES / 1024} KiB limit; ignored`);
    return null;
  }
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * The checked theme, plus everything that was refused and why.
 *
 * Nothing in here throws. A theme is decoration; a decoration that can stop the login page from
 * rendering would be a way to lock everyone out of the documentation by mistyping a colour.
 */
export function loadTheme(
  root: string,
  configured: ConfiguredTheme | null | undefined,
  io: ThemeIO,
): { theme: Theme; warnings: string[] } {
  const warnings: string[] = [];
  const t = configured ?? {};

  let brand = ENGINE_BRAND;
  if (t.brand != null && t.brand !== '') {
    if (isBrandColor(t.brand)) {
      brand = t.brand;
    } else {
      // Quoted and truncated: this goes in a log, and the whole point of the rejected value is
      // that it may be an injection payload several lines long.
      warnings.push(`theme colour ${JSON.stringify(String(t.brand).slice(0, 40))} is not a hex colour like #0B5FA5; using the engine default`);
    }
  }

  const brandInk = readableInk(brand);
  if (contrast(brand, brandInk) < 4.5) {
    // Still applied — it is their brand and refusing it would be the engine overruling a decision
    // that is not its own. But it is said out loud, once, at boot.
    warnings.push(`theme colour ${brand} carries text at only ${contrast(brand, brandInk).toFixed(1)}:1; WCAG 1.4.3 asks for 4.5:1`);
  }

  const name = typeof t.name === 'string' && t.name.trim() !== '' ? t.name.trim() : null;
  const logo = typeof t.logo === 'string' && t.logo.trim() !== ''
    ? loadLogo(root, t.logo.trim(), io, warnings)
    : null;

  return { theme: { brand, brandInk, name, logo }, warnings };
}

/**
 * The theme as CSS, ready to go in a `<style>` after base.css.
 *
 * A second `:root` rather than an edit to base.css: the engine's defaults stay readable as
 * defaults, the override is one visible block, and "what did the project change?" is answerable by
 * looking at four lines of served HTML.
 *
 * ⚠️ Both values are already constrained to `#` plus hex digits by the time they arrive — there is
 * nothing left to escape, which is the point of validating instead of escaping. The assertion here
 * is a second lock on the same door: if a future caller builds a `Theme` by hand and skips
 * `loadTheme`, this is where it stops, rather than in someone's stylesheet.
 */
export function themeCss(theme: Theme): string {
  const brand = isBrandColor(theme.brand) ? theme.brand : ENGINE_BRAND;
  const ink = isBrandColor(theme.brandInk) ? theme.brandInk : LIGHT_INK;
  return `:root { --holdrim-brand: ${brand}; --holdrim-brand-ink: ${ink}; }`;
}
