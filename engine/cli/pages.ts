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

/** One attribute to write, and the value it must carry once written. */
export interface Stamp { attr: string; value: string }

export interface MarkPlan {
  /** `data-validated="value"`, right after the needle — only `mark` sets this; `restamp` never touches it. */
  validatedAt?: string;
  attributes: Stamp[];
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
 * Whether the needle at `start` could be an attribute of a start tag, judged from the raw text alone:
 * whitespace right before it, and a `<` nearer than any `>`. A cost filter, not a safety check — it
 * spares a full re-parse for every mention of the needle in prose, which is what made a page with a
 * thousand of them take seconds. It errs one way only: a `>` inside a quoted value BEFORE `data-id`
 * (`title="a -> b" data-id="y"`) or no space before it (`title="x"data-id="y"`) reads as "not in a
 * tag", so that block is refused, loudly, never written wrong.
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
 * included — the first date stands, and a second copy the parser would read ahead of it cannot
 * appear (a raw-text test for "already there" is fooled by a `title` that merely mentions the name,
 * or by the attribute sitting later in the tag). Nothing left to insert returns `html` untouched,
 * without trying a splice at all.
 *
 * Where to insert is found by trying each raw occurrence of `data-id="${id}"` — it can also sit in
 * prose, a comment, a `<script>` or another element's value — and accepting the first candidate that
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
 */
export function spliceAttributes(html: string, id: string, plan: MarkPlan): { html: string } | { error: string } {
  const { document } = parseHTML(html);
  const targets = blocksNamed(document, id);
  if (targets.length !== 1) return { error: `${targets.length} blocks carry this id in this file` };
  const target = targets[0];

  const validated = plan.validatedAt !== undefined && !target.hasAttribute('data-validated')
    ? { attr: 'data-validated', value: plan.validatedAt } : null;
  const rest = plan.attributes.filter(({ attr }) => !target.hasAttribute(attr));
  if (!validated && !rest.length) return { html };
  const inserted = validated ? [validated, ...rest] : rest;

  const afterNeedle = validated ? ` ${validated.attr}="${validated.value}"` : '';
  const beforeTagEnd = rest.map(({ attr, value }) => ` ${attr}="${value}"`).join('');
  const original = document.toString();
  const needle = `data-id="${id}"`;

  for (let start = html.indexOf(needle); start !== -1; start = html.indexOf(needle, start + 1)) {
    if (!mayBeAttribute(html, start)) continue;
    const needleEnd = start + needle.length;
    const tagEnd = tagEndFrom(html, needleEnd);
    if (tagEnd === null) continue;

    const candidate = html.slice(0, needleEnd) + afterNeedle + html.slice(needleEnd, tagEnd)
      + beforeTagEnd + html.slice(tagEnd);
    if (writesOnlyThe(candidate, id, inserted, original)) return { html: candidate };
  }
  return { error: 'could not locate its tag without risking another block' };
}

/**
 * The acceptance test of one candidate, (a) and (b) in `spliceAttributes`. `getAttribute` hands
 * back the DECODED value — `&quot;` read as `"` — because `data-depended-on` carries a `"` inside the
 * JSON it stamps, escaped so it does not close the attribute early; undoing that one entity is what
 * makes the comparison the same string the write intended.
 */
function writesOnlyThe(candidate: string, id: string, inserted: Stamp[], original: string): boolean {
  const { document } = parseHTML(candidate);
  const targets = blocksNamed(document, id);
  if (targets.length !== 1) return false;
  const el = targets[0];
  for (const { attr, value } of inserted) {
    if (el.getAttribute(attr) !== value.replace(/&quot;/g, '"')) return false;
  }
  for (const { attr } of inserted) el.removeAttribute(attr);
  return document.toString() === original;
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
