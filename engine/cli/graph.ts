import { readBlocks, type Block } from './pages.ts';
import { loadRegistry, type Registry } from './validation.ts';
import { trafficLight, COLOURS } from '../core/validity.js';

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

/** One block, as the graph draws it: enough to place it and to say what state it is in. */
export interface GraphNode { id: string; page: string; kind: string; state: string; }

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

  const nodes = [...blocks.values()]
    .map((b) => ({ id: b.id, page: b.page, kind: b.kind, state: byBlock.get(b.id)?.state ?? 'none' }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // The edge is `from` (the block that declares `data-depends`) toward `to` (what it names) — the
  // same direction `dependsOn` is stored in, and the one `if-i-touch` walks backwards to answer
  // "what turns red if I touch this". Drawing it the other way would make an arrow mean two
  // different things depending on which command you asked.
  const edges = [...blocks.values()]
    .flatMap((b) => b.dependsOn.map((to) => ({ from: b.id, to })))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

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

/**
 * A block id read literally by Mermaid's node-id grammar, which stops at the first character that
 * is not a letter, a digit or an underscore. `A01.1.4` would otherwise be read as the node `A01`
 * followed by syntax Mermaid does not have. The dot is the only separator the id grammar uses
 * (`engine/cli/pages.ts`), so this cannot collide two different real ids into one node — the label
 * still carries the id untouched, for the reader.
 */
const mermaidId = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * Mermaid, grouped by page — a subgraph per page keeps a project of any size readable, the same way
 * the home lists blocks page by page rather than as one flat list. The traffic-light emoji in each
 * label is the SAME vocabulary `lights` prints (`COLOURS`, engine/core/validity.js): a reader who
 * knows one knows the other, and a colour scheme invented just for this diagram would be a second
 * vocabulary to learn for no reason.
 */
export function toMermaid(graph: Graph): string {
  const byPage = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (!byPage.has(n.page)) byPage.set(n.page, []);
    byPage.get(n.page)!.push(n);
  }

  const lines = ['flowchart TD'];
  for (const page of [...byPage.keys()].sort()) {
    lines.push(`  subgraph ${mermaidId(page)}["${page}"]`);
    for (const n of byPage.get(page)!) {
      lines.push(`    ${mermaidId(n.id)}["${COLOURS[n.state as keyof typeof COLOURS]} ${n.id}"]`);
    }
    lines.push('  end');
  }
  for (const e of graph.edges) {
    lines.push(`  ${mermaidId(e.from)} --> ${mermaidId(e.to)}`);
  }
  return lines.join('\n') + '\n';
}

/** A double quote inside a DOT string literal, escaped — the only character its grammar demands it. */
const dotQuote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

/**
 * DOT (Graphviz): the same page grouping as Mermaid, as a `cluster_` subgraph — the one prefix
 * Graphviz itself recognises for drawing a box around a group, so the pages stay visually apart
 * without a second convention invented for this format alone.
 */
export function toDot(graph: Graph): string {
  const byPage = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (!byPage.has(n.page)) byPage.set(n.page, []);
    byPage.get(n.page)!.push(n);
  }

  const lines = ['digraph holdrim {', '  rankdir=LR;', '  node [shape=box];'];
  for (const page of [...byPage.keys()].sort()) {
    lines.push(`  subgraph ${dotQuote(`cluster_${page}`)} {`);
    lines.push(`    label=${dotQuote(page)};`);
    for (const n of byPage.get(page)!) {
      lines.push(`    ${dotQuote(n.id)} [label=${dotQuote(`${COLOURS[n.state as keyof typeof COLOURS]} ${n.id}`)}];`);
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
  options: { json?: boolean; mermaid?: boolean; dot?: boolean }): Promise<number> {
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
