import { readBlocks, projectRoles, type Block } from './pages.ts';
import { refuseToActOnBrokenGuards } from './requests.ts';
import type { Source } from './remote.ts';
import type { Event } from '../api/types.ts';
import { GLOSSARY_TERMS, termsIn } from '../core/glossary.js';

/**
 * `holdrim propose-deps`: a missing `data-depends` is invisible until something breaks. Two blocks
 * that talk about the same concept of the method and do not name each other are the shape a missing
 * dependency takes before anybody notices — so this proposes one, deterministically, from the
 * glossary alone, with no model involved and no guess at which direction the dependency runs.
 *
 * It writes NOTHING onto a block. It writes a `request`, of category `dependency`, exactly the way
 * a person's `term` or `text` request is written from the panel — the owner triages it like any
 * other, and only an approved-and-applied one ever becomes a real `data-depends`, added by hand in
 * the commit that applies it. A proposal that edited a page directly would be the very thing this
 * engine exists to stop: an unreviewed change nobody asked for.
 */

/** One pair of blocks proposed to depend on one another, and why. */
export interface Proposal { a: string; b: string; page: string; terms: string[]; text: string; }

/**
 * The line every proposal's `text` starts with, and the one thing `existingProposalMarkers` reads
 * back — `a` and `b` already sorted, so the SAME pair always produces the SAME marker regardless of
 * which block a caller happened to name first.
 */
function marker(a: string, b: string): string {
  return `Proposed dependency: ${a} ⇄ ${b}`;
}

/**
 * Every pair a PAST run of `propose-deps` already put in front of the owner, from the events
 * themselves — never from a second store of "what was already proposed", which would drift from the
 * events the moment anybody edited one by hand. Read from `text`, not `data`: a request's `data` is
 * the small, closed vocabulary every event shares (`category`, `commit`, …), the same way a `term`
 * or `text` request already carries its whole explanation in `text` and nothing else.
 */
export function existingProposalMarkers(events: Event[]): Set<string> {
  const found = new Set<string>();
  for (const e of events) {
    if (e.type !== 'request' || e.data?.category !== 'dependency' || typeof e.text !== 'string') continue;
    const m = /^Proposed dependency: (\S+) ⇄ (\S+)/.exec(e.text);
    if (m) found.add(marker(m[1], m[2]));
  }
  return found;
}

/**
 * The wording of one proposal. It says WHY (the shared term(s)) and is explicit that sharing a term
 * is a reason to look, never a claim that one block truly depends on the other — the direction is
 * for the owner to decide, not for this to guess.
 */
function textOf(a: string, b: string, terms: string[]): string {
  const quoted = terms.map((t) => `"${t}"`).join(', ');
  const plural = terms.length > 1 ? 's' : '';
  return `${marker(a, b)} — both blocks use the glossary term${plural} ${quoted}, and neither `
    + 'declares a data-depends on the other. This is a deterministic match on docs/GLOSSARY.md, not '
    + 'a claim that one truly depends on the other, or in which direction — only that a human should '
    + 'look, and add a data-depends by hand if one is real.';
}

/**
 * The proposals themselves: every unordered pair of blocks that (a) share at least one glossary
 * term, (b) do not already declare a `data-depends` on one another in either direction, and (c) is
 * not already covered by an entry in `existing`. Deterministic and idempotent — the same blocks and
 * the same prior proposals always produce the same list, in the same order, and a second run against
 * unchanged content produces nothing new.
 *
 * The output order never depends on the order `blocks` happens to iterate in: `a`/`b` are always
 * the pair's two ids compared and swapped into place (never "whichever came first in the scan"),
 * the shared terms of a pair are gathered into a `Set` and sorted before they reach `textOf`, and
 * the pairs themselves are sorted once, explicitly, right before they are returned — three places a
 * caller's insertion order could otherwise leak into the answer, all closed the same way: never
 * trust iteration order, always sort before it is read.
 */
export function proposalsOf(blocks: Map<string, Block>, existing: Set<string>): Proposal[] {
  // term → every block id that mentions it.
  const byTerm = new Map<string, string[]>();
  for (const block of blocks.values()) {
    for (const term of termsIn(block.text)) {
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term)!.push(block.id);
    }
  }

  const pairs = new Map<string, { a: string; b: string; terms: Set<string> }>();
  for (const term of GLOSSARY_TERMS) {
    const ids = byTerm.get(term);
    if (!ids || ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
        if (a === b) continue;
        const from = blocks.get(a)!, to = blocks.get(b)!;
        // Already linked, whichever way round — proposing it again would ask the owner to decide
        // something the page has already decided.
        if (from.dependsOn.includes(b) || to.dependsOn.includes(a)) continue;
        const key = `${a}\u0000${b}`;
        if (!pairs.has(key)) pairs.set(key, { a, b, terms: new Set() });
        pairs.get(key)!.terms.add(term);
      }
    }
  }

  return [...pairs.values()]
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
    .map(({ a, b, terms }) => {
      const sortedTerms = [...terms].sort();
      return { a, b, page: blocks.get(a)!.page, terms: sortedTerms, text: textOf(a, b, sortedTerms) };
    })
    .filter((p) => !existing.has(marker(p.a, p.b)));
}

/**
 * `holdrim propose-deps`: reads the blocks and the events, works out what is new, and — unless
 * `--dry-run` — writes each one as a `request` through `source.add`, the SAME door `state` and
 * `apply` write through, so it goes through the cycle, the roles and the limits like anything else
 * an agent files.
 */
export async function proposeDeps(root: string,
  source: Pick<Source, 'events' | 'add'> & Partial<Pick<Source, 'guardsTampered'>>,
  options: { dryRun?: boolean } = {}): Promise<number> {
  // Same two guards `list`, `sync` and `apply` run before touching a project: authority is the
  // deployment's alone (`projectRoles` refuses a holdrim.json naming one), and a write never
  // happens against a store whose guards are not the ones this version installs (`requests.ts`,
  // `refuseToActOnBrokenGuards`) — this reads `events` to decide what NOT to repeat, so a forged
  // `data` in there is exactly the kind of thing that must not silently steer what gets proposed.
  projectRoles(root);
  const blocks = await readBlocks(root);
  const events = await source.events();
  refuseToActOnBrokenGuards(source);
  const proposals = proposalsOf(blocks, existingProposalMarkers(events));

  if (!proposals.length) {
    console.log('no proposed dependency: no two blocks share a glossary term without already '
      + 'depending on one another, or every such pair was proposed before.');
    return 0;
  }
  for (const p of proposals) {
    const shared = p.terms.join(', ');
    if (options.dryRun) {
      console.log(`would propose: ${p.a} ${'⇄'} ${p.b}  (${shared})`);
      continue;
    }
    const id = await source.add({ type: 'request', page: p.page, block: p.a, text: p.text, data: { category: 'dependency' } });
    console.log(`proposed: ${p.a} ${'⇄'} ${p.b}  (${shared}) — request ${id.slice(0, 8)}`);
  }
  return 0;
}
