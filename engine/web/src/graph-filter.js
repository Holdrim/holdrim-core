/**
 * Narrowing the documentation graph (#42) to what a viewer asked to see — pure, so `node --test`
 * proves it without a browser, the same split `graph-layout.js` already makes for the layout.
 *
 * A view concern, done in the browser on the graph `/api/graph` already sent: every node already
 * carries its `page`, its `state` and — box three — its `mayAct`, so the server has already answered
 * everything a filter here could ask, and a filtered route would be a second answer to "what is in
 * the graph" that the CLI's `holdrim graph` does not give. Neither the state nor `mayAct` is worked
 * out here: the state is `graphOf`'s own (engine/cli/graph.ts), the same `trafficLight` the rest of
 * the engine reads, and `mayAct` is `mayActOn`'s (engine/api/here.ts), the server's own `can` asked
 * with the node's place — this file only reads the two booleans it is sent, never recomputes either.
 */

/**
 * The nodes that pass both filters, and only the edges with BOTH ends still drawn.
 *
 * Case-insensitive, and trimmed: a search box a reader types into, not an id the engine resolves —
 * `s03` and `S03 ` mean the page they plainly mean. An empty prefix is every page.
 *
 * Order is kept, never re-sorted: `layoutOf` (graph-layout.js) expects nodes sorted by id, and
 * `graphOf` already sorted them — a filter only ever removes.
 *
 * An edge to a node the filter hid is dropped here rather than left for the drawing to skip: a line
 * into a spot the new layout gave to some OTHER node would point at the wrong block.
 *
 * @param {{ nodes: {id: string, page: string, state: string, mayAct?: boolean}[], edges: {from: string, to: string}[] }} graph
 * @param {{ prefix?: string, states: Set<string>, mayAct?: boolean }} filter  `states` is every state
 *   still shown, `missing` included — the graph's own marker for a dangling `data-depends`, filtered
 *   like the rest; `mayAct`, unticked by default, keeps every node when false and, when true, only
 *   those the server already marked `mayAct: true` (box three, "where I may act") — never a role or
 *   a capability re-read here, only the one boolean `/api/graph` sent for this viewer
 * @returns {{ nodes: typeof graph.nodes, edges: typeof graph.edges }}
 */
export function filterGraph(graph, { prefix = '', states, mayAct = false }) {
  const wanted = prefix.trim().toLowerCase();
  const nodes = graph.nodes.filter((n) => states.has(n.state) && n.page.toLowerCase().startsWith(wanted)
    && (!mayAct || n.mayAct === true));
  const shown = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
  return { nodes, edges };
}
