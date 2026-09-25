/**
 * `holdrim graph`. The one thing worth proving twice here is determinism: the same blocks, read in
 * whatever order a Map happens to iterate them, must print the same bytes every time — a diagram a
 * script diffs in CI is useless if it reorders itself for no reason.
 *
 * The traffic-light STATE itself is not re-tested: `graphOf` calls `trafficLight`
 * (engine/core/validity.js), and `engine/tests/validity.test.js` already proves every one of its
 * cases. Testing it again here would be the second copy of the computation this module's own
 * comment warns against, wearing a different file name.
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
  assert.match(out, /subgraph A01\["A01"\]/);
  assert.match(out, /A01_1_1\["⚪ A01\.1\.1"\]/, 'a dot in the id would break Mermaid\'s own grammar');
  assert.match(out, /A01_1_1 --> B01_1_1/);
});

test('DOT clusters by page and quotes ids, so a dot in them is not read as DOT syntax', () => {
  const blocks = new Map([block('A01.1.1', 'A01', 'rule', ['A01.2.1']), block('A01.2.1', 'A01', 'contract')]);
  const out = toDot(graphOf(blocks, {}));
  assert.match(out, /^digraph holdrim \{/);
  assert.match(out, /subgraph "cluster_A01" \{/);
  assert.match(out, /"A01\.1\.1" \[label="⚪ A01\.1\.1"\];/);
  assert.match(out, /"A01\.1\.1" -> "A01\.2\.1";/);
});

test('an empty documentation is a graph with no nodes and no edges, in every format', () => {
  const g = graphOf(new Map(), {});
  assert.deepEqual(g, { nodes: [], edges: [] });
  assert.doesNotThrow(() => toJSON(g));
  assert.doesNotThrow(() => toMermaid(g));
  assert.doesNotThrow(() => toDot(g));
});
