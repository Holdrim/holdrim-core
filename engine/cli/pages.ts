import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../core/config.js';
import { rolesOf } from '../core/roles.js';
import { parseHTML } from 'linkedom';
import { fingerprintOfText } from '../core/fingerprint.js';
import { kindOf, whatIsMissing } from '../core/kinds.js';

/**
 * Reading a repository's pages: which blocks exist, the text of each one, and the fingerprint.
 *
 * ⚠️ The text has to come out EXACTLY as the browser sees it, or the fingerprint diverges and every
 * approval falls silently. The parser in use was checked against blocks already validated with a
 * real DOM, and all of them matched. Swapping parsers means redoing that check.
 */

export interface Block {
  id: string; page: string; file: string; path: string;
  text: string; fingerprint: string; validated: string | null;
  /** Which other blocks this one depends on (`data-depends="D01.1.4 D02.3.1"`). It is what allows
   *  saying "the text did not change, but the ground did" — the red of the traffic light. */
  dependsOn: string[];
  /** The content kind: title, box, diagram, decision… (engine/core/kinds.js). */
  kind: string;
  /** The test that defends a `rule`, written as `path/to/file.test.js::name of the test`
   *  (`data-proof`). `null` when the block declares none — which, for a `rule`, the kind already
   *  reports through `missing`. It is read out here because the attribute is a POINTER: unlike every
   *  other demand, satisfying it is not something the block alone can prove. */
  proof: string | null;
  /** What this kind demands and the block does not have. Empty means ready for approval. */
  missing: string[];
  code: string;
  /** Section headings and subheadings show no number, but they ARE locked: they enter the record
   *  and have to be checked. Filtering them out would make `check` report "the block is gone" for
   *  the ones the owner has already validated. */
  numbered: boolean;
  /** Every seal attribute the block carries, whatever the case of its name, in source order (see
   *  `sealOf`). `check` compares it with the registry; `validated` alone cannot, because it is read
   *  case-sensitively and a browser is not. */
  seal: readonly SealAttribute[];
}

/**
 * The three attributes a ✓ writes onto its block — the copy of the registry the browser paints the
 * traffic light from. `data-depends` is not one of them: the author writes it, not the ✓.
 */
export const SEAL_NAMES = ['data-validated', 'data-validated-fingerprint', 'data-depended-on'] as const;

export interface SealAttribute { name: string; value: string }

/**
 * The seal attributes on `el` as the parser kept them, names as written. A browser lowercases every
 * attribute name and keeps the FIRST of two that then collide; linkedom keeps the case, so its
 * `getAttribute('data-validated-fingerprint')` misses a `DATA-VALIDATED-FINGERPRINT` sitting ahead
 * of it — which is the copy the browser shows. Reading them all, case-folded, is the only way a
 * writer or `check` sees what the panel will.
 */
export function sealOf(el: Element): SealAttribute[] {
  const names: readonly string[] = SEAL_NAMES;
  return Array.from(el.attributes ?? [])
    .filter((a) => names.includes((a as Attr).name.toLowerCase()))
    .map((a) => ({ name: (a as Attr).name, value: (a as Attr).value }));
}

/**
 * The project's configuration, read from `holdrim.json` at `root`, with the environment on top. The
 * one place the CLI reads it from disk: `readConfig` takes its reader as a parameter so it can be
 * tested without one, and five callers each building their own reader was five places to change the
 * day reading it has to change.
 */
export function ofProject(root: string) {
  return readConfig(root, { readFile: (p: string) => readFileSync(p, 'utf8') }, process.env);
}

/**
 * Who the owner and the admins of the project at `root` are, resolved exactly as the server
 * resolves them: `ofProject`, then `rolesOf`. Zero owners or two throw, here as at boot.
 *
 * ⚠️ Not `process.env.HOLDRIM_OWNER` read here. The variables are the only source, but reading them
 * in a second place is a second statement of where authority comes from, and the day one of the two
 * changes the CLI and the server disagree about whose ✓ locks and whose request needs no triage.
 */
export function projectRoles(root: string) {
  return rolesOf(ofProject(root));
}

/**
 * The page folders come from `holdrim.json` (`content.folders`), not from the code.
 *
 * Written here, they would be the hardest coupling between the engine and a single project: anyone
 * adopting the method would have to name their folders exactly as that project names its own.
 */
export function sheetFolders(root: string): string[] {
  return ofProject(root).sheetFolders.map((p: string) => join(root, ...p.split('/')));
}

export function sheetFiles(root: string): string[] {
  const out: string[] = [];
  for (const folder of sheetFolders(root)) {
    try {
      // By number, as a person counts: a plain sort puts A10 before A9, and so would the home,
      // which lists pages in the order they arrive here.
      for (const name of readdirSync(folder).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
        if (name.endsWith('.html') && !name.startsWith('_')) out.push(join(folder, name));
      }
    } catch { /* folder that does not exist in this project */ }
  }
  return out;
}

/**
 * Each file's blocks as last parsed, by the file's whole text. The server reads every page on every
 * home and every fingerprint request: at 500 pages, without this, that is 0.7 s a load, nearly all
 * of it parsing and hashing text that has not changed. Keyed by the text itself, not by mtime — an
 * edit inside the same millisecond, or a checkout that restores an old date, would fool a clock,
 * not a string.
 */
const parsed = new Map<string, { html: string; file: string; blocks: readonly Block[] }>();

/** Every block in the pages, with its fingerprint computed. */
export async function readBlocks(root: string): Promise<Map<string, Block>> {
  const map = new Map<string, Block>();
  for (const path of sheetFiles(root)) {
    const html = readFileSync(path, 'utf8');
    // The name a block is filed under comes from holdrim.json (`trimPrefix`), read live: a change
    // there has to reach the blocks as surely as a change to the page.
    const file = shortName(root, path);
    const key = `${root}\0${path}`;
    let known = parsed.get(key);
    if (known?.html !== html || known.file !== file) {
      known = { html, file, blocks: await blocksOf(file, path, html) };
      parsed.set(key, known);
    }
    for (const block of known.blocks) map.set(block.id, block);
  }
  return map;
}

/**
 * A block's text as a reader sees it, with the review UI stripped out — raw, before whitespace is
 * collapsed, because that is what the fingerprint is computed over. One function for `readBlocks`
 * and `mark`: two copies of this extraction are two places for the fingerprint a ✓ records and the
 * one the traffic light recomputes to drift apart.
 */
export function textOf(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[data-review-ui]').forEach((x: Element) => x.remove());
  return copy.textContent ?? '';
}

/**
 * The blocks of one page. Frozen, lists included, because they are shared by every later read of an
 * unchanged file: a caller that changed one would change it for the next request too, and throws
 * instead. The casts only say so to the type, whose fields are plain arrays everywhere else.
 */
async function blocksOf(file: string, path: string, html: string): Promise<readonly Block[]> {
  const blocks: Block[] = [];
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll('main [data-id]')) {
    const code = el.getAttribute('data-code') ?? '';
    const id = el.getAttribute('data-id')!;
    const text = textOf(el);
    const attributes: Record<string, string> = {};
    for (const a of Array.from(el.attributes ?? [])) attributes[(a as Attr).name] = (a as Attr).value;
    const context = {
      text: text.replace(/\s+/g, ' ').trim(), html: el.innerHTML ?? '', attributes,
    };
    const kind = kindOf({
      attributes, classes: (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
      tag: (el.tagName ?? 'div').toLowerCase(), html: context.html,
    });

    blocks.push(Object.freeze({
      id, page: id.split('.')[0], path, code,
      kind, missing: Object.freeze(whatIsMissing(kind, context)) as string[],
      proof: el.getAttribute('data-proof'),
      file,
      text: text.replace(/\s+/g, ' ').trim(),
      fingerprint: await fingerprintOfText(text),
      validated: el.getAttribute('data-validated'),
      dependsOn: Object.freeze((el.getAttribute('data-depends') ?? '').split(/\s+/).filter(Boolean)) as string[],
      numbered: /^\d+\.\d/.test(code),
      seal: Object.freeze(sealOf(el).map((a) => Object.freeze(a))),
    }));
  }
  return blocks;
}

/**
 * One block, resolved the way `readBlocks` sees blocks — a `main [data-id]` element, matched by
 * comparing the attribute's actual VALUE rather than a needle or a CSS selector built from the id,
 * which the id's own `"` or `\` could break or mis-match (holdrim#135). `mark` and `restamp` write
 * a ✓'s seal, so the write has to land on the one block a person or the server meant by that id —
 * never on "whichever matched first": zero or several candidates get no write at all, with a reason.
 */
export type BlockLookup =
  | { ok: true; path: string; html: string; element: Element }
  | { ok: false; kind: 'not-found' | 'multiple' | 'invalid'; message: string };

export function resolveBlock(root: string, id: string): BlockLookup {
  // Stated policy, not what makes a stamp safe — `spliceAttributes` verifies every write whatever
  // the id holds. An id with `"` or `&` is one whose page text carries it as an entity (`&quot;`,
  // `&amp;`), so the literal `data-id="${id}"` a splice starts from is not in the file at all; saying
  // so here names the real reason, where the splice could only say it found no safe tag. `<` and `>`
  // are not refused: inside a quoted value they are literal text, and such an id stamps like any other.
  if (/["&]/.test(id)) {
    return { ok: false, kind: 'invalid', message: 'an id containing " or & cannot be located safely' };
  }
  const matches: { path: string; html: string; element: Element }[] = [];
  for (const path of sheetFiles(root)) {
    const html = readFileSync(path, 'utf8');
    for (const element of blocksNamed(parseHTML(html).document, id)) matches.push({ path, html, element });
  }
  if (matches.length === 0) return { ok: false, kind: 'not-found', message: 'not found' };
  if (matches.length > 1) {
    return { ok: false, kind: 'multiple', message: `${matches.length} blocks carry this id` };
  }
  return { ok: true, ...matches[0] };
}

/** Every `main [data-id]` element already parsed, in document order. */
function mainBlocks(document: { querySelectorAll(selector: string): Iterable<Element> }): Element[] {
  return [...document.querySelectorAll('main [data-id]')];
}

/** The blocks of one parsed page whose id is exactly `id` — the one resolution every writer uses. */
function blocksNamed(document: { querySelectorAll(selector: string): Iterable<Element> }, id: string): Element[] {
  return mainBlocks(document).filter((el) => el.getAttribute('data-id') === id);
}

/** One attribute to write, as the text spliced between its quotes (see `attributeText`). */
export interface Stamp { attr: string; value: string }

/**
 * `value` as the text to write between an attribute's double quotes: `&` first, then `"`. Escaping
 * only `"` left a `&` that happened to start an entity for the parser to decode — a dependency id
 * holding a literal `&quot;` or `&lt;` read back as `"` or `<`, a map naming a block that does not
 * exist. `&` has to go first, or the `&` of every `&quot;` just written would be escaped again.
 */
export function attributeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** What a reader's `getAttribute` returns for text `attributeText` wrote: the two steps undone in reverse. */
function readBack(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export interface MarkPlan {
  /** `data-validated="value"`, right after the needle — only `mark` sets this; `restamp` never touches it. */
  validatedAt?: string;
  attributes: Stamp[];
  /**
   * Replace the seal the block already carries, rather than keep it. `sync` sets this: the ✓ it
   * records is newer than any seal on the page, and a kept seal leaves the registry holding the new
   * fingerprint and date while the page shows the old ones — 🟡 on a block just approved, and `check`
   * failing on the date (holdrim#140). `restamp` never sets it: it fills in only what is missing, so a
   * page value that disagrees with the registry stays there for `check` to report, instead of being
   * settled in the registry's favour by a command nobody reviews the output of.
   */
  replace?: boolean;
}

/**
 * The index of the `>` that closes a tag opened before `from`, skipping one sitting inside a quoted
 * attribute value — `title="a>b"` must not end the tag one character early. `null` when the tag
 * never closes.
 */
function tagEndFrom(html: string, from: number): number | null {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return null;
}

/**
 * Whether the needle at `start` looks like an attribute of a start tag, judged from the raw text
 * alone: whitespace right before it, and a `<` nearer than any `>`. Only an ORDER, never a verdict:
 * the occurrences that pass are tried first, so the real tag is usually reached before a single
 * re-parse is spent on a mention of the needle in prose — without that, a page with a thousand such
 * mentions took seconds. It can be wrong both ways — a `>` inside a quoted value before `data-id`
 * (`title="a -> b" data-id="y"`), or no space before it (`title="x"data-id="y"`), fails it on the
 * real tag — so the occurrences that fail are still tried afterwards, and no block is refused on
 * its word.
 */
function mayBeAttribute(html: string, start: number): boolean {
  if (!/\s/.test(html[start - 1] ?? '')) return false;
  return html.lastIndexOf('<', start) > html.lastIndexOf('>', start);
}

/**
 * Writes `plan` onto the ONE `main [data-id]` element named `id` in `html`, and nowhere else — or
 * says why it could not.
 *
 * What to insert is decided from that element's own parsed attributes, never from the raw text
 * around a needle: an attribute the element already carries is never inserted again, `data-validated`
 * included — unless `plan.replace` hands the whole seal to `reseal` — so a second copy the parser
 * would read ahead of it cannot appear (a raw-text test for "already there" is fooled by a `title`
 * that merely mentions the name, or by the attribute sitting later in the tag). Nothing left to
 * insert returns `html` untouched, without trying a splice at all.
 *
 * Where to insert is found by trying each raw occurrence of `data-id="${id}"` — it can also sit in
 * prose, a comment, a `<script>` or another element's value — the likely ones first (`mayBeAttribute`),
 * each group in document order, and accepting the first candidate that
 * (a) resolves `id` to exactly one element carrying every inserted attribute with exactly the value
 * planned, and (b) once those attributes are taken off that element again, serialises exactly like
 * the original page. Each catches what the other cannot. (a) refuses a write the parser silently
 * drops — one spliced into an end tag leaves the page serialising as before. (b) refuses a write
 * that changed anything besides those attributes: another element's attribute, a comment, a script,
 * the head, an element outside main, or the rest of the target's own tag re-tokenised around the
 * insertion — none of which comparing only the blocks' ids and texts would see.
 * The comparison is meaningful because both sides go through the same linkedom serialiser, which
 * keeps attributes in source order and re-encodes entities and whitespace identically on each side.
 * (It leaves `&` unescaped inside attribute values, so a value holding `"` and one holding a literal
 * `&quot;` serialise alike; text that is only ever inserted, never removed, cannot turn one into the
 * other.) None accepted → an error, and the caller writes nothing: no partial write.
 *
 * A seal attribute whose name is not lower case is refused here, before "nothing left to insert" is
 * even asked: `hasAttribute` does not see it, so it would be stamped around — a lower-case copy
 * added after it, which the browser ignores because it keeps the first — or counted as "already
 * there" while the browser shows its value. Only `plan.replace` removes it (`reseal`), because only
 * a new ✓ knows what the seal should say instead.
 */
export function spliceAttributes(html: string, id: string, plan: MarkPlan): { html: string } | { error: string } {
  const { document } = parseHTML(html);
  const targets = blocksNamed(document, id);
  if (targets.length !== 1) return { error: `${targets.length} blocks carry this id in this file` };
  const target = targets[0];
  const carried = sealOf(target);

  if (plan.replace && carried.length) return reseal(html, document, target, id, carried, plan);

  const upper = carried.find(({ name }) => name !== name.toLowerCase());
  if (upper) {
    return { error: `it carries ${upper.name}, which a browser reads as ${upper.name.toLowerCase()} ahead of `
      + 'any copy after it, so no seal is written beside it' };
  }

  const validated = plan.validatedAt !== undefined && !target.hasAttribute('data-validated')
    ? { attr: 'data-validated', value: plan.validatedAt } : null;
  const rest = plan.attributes.filter(({ attr }) => !target.hasAttribute(attr));
  if (!validated && !rest.length) return { html };
  const inserted = validated ? [validated, ...rest] : rest;

  const afterNeedle = validated ? ` ${validated.attr}="${validated.value}"` : '';
  const beforeTagEnd = rest.map(({ attr, value }) => ` ${attr}="${value}"`).join('');
  const cleared = inserted.map(({ attr }) => attr);
  const original = withoutSeal(document, target, cleared);
  const needle = `data-id="${id}"`;

  for (const start of occurrences(html, needle)) {
    const needleEnd = start + needle.length;
    const tagEnd = tagEndFrom(html, needleEnd);
    if (tagEnd === null) continue;

    const candidate = html.slice(0, needleEnd) + afterNeedle + html.slice(needleEnd, tagEnd)
      + beforeTagEnd + html.slice(tagEnd);
    if (writesOnlyThe(candidate, id, inserted, original, cleared)) return { html: candidate };
  }
  return { error: 'could not locate its tag without risking another block' };
}

/** Every raw occurrence of `needle`, the likely attributes first (`mayBeAttribute`), each group in document order. */
function occurrences(html: string, needle: string): number[] {
  const likely: number[] = [];
  const unlikely: number[] = [];
  for (let start = html.indexOf(needle); start !== -1; start = html.indexOf(needle, start + 1)) {
    (mayBeAttribute(html, start) ? likely : unlikely).push(start);
  }
  return [...likely, ...unlikely];
}

/**
 * The whole seal a new ✓ gives, in `SEAL_NAMES` order: every name in it ends up carrying exactly this
 * value, and a name left out — `data-depended-on` for a block that now depends on nothing — ends up
 * absent. A snapshot of dependencies the block no longer declares, kept, paints 🔴 over ground
 * nobody approved against.
 */
function sealPlanned(plan: MarkPlan): Stamp[] {
  const all = plan.validatedAt === undefined ? plan.attributes
    : [{ attr: 'data-validated', value: plan.validatedAt }, ...plan.attributes];
  return SEAL_NAMES.flatMap((name) => all.filter(({ attr }) => attr === name));
}

/**
 * `spliceAttributes` for a block that already carries a seal and a ✓ that replaces it. In the one
 * start tag the needle opens, the first copy of each seal name — any case, any quoting, no value at
 * all — is rewritten in place to the planned name and value, every later copy is removed, a name the
 * plan leaves out is removed entirely, and a name the tag lacks is inserted where a first ✓ would
 * put it. In place, rather than removed and appended, so a re-approval's diff shows the values that
 * changed and nothing moving around them.
 *
 * Accepted on the same two tests, with the seal taken as a whole: (a) the block carries each seal
 * name exactly once, case-insensitively, lower case, with exactly the planned value — or not at all,
 * where the plan leaves it out; (b) the page with every seal attribute taken off THAT block, on both
 * sides, serialises exactly like the original taken apart the same way. Only that block: a
 * whole-page removal would accept a candidate that rewrote a neighbour's seal.
 * A block already carrying exactly the planned seal, once and in lower case, is returned untouched
 * before any splice — the same "nothing to write" the first ✓ answers from the element.
 */
function reseal(html: string, document: Parsed, target: Element, id: string,
                carried: SealAttribute[], plan: MarkPlan): { html: string } | { error: string } {
  const planned = sealPlanned(plan);
  const already = carried.length === planned.length
    && planned.every(({ attr, value }) => carried.some((a) => a.name === attr && a.value === readBack(value)));
  if (already) return { html };

  const original = withoutSeal(document, target, SEAL_NAMES);
  const needle = `data-id="${id}"`;

  for (const start of occurrences(html, needle)) {
    const needleEnd = start + needle.length;
    const tag = startTagAt(html, html.lastIndexOf('<', start));
    // The needle has to BE the tag's `data-id` attribute, not text inside another attribute's value:
    // tokens found around a needle in a value belong to some other element's tag.
    if (!tag?.tokens.some((t) => t.nameAt === start && t.to === needleEnd)) continue;

    const edits: Edit[] = [];
    for (const name of SEAL_NAMES) {
      const stamp = planned.find(({ attr }) => attr === name);
      const copies = tag.tokens.filter((t) => t.name.toLowerCase() === name);
      copies.forEach((t, i) => {
        if (i === 0 && stamp) {
          edits.push({ at: t.nameAt, to: t.to, text: `${name}="${stamp.value}"` });
        } else {
          // Its leading separator goes with it, unless the next attribute starts right after it and
          // would then run into whatever precedes — the tag name itself, for the first attribute.
          edits.push({ at: t.from, to: t.to, text: SEPARATOR_OR_END.test(html[t.to] ?? '') ? '' : ' ' });
        }
      });
      if (!copies.length && stamp) {
        const at = name === 'data-validated' ? needleEnd : tag.end;
        edits.push({ at, to: at, text: ` ${name}="${stamp.value}"` });
      }
    }
    const candidate = applyEdits(html, edits);
    if (writesOnlyThe(candidate, id, planned, original, SEAL_NAMES)) return { html: candidate };
  }
  return { error: 'could not locate its tag without risking another block' };
}

/** One change to the raw text: `[at, to)` replaced by `text`; `at === to` is an insertion. */
interface Edit { at: number; to: number; text: string }

function applyEdits(html: string, edits: Edit[]): string {
  // An insertion at the same index as a removal goes first, so it lands before the removed text
  // rather than being cut out with it.
  const sorted = [...edits].sort((a, b) => a.at - b.at || a.to - b.to);
  let out = '';
  let from = 0;
  for (const { at, to, text } of sorted) {
    out += html.slice(from, at) + text;
    from = to;
  }
  return out + html.slice(from);
}

/** HTML's own whitespace — not `\s`, which also takes characters a browser keeps inside a name. */
const SPACE = /[\t\n\f\r ]/;
const SEPARATOR_OR_END = /[\t\n\f\r />]/;

/** One attribute in a raw start tag: its separator starts at `from`, its name at `nameAt`, it ends before `to`. */
interface Token { name: string; from: number; nameAt: number; to: number }

/**
 * The attributes of the start tag opening at `open`, tokenised the way the HTML standard does — a
 * name runs to whitespace, `/`, `>` or `=`; a value is double-quoted, single-quoted, unquoted up to
 * whitespace or `>`, or absent — and the index of the `>` that ends it. `null` when `open` does not
 * start a tag, or the tag never closes. It only proposes where the seal's copies sit: whatever it gets
 * wrong on a malformed tag, `writesOnlyThe` refuses.
 */
function startTagAt(html: string, open: number): { tokens: Token[]; end: number } | null {
  if (open < 0 || html[open] !== '<' || !/[A-Za-z]/.test(html[open + 1] ?? '')) return null;
  let i = open + 1;
  while (i < html.length && !SEPARATOR_OR_END.test(html[i])) i++;
  const tokens: Token[] = [];
  for (;;) {
    const from = i;
    while (i < html.length && (SPACE.test(html[i]) || html[i] === '/')) i++;
    if (i >= html.length) return null;
    if (html[i] === '>') return { tokens, end: i };
    const nameAt = i;
    i++; // the first character is the name's even when it is `=`, as the standard reads it
    while (i < html.length && !/[\t\n\f\r />=]/.test(html[i])) i++;
    const name = html.slice(nameAt, i);
    let j = i;
    while (j < html.length && SPACE.test(html[j])) j++;
    if (html[j] === '=') {
      j++;
      while (j < html.length && SPACE.test(html[j])) j++;
      const quote = html[j];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, j + 1);
        if (close === -1) return null;
        i = close + 1;
      } else {
        while (j < html.length && !/[\t\n\f\r >]/.test(html[j])) j++;
        i = j;
      }
    }
    tokens.push({ name, from, nameAt, to: i });
  }
}

/**
 * The acceptance test of one candidate, (a) and (b) in `spliceAttributes`. `getAttribute` hands
 * back the DECODED value, so each planned value is compared as `readBack` decodes it — the string a
 * reader of the page will actually get, not the escaped text that was spliced in.
 *
 * `cleared` names the seal attributes whose final state the write decides: each must be on the block
 * once — counted case-insensitively, because a browser folds `DATA-VALIDATED` into `data-validated`
 * and shows the first — in lower case, with its planned value, or be absent when `written` has no
 * value for it. Those, and only on the block, are what (b) takes off before comparing; `original`
 * has already had them taken off the same way.
 *
 * Every value on every write path today is either already safe (a date, a hex fingerprint) or goes
 * through `attributeText` first, so this comparison agrees with a bare presence check on all of them
 * — it stays a value check anyway, as the guard for a future writer that forgets to escape.
 */
function writesOnlyThe(candidate: string, id: string, written: Stamp[], original: string,
                       cleared: readonly string[]): boolean {
  const { document } = parseHTML(candidate);
  const targets = blocksNamed(document, id);
  if (targets.length !== 1) return false;
  const el = targets[0];
  const seal = sealOf(el);
  for (const name of cleared) {
    const stamp = written.find(({ attr }) => attr === name);
    const copies = seal.filter((a) => a.name.toLowerCase() === name);
    if (copies.length !== (stamp ? 1 : 0)) return false;
    if (stamp && (copies[0].name !== name || copies[0].value !== readBack(stamp.value))) return false;
  }
  return withoutSeal(document, el, cleared) === original;
}

type Parsed = ReturnType<typeof parseHTML>['document'];

/**
 * `document` serialised with every `cleared` seal name, in any case, taken off `el` — and off `el`
 * alone. It is both sides of (b): taken off every element instead, a candidate that rewrote a
 * neighbour's seal would compare equal to the original.
 */
function withoutSeal(document: Parsed, el: Element, cleared: readonly string[]): string {
  for (const { name } of sealOf(el)) if (cleared.includes(name.toLowerCase())) el.removeAttribute(name);
  return document.toString();
}

/**
 * The file name as it appears in the approvals record.
 *
 * The path relative to the root, minus whatever prefix the project asks to trim. Searching for a
 * hard-coded folder name inside the absolute path instead would, in a project without that folder,
 * get -1 back and slice from the end, returning garbage.
 */
export function shortName(root: string, path: string): string {
  const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]/, '') : path;
  const trim = ofProject(root).trimPrefix;
  return trim && rel.startsWith(trim) ? rel.slice(trim.length) : rel;
}

export function write(path: string, content: string) {
  writeFileSync(path, content, 'utf8');
}
