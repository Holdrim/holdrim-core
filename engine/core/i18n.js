/**
 * Language choice. The core returns KEYS; the edge turns them into sentences.
 *
 * Why this exists at all: the rule "the code is English only" and the rule "the reviewer reads in
 * their own language" look like they contradict each other, and they do — as long as the sentences
 * live inside the code. Move them out and both hold at once.
 *
 * ⚠️ Three audiences, and they are not the same:
 *
 *   the reviewer      reads messages in the browser. Their language. Always translated.
 *   whoever operates  reads logs. English, always, and NOT through here — a log is evidence, and
 *                     evidence that changes wording by locale is evidence you cannot grep.
 *   whoever develops  reads configuration errors at boot. English, hard-coded: a service that
 *                     refuses to start has no session, no person and no chosen language yet.
 *
 * So this module serves the first audience only. Mixing the other two in was the mistake waiting
 * to happen.
 * @module
 */

/** @typedef {Record<string, string>} Dictionary */

/**
 * Builds the translator.
 *
 * @param {Record<string, Dictionary>} dictionaries  language tag → dictionary
 * @param {string} fallback  the language used when the chosen one lacks the key
 */
export function createI18n(dictionaries, fallback = 'en') {
  if (!dictionaries[fallback]) {
    throw new Error(`i18n: the fallback language "${fallback}" has no dictionary.`);
  }

  /**
   * One sentence, in one language.
   *
   * A missing key returns the key itself, never an empty string or a crash. A page that shows
   * `block.approved` is ugly and instantly diagnosable; a page that shows nothing is a bug someone
   * will chase for an afternoon.
   *
   * @param {string} lang
   * @param {string} key
   * @param {Record<string, string|number>} [params]  `{n}` in the text is replaced by `params.n`
   */
  function t(lang, key, params) {
    const sentence = dictionaries[lang]?.[key] ?? dictionaries[fallback][key] ?? key;
    if (!params) return sentence;
    return sentence.replace(/\{(\w+)\}/g, (whole, name) =>
      (name in params ? String(params[name]) : whole));
  }

  /**
   * Which language to speak, in order of who gets to decide:
   *   1. the person's own preference, when they set one
   *   2. what the browser asks for, via Accept-Language
   *   3. the project's default
   *
   * The person's choice comes first because it is the only one they made deliberately — the
   * browser header is usually whatever the laptop came with.
   *
   * @param {{ person?: string|null, acceptLanguage?: string|null, project?: string|null }} o
   */
  function choose(o = {}) {
    const known = Object.keys(dictionaries);
    const match = (tag) => {
      if (!tag) return null;
      const exact = known.find((k) => k.toLowerCase() === tag.toLowerCase());
      if (exact) return exact;
      // `pt-PT` should land on `pt-BR` rather than fall through to English: a slightly off dialect
      // is closer to right than the wrong language entirely.
      const base = tag.split('-')[0].toLowerCase();
      return known.find((k) => k.split('-')[0].toLowerCase() === base) ?? null;
    };

    if (o.person) { const m = match(o.person); if (m) return m; }
    for (const part of String(o.acceptLanguage ?? '').split(',')) {
      const tag = part.split(';')[0].trim();
      const m = match(tag);
      if (m) return m;
    }
    return match(o.project) ?? fallback;
  }

  /**
   * Every key used that some dictionary does not have.
   *
   * This is the one bug of translated software that always reaches production: the key exists in
   * the language whoever wrote it speaks, and is missing in the others. Nothing breaks at build
   * time, nothing breaks in the tests of whoever wrote it, and one day someone sees `block.approved`
   * on screen. A test calling this is worth more than any amount of care.
   */
  function missing() {
    const all = new Set(Object.values(dictionaries).flatMap((d) => Object.keys(d)));
    const holes = [];
    for (const [lang, dict] of Object.entries(dictionaries)) {
      for (const key of all) if (!(key in dict)) holes.push({ lang, key });
    }
    return holes.sort((a, b) => a.lang.localeCompare(b.lang) || a.key.localeCompare(b.key));
  }

  return { t, choose, missing, languages: Object.keys(dictionaries), fallback };
}
