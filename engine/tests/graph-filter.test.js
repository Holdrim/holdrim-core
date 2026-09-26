/**
 * The graph's filters (#42), without a browser: `graph-filter.js` is pure, so which nodes and edges
 * survive a prefix and a set of states is proved here, and what only a browser can see — the
 * controls on the home actually driving it — is `engine/test-browser.js`'s job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterGraph } from '../web/src/graph-filter.js';

const ALL = new Set(['none', 'valid', 'stale', 'broken', 'missing']);
// `mayAct` defaults false: most nodes here stand in for a member's or an agent's view of the graph,
// where the server sent it false everywhere — only A01.1.1 and S01.1.2, below, stand in for the
// handful a viewer with real grants may act on.
const node = (id, state, mayAct = false) => ({ id, page: id.split('.')[0], state, mayAct });

// Sorted by id, as `graphOf` hands it over: two pages sharing a prefix (S01, S02), one that does
// not (A01), a dangling dependency (NOPE), and edges within a page, across pages, and into NOPE.
const GRAPH = {
  nodes: [
    node('A01.1.1', 'valid', true), node('A01.1.2', 'stale'),
    node('NOPE.1.1', 'missing'),
    node('S01.1.1', 'none'), node('S01.1.2', 'broken', true),
    node('S02.1.1', 'none'),
  ],
  edges: [
    { from: 'A01.1.2', to: 'A01.1.1' },
    { from: 'A01.1.2', to: 'NOPE.1.1' },
    { from: 'S01.1.2', to: 'S01.1.1' },
    { from: 'S02.1.1', to: 'A01.1.1' },
    { from: 'S02.1.1', to: 'S01.1.1' },
  ],
};
const ids = (g) => g.nodes.map((n) => n.id);

test('no prefix and every state: the whole graph, unchanged', () => {
  assert.deepEqual(filterGraph(GRAPH, { prefix: '', states: ALL }), GRAPH);
});

test('a page prefix keeps every page that starts with it, and only those', () => {
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: 'S0', states: ALL })), ['S01.1.1', 'S01.1.2', 'S02.1.1']);
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: 'S01', states: ALL })), ['S01.1.1', 'S01.1.2']);
});

test('the prefix is matched against the PAGE, from its start — never anywhere in the id', () => {
  // "1.1" is inside every id here; a substring match would keep them all.
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: '1.1', states: ALL })), []);
});

test('a prefix as a reader types it: case and surrounding spaces do not matter', () => {
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: '  s01 ', states: ALL })), ['S01.1.1', 'S01.1.2']);
});

test('the state filter keeps only the traffic-light states still ticked', () => {
  assert.deepEqual(ids(filterGraph(GRAPH, { states: new Set(['none']) })), ['S01.1.1', 'S02.1.1']);
  assert.deepEqual(ids(filterGraph(GRAPH, { states: new Set(['valid', 'stale']) })), ['A01.1.1', 'A01.1.2']);
});

test('a dangling dependency is filtered by its own `missing` state, like any other', () => {
  const without = new Set([...ALL].filter((s) => s !== 'missing'));
  assert.ok(!ids(filterGraph(GRAPH, { states: without })).includes('NOPE.1.1'));
  assert.deepEqual(ids(filterGraph(GRAPH, { states: new Set(['missing']) })), ['NOPE.1.1']);
});

test('both filters at once: a node has to pass each of them', () => {
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: 'S', states: new Set(['broken']) })), ['S01.1.2']);
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: 'A', states: new Set(['none']) })), []);
});

test('an edge survives only when both of its ends do', () => {
  // S02.1.1 → A01.1.1 crosses out of the prefix; S02.1.1 → S01.1.1 stays inside it.
  assert.deepEqual(filterGraph(GRAPH, { prefix: 'S', states: ALL }).edges, [
    { from: 'S01.1.2', to: 'S01.1.1' },
    { from: 'S02.1.1', to: 'S01.1.1' },
  ]);
  // The same edge, cut by the state filter instead: S01.1.1 is `none`, S01.1.2 is not.
  assert.deepEqual(filterGraph(GRAPH, { prefix: 'S01', states: new Set(['broken']) }).edges, []);
});

test('nodes come back in the order they went in — layoutOf reads them already sorted', () => {
  const shuffledStates = new Set(['broken', 'none', 'valid']);
  const kept = ids(filterGraph(GRAPH, { states: shuffledStates }));
  assert.deepEqual(kept, [...kept].sort());
});

// ---------------------------------------------------------------- "where I may act" (#42, box three)

test('unticked, mayAct never narrows the graph — the default is every node the other filters kept', () => {
  assert.deepEqual(filterGraph(GRAPH, { states: ALL }), GRAPH, 'mayAct omitted entirely, the same as false');
  assert.deepEqual(filterGraph(GRAPH, { states: ALL, mayAct: false }), GRAPH);
});

test('ticked, mayAct keeps only the nodes the server already marked true — never a role read here', () => {
  assert.deepEqual(ids(filterGraph(GRAPH, { states: ALL, mayAct: true })), ['A01.1.1', 'S01.1.2']);
});

test('mayAct composes with the prefix and the state filter: a node has to pass every one ticked', () => {
  assert.deepEqual(ids(filterGraph(GRAPH, { prefix: 'S', states: ALL, mayAct: true })), ['S01.1.2']);
  assert.deepEqual(ids(filterGraph(GRAPH, { states: new Set(['valid']), mayAct: true })), ['A01.1.1']);
  // A member's or an agent's graph (#42's own case): every node false, so ticking mayAct empties it.
  assert.deepEqual(ids(filterGraph({ ...GRAPH, nodes: GRAPH.nodes.map((n) => ({ ...n, mayAct: false })) },
    { states: ALL, mayAct: true })), []);
});

test('an edge survives mayAct only when both of its ends do', () => {
  // Neither A01.1.1 nor S01.1.2 shares an edge with the OTHER node mayAct also keeps, so every
  // edge in GRAPH loses at least one end and none survive.
  assert.deepEqual(filterGraph(GRAPH, { states: ALL, mayAct: true }).edges, []);
});
