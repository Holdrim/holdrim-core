/**
 * One log line, one shape, for the whole service.
 *
 * This module exists so the same running server cannot emit two different envelopes: if the API
 * wrote `{severity, event, time}` while the identity layer wrote its own, with the severity under a
 * field no collector reads, those lines would arrive with no severity at all and never match an
 * alert rule. The levels would disagree too, two spellings of one thing.
 *
 * ⚠️ English, always, and NEVER through i18n. A log is evidence, and evidence that changes wording
 * with whoever happens to be signed in is evidence nobody can grep. That covers the level, the
 * event name and the field names alike — see the comment at the top of engine/core/i18n.js for the
 * three audiences and why only one of them is translated.
 *
 * @module
 */

/**
 * The four levels, and nothing else.
 *
 * A union rather than `string` because a misspelt level is exactly the kind of typo that a reviewer
 * misses and a compiler never does. There is no DEBUG on purpose: a level nobody has configured a
 * filter for is a level that only makes the important lines harder to find.
 *
 * CRITICAL sits above ERROR, and is spent on exactly one thing so far: a text that no longer matches
 * its own hash (`reportTampered`, engine/api/texts.ts). An ordinary bug can also log ERROR, so an
 * alert rule keyed on ERROR alone would fire on both and teach whoever reads it to ignore the pager —
 * CRITICAL is reserved for "the store was written to outside the product", which is never a bug to
 * file, only a credential to rotate.
 */
export type LogLevel = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

/**
 * One JSON line per fact: log collectors understand `severity`, and an event can be found by id.
 *
 * @param level  the severity a collector routes on
 * @param event  snake_case, English, and stable — this is what someone greps for
 * @param extra  the facts. Contract VALUES (`type`, the states) go in as they are, so a log line
 *               still matches the record it is evidence about.
 * @param write  where the line goes. The server's stdout is its log. The CLI's stdout is its answer
 *               — `holdrim list --json` is data another program parses — so a line the CLI logs goes
 *               to stderr, and the envelope stays this one either way.
 */
export function log(level: LogLevel, event: string, extra: Record<string, unknown> = {},
                    write: (line: string) => void = console.log) {
  write(jsonForTerminal({ severity: level, event, time: new Date().toISOString(), ...extra }));
}

/**
 * `JSON.stringify`, with everything a terminal still acts on written as `\uXXXX`, so a value that
 * came from outside — a trigger's name in the events file, say — is printed and never obeyed.
 * `JSON.stringify` already escapes the quote, the backslash and the C0 controls (U+0000–U+001F).
 * It leaves raw DEL and the C1 controls (U+007F–U+009F; U+009B alone starts a sequence, as ESC [
 * does), the bidirectional marks, embeddings, overrides and isolates, which can make a name read as
 * another, and the two Unicode line breaks — so those are escaped here too. The result is still the
 * same JSON: parsed, it gives back exactly the value that went in.
 */
export function jsonForTerminal(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
