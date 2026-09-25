/**
 * The documentation graph's own layout math (#38) — pure, so `node --test` proves it without a
 * browser, the same split `state.js` already makes for the traffic light.
 *
 * Nodes are grouped by page, the same grouping `holdrim graph`'s Mermaid and DOT output already
 * use (engine/cli/graph.ts, `byPage`): one band per page, so a reader who has seen either export
 * recognises the shape instead of learning a second one for the browser alone.
 *
 * Never a physics simulation. A force layout has to keep running to stay settled, and at 500+
 * blocks — the size this has to hold up at — that stops being interactive on a plain click-and-drag
 * home screen; it would also make the picture different on every load, which is no use to a
 * screenshot or a test asserting where a node landed. A layout computed once, from input already
 * sorted by id (`graphOf` gives it that way), is deterministic instead: the same graph places the
 * same node in the same spot every time.
 */

/** The square a node's icon sits in, and the gap to the next one — both in SVG user units. */
export const NODE = 26;
export const GAP = 14;
/** How many nodes wide one page's band grows before wrapping into a further row of its own. */
export const COLS = 8;
/** Between one page's band and the next. */
export const BAND_GAP = 48;

/** The step from one node's corner to the next, in either direction. */
const STEP = NODE + GAP;

/**
 * The icon a node draws — the SAME vocabulary `holdrim lights` and `holdrim graph --mermaid`
 * already print (`COLOURS`, engine/core/validity.js), plus the one marker that vocabulary never
 * carries: `missing`, `graphOf`'s name for a `data-depends` that points at no real block. Reusing
 * it, rather than inventing a palette for this one diagram, is also what keeps the theme (untrusted
 * input, AGENTS.md) out of this entirely — colour here is a character, never an interpolated value.
 *
 * @param {Record<string, string>} colours  `COLOURS` from engine/core/validity.js, passed in so
 *   this module stays free of an import a caller may not want — `engine/tests/graph-layout.test.js`
 *   imports THIS FILE directly and hands it a literal palette of its own, never `COLOURS` itself.
 * @param {string} state
 */
export function iconOf(colours, state) {
  return state === 'missing' ? '❓' : (colours[state] ?? colours.none);
}

/**
 * Where every node sits, band by band: each page's blocks, sorted, filling `COLS`-wide rows before
 * the next page's band starts `BAND_GAP` to the right of the widest row this one used.
 *
 * @param {{id: string, page: string}[]} nodes  already sorted by id — `graphOf` hands them over
 *   that way, and re-sorting here would be a second sort this module has no business doing.
 * @returns {{ positions: Map<string, {x: number, y: number}>, width: number, height: number }}
 */
export function layoutOf(nodes) {
  const byPage = new Map();
  for (const n of nodes) {
    if (!byPage.has(n.page)) byPage.set(n.page, []);
    byPage.get(n.page).push(n);
  }

  const positions = new Map();
  let x = 0;
  let height = STEP;
  for (const page of [...byPage.keys()].sort()) {
    const here = byPage.get(page);
    here.forEach((n, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      positions.set(n.id, { x: x + col * STEP, y: row * STEP });
    });
    height = Math.max(height, Math.ceil(here.length / COLS) * STEP);
    x += Math.min(here.length, COLS) * STEP + BAND_GAP;
  }

  // The last band's trailing BAND_GAP counted toward `x` but draws nothing after it — left in, the
  // viewBox would carry 48 empty units nobody's node ever reaches.
  return { positions, width: Math.max(x - BAND_GAP, STEP), height };
}
