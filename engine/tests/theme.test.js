/**
 * The project's theme, and the one thing it must never be able to do.
 *
 * A theme is a value from `holdrim.json` — a file written by whoever adopts the method, kept in
 * their repository, edited by hand — that this engine writes into a stylesheet and into HTML on
 * the one page served WITHOUT a session. That is the shape of every CSS injection there has ever
 * been. `--holdrim-brand: red; } body { display: none } /*` closes the rule it was put in, opens
 * another, and blanks the documentation for everyone; the same trick with `position: fixed` puts
 * an invisible element over the sign-in button.
 *
 * So the colour is not escaped, it is VALIDATED — and validation is logic, which means it earns a
 * test with mutations rather than one happy case. The list below is the point of this file: each
 * entry is a spelling that a validator written slightly differently would have let through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createI18n } from '../core/i18n.js';
import { readConfig } from '../core/config.js';
import { renderLoginPage } from '../api/login-page.ts';
import {
  ENGINE_BRAND, ENGINE_NAME, ENGINE_THEME, contrast, isBrandColor, loadTheme, readableInk, themeCss,
} from '../api/theme.ts';

const i18n = createI18n({ en: { 'language.name': 'English' } }, 'en');
const encoder = new TextEncoder();

/** A disk that has exactly the files it is told about. */
const disk = (files) => ({
  readBinary(path) {
    if (!(path in files)) throw new Error(`no such file: ${path}`);
    return files[path];
  },
});

// --------------------------------------------------------------- the default

test('the engine default brand is neutral, not anybody\'s brand', () => {
  // The engine names no company and no product, and its unthemed screen should not look like one
  // either: a saturated default reads as somebody's brand, and every project that has not set its
  // own would ship it. Neutral here means grey — no channel far from the others.
  assert.match(ENGINE_BRAND, /^#[0-9A-Fa-f]{6}$/);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(ENGINE_BRAND.slice(i, i + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 0x30, `${ENGINE_BRAND} is a colour, not a neutral`);
  // Neutral is not an excuse for unreadable: the unthemed screen has to pass WCAG 1.4.3 too.
  assert.ok(contrast(ENGINE_BRAND, '#FFFFFF') >= 4.5,
    `the default brand carries white text at only ${contrast(ENGINE_BRAND, '#FFFFFF').toFixed(2)}:1`);
});

test('the default in the stylesheet and the default in the code are the same colour', () => {
  // Two defaults that drift apart is a page that looks themed before the theme is applied and
  // different after — with nothing in either file admitting which one is right.
  const css = readFileSync(new URL('../web/base.css', import.meta.url), 'utf8');
  const declared = css.match(/--holdrim-brand:\s*(#[0-9A-Fa-f]{3,8})\s*;/)?.[1];
  assert.equal(declared?.toLowerCase(), ENGINE_BRAND.toLowerCase());
});

// ------------------------------------------------------- validating a colour

test('a brand colour is hex, three or six digits, and nothing else', () => {
  for (const good of ['#000', '#fff', '#FFF', '#0B5FA5', '#0b5fa5', '#3F4B57']) {
    assert.ok(isBrandColor(good), `${good} is a colour and should be accepted`);
  }
});

test('every spelling that would escape the stylesheet is refused', () => {
  // ⚠️ Mutations, not examples. Each of these passes a validator that is one character too
  // generous, and the comment says which one.
  const refused = [
    ['red; } body { display: none } /*', 'the payload: a keyword, then out of the rule'],
    ['#0B5FA5; } body { display: none }', 'a VALID colour followed by an escape'],
    ['#0B5FA5 ', 'a trailing space — a trimming validator would accept it, and CSS would too'],
    ['#0B5FA5\n', 'a trailing newline: in some languages `$` matches before it. Not in JavaScript,'
      + ' and this is what proves the pattern was not ported from one of those.'],
    [' #0B5FA5', 'a leading space'],
    ['#0B5FA', 'five digits — not a colour, and browsers drop the declaration'],
    ['#0B5FA55', 'seven digits'],
    ['#0B5FA5FF', 'eight digits: valid CSS, but alpha makes the primary button see-through and'
      + ' makes the contrast measurement meaningless'],
    ['#0B5F', 'four digits, same reason'],
    ['#zzzzzz', 'the right shape, not hex'],
    ['rgb(8, 131, 197)', 'valid CSS, refused on purpose: parentheses and commas need a parser'],
    ['var(--anything)', 'indirection: a value that reads another value'],
    ['url(https://elsewhere.example/x.png)', 'a colour slot used to make a request'],
    ['expression(alert(1))', 'the old IE way of running script from a stylesheet'],
    ['0B5FA5', 'no hash'],
    ['##0B5FA5', 'two hashes'],
    ['', 'empty'],
    ['   ', 'blank'],
    [null, 'null'], [undefined, 'undefined'], [42, 'a number'], [{}, 'an object'],
    [['#0B5FA5'], 'an array containing a valid colour — String(x) would unwrap it'],
  ];
  for (const [value, why] of refused) {
    assert.equal(isBrandColor(value), false, `${JSON.stringify(value)} must be refused: ${why}`);
  }
});

test('a refused colour never reaches the stylesheet, and is complained about', () => {
  const { theme, warnings } = loadTheme('/p', { brand: 'red; } body { display: none } /*' }, disk({}));
  assert.equal(theme.brand, ENGINE_BRAND);
  assert.equal(themeCss(theme), ':root { --holdrim-brand: #3F4B57; --holdrim-brand-ink: #FFFFFF; }');
  // Refusing quietly would be worse than not refusing: whoever set the colour would reload the
  // page for an hour before suspecting the engine had an opinion about it.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not a hex colour/);
});

test('themeCss cannot emit a value that leaves the rule, even when handed one directly', () => {
  // A second lock on the same door: a future caller who builds a Theme by hand and skips
  // loadTheme should not be able to write CSS through it.
  const css = themeCss({ brand: 'red; } body { display: none } /*', brandInk: 'x; }', name: null, logo: null });
  assert.equal(css, ':root { --holdrim-brand: #3F4B57; --holdrim-brand-ink: #FFFFFF; }');
  // One `{`, one `}`, and two declarations. Counting is what catches a payload that happens not to
  // match any word this test thought to look for.
  assert.equal((css.match(/[{]/g) ?? []).length, 1);
  assert.equal((css.match(/[}]/g) ?? []).length, 1);
  assert.equal((css.match(/;/g) ?? []).length, 2);
});

// ------------------------------------------------------------- readable text

test('what goes on the brand is measured, not assumed', () => {
  // The bug this prevents: white text hard-coded on a themeable button. It works for the first
  // three customers, who are all dark blue, and the fourth is a yellow whose button then reads as
  // an empty rectangle.
  assert.equal(readableInk('#0B5FA5'), '#FFFFFF', 'a dark brand takes white');
  assert.equal(readableInk('#F2C744'), '#12263A', 'a light brand takes the dark ink');
  assert.equal(readableInk('#FFFFFF'), '#12263A');
  assert.equal(readableInk('#000000'), '#FFFFFF');
  // Whichever was picked, it is the better of the two — never the merely conventional one.
  for (const brand of ['#0B5FA5', '#F2C744', '#7FB069', '#3F4B57', '#888888']) {
    const ink = readableInk(brand);
    const other = ink === '#FFFFFF' ? '#12263A' : '#FFFFFF';
    assert.ok(contrast(brand, ink) >= contrast(brand, other), `${brand} picked the worse ink`);
  }
});

test('a brand that cannot carry text is applied, and said out loud', () => {
  // Applied because it is their brand and the engine does not get to overrule it. Said out loud
  // because nobody chooses an unreadable button on purpose.
  // A mid grey is the worst case there is: it sits at the crossover where white and the dark ink
  // are equally bad, about 3.9:1 either way, so no choice of ink can rescue it.
  const { theme, warnings } = loadTheme('/p', { brand: '#808080' }, disk({}));
  assert.equal(theme.brand, '#808080');
  assert.ok(warnings.some((w) => /WCAG/.test(w)), `expected a contrast warning, got ${warnings}`);
});

// -------------------------------------------------------------------- a logo

test('a logo becomes bytes we read, never a path the browser fetches', () => {
  const svg = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const { theme, warnings } = loadTheme('/p', { logo: 'theme/logo.svg' }, disk({ '/p/theme/logo.svg': svg }));
  assert.deepEqual(warnings, []);
  assert.match(theme.logo, /^data:image\/svg\+xml;base64,/);
});

test('a logo path cannot walk out of the project', () => {
  // `holdrim.json` is a config file, not a key to the disk.
  // ⚠️ The files EXIST on the fake disk. With an empty disk this test would pass with the guard
  // deleted — "could not be read" covers for "refused to read" — and prove nothing. Here the only
  // way the logo stays null is the guard saying no.
  const leak = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const files = disk({ '/etc/passwd.png': leak, '/secret.png': leak, '/etc/hosts.png': leak });
  for (const escape of ['../../etc/passwd.png', 'theme/../../../secret.png']) {
    const { theme, warnings } = loadTheme('/p', { logo: escape }, files);
    assert.equal(theme.logo, null, `${escape} must not be read`);
    assert.match(warnings.join(' '), /outside the project/, `${escape} has to be refused, not merely missing`);
  }
  // An absolute path is not an escape: it is resolved UNDER the project root, so `/etc/hosts.png`
  // means `/p/etc/hosts.png`, which is not on this disk — and the file at the real root is never
  // touched.
  const absolute = loadTheme('/p', { logo: '/etc/hosts.png' }, files);
  assert.equal(absolute.theme.logo, null);
  assert.match(absolute.warnings.join(' '), /could not be read/);
});

test('a logo of an unexpected type is refused, and the name is shown instead', () => {
  const { theme, warnings } = loadTheme('/p', { logo: 'theme/logo.html' }, disk({ '/p/theme/logo.html': encoder.encode('<b>') }));
  assert.equal(theme.logo, null);
  assert.match(warnings.join(' '), /not one of/);
});

test('a logo too heavy to inline is refused rather than slowing every sign-in', () => {
  const huge = new Uint8Array(70 * 1024);
  const { theme, warnings } = loadTheme('/p', { logo: 'theme/logo.png' }, disk({ '/p/theme/logo.png': huge }));
  assert.equal(theme.logo, null);
  assert.match(warnings.join(' '), /over the 64 KiB limit/);
});

test('a missing logo file does not stop anyone from signing in', () => {
  const { theme, warnings } = loadTheme('/p', { logo: 'theme/logo.svg' }, disk({}));
  assert.equal(theme.logo, null);
  assert.equal(theme.brand, ENGINE_BRAND);
  assert.match(warnings.join(' '), /could not be read/);
});

// ---------------------------------------------------- the whole page, served

/** The theme `<style>` block, which is the only one that starts with a rule rather than a comment. */
const themeBlock = (page) => page.match(/<style[^>]*>(:root \{[^<]*)<\/style>/)?.[1];

test('with no theme the served page wears the engine\'s own neutral brand', () => {
  const page = renderLoginPage(i18n, 'en');
  assert.equal(themeBlock(page), ':root { --holdrim-brand: #3F4B57; --holdrim-brand-ink: #FFFFFF; }');
  assert.match(page, new RegExp(`<span class="holdrim-brandmark__name">${ENGINE_NAME}</span>`));
});

test('with a theme the served page wears it', () => {
  const { theme } = loadTheme('/p', { brand: '#0B5FA5', name: 'Handbook · Product' }, disk({}));
  const page = renderLoginPage(i18n, 'en', '/sign-in', theme);
  assert.equal(themeBlock(page), ':root { --holdrim-brand: #0B5FA5; --holdrim-brand-ink: #FFFFFF; }');
  assert.match(page, /<span class="holdrim-brandmark__name">Handbook · Product<\/span>/);
  // The override comes AFTER the engine's defaults, or it would not override anything.
  assert.ok(page.indexOf('--holdrim-brand: #3F4B57') < page.indexOf('--holdrim-brand: #0B5FA5'),
    'the theme block has to come after base.css');
});

test('a logo replaces the name, in an <img>, never as markup', () => {
  // ⚠️ An SVG inside `<img>` cannot run script. The same SVG pasted into the DOM can, and the file
  // it came from is named by a config this engine did not write.
  const hostile = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const { theme } = loadTheme('/p', { logo: 'logo.svg', name: 'Handbook' }, disk({ '/p/logo.svg': hostile }));
  const page = renderLoginPage(i18n, 'en', '/sign-in', theme);
  assert.match(page, /<img class="holdrim-brandmark__logo" src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" alt="Handbook">/);
  assert.doesNotMatch(page, /<svg/, 'the logo must not be inlined as markup');
  assert.doesNotMatch(page, /<span class="holdrim-brandmark__name">/, 'the logo replaces the name, never doubles it');
});

test('a hostile brand colour does not become CSS on the served page', () => {
  // THE ONE THIS FILE EXISTS FOR. End to end, through readConfig and loadTheme and the renderer,
  // exactly as a project would configure it.
  const config = readConfig('/p', {
    readFile: () => JSON.stringify({ name: 'Handbook', theme: { brand: 'red; } body { display:none } /*' } }),
  });
  const { theme } = loadTheme('/p', config.theme, disk({}));
  const page = renderLoginPage(i18n, 'en', '/sign-in', theme);

  assert.equal(themeBlock(page), ':root { --holdrim-brand: #3F4B57; --holdrim-brand-ink: #FFFFFF; }');
  assert.doesNotMatch(page, /body \{ display/, 'the payload became a rule');
  assert.doesNotMatch(page, /--holdrim-brand: red/);
  assert.equal(page.includes('red; }'), false, 'the raw value is on the page in some form');
});

test('a product name cannot become a script on the sign-in screen', () => {
  // The name is text from a file somebody edits by hand, and it lands on the one page served to
  // anyone who can reach the port.
  const { theme } = loadTheme('/p', { name: '</span><script>alert(1)</script>' }, disk({}));
  const page = renderLoginPage(i18n, 'en', '/sign-in', theme);
  assert.doesNotMatch(page, /<script>alert\(1\)<\/script>/);
  assert.match(page, /&lt;\/span&gt;&lt;script&gt;/);
});

test('the engine theme is the one used when a caller forgets to pass one', () => {
  assert.equal(renderLoginPage(i18n, 'en'), renderLoginPage(i18n, 'en', '/', ENGINE_THEME));
});
