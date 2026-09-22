/**
 * The panel in the reader's language, with the engine's own translator and dictionaries.
 *
 * The screens the server renders — sign-in, home, people — speak the reader's language, and so
 * must the panel: a panel that spoke English to everybody would greet a Portuguese reader in
 * Portuguese at the door and then hand them the review in English.
 *
 * Only English travels in the bundle: it is the fallback, and a panel must be able to speak before
 * anything else loads. Every other dictionary is fetched from `/engine/locales/`, the folder the
 * server itself reads, once `/api/me` has said which one this person reads. A list of languages
 * written here would be a second list, and adding a language is meant to be copying one file into
 * that folder, nothing else — a bundled list would break that promise the day it was written.
 */
import { createI18n } from '../../core/i18n.js';
import en from '../../locales/en.json';

let i18n = createI18n({ en }, 'en');
let lang = 'en';

/**
 * Speak `chosen`, the language the server decided for this person (their own choice, then the
 * browser, then the project). Called before anything is drawn. A dictionary that does not arrive
 * leaves the panel in English: the wrong language is better than a panel that never appears.
 */
export async function speak(chosen) {
  if (!chosen || chosen === 'en') return;
  try {
    const r = await fetch(`/engine/locales/${encodeURIComponent(chosen)}.json`);
    if (!r.ok) throw new Error(`${r.status} for the ${chosen} dictionary`);
    i18n = createI18n({ en, [chosen]: await r.json() }, 'en');
    lang = chosen;
  } catch (e) {
    console.warn('[holdrim] staying in English:', e);
  }
}

/** One sentence in the reader's language; `{name}` in it is filled from `params`. */
export const t = (key, params) => i18n.t(lang, key, params);
