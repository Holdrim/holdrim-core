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
 * The three levels, and nothing else.
 *
 * A union rather than `string` because a misspelt level is exactly the kind of typo that a reviewer
 * misses and a compiler never does. There is no DEBUG on purpose: a level nobody has configured a
 * filter for is a level that only makes the important lines harder to find.
 */
export type LogLevel = 'INFO' | 'WARNING' | 'ERROR';

/**
 * One JSON line per fact: log collectors understand `severity`, and an event can be found by id.
 *
 * @param level  the severity a collector routes on
 * @param event  snake_case, English, and stable — this is what someone greps for
 * @param extra  the facts. Contract VALUES (`type`, the states) go in as they are, so a log line
 *               still matches the record it is evidence about.
 */
export function log(level: LogLevel, event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ severity: level, event, time: new Date().toISOString(), ...extra }));
}
