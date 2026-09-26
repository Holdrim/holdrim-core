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

/** One specific block, without scanning everything (used when marking a validation). */
export function findBlockFile(root: string, id: string): { path: string; html: string } | null {
  for (const path of sheetFiles(root)) {
    const html = readFileSync(path, 'utf8');
    if (html.includes(`data-id="${id}"`)) return { path, html };
  }
  return null;
}

/**
 * A block's opening tag, located by plain string search — a regex or a CSS selector built from the
 * id lets the id's own characters (`+ * ( [ | ? \` and more) change what matches, so the tag is
 * found by indexOf instead of a pattern. Returns null when the id, or its tag's `>`, is not there.
 */
export function openTag(html: string, id: string): { needleEnd: number; tagEnd: number } | null {
  const needle = `data-id="${id}"`;
  const start = html.indexOf(needle);
  if (start === -1) return null;
  const needleEnd = start + needle.length;
  const tagEnd = html.indexOf('>', needleEnd);
  return tagEnd === -1 ? null : { needleEnd, tagEnd };
}

/**
 * Inserts `attr="value"` into a block's opening tag, unless that part of the tag already has it.
 * Slicing keeps the id and the value out of a pattern entirely, and inserting by index (rather than
 * `String.replace` with a string second argument) keeps `$&`/`$1`/`$$` inside `value` — a
 * `data-depended-on` JSON blob carries other block ids — from being read as replacement syntax.
 */
export function withAttribute(html: string, id: string, attr: string, value: string): string {
  const tag = openTag(html, id);
  if (!tag) return html;
  const { needleEnd, tagEnd } = tag;
  if (html.slice(needleEnd, tagEnd).includes(attr)) return html;
  return html.slice(0, tagEnd) + ` ${attr}="${value}"` + html.slice(tagEnd);
}

/** Marks a block validated, right after its `data-id`, unless it already carries the mark. */
export function withValidatedMark(html: string, id: string, when: string): string {
  const needle = `data-id="${id}"`;
  const start = html.indexOf(needle);
  if (start === -1) return html;
  const needleEnd = start + needle.length;
  if (html.startsWith(' data-validated=', needleEnd)) return html;
  return html.slice(0, needleEnd) + ` data-validated="${when}"` + html.slice(needleEnd);
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
