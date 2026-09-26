import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readConfig } from '../core/config.js';
import { rolesOf, pageOfBlock } from '../core/roles.js';
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
 * Every attribute name the engine reads a block by: what it is, what it depends on, and its seal.
 * Each is read here in lower case only, and a browser reads each in ANY case — so one written
 * otherwise is an attribute the page shows and every read in this engine walks past.
 */
export const BLOCK_NAMES: readonly string[] = ['data-id', 'data-code', 'data-depends', ...SEAL_NAMES];

/** The names in `BLOCK_NAMES` that `el` carries in some case other than lower, as written. */
export function namesNotLowerCase(el: Element): string[] {
  return Array.from(el.attributes ?? []).map((a) => (a as Attr).name)
    .filter((name) => name !== name.toLowerCase() && BLOCK_NAMES.includes(name.toLowerCase()));
}

/**
 * The id a browser gives `el`: the value of its first attribute named `data-id` in any case, which
 * is the copy a browser keeps. `null` when it carries none. linkedom's `getAttribute('data-id')`
 * sees only the lower-case spelling, so `<p Data-Id="q" data-id="y">` is `y` to it and `q` to a reader.
 */
export function browserIdOf(el: Element): string | null {
  const first = Array.from(el.attributes ?? []).find((a) => (a as Attr).name.toLowerCase() === 'data-id');
  return first ? (first as Attr).value : null;
}

/**
 * Every element under `main` a browser selects as a block, with the id it reads there. A browser
 * matches `main [data-id]` case-insensitively on the name, so this is the list the panel paints;
 * linkedom's own `main [data-id]` is not, because it matches the name case-sensitively.
 */
export function browserBlocks(document: { querySelectorAll(selector: string): Iterable<Element> }):
  { element: Element; id: string }[] {
  const out: { element: Element; id: string }[] = [];
  for (const element of document.querySelectorAll('main *')) {
    const id = browserIdOf(element);
    if (id !== null) out.push({ element, id });
  }
  return out;
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
      // `pageOfBlock`, the one derivation a scope is judged by too (engine/core/roles.js).
      id, page: pageOfBlock(id), path, code,
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
  | { ok: true; path: string; html: string; element: Element; document: Parsed }
  | { ok: false; kind: 'not-found' | 'multiple' | 'invalid'; message: string };

export function resolveBlock(root: string, id: string): BlockLookup {
  const found = scanBlocks(root, [id], (path, html, element, document) => ({ path, html, element, document })).get(id)!;
  return found.ok ? { ok: true, ...found.found } : found;
}

/**
 * Where each id lives, for `markAll` and `restamp`: the page, and a digest of the text it was found
 * in — the same answer `resolveBlock` gives each id alone, the same pages in the same order, the same
 * refusals, from one read and parse per page for all of them. Only the path and the digest outlive the page's
 * parse. Every touched page's text and parsed document, held until the last page is stamped, make a
 * sync's memory grow with the whole site — about 100 MB for 500 pages of 100 KB — where stamping needs
 * one page at a time; the page is read again when its turn comes, and the digest says whether it is
 * still the page these answers are about.
 */
export type Location = { ok: true; path: string; digest: string } | Extract<BlockLookup, { ok: false }>;

export function locateBlocks(root: string, ids: readonly string[]): Map<string, Location> {
  const digests = new Map<string, string>();
  const located = scanBlocks(root, ids, (path, html) => {
    let digest = digests.get(path);
    if (digest === undefined) digests.set(path, digest = digestOf(html));
    return { path, digest };
  });
  return new Map([...located].map(([id, found]): [string, Location] => [id, found.ok ? { ok: true, ...found.found } : found]));
}

/** What `locateBlocks` compares a page's text by: equal digests, equal text, without keeping the text. */
export function digestOf(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

/**
 * Every block's id and fingerprint, computed one page at a time — `sync`'s `fingerprintsNow`, which
 * checks a dependency's ground and an approved id's own text, and needs nothing more than that pair
 * to do either. `readBlocks` answers a richer question — a block's kind, text, seal, what it is
 * missing — kept in the `parsed` cache for the life of the process, because the server asks it that
 * question on every request; calling it here would hold every page's full text and parsed document
 * for as long as `sync` runs, on top of whatever `markAll` holds one page of at a time (holdrim#144,
 * round 3). This bypasses that cache entirely: each page is read, parsed for its ids and fingerprints,
 * and let go before the next, so what outlives the loop is an id and a 16-character hash per block —
 * not the page it came from.
 */
export async function fingerprintsByPage(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const path of sheetFiles(root)) {
    const html = readFileSync(path, 'utf8');
    const { document } = parseHTML(html);
    for (const el of document.querySelectorAll('main [data-id]')) {
      // `blocksOf` reads the same selector with the same `!` — the selector already guarantees the
      // attribute is there, even when its value is `''`, and `readBlocks` keeps that block under id
      // `''` too. `if (id)` here would silently drop it instead of matching that.
      out.set(el.getAttribute('data-id')!, await fingerprintOfText(textOf(el)));
    }
  }
  return out;
}

/** A page read afresh, parsed once, with its blocks by id — what `markAll` and `restamp` plan and splice from. */
export function parsePage(html: string): { document: Parsed; byId: Map<string, Element[]> } {
  const { document } = parseHTML(html);
  return { document, byId: blocksById(document) };
}

/**
 * The one pass `resolveBlock` and `locateBlocks` share: every page read and parsed once for all
 * `ids`, and each element an id names handed to `keep` while its page is parsed — what `keep`
 * returns is all that outlives the page. Asked one id at a time, a sync of N blocks parsed every
 * page N times. Each id ends refused, or with exactly one kept value.
 */
function scanBlocks<T>(root: string, ids: readonly string[],
                       keep: (path: string, html: string, element: Element, document: Parsed) => T):
  Map<string, { ok: true; found: T } | Extract<BlockLookup, { ok: false }>> {
  const out = new Map<string, { ok: true; found: T } | Extract<BlockLookup, { ok: false }>>();
  const matches = new Map<string, T[]>();
  for (const id of ids) {
    // Stated policy, not what makes a stamp safe — `spliceAttributes` verifies every write whatever
    // the id holds. An id with `"` or `&` is one whose page text carries it as an entity (`&quot;`,
    // `&amp;`), so the literal `data-id="${id}"` a splice starts from is not in the file at all; saying
    // so here names the real reason, where the splice could only say it found no safe tag. `<` and `>`
    // are not refused: inside a quoted value they are literal text, and such an id stamps like any other.
    if (/["&]/.test(id)) out.set(id, { ok: false, kind: 'invalid', message: 'an id containing " or & cannot be located safely' });
    else matches.set(id, []);
  }
  for (const path of sheetFiles(root)) {
    const html = readFileSync(path, 'utf8');
    const { document } = parseHTML(html);
    const byId = blocksById(document);
    const browserIds = new Set(browserBlocks(document).map((b) => b.id));
    let odd: string | null | undefined;
    for (const [id, found] of matches) {
      if (out.has(id)) continue;
      const named = byId.get(id) ?? [];
      // A page where a browser finds a block linkedom does not — `DATA-ID`, or a `Data-Id` ahead of the
      // `data-id` read here — or reads its code or dependencies from a name linkedom skips, is a page the
      // seal would be written onto blind: the id resolved here may not be the block the browser paints
      // under it, and a twin in any case is a second seal nothing here sees. So such a page refuses, as a
      // whole, and says which name to fix. The seal names are left to `spliceAttributes`, which refuses
      // them on the block itself or, for a new ✓, replaces them.
      if (named.length || browserIds.has(id)) {
        if (odd === undefined) odd = oddIdentityName(document);
        if (odd) {
          out.set(id, { ok: false, kind: 'invalid', message: `${shortName(root, path)} carries ${odd}, which a browser `
            + `reads as ${odd.toLowerCase()} and this engine does not, so no seal is written on that page` });
          continue;
        }
      }
      for (const element of named) found.push(keep(path, html, element, document));
    }
  }
  for (const [id, found] of matches) {
    if (out.has(id)) continue;
    if (found.length === 0) out.set(id, { ok: false, kind: 'not-found', message: 'not found' });
    else if (found.length > 1) out.set(id, { ok: false, kind: 'multiple', message: `${found.length} blocks carry this id` });
    else out.set(id, { ok: true, found: found[0] });
  }
  return out;
}

/** The first name on the page, on any element, that decides which block an id names and is not written in lower case. */
function oddIdentityName(document: Parsed): string | null {
  const identity = BLOCK_NAMES.filter((name) => !(SEAL_NAMES as readonly string[]).includes(name));
  for (const el of document.querySelectorAll('*')) {
    const odd = namesNotLowerCase(el).find((name) => identity.includes(name.toLowerCase()));
    if (odd) return odd;
  }
  return null;
}

/** Every `main [data-id]` element already parsed, in document order. */
function mainBlocks(document: { querySelectorAll(selector: string): Iterable<Element> }): Element[] {
  return [...document.querySelectorAll('main [data-id]')];
}

/** The blocks of one parsed page whose id is exactly `id` — the one resolution every writer uses. */
function blocksNamed(document: { querySelectorAll(selector: string): Iterable<Element> }, id: string): Element[] {
  return blocksById(document).get(id) ?? [];
}

/**
 * `blocksNamed` for every id on the page in one pass, in document order within each id. Asked id by
 * id, a page of N blocks is walked N times.
 */
function blocksById(document: { querySelectorAll(selector: string): Iterable<Element> }): Map<string, Element[]> {
  const byId = new Map<string, Element[]>();
  for (const el of mainBlocks(document)) {
    const id = el.getAttribute('data-id')!;
    const list = byId.get(id);
    if (list) list.push(el);
    else byId.set(id, [el]);
  }
  return byId;
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
 *
 * A second scanner beside `startTagAt`, on purpose. This one opens a quote at ANY `'` or `"`, where
 * the standard opens one only right after `=`: on a tag like `<p data-id="y" it's>`, whose `it's` is
 * one attribute name to a browser, it runs past the real `>` and every candidate it offers is refused
 * by `writesOnlyThe`. `startTagAt` finds the real `>` there and the write it offers is accepted — so
 * swapping it in here changes what a first ✓ does on those tags from a refusal to a stamp, which the
 * #141 tests pin as refusals. Where the two disagree is only on such malformed tags, and both only
 * PROPOSE a place: `writesOnlyThe` decides for either. Making the first ✓ stamp there is its own change.
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
 * included — unless `plan.replace` hands the whole seal to `prepareReseal` — so a second copy the parser
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
 * there" while the browser shows its value. Only `plan.replace` removes it (`prepareReseal`), because only
 * a new ✓ knows what the seal should say instead.
 */
export function spliceAttributes(html: string, id: string, plan: MarkPlan): { html: string } | { error: string } {
  const { document } = parseHTML(html);
  const targets = blocksNamed(document, id);
  if (targets.length !== 1) return { error: `${targets.length} blocks carry this id in this file` };
  const prepared = prepare(html, targets[0], id, plan);
  if ('error' in prepared) return prepared;
  if ('unchanged' in prepared) return { html };

  const original = withoutSeal(document, targets[0], prepared.cleared);
  for (const edits of prepared.candidates) {
    const candidate = applyEdits(html, edits);
    if (writesOnlyThe(candidate, id, prepared.written, original, prepared.cleared)) return { html: candidate };
  }
  return { error: prepared.exhausted() };
}

/**
 * One block's write, decided before any candidate is tried: what (a) must find on the block
 * (`written`), which seal names are the write's to decide (`cleared`), and the places to try, as edits
 * to the raw text, in the order `spliceAttributes` tries them. Everything read off `target` is read
 * here, eagerly, because the caller then takes `cleared` off it to build (b)'s original. `exhausted`
 * is the refusal once every candidate has been tried and none accepted.
 */
type Preparation =
  | { unchanged: true }
  | { error: string }
  | { written: Stamp[]; cleared: readonly string[]; candidates: Iterable<Edit[]>; exhausted: () => string };

function prepare(html: string, target: Element, id: string, plan: MarkPlan): Preparation {
  const carried = sealOf(target);
  if (plan.replace && carried.length) return prepareReseal(html, target, id, carried, plan);

  const upper = carried.find(({ name }) => name !== name.toLowerCase());
  if (upper) {
    return { error: `it carries ${upper.name}, which a browser reads as ${upper.name.toLowerCase()} ahead of `
      + 'any copy after it, so no seal is written beside it' };
  }

  const validated = plan.validatedAt !== undefined && !target.hasAttribute('data-validated')
    ? { attr: 'data-validated', value: plan.validatedAt } : null;
  const rest = plan.attributes.filter(({ attr }) => !target.hasAttribute(attr));
  if (!validated && !rest.length) return { unchanged: true };
  const inserted = validated ? [validated, ...rest] : rest;

  const afterNeedle = validated ? ` ${validated.attr}="${validated.value}"` : '';
  const beforeTagEnd = rest.map(({ attr, value }) => ` ${attr}="${value}"`).join('');
  const needle = `data-id="${id}"`;

  function* candidates(): Generator<Edit[]> {
    for (const start of occurrences(html, needle)) {
      const needleEnd = start + needle.length;
      const tagEnd = tagEndFrom(html, needleEnd);
      if (tagEnd === null) continue;
      yield [{ at: needleEnd, to: needleEnd, text: afterNeedle }, { at: tagEnd, to: tagEnd, text: beforeTagEnd }];
    }
  }
  return { written: inserted, cleared: inserted.map(({ attr }) => attr), candidates: candidates(),
    exhausted: () => 'could not locate its tag without risking another block' };
}

/** One page's stamps for `spliceAll`: which block, and the plan `spliceAttributes` would take for it. */
export interface PageStamp { id: string; plan: MarkPlan }

/**
 * Every stamp of one page written onto `html` at once, verified once — `spliceAttributes` for each of
 * them, at the cost of one: a sync of N blocks on one page used to parse, splice, re-parse and
 * serialise the whole page for every block, and a thousand blocks took minutes.
 *
 * Each stamp's first candidate (`prepare`) is spliced in together, and the page that results is held
 * to (a) and (b) for all of them in one parse: (a) every target resolves to exactly one element
 * carrying exactly its own planned seal, and (b) once each target's own `cleared` names — and only
 * those, and only on that target — are taken off, on both sides, the page serialises exactly like the
 * original. That is the same claim the per-block writes make one after another, made about the page
 * they end in: each per-block (b) keeps everything but one target's cleared names as it was, so the
 * last page differs from the first only in the targets' cleared names, and each per-block (a) pins
 * what those say. A write that touched a neighbour's seal is seen by the neighbour's own (a) when it
 * is a target and by (b) when it is not; a write the parser drops is seen by its own (a).
 *
 * When the whole page is refused, the stamps are halved until each refusal is down to a single
 * stamp, which then goes through `spliceAttributes` alone, on the page as it stands with the others
 * written: it tries that block's later candidates as it always has, and a block no candidate fits is
 * refused alone with the reason it always gave, while the rest of the page is stamped. The stamps the
 * halving accepted were each verified only inside their own half, so they are verified once more,
 * together, before any of them is written; refused together — two writes safe apart and not together
 * — every stamp goes through `spliceAttributes` one after another, exactly the per-block path. Without
 * that last verification, a page whose halves each passed is written as a whole nobody verified. Each
 * result is `{ ok: true }` or the error `spliceAttributes` would give; the returned `html` carries only
 * the accepted ones. A stamp with nothing left to write — the block already carries all of it — is
 * `{ ok: true, unchanged: true }`: `restamp` counts it as "already had it", and cannot tell it from a
 * written one by comparing pages, because the page as a whole changed for the other stamps on it.
 *
 * Two paths here are safety nets that no page found so far needs. The per-block fallback: linkedom
 * reads each tag on its own, and no page is known whose writes are safe apart and refused together.
 * `verify` is there so a test can make one — "spliceAll verifies the stamps the halving accepted
 * together, and goes block by block when they are refused together" — and it defaults to the real
 * check. And the overlap guard below: the `it's` page of "sync stamps the other blocks of a page and
 * refuses only the one whose seal the parser would drop" reaches it, but its edits are insertions,
 * which compose in any order, so with or without the guard that page ends the same; whatever edits are
 * composed, the page they make is verified before it is written.
 */
export function spliceAll(html: string, document: Parsed, stamps: readonly PageStamp[], verify: Verifier = verifyAll):
  { html: string; results: Spliced[] } {
  const results: Spliced[] = stamps.map(() => ({ ok: true }));
  const byId = blocksById(document);
  const batch: Batched[] = [];
  const alone: number[] = [];
  for (const [i, { id, plan }] of stamps.entries()) {
    const targets = byId.get(id) ?? [];
    if (targets.length !== 1) { results[i] = { error: `${targets.length} blocks carry this id in this file` }; continue; }
    const prepared = prepare(html, targets[0], id, plan);
    if ('error' in prepared) { results[i] = prepared; continue; }
    if ('unchanged' in prepared) { results[i] = { ok: true, unchanged: true }; continue; }
    const first = prepared.candidates[Symbol.iterator]().next();
    if (first.done) { alone.push(i); continue; }
    batch.push({ index: i, id, written: prepared.written, cleared: prepared.cleared, edits: first.value });
  }

  // Two stamps whose edits reach into the same stretch of text cannot be applied together in any
  // meaningful order; the later one waits and is tried alone.
  const disjoint: Batched[] = [];
  let reach = -1;
  for (const entry of [...batch].sort((a, b) => spanOf(a).at - spanOf(b).at)) {
    const { at, to } = spanOf(entry);
    if (at <= reach) { alone.push(entry.index); continue; }
    disjoint.push(entry);
    reach = to;
  }

  const accepted = accept(html, disjoint, verify);
  if (!accepted.whole && verify(html, accepted.good) === null) return spliceOneByOne(html, stamps, results);
  let out = accepted.good.length ? applyEdits(html, accepted.good.flatMap((e) => e.edits)) : html;
  for (const i of [...alone, ...accepted.bad.map((e) => e.index)].sort((a, b) => a - b)) {
    [out, results[i]] = spliceOne(out, stamps[i]);
  }
  return { html: out, results };
}

/** What `spliceAll` says of one stamp: written, already there (`unchanged`), or refused with the reason. */
export type Spliced = { ok: true; unchanged?: true } | { error: string };

/** `spliceAttributes` for one stamp on `html`, as the page it leaves and its `Spliced` result. */
function spliceOne(html: string, { id, plan }: PageStamp): [string, Spliced] {
  const result = spliceAttributes(html, id, plan);
  if ('error' in result) return [html, result];
  return [result.html, result.html === html ? { ok: true, unchanged: true } : { ok: true }];
}

/** One stamp inside `spliceAll`: where it sits in the caller's list, and its first candidate. */
export interface Batched { index: number; id: string; written: Stamp[]; cleared: readonly string[]; edits: Edit[] }

/** The stretch of raw text a stamp's edits cover, from the first one's start to the last one's end. */
function spanOf({ edits }: Batched): { at: number; to: number } {
  return { at: Math.min(...edits.map((e) => e.at)), to: Math.max(...edits.map((e) => e.to)) };
}

/**
 * The stamps `verify` accepts, found by halving: a group accepted whole is kept whole, and a group
 * refused is split until each refusal is one stamp. Only the refused stamps cost more than the one
 * verification of the whole page — a few halvings each. `whole` says the `good` returned were
 * verified as one group; after a split they were not, and `spliceAll` verifies them together.
 */
function accept(html: string, entries: Batched[], verify: Verifier): { good: Batched[]; bad: Batched[]; whole: boolean } {
  if (!entries.length || verify(html, entries) !== null) return { good: entries, bad: [], whole: true };
  if (entries.length === 1) return { good: [], bad: entries, whole: false };
  const half = Math.ceil(entries.length / 2);
  const left = accept(html, entries.slice(0, half), verify);
  const right = accept(html, entries.slice(half), verify);
  return { good: [...left.good, ...right.good], bad: [...left.bad, ...right.bad], whole: false };
}

/** The check `spliceAll` holds a group of stamps to: the page they make together, or `null` when it is refused. */
export type Verifier = (html: string, entries: readonly Batched[]) => string | null;

/**
 * (a) and (b) of `writesOnlyThe`, for every stamp in `entries` at once, on `html` with all their edits
 * applied. The candidate page, or `null` when it is refused.
 */
function verifyAll(html: string, entries: readonly Batched[]): string | null {
  const candidate = applyEdits(html, entries.flatMap((e) => e.edits));
  const before = parseHTML(html).document;
  const beforeById = blocksById(before);
  const original = withoutSeals(before, entries.map((e) => [beforeById.get(e.id)![0], e.cleared]));

  const after = parseHTML(candidate).document;
  const afterById = blocksById(after);
  const stripped: [Element, readonly string[]][] = [];
  for (const { id, written, cleared } of entries) {
    const targets = afterById.get(id) ?? [];
    if (targets.length !== 1 || !carriesExactly(targets[0], written, cleared)) return null;
    stripped.push([targets[0], cleared]);
  }
  return withoutSeals(after, stripped) === original ? candidate : null;
}

/** Every stamp through `spliceAttributes`, one after another on the page each leaves — the per-block path. */
function spliceOneByOne(html: string, stamps: readonly PageStamp[], results: Spliced[]):
  { html: string; results: Spliced[] } {
  let out = html;
  for (const [i, stamp] of stamps.entries()) {
    if ('error' in results[i]) continue;
    [out, results[i]] = spliceOne(out, stamp);
  }
  return { html: out, results };
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
function prepareReseal(html: string, target: Element, id: string, carried: SealAttribute[], plan: MarkPlan): Preparation {
  const planned = sealPlanned(plan);
  const already = carried.length === planned.length
    && planned.every(({ attr, value }) => carried.some((a) => a.name === attr && a.value === readBack(value)));
  if (already) return { unchanged: true };

  // Taken here, not inside `candidates`: that runs later, after the caller's `withoutSeal` has
  // stripped the seal off `target` itself.
  const parsedNames = Array.from(target.attributes ?? []).map((a) => (a as Attr).name);
  const needle = `data-id="${id}"`;
  let hidden = false;

  function* candidates(): Generator<Edit[]> {
    for (const start of occurrences(html, needle)) {
      const needleEnd = start + needle.length;
      const tag = startTagAt(html, html.lastIndexOf('<', start));
      // The needle has to BE the tag's `data-id` attribute, not text inside another attribute's value:
      // tokens found around a needle in a value belong to some other element's tag.
      if (!tag?.tokens.some((t) => t.nameAt === start && t.to === needleEnd)) continue;
      // And the `<` has to be where the element's tag really starts. One inside an earlier quoted value
      // (`title="a<b"`) still reads the needle as an attribute, but whatever sits before it — a seal copy
      // included — is out of sight: rewritten or not, it stays, and (a) cannot count it, because the
      // parser keeps only the first of two copies spelt alike and (a) reads the parser. So the names read
      // from this `<` must be the parser's own, in order, each first copy only, as the parser keeps them:
      // the attribute holding the `<`, and any before it, is one the parser lists and this reading does
      // not. A value that spells those names out itself can still line the lists up; then every copy the
      // parser keeps is out of reach of the edits, and (a) accepts only where it already reads the
      // planned seal. Finding the real `<` further back instead would mean trusting a backwards guess the
      // raw text cannot settle — every `<` inside a value looks like a tag start — so this is a refusal.
      const tokenNames = [...new Set(tag.tokens.map((t) => t.name))];
      if (tokenNames.join('\0') !== parsedNames.join('\0')) { hidden = true; continue; }

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
      yield edits;
    }
  }
  return { written: planned, cleared: SEAL_NAMES, candidates: candidates(),
    exhausted: () => hidden
      ? 'a "<" inside one of its attribute values hides where its start tag begins, so its whole '
        + 'seal cannot be seen to be replaced — write that "<" as &lt;'
      : 'could not locate its tag without risking another block' };
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
  if (!carriesExactly(el, written, cleared)) return false;
  return withoutSeal(document, el, cleared) === original;
}

/** (a) for one block: each `cleared` name on `el` once, in lower case, with its value in `written` — or absent when `written` has none. */
function carriesExactly(el: Element, written: Stamp[], cleared: readonly string[]): boolean {
  const seal = sealOf(el);
  for (const name of cleared) {
    const stamp = written.find(({ attr }) => attr === name);
    const copies = seal.filter((a) => a.name.toLowerCase() === name);
    if (copies.length !== (stamp ? 1 : 0)) return false;
    if (stamp && (copies[0].name !== name || copies[0].value !== readBack(stamp.value))) return false;
  }
  return true;
}

type Parsed = ReturnType<typeof parseHTML>['document'];

/**
 * `document` serialised with every `cleared` seal name, in any case, taken off `el` — and off `el`
 * alone. It is both sides of (b): taken off every element instead, a candidate that rewrote a
 * neighbour's seal would compare equal to the original.
 */
function withoutSeal(document: Parsed, el: Element, cleared: readonly string[]): string {
  return withoutSeals(document, [[el, cleared]]);
}

/** `withoutSeal` for several blocks at once, each losing only its own `cleared` names — `spliceAll`'s (b). */
function withoutSeals(document: Parsed, blocks: readonly (readonly [Element, readonly string[]])[]): string {
  for (const [el, cleared] of blocks) {
    for (const { name } of sealOf(el)) if (cleared.includes(name.toLowerCase())) el.removeAttribute(name);
  }
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
