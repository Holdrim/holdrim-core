/**
 * `holdrim graph`. The one thing worth proving twice here is determinism: the same blocks, read in
 * whatever order a Map happens to iterate them, must print the same bytes every time — a diagram a
 * script diffs in CI is useless if it reorders itself for no reason.
 *
 * The traffic-light STATE itself is not re-tested: `graphOf` calls `trafficLight`
 * (engine/core/validity.js), and `engine/tests/validity.test.js` already proves every one of its
 * cases. Testing it again here would be the second copy of the computation this module's own
 * comment warns against, wearing a different file name.
 *
 * What IS tested at length here is the two renderers' own grammars — Mermaid's label escaping and
 * reserved words, DOT's string escaping — because a diagram that a real block id can break is a
 * diagram nobody can trust with real content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphOf, toJSON, toMermaid, toDot } from '../cli/graph.ts';

/** A block with just what `graphOf` and `trafficLight` read. */
const block = (id, page, kind, dependsOn = [], fingerprint = id) =>
  [id, { id, page, kind, dependsOn, fingerprint }];

test('nodes carry the state the traffic light gives them, sorted by id', () => {
  const blocks = new Map([
    block('B01.1.1', 'B01', 'text'),
    block('A01.1.1', 'A01', 'rule'),
  ]);
  const registry = { 'A01.1.1': { fingerprint: 'A01.1.1' } };  // validated, unchanged → green
  const { nodes } = graphOf(blocks, registry);
  assert.deepEqual(nodes.map((n) => n.id), ['A01.1.1', 'B01.1.1'], 'sorted, not insertion order');
  assert.equal(nodes[0].state, 'valid');
  assert.equal(nodes[1].state, 'none');
});

test('edges run from the block that depends to what it names, sorted', () => {
  const blocks = new Map([
    block('B01.1.1', 'B01', 'text', ['A01.2.1']),
    block('A01.1.1', 'A01', 'rule', ['A01.2.1', 'B01.1.1']),
    block('A01.2.1', 'A01', 'contract'),
  ]);
  const { edges } = graphOf(blocks, {});
  assert.deepEqual(edges, [
    { from: 'A01.1.1', to: 'A01.2.1' },
    { from: 'A01.1.1', to: 'B01.1.1' },
    { from: 'B01.1.1', to: 'A01.2.1' },
  ]);
});

test('the same graph built from maps inserted in a different order prints identical JSON', () => {
  const forward = new Map([
    block('A01.1.1', 'A01', 'rule', ['A01.1.2']),
    block('A01.1.2', 'A01', 'text'),
  ]);
  const backward = new Map([
    block('A01.1.2', 'A01', 'text'),
    block('A01.1.1', 'A01', 'rule', ['A01.1.2']),
  ]);
  assert.equal(toJSON(graphOf(forward, {})), toJSON(graphOf(backward, {})));
});

test('JSON keeps only the fields a script can rely on, in a fixed shape', () => {
  const blocks = new Map([block('A01.1.1', 'A01', 'rule', ['A01.1.2']), block('A01.1.2', 'A01', 'text')]);
  const parsed = JSON.parse(toJSON(graphOf(blocks, {})));
  assert.deepEqual(parsed, {
    nodes: [
      { id: 'A01.1.1', page: 'A01', kind: 'rule', state: 'none' },
      { id: 'A01.1.2', page: 'A01', kind: 'text', state: 'none' },
    ],
    edges: [{ from: 'A01.1.1', to: 'A01.1.2' }],
  });
});

test('Mermaid groups blocks by page and marks the state with the SAME emoji `lights` prints', () => {
  const blocks = new Map([block('A01.1.1', 'A01', 'rule', ['B01.1.1']), block('B01.1.1', 'B01', 'text')]);
  const out = toMermaid(graphOf(blocks, {}));
  assert.match(out, /^flowchart TD/);
  assert.match(out, /subgraph p1\["A01"\]/);
  assert.match(out, /n1\["⚪ A01\.1\.1"\]/, 'the label carries the real id; the node\'s OWN id is synthetic');
  assert.match(out, /n1 --> n2/, 'A01.1.1 is node 1 and its dependency B01.1.1 is node 2, in sorted order');
});

test('DOT clusters by page and quotes ids, so a dot in them is not read as DOT syntax', () => {
  const blocks = new Map([block('A01.1.1', 'A01', 'rule', ['A01.2.1']), block('A01.2.1', 'A01', 'contract')]);
  const out = toDot(graphOf(blocks, {}));
  assert.match(out, /^digraph holdrim \{/);
  assert.match(out, /subgraph "cluster_A01" \{/);
  assert.match(out, /"A01\.1\.1" \[label="⚪ A01\.1\.1"\];/);
  assert.match(out, /"A01\.1\.1" -> "A01\.2\.1";/);
});

// ---------------------------------------------------------------- a dangling data-depends

test('a dependency that names no real block is a node of its own, state "missing" — not silence, not a crash', () => {
  const blocks = new Map([block('A01.1.1', 'A01', 'rule', ['A01.9.9'])]);
  const graph = graphOf(blocks, {});
  const ghost = graph.nodes.find((n) => n.id === 'A01.9.9');
  assert.ok(ghost, 'the dangling target got a node');
  assert.equal(ghost.state, 'missing');
  assert.equal(ghost.page, 'A01', 'its page is read off its own id, the way a real block\'s is');
  // The edge itself is unchanged — still one edge, still pointing at the name that was declared.
  assert.deepEqual(graph.edges, [{ from: 'A01.1.1', to: 'A01.9.9' }]);
});

test('a missing node draws differently, not just in a different colour, in Mermaid and in DOT', () => {
  const blocks = new Map([block('A01.1.1', 'A01', 'rule', ['A01.9.9'])]);
  const graph = graphOf(blocks, {});
  assert.match(toMermaid(graph), /\{\{"❓ A01\.9\.9"\}\}/, 'a hexagon, not the usual box');
  assert.match(toDot(graph), /"A01\.9\.9" \[label="❓ A01\.9\.9", style=dashed\];/);
});

// ---------------------------------------------------------------- Mermaid's own grammar

test('Mermaid never uses the real id as ITS id — two ids that would sanitise the same do not merge', () => {
  // Stripped of everything but letters, digits and underscore, "A.1" and "A_1" both become "A_1".
  // If the renderer ever went back to doing that, this is the test that would catch it.
  const blocks = new Map([block('A.1', 'A', 'text'), block('A_1', 'A', 'text')]);
  const out = toMermaid(graphOf(blocks, {}));
  const declared = [...out.matchAll(/^\s*n\d+\[/gm)];
  assert.equal(declared.length, 2, 'two distinct ids must produce two distinct node declarations');
  assert.match(out, /"⚪ A\.1"/);
  assert.match(out, /"⚪ A_1"/);
});

test('a page or an id that IS a Mermaid keyword does not break the diagram', () => {
  // "end" closes a subgraph in Mermaid's own grammar. A page named exactly that must never become
  // the subgraph's id — only its label, where the word means nothing special.
  const blocks = new Map([block('end', 'end', 'text')]);
  const out = toMermaid(graphOf(blocks, {}));
  assert.doesNotMatch(out, /subgraph end\[/, 'the keyword must never be used as an id');
  assert.match(out, /subgraph p1\["end"\]/, 'it is only ever the label');
  assert.match(out, /n1\["⚪ end"\]/);
  // The diagram still has to close its subgraph with the real keyword — that "end" is Mermaid's
  // syntax, not a node called "end", and the two must not be confused for one another.
  assert.match(out, /^\s*end\s*$/m);
});

test('a quote, a backslash, angle brackets and a hash in an id cannot break a Mermaid label', () => {
  const blocks = new Map([block('A"1<2>#3\\4', 'A', 'text')]);
  const out = toMermaid(graphOf(blocks, {}));
  assert.match(out, /"⚪ A#quot;1#lt;2#gt;#35;3#92;4"/);
});

// ---------------------------------------------------------------- DOT's own grammar

test('a quote in an id is escaped in DOT', () => {
  const blocks = new Map([block('A"1', 'A', 'text')]);
  const out = toDot(graphOf(blocks, {}));
  assert.match(out, /"A\\"1" \[label="⚪ A\\"1"\];/);
});

test('a trailing backslash in an id does not eat the closing quote in DOT', () => {
  // Escaping the quote alone turns `A\` into `"A\"` — an ODD number of backslashes before the
  // closing quote, which DOT reads as an escaped quote, not the end of the string. The backslash
  // itself has to be escaped first.
  const blocks = new Map([block('A\\', 'A', 'text')]);
  const out = toDot(graphOf(blocks, {}));
  assert.match(out, /"A\\\\" \[label="⚪ A\\\\"\];/);
});

// ---------------------------------------------------------------- every state, rendered

test('stale and broken render with their own emoji in both Mermaid and DOT', () => {
  const blocks = new Map([
    block('A01.1.1', 'A01', 'text', [], 'NEW'),                        // text changed → stale
    block('A01.1.2', 'A01', 'rule', ['A01.1.3'], 'same'),               // ground moved → broken
    block('A01.1.3', 'A01', 'contract', [], 'MOVED'),
  ]);
  const registry = {
    'A01.1.1': { fingerprint: 'old' },
    'A01.1.2': { fingerprint: 'same', dependsOn: { 'A01.1.3': 'was-this' } },
  };
  const graph = graphOf(blocks, registry);
  assert.equal(graph.nodes.find((n) => n.id === 'A01.1.1').state, 'stale');
  assert.equal(graph.nodes.find((n) => n.id === 'A01.1.2').state, 'broken');

  const mermaid = toMermaid(graph);
  assert.match(mermaid, /"🟡 A01\.1\.1"/);
  assert.match(mermaid, /"🔴 A01\.1\.2"/);

  const dot = toDot(graph);
  assert.match(dot, /label="🟡 A01\.1\.1"/);
  assert.match(dot, /label="🔴 A01\.1\.2"/);
});

test('an empty documentation is a graph with no nodes and no edges, in every format', () => {
  const g = graphOf(new Map(), {});
  assert.deepEqual(g, { nodes: [], edges: [] });
  assert.doesNotThrow(() => toJSON(g));
  assert.doesNotThrow(() => toMermaid(g));
  assert.doesNotThrow(() => toDot(g));
});
