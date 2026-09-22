/**
 * Language choice.
 *
 * The test that earns its place here is the last one: every key present in one dictionary has to
 * exist in all of them. That is the one bug translated software always ships — the key exists in
 * the language of whoever wrote it, and is missing everywhere else. Nothing breaks at build time,
 * nothing breaks in their tests, and one day a reviewer sees `block.state.valid` on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createI18n } from '../core/i18n.js';
import { LOGIN_KEYS, keysUsedByTemplate, renderLoginPage } from '../api/login-page.ts';
import { LANGUAGE_COOKIE, chosenLanguage, languageSwitch } from '../api/language.ts';

const read = (dir) => Object.fromEntries(readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]));

// The three the engine ships. Reading the folder rather than naming the files is what makes a
// fourth dictionary tested the moment it is dropped in — a named list would let it arrive
// untested, which for a translation means arriving incomplete.
const everyDict = read(new URL('../locales/', import.meta.url));

/** A `URL` for the switch route, the way the server hands one to `languageSwitch`. */
const switching = (query) => new URL(`http://doc.example/language?${query}`);

test('a missing key returns the key, never nothing', () => {
  // A page showing `block.approved` is ugly and diagnosable in one second. A page showing an empty
  // string is a bug someone chases for an afternoon.
  const i18n = createI18n({ en: { a: 'A' } }, 'en');
  assert.equal(i18n.t('en', 'does.not.exist'), 'does.not.exist');
});

test('a language with no dictionary falls back instead of breaking', () => {
  const i18n = createI18n({ en: { a: 'A' } }, 'en');
  assert.equal(i18n.t('ja', 'a'), 'A');
});

test('a key missing in one language falls back to the other', () => {
  const i18n = createI18n({ en: { a: 'A', b: 'B' }, 'pt-BR': { a: 'a' } }, 'en');
  assert.equal(i18n.t('pt-BR', 'a'), 'a');
  assert.equal(i18n.t('pt-BR', 'b'), 'B', 'falls back rather than showing the key');
});

test('placeholders are replaced, and unknown ones are left alone', () => {
  const i18n = createI18n({ en: { greet: 'hello {name}, you have {n}' } }, 'en');
  assert.equal(i18n.t('en', 'greet', { name: 'ana', n: 3 }), 'hello ana, you have 3');
  // Leaving `{missing}` visible beats rendering "undefined": one says a parameter was forgotten,
  // the other says the software is broken.
  assert.equal(i18n.t('en', 'greet', { name: 'ana' }), 'hello ana, you have {n}');
});

test('the person decides before the browser does', () => {
  // The browser header is usually whatever the laptop shipped with. A stated preference is the
  // only one the person actually made.
  const i18n = createI18n({ en: {}, 'pt-BR': {}, es: {} }, 'en');
  assert.equal(i18n.choose({ person: 'pt-BR', acceptLanguage: 'en-US,en;q=0.9' }), 'pt-BR');
  assert.equal(i18n.choose({ person: 'es', acceptLanguage: 'pt-BR,pt;q=0.9' }), 'es');
  // Three steps down the ladder, one at a time: with no person the header decides, with no header
  // the project does, with nothing at all the fallback.
  assert.equal(i18n.choose({ acceptLanguage: 'es-MX,es;q=0.9', project: 'pt-BR' }), 'es',
    'the header beats the project default');
  assert.equal(i18n.choose({ acceptLanguage: 'pt-PT,pt;q=0.9,en;q=0.8' }), 'pt-BR',
    'a near dialect is closer to right than the wrong language');
  assert.equal(i18n.choose({ project: 'pt-BR' }), 'pt-BR');
  assert.equal(i18n.choose({}), 'en', 'with nothing to go on, the fallback');
  // A language nobody has a dictionary for is not an error and not a blank page: it is English.
  assert.equal(i18n.choose({ person: 'ja', acceptLanguage: 'ja-JP', project: 'ja' }), 'en',
    'an unknown language falls back to English');
});

test('a fallback with no dictionary is caught at build time, not at render', () => {
  assert.throws(() => createI18n({ en: {} }, 'ja'), /fallback language/);
});

test('missing() names every hole, sorted, and nothing else', () => {
  const i18n = createI18n({ en: { a: 'A', b: 'B' }, es: { a: 'a' }, 'pt-BR': { b: 'b', c: 'c' } }, 'en');
  assert.deepEqual(i18n.missing(), [
    { lang: 'en', key: 'c' },
    { lang: 'es', key: 'b' }, { lang: 'es', key: 'c' },
    { lang: 'pt-BR', key: 'a' },
  ]);
});

test('every key exists in every language', () => {
  const i18n = createI18n(everyDict, 'en');
  const holes = i18n.missing().filter((h) => !h.key.startsWith('_'));
  assert.deepEqual(holes, [],
    `keys missing per language:\n${holes.map((h) => `  ${h.lang}: ${h.key}`).join('\n')}`);
  // Naming the three: the check above compares the dictionaries against each other, so a folder
  // holding only `en.json` would pass it while proving nothing at all.
  for (const language of ['en', 'pt-BR', 'es']) {
    assert.ok(i18n.languages.includes(language), `${language} has no dictionary`);
  }
  assert.equal(i18n.fallback, 'en', 'English is the fallback and has to be one of them');
});

test('every language says its own name in its own language', () => {
  // The selector shows `language.name`, and it is the one key that must NOT be translated: a
  // person who does not read the interface language cannot recognise their own language spelled
  // in it. "Spanish" in es.json would be the whole point of the selector, lost.
  assert.equal(everyDict.en['language.name'], 'English');
  assert.equal(everyDict['pt-BR']['language.name'], 'Português');
  assert.equal(everyDict.es['language.name'], 'Español');
});

test('every placeholder in a translation exists in the English sentence', () => {
  // `{max}` in en.json and `{maximo}` in a translation is a sentence that renders with a hole in
  // it, in one language only, on the screen of a reviewer who cannot tell why.
  const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [lang, dict] of Object.entries(everyDict)) {
    if (lang === 'en') continue;
    for (const [key, sentence] of Object.entries(dict)) {
      if (key.startsWith('_') || !(key in everyDict.en)) continue;
      assert.deepEqual(placeholders(sentence), placeholders(everyDict.en[key]),
        `${lang}: ${key} does not carry the same placeholders as English`);
    }
  }
});

test('the chosen language is read back out of the cookie', () => {
  assert.equal(chosenLanguage(`${LANGUAGE_COOKIE}=es`), 'es');
  assert.equal(chosenLanguage(`holdrim_session=abc; ${LANGUAGE_COOKIE}=pt-BR; other=1`), 'pt-BR');
  assert.equal(chosenLanguage('holdrim_session=abc'), null, 'no preference is not a preference');
  assert.equal(chosenLanguage(undefined), null);
  // A cookie is whatever the client cares to send. A lone `%` makes decodeURIComponent throw, and
  // a 500 on every page because somebody edited a cookie would be an absurd way to lose the site.
  assert.equal(chosenLanguage(`${LANGUAGE_COOKIE}=%`), '%');
});

test('a language nobody has a dictionary for changes nothing', () => {
  // The value came from OUR selector, which can only offer what is in engine/locales/. Anything
  // else was typed into the address bar, and the only honest answer to an invented language is to
  // keep the one already in force — not to guess, and not to fail.
  const known = ['en', 'es', 'pt-BR'];
  assert.equal(languageSwitch(switching('lang=klingon'), known, true)['set-cookie'], undefined);
  assert.equal(languageSwitch(switching('lang='), known, true)['set-cookie'], undefined);
  assert.equal(languageSwitch(switching('next=/sign-in'), known, true)['set-cookie'], undefined,
    'no language asked for at all is not a change either');
  // And it still goes somewhere: an ignored choice returns the person to the page they were on.
  assert.equal(languageSwitch(switching('lang=klingon&next=/sign-in'), known, true).location,
    '/sign-in');
});

test('switching language stores the choice, and only where it can reach', () => {
  const known = ['en', 'es', 'pt-BR'];
  const swap = languageSwitch(switching('lang=es&next=%2Fsign-in%3Fnext%3D%2FD01.html'), known, true);
  assert.match(swap['set-cookie'], new RegExp(`^${LANGUAGE_COOKIE}=es;`));
  assert.match(swap['set-cookie'], /SameSite=Lax/, 'it has to survive a link from a chat window');
  assert.doesNotMatch(swap['set-cookie'], /HttpOnly/, 'a language is not a secret');
  assert.match(swap['set-cookie'], /Secure/);
  assert.equal(swap.location, '/sign-in?next=/D01.html',
    'the page the person was heading for survives the switch');

  // `pt-br` typed by hand is the same decision; the cookie still gets the canonical tag, because
  // that is the one that matches a file in engine/locales/.
  assert.match(languageSwitch(switching('lang=pt-br'), known, true)['set-cookie'], /=pt-BR;/);
  // Development serves over plain HTTP, where a Secure cookie is a cookie the browser drops.
  assert.doesNotMatch(languageSwitch(switching('lang=es'), known, false)['set-cookie'], /Secure/);

  // ⚠️ Open redirect. The same rule as the login screen's: resolve it and compare origins,
  // because a pattern that blocks `//evil.example` still lets a value starting with a tab through.
  for (const hostile of ['//evil.example', 'http://evil.example/x', '\\\\evil.example',
    '\thttp://evil.example', 'https://evil.example']) {
    const away = languageSwitch(
      switching(`lang=es&next=${encodeURIComponent(hostile)}`), known, true);
    assert.equal(away.location, '/', `${JSON.stringify(hostile)} must not become a redirect`);
  }
});

test('the login screen asks for exactly the keys it declares', () => {
  // Both directions on purpose. A key in the markup and not in the list renders as `{{…}}`; a key
  // in the list and not in the markup is a translation everyone keeps translating for nothing.
  assert.deepEqual(keysUsedByTemplate(), [...LOGIN_KEYS].sort());
});

test('every key the login screen uses exists in every language', () => {
  // The one screen a person sees before they are anybody. A key missing here is not a blemish in
  // a corner of the panel — it is the first impression, in a language nobody chose.
  for (const [lang, dict] of Object.entries(everyDict)) {
    const holes = LOGIN_KEYS.filter((k) => !(k in dict));
    assert.deepEqual(holes, [], `${lang} is missing: ${holes.join(', ')}`);
  }
});

test('the login screen comes out translated, with nothing left to fill in', () => {
  const i18n = createI18n(everyDict, 'en');
  const english = renderLoginPage(i18n, 'en');
  const portuguese = renderLoginPage(i18n, 'pt-BR');
  const spanish = renderLoginPage(i18n, 'es');

  assert.match(english, /<html lang="en">/);
  assert.match(english, /<title>Sign in<\/title>/);
  assert.match(portuguese, /<html lang="pt-BR">/);
  assert.match(portuguese, /<title>Entrar<\/title>/);
  assert.match(spanish, /<html lang="es">/);
  assert.match(spanish, /<title>Iniciar sesión<\/title>/);

  // No placeholder survives the render — the failure this catches is a page that ships a raw
  // `{{login.submit}}` on the button, which no type checker and no lint would ever notice.
  for (const page of [english, portuguese, spanish]) assert.doesNotMatch(page, /\{\{/);

  // `{min}` comes from users.ts, not from the sentence: a screen promising a different number from
  // the one the server enforces locks someone out with a password they believe is long enough.
  assert.match(portuguese, /12 caracteres ou mais/);
  assert.match(spanish, /de 12 caracteres o más/);
});

test('the language selector offers every language, in its own name, with no flag', () => {
  const i18n = createI18n(everyDict, 'en');
  const page = renderLoginPage(i18n, 'es', '/sign-in?next=/D01.html');
  // The selector alone, not the whole page: the page also has a `button:disabled` rule in its
  // stylesheet, and asserting against all of it would be asserting against the wrong thing.
  // `class="[^"]*"` rather than the literal `class="languages"`: the selector composes the
  // engine's own `holdrim-langbar` with the `languages` hook this test looks for. What is being asserted
  // is that the hook survives and that the form is still a plain GET — not the order of two class
  // names.
  const selector = page.match(/<form class="[^"]*\blanguages\b[^"]*"[\s\S]*?<\/form>/)?.[0];
  assert.ok(selector, 'the selector has to be on the page at all');

  // All three, always, whichever language the page is being served in: someone stuck in a language
  // they do not read has to be able to find the way out.
  for (const name of ['English', 'Português', 'Español']) {
    assert.match(selector, new RegExp(`name="lang"[^>]*>${name}</button>`));
  }
  // The current one marked, and only it. Marked with `aria-current` rather than `disabled`, so it
  // stays reachable by keyboard — a disabled button is skipped by Tab.
  assert.match(selector, /value="es"[^>]*aria-current="true"/);
  assert.equal(selector.match(/aria-current="true"/g).length, 1);
  assert.doesNotMatch(selector, /disabled/);
  assert.match(selector, /aria-label="Idioma"/, 'the selector is labelled, in the page language');

  // It has to work with JavaScript off: a GET form, which the browser submits on its own.
  assert.match(selector, /^<form class="[^"]*\blanguages\b[^"]*" method="get" action="\/language"/);
  assert.match(selector, /<input type="hidden" name="next" value="\/sign-in\?next=\/D01\.html">/);

  // ⚠️ No flags. A flag is a country, not a language — Spain or Mexico? the United Kingdom or the
  // United States? The selector says what language it is, and says nothing about anyone's
  // nationality. This asserts the regional-indicator range, which is what a flag emoji is made of.
  assert.doesNotMatch(selector, /[\u{1F1E6}-\u{1F1FF}]/u);
});

test('a translation cannot close the script tag it travels in', () => {
  // The dictionaries are files someone contributes. `</script>` inside one would end the JSON
  // block and turn the rest of the sentence into code running on the login page.
  const nasty = { ...everyDict.en, 'login.error.noAnswer': '</script><script>alert(1)</script>' };
  const page = renderLoginPage(createI18n({ en: nasty }, 'en'), 'en');
  assert.doesNotMatch(page, /<\/script><script>alert/);
  assert.match(page, /\\u003c\/script/);
});
