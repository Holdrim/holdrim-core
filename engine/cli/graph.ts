import { readBlocks, type Block } from './pages.ts';
import { loadRegistry, type Registry } from './validation.ts';
import { trafficLight, COLOURS } from '../core/validity.js';
import { pageOfBlock } from '../core/roles.js';

/**
 * The documentation graph, for scripts, other tools and review — outside the browser.
 *
 * `holdrim graph` builds NOTHING of its own: `graphOf` reads the same blocks `readBlocks` gives
 * every other command, and the same `trafficLight` that colours `lights` and the panel. A second
 * computation here — a re-derived state, a re-walked dependency list — is exactly the drift this
 * engine exists to catch elsewhere, and it would be no less wrong for happening in the tool that
 * reads dependencies for a living.
 *
 * Issue #40 (Mermaid rendered in the panel) draws its OWN picture, in the browser, from the
 * browser's own data. Nothing here is written for it to import, and nothing it does should change
 * what this file prints: a script that runs `holdrim graph --json` in CI cannot depend on what a
 * person happens to have open in a tab.
 */

/**
 * `missing` is not a traffic-light state — `engine/core/validity.js` knows nothing of it, and
 * never will. It marks a node this module invented because an edge named it and no block answers
 * to the name: a dangling `data-depends`, drawn instead of silently swallowed.
 */
export type GraphState = 'none' | 'valid' | 'stale' | 'broken' | 'missing';

/** One block, as the graph draws it: enough to place it and to say what state it is in. */
export interface GraphNode { id: string; page: string; kind: string; state: GraphState; }

/** One `data-depends` edge, in the direction the attribute is written: `from` depends on `to`. */
export interface GraphEdge { from: string; to: string; }

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; }

/**
 * The graph, built from the blocks and the registry — never from the HTML twice. Both lists are
 * sorted here, once, so every format below can write them out as it reads them and still be
 * deterministic: the same documentation gives the same bytes, which is what makes `--json` diffable
 * in a pull request and `--mermaid` reproducible in CI.
 */
export function graphOf(blocks: Map<string, Block>, registry: Registry): Graph {
  const { byBlock } = trafficLight(blocks, registry);

  const real: GraphNode[] = [...blocks.values()]
    .map((b) => ({ id: b.id, page: b.page, kind: b.kind, state: (byBlock.get(b.id)?.state ?? 'none') as GraphState }));

  // The edge is `from` (the block that declares `data-depends`) toward `to` (what it names) — the
  // same direction `dependsOn` is stored in, and the one `if-i-touch` walks backwards to answer
  // "what turns red if I touch this". Drawing it the other way would make an arrow mean two
  // different things depending on which command you asked.
  const edges = [...blocks.values()]
    .flatMap((b) => b.dependsOn.map((to) => ({ from: b.id, to })))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // `mark()` (engine/cli/validation.ts) already warns and moves on when a declared dependency does
  // not exist, so the pages this reads can carry that edge today. Leaving it out of the graph would
  // silently agree with the typo; drawing an arrow into nothing would be worse. A synthetic node
  // gives every format something to point at, and gives a script a `state: "missing"` to filter on.
  // `page` is derived the same way `readBlocks` derives it for a real block (the id up to its first
  // dot) so a dangling reference still lands in the right page's group when the id follows the
  // convention — and in a group of its own, named after the whole id, when it does not.
  const missingIds = new Set(edges.map((e) => e.to).filter((id) => !blocks.has(id)));
  const missing: GraphNode[] = [...missingIds]
    .map((id) => ({ id, page: pageOfBlock(id), kind: '', state: 'missing' as const }));

  const nodes = [...real, ...missing].sort((a, b) => a.id.localeCompare(b.id));

  return { nodes, edges };
}

/**
 * Deterministic JSON: an object literal written out field by field, never a spread of whatever a
 * caller passed in. A spread's key order follows insertion, which is one accidental reorder away
 * from a byte-for-byte diff that says nothing changed.
 */
export function toJSON(graph: Graph): string {
  return JSON.stringify({
    nodes: graph.nodes.map((n) => ({ id: n.id, page: n.page, kind: n.kind, state: n.state })),
    edges: graph.edges.map((e) => ({ from: e.from, to: e.to })),
  }, null, 2) + '\n';
}

/** Every node, grouped by page, in the order `graphOf` already sorted them — so grouping cannot reorder anything. */
function byPage(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const grouped = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!grouped.has(n.page)) grouped.set(n.page, []);
    grouped.get(n.page)!.push(n);
  }
  return grouped;
}

/** The traffic-light emoji `lights` already prints, plus the one marker this module adds of its own. */
const MARK: Record<GraphState, string> = { ...COLOURS, missing: '❓' };

/**
 * Mermaid's OWN ids for nodes and subgraphs — never the block id, however it is spelled.
 *
 * `data-id` is read raw (`engine/cli/pages.ts`): nothing in this codebase constrains its
 * characters, so it can hold a dot, a quote, or — nothing stops it — the literal word `end`, which
 * is Mermaid's own keyword for closing a subgraph. Stripping the characters Mermaid's grammar does
 * not accept would dodge the syntax error and open a worse one: `A.1` and `A_1` would both sanitise
 * to `A_1` and silently become ONE node. A sequential id (`n1`, `n2`, …), assigned once per render
 * from the list `graphOf` already sorted, cannot collide with another id, and cannot collide with a
 * keyword no render ever produces. The block's real id still reaches the diagram — as the LABEL,
 * escaped for Mermaid's label grammar, not as the id a person never sees.
 */
function mermaidIds<T extends { id: string }>(items: T[], prefix: string): Map<string, string> {
  return new Map(items.map((item, i) => [item.id, `${prefix}${i + 1}`]));
}

/**
 * The characters Mermaid's own label grammar treats specially inside a quoted node or subgraph
 * label, replaced by the HTML character reference Mermaid itself reads back as that literal
 * character. One pass over the ORIGINAL text — `String#replace` with a global pattern never
 * re-scans what it just wrote — so escaping `\` cannot have its own backslash re-escaped by the
 * same call that handles `"`.
 */
const MERMAID_LABEL_ESCAPES: Record<string, string> = {
  '"': '#quot;', '\\': '#92;', '<': '#lt;', '>': '#gt;', '#': '#35;',
};
const mermaidLabel = (s: string) => s.replace(/["\\<>#]/g, (c) => MERMAID_LABEL_ESCAPES[c]);

/**
 * Mermaid, grouped by page — a subgraph per page keeps a project of any size readable, the same way
 * the home lists blocks page by page rather than as one flat list. The traffic-light emoji in each
 * label is the SAME vocabulary `lights` prints (`COLOURS`, engine/core/validity.js): a reader who
 * knows one knows the other, and a colour scheme invented just for this diagram would be a second
 * vocabulary to learn for no reason. A missing dependency draws as a hexagon instead of a box — a
 * shape difference survives a black-and-white print or a colour-blind reader the way a colour alone
 * would not.
 */
export function toMermaid(graph: Graph): string {
  const pages = byPage(graph.nodes);
  const pageIds = mermaidIds([...pages.keys()].sort().map((id) => ({ id })), 'p');
  const nodeIds = mermaidIds(graph.nodes, 'n');

  const lines = ['flowchart TD'];
  for (const page of [...pages.keys()].sort()) {
    lines.push(`  subgraph ${pageIds.get(page)}["${mermaidLabel(page)}"]`);
    for (const n of pages.get(page)!) {
      const [open, close] = n.state === 'missing' ? ['{{', '}}'] : ['[', ']'];
      lines.push(`    ${nodeIds.get(n.id)}${open}"${MARK[n.state]} ${mermaidLabel(n.id)}"${close}`);
    }
    lines.push('  end');
  }
  for (const e of graph.edges) {
    lines.push(`  ${nodeIds.get(e.from)} --> ${nodeIds.get(e.to)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * A DOT string literal, quoted — Graphviz's own grammar accepts any character inside one, so
 * (unlike Mermaid) the block's real id can BE the node's id, quoted, with nothing invented. The
 * backslash has to go first: escaping the quote before the backslash would rewrite `A\"` into
 * `A\\"`, one PAIR of characters DOT still reads as an escaped quote, and the literal string still
 * runs on past where it was meant to end. Escaping `\` first turns that same input into `A\\\"`,
 * which is what a trailing backslash followed by a real quote has to become.
 */
const dotQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * DOT (Graphviz): the same page grouping as Mermaid, as a `cluster_` subgraph — the one prefix
 * Graphviz itself recognises for drawing a box around a group, so the pages stay visually apart
 * without a second convention invented for this format alone. A missing dependency gets a dashed
 * outline (`style=dashed`), Graphviz's own idiom for "not really here", instead of a colour alone.
 */
export function toDot(graph: Graph): string {
  const pages = byPage(graph.nodes);

  const lines = ['digraph holdrim {', '  rankdir=LR;', '  node [shape=box];'];
  for (const page of [...pages.keys()].sort()) {
    lines.push(`  subgraph ${dotQuote(`cluster_${page}`)} {`);
    lines.push(`    label=${dotQuote(page)};`);
    for (const n of pages.get(page)!) {
      const style = n.state === 'missing' ? ', style=dashed' : '';
      lines.push(`    ${dotQuote(n.id)} [label=${dotQuote(`${MARK[n.state]} ${n.id}`)}${style}];`);
    }
    lines.push('  }');
  }
  for (const e of graph.edges) {
    lines.push(`  ${dotQuote(e.from)} -> ${dotQuote(e.to)};`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}

/**
 * `holdrim graph`: prints the dependency graph in exactly one of the three formats. No default
 * format, on purpose — a graph piped into a file or a `mermaid` renderer that silently got JSON
 * because nobody chose fails far from where the mistake was made. Refusing to guess is the same
 * posture `lights --only` already takes toward an unknown filter.
 */
export async function showGraph(root: string,
  options: { json?: boolean; mermaid?: boolean; dot?: boolean; enabled: boolean }): Promise<number> {
  // `enabled` is `features.graph` (docs/ROLES.md §7), resolved by the caller (`holdrim.ts`) from the
  // SAME `ofProject` every other command reads its configuration through — a second read here could
  // answer a different question if the two ever drifted. Checked before the format check below: a
  // project that turned the command off should not learn that also by way of "choose one format".
  if (!options.enabled) {
    console.error('graph is turned off: this project\'s holdrim.json sets "features": { "graph": false }');
    return 2;
  }
  const chosen = ['json', 'mermaid', 'dot'].filter((f) => options[f as 'json' | 'mermaid' | 'dot']);
  if (chosen.length !== 1) {
    console.error(`graph needs exactly one of --json, --mermaid, --dot; got ${chosen.length ? chosen.join(', ') : 'none'}`);
    return 2;
  }

  const blocks = await readBlocks(root);
  const registry = loadRegistry(root);
  const graph = graphOf(blocks, registry);

  if (options.json) process.stdout.write(toJSON(graph));
  else if (options.mermaid) process.stdout.write(toMermaid(graph));
  else process.stdout.write(toDot(graph));
  return 0;
}
