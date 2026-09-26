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
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('[data-review-ui]').forEach((x: Element) => x.remove());
    const text = copy.textContent ?? '';
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
  // `"`, `&`, `<` and `>` are exactly the characters that separate one attribute, or one tag, from
  // the next in the raw text a needle-based search or a splice would work on. An id carrying one of
  // them has no literal `data-id="${id}"` to find at all — the browser would have decoded an entity
  // or closed a tag where the id's own text runs on, so refusing here is not a missing case, it is
  // the honest answer for a string this format cannot represent unescaped.
  if (/["&<>]/.test(id)) {
    return { ok: false, kind: 'invalid', message: 'an id containing ", &, < or > cannot be located safely' };
  }
  const matches: { path: string; html: string; element: Element }[] = [];
  for (const path of sheetFiles(root)) {
    const html = readFileSync(path, 'utf8');
    const { document } = parseHTML(html);
    for (const el of document.querySelectorAll('main [data-id]')) {
      if (el.getAttribute('data-id') === id) matches.push({ path, html, element: el });
    }
  }
  if (matches.length === 0) return { ok: false, kind: 'not-found', message: 'not found' };
  if (matches.length > 1) {
    return { ok: false, kind: 'multiple', message: `${matches.length} blocks carry this id` };
  }
  return { ok: true, ...matches[0] };
}

/** A block's id and text, in the shape `readBlocks` reports them — for comparing "before" and "after" a splice. */
interface Signature { id: string; text: string }

/** Every `main [data-id]` element already parsed, in document order. */
function mainBlocks(document: { querySelectorAll(selector: string): Iterable<Element> }): Element[] {
  return [...document.querySelectorAll('main [data-id]')];
}

/** The same text `readBlocks` computes: what a reader sees, with the review UI stripped out. */
function signatureOf(el: Element): Signature {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[data-review-ui]').forEach((x: Element) => x.remove());
  return { id: el.getAttribute('data-id') ?? '', text: (copy.textContent ?? '').replace(/\s+/g, ' ').trim() };
}

function signaturesOf(html: string): Signature[] {
  const { document } = parseHTML(html);
  return mainBlocks(document).map(signatureOf);
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
 * One attribute `verifiesPlan` has to find on the resolved element: `value: null` for one the plan
 * found already there and left alone (today's semantics — an existing mark or fingerprint is never
 * overwritten, so its OLD value, whatever it is, must not be demanded), `value: string` for one this
 * splice just inserted, which has to carry exactly the value written.
 */
interface Expectation { attr: string; value: string | null }

/**
 * The candidate for ONE occurrence of the needle: the html with `plan` spliced in at `start`, and
 * what a correct write must show for it — computed from `middle`, the ORIGINAL text of the tag past
 * the needle, so "already there" is asked of the tag as it was, not of a half-built candidate.
 */
function candidateFor(html: string, needleEnd: number, tagEnd: number, plan: MarkPlan):
  { candidate: string; expectations: Expectation[] } {
  const middle = html.slice(needleEnd, tagEnd);
  const expectations: Expectation[] = [];

  let afterNeedle = '';
  if (plan.validatedAt !== undefined) {
    if (middle.startsWith(' data-validated=')) {
      expectations.push({ attr: 'data-validated', value: null });
    } else {
      afterNeedle = ` data-validated="${plan.validatedAt}"`;
      expectations.push({ attr: 'data-validated', value: plan.validatedAt });
    }
  }

  let beforeTagEnd = '';
  for (const { attr, value } of plan.attributes) {
    if (middle.includes(attr)) {
      expectations.push({ attr, value: null });
    } else {
      beforeTagEnd += ` ${attr}="${value}"`;
      expectations.push({ attr, value });
    }
  }

  return {
    candidate: html.slice(0, needleEnd) + afterNeedle + middle + beforeTagEnd + html.slice(tagEnd),
    expectations,
  };
}

/**
 * Re-parses a candidate and accepts it only if the write landed on the one block meant, and on
 * nothing else: the resolved block for `id` carries every expected attribute — exactly the value
 * just inserted, or, for one already there, at least still present — and every `main [data-id]`
 * block of the page, including that one, still has the same id and the same text, in the same
 * order, as `before`. Without the second half, an insertion that happens to close a comment early,
 * or that lands inside another block's own text, could verify its OWN attributes fine while quietly
 * rewriting a neighbour.
 */
function verifiesPlan(candidate: string, id: string, expectations: Expectation[], before: Signature[]): boolean {
  const { document } = parseHTML(candidate);
  const elements = mainBlocks(document);
  const targets = elements.filter((e) => e.getAttribute('data-id') === id);
  if (targets.length !== 1) return false;
  const el = targets[0];
  for (const { attr, value } of expectations) {
    if (value === null) {
      if (!el.hasAttribute(attr)) return false;
    // `getAttribute` hands back the DECODED value — `&quot;` read as `"` — because `data-depended-on`
    // carries a `"` inside the JSON it stamps, escaped so it does not close the attribute early. The
    // written text and what a reader gets back differ only by that one entity, so undoing it is what
    // makes the comparison the same string the write intended.
    } else if (el.getAttribute(attr) !== value.replace(/&quot;/g, '"')) {
      return false;
    }
  }
  if (elements.length !== before.length) return false;
  return elements.every((e, i) => {
    const sig = signatureOf(e);
    return sig.id === before[i].id && sig.text === before[i].text;
  });
}

/**
 * Writes `plan` onto the ONE tag naming `id`, verifying before returning it rather than trusting the
 * first textual match. The needle `data-id="${id}"` can also sit in another block's own text, inside
 * an HTML comment, inside a `<script>`, or ahead of a `>` a quoted attribute value hides — any of
 * which would send a plain splice to the wrong place. So every occurrence of the needle in `html` is
 * tried, in the order it appears, and the first candidate `verifiesPlan` accepts is the one written.
 * None accepted → an error, and `html` is returned unchanged by the caller: no partial write.
 */
export function spliceAttributes(html: string, id: string, plan: MarkPlan): { html: string } | { error: string } {
  const needle = `data-id="${id}"`;
  const before = signaturesOf(html);

  for (let start = html.indexOf(needle); start !== -1; start = html.indexOf(needle, start + 1)) {
    const needleEnd = start + needle.length;
    const tagEnd = tagEndFrom(html, needleEnd);
    if (tagEnd === null) continue;

    const { candidate, expectations } = candidateFor(html, needleEnd, tagEnd, plan);
    if (verifiesPlan(candidate, id, expectations, before)) return { html: candidate };
  }
  return { error: 'could not locate its tag without risking another block' };
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
