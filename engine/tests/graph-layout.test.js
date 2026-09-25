/**
 * The documentation graph's layout math (#38), without a browser — the same split
 * `engine/tests/web.test.js` already makes for the traffic light: `graph-layout.js` is pure, so its
 * rules are proved here, and what only a browser can see (pan, zoom, a click opening a block) is
 * `engine/test-browser.js`'s job instead. A DOM imitation here would prove the imitation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutOf, iconOf, NODE, GAP, COLS, BAND_GAP } from '../web/src/graph-layout.js';

const STEP = NODE + GAP;
const node = (id, page) => ({ id, page });

test('one page, fewer nodes than a row: laid out left to right, top row only', () => {
  const { positions, width, height } = layoutOf([node('A01.1.1', 'A01'), node('A01.1.2', 'A01')]);
  assert.deepEqual(positions.get('A01.1.1'), { x: 0, y: 0 });
  assert.deepEqual(positions.get('A01.1.2'), { x: STEP, y: 0 });
  assert.equal(width, 2 * STEP);
  assert.equal(height, STEP);
});

test('a page with more nodes than COLS wraps into a further row of its own', () => {
  const nodes = Array.from({ length: COLS + 1 }, (_, i) => node(`A01.1.${i + 1}`, 'A01'));
  const { positions, height } = layoutOf(nodes);
  // The (COLS+1)th node starts a second row, back at column 0 — not a (COLS+1)th column.
  assert.deepEqual(positions.get(`A01.1.${COLS + 1}`), { x: 0, y: STEP });
  assert.equal(height, 2 * STEP, 'a wrapped row makes the band, and so the whole graph, taller');
});

test('a second page starts its own band, BAND_GAP past the widest row the first one used', () => {
  const nodes = [
    ...Array.from({ length: COLS }, (_, i) => node(`A01.1.${i + 1}`, 'A01')), // exactly one full row
    node('B01.1.1', 'B01'),
  ];
  const { positions, width } = layoutOf(nodes);
  const firstBandWidth = COLS * STEP;
  assert.deepEqual(positions.get('B01.1.1'), { x: firstBandWidth + BAND_GAP, y: 0 });
  // The trailing gap after the LAST band never turns into empty width nobody's node reaches.
  assert.equal(width, firstBandWidth + BAND_GAP + STEP);
});

test('pages land in their own sorted order, never the order nodes arrived in', () => {
  const { positions } = layoutOf([node('B01.1.1', 'B01'), node('A01.1.1', 'A01')]);
  assert.deepEqual(positions.get('A01.1.1'), { x: 0, y: 0 }, 'A01 first, though B01 came first in the array');
  assert.deepEqual(positions.get('B01.1.1'), { x: STEP + BAND_GAP, y: 0 });
});

test('no nodes at all: a sane, non-empty box rather than zero or NaN', () => {
  const { positions, width, height } = layoutOf([]);
  assert.equal(positions.size, 0);
  assert.ok(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height));
});

// ---------------------------------------------------------------- the icon (colour) vocabulary

const COLOURS = { none: '⚪', valid: '🟢', stale: '🟡', broken: '🔴' };

test('every traffic-light state draws the SAME icon `holdrim lights` prints — no palette of its own', () => {
  for (const [state, icon] of Object.entries(COLOURS)) assert.equal(iconOf(COLOURS, state), icon);
});

test('a dangling data-depends draws the one marker that is not a traffic-light state at all', () => {
  assert.equal(iconOf(COLOURS, 'missing'), '❓');
});

test('a state this vocabulary has never heard of falls back to "none", never undefined', () => {
  assert.equal(iconOf(COLOURS, 'nonsense'), COLOURS.none);
});
