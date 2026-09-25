/**
 * The documentation graph on the home screen (#38): pages and blocks as nodes, `data-depends` as
 * edges, the traffic light as colour — fetched from `/api/graph`, which answers with the SAME
 * `graphOf` `holdrim graph` already prints (engine/cli/graph.ts). Nothing here recomputes a graph.
 *
 * Its own bundle, `home-graph.js`, never merged into `panel-react.js`: a documentation PAGE does
 * not carry this, only the home screen does, and only when a project's `holdrim.json` turns
 * `features.graph` on (`engine/api/home-page.ts` writes this file's `<script>` tag only then). A
 * library or a script loaded on every page nobody asked for it on is the #105 mistake, with none of
 * the excuse of at least running somewhere useful.
 *
 * No bundled graph library and no React: `graph-layout.js`'s own layered layout, plain SVG, and a
 * hand-rolled pan and zoom keep this file's entire cost at a few kilobytes for what is, underneath,
 * boxes, lines and one CSS transform — measured against a real library (cytoscape.js alone bundles
 * heavier than this whole engine's panel) before this file was written, not after.
 */
import { fetchGraph } from './api.js';
import { layoutOf, iconOf, NODE } from './graph-layout.js';
import { filterGraph } from './graph-filter.js';
import { COLOURS } from '../../core/validity.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** One namespaced SVG element, with its attributes set in one call — `document.createElementNS`
 *  everywhere else in this file would bury the one thing worth reading, which attribute goes where. */
function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const container = document.getElementById('holdrim-graph');
// `home-page.ts` writes this element only when `features.graph` is on — with it off the tag never
// exists, and this script (loaded only from that same section) never runs at all. Guarded all the
// same: a page that keeps an old, cached copy of this file after a project turns the toggle off
// must not throw into the console over an element that is simply, correctly, not there.
if (container) {
  /** Everything `home-page.ts` already translated for this viewer, read once. */
  const i18n = JSON.parse(container.dataset.graphI18n || '{}');

  /** Shows one of the two server-rendered status paragraphs, and hides the other — never both. A
   *  success replaces the container's children outright, so this is only ever reached on failure. */
  function showStatus(status) {
    for (const p of container.querySelectorAll('[data-graph-status]')) {
      p.hidden = p.getAttribute('data-graph-status') !== status;
    }
  }

  /** A pointer has to move more than this, between press and release, to count as a drag rather
   *  than a click — without it every pan ends by "clicking" whatever node the cursor happens to be
   *  over when it comes back up, nowhere near where the drag itself started. */
  const DRAG_THRESHOLD = 4;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 8;
  const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

  /** The filters `home-page.ts` writes in the same section as `container` (#42), but outside it —
   *  a draw empties the container, and the filters have to keep whatever a reader typed or ticked
   *  before the graph finished loading. */
  const filters = document.querySelector('.home-graph__filters');
  const noMatch = document.querySelector('.home-graph__empty');
  // Enter in the prefix box would submit the form, reloading the whole home for a filter that never
  // needed the server — and losing every tick in the process. Cancelled HERE, not once the graph is
  // drawn: the form is live from the moment the page is, and a reader who types and presses Enter
  // while `/api/graph` is still on its way would otherwise send it for real.
  filters.addEventListener('submit', (event) => event.preventDefault());
  /** What the filters say right now. Every state is the VALUE of a ticked box — this script keeps
   *  no list of states of its own, so a state the legend names is one a reader can hide. */
  const filterOf = () => ({
    prefix: filters.elements.prefix.value,
    states: new Set([...filters.querySelectorAll('input[name="state"]:checked')].map((box) => box.value)),
  });

  function draw(graph) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    const view = svgEl('svg', {
      class: 'home-graph__svg', role: 'img', 'aria-label': i18n.label ?? 'Documentation graph',
    });
    const world = svgEl('g', { class: 'home-graph__world' });
    const edges = svgEl('g');
    const nodes = svgEl('g');
    world.append(edges, nodes);
    view.append(world);

    /** Draws what the filters let through, laid out AFRESH — never the full layout with holes in it:
     *  narrowed to one page out of eight, the full layout would leave that page a sliver of a
     *  viewBox still sized for all eight, which is no easier to read than before it was filtered. */
    function render() {
      const shown = filterGraph(graph, filterOf());
      const { positions, width, height } = layoutOf(shown.nodes);
      const centre = (id) => {
        const p = positions.get(id);
        return p && { x: p.x + NODE / 2, y: p.y + NODE / 2 };
      };
      view.setAttribute('viewBox', `0 0 ${width} ${height}`);
      noMatch.hidden = shown.nodes.length > 0;

      edges.replaceChildren();
      for (const e of shown.edges) {
        const from = centre(e.from);
        const to = centre(e.to);
        // A dependency naming a block on neither side draws nothing rather than a line to the
        // origin — graphOf already turned a truly dangling one into its own `missing` NODE
        // (engine/cli/graph.ts), and `filterGraph` already dropped every edge the filters cut; this
        // guard is only ever real for a graph an older server sent a newer script, where the two
        // disagree about what exists.
        if (!from || !to) continue;
        edges.append(svgEl('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'home-graph__edge' }));
      }

      nodes.replaceChildren();
      for (const n of shown.nodes) {
        const p = positions.get(n.id);
        const group = svgEl('g', {
          class: 'home-graph__node', transform: `translate(${p.x},${p.y})`,
          'data-id': n.id, tabindex: '0', role: 'button',
          'aria-label': `${n.id} — ${i18n.states?.[n.state] ?? n.state}`,
        });
        group.append(
          svgEl('rect', { width: NODE, height: NODE, rx: 4 }),
          svgEl('text', { x: NODE / 2, y: NODE / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }),
        );
        group.lastChild.textContent = iconOf(COLOURS, n.state);
        const open = () => { if (n.href) location.assign(n.href); };
        // Enter and Space: a `role="button"` on an SVG `<g>` carries none of a real `<button>`'s
        // built-in key handling, so without this the graph has nodes a keyboard cannot open at all.
        group.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
        });
        nodes.append(group);
      }
    }

    // Pan and zoom, both driven by one `transform` on `world` — the DOM underneath never moves, so
    // the cost of a drag or a wheel tick is one attribute write, not a relayout of 500+ nodes.
    let originX = 0;
    let originY = 0;
    let scale = 1;
    let dragging = false;
    let dragged = false;
    let start = { x: 0, y: 0 };
    let originStart = { x: 0, y: 0 };
    const apply = () => world.setAttribute('transform', `translate(${originX},${originY}) scale(${scale})`);
    const resetView = () => { originX = 0; originY = 0; scale = 1; apply(); };
    render();
    resetView(); // written once up front — an attribute a reader (or a test) can read before any
                 // interaction, rather than the absence of one meaning the same thing by accident.

    // A new filter is a new layout, so the view goes back to where it starts: a pan or zoom set for
    // the old layout would point at wherever some other node now happens to sit.
    filters.addEventListener('input', () => { render(); resetView(); });

    view.addEventListener('pointerdown', (event) => {
      dragging = true; dragged = false;
      start = { x: event.clientX, y: event.clientY };
      originStart = { x: originX, y: originY };
      view.setPointerCapture(event.pointerId);
    });
    view.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) dragged = true;
      originX = originStart.x + dx; originY = originStart.y + dy;
      apply();
    });
    // The click is decided HERE, on pointerup, from the actual point the pointer let go at — never
    // from a `click` listener. `setPointerCapture` above (needed so a drag that leaves the SVG's
    // bounds keeps tracking) redirects every later pointer AND mouse event for this pointer to
    // `view`, `click` included: its `target` becomes `view` itself, not whatever the cursor was
    // over, so `event.target.closest('[data-id]')` would find nothing no browser this runs in.
    // `elementFromPoint` asks the actual DOM at the release coordinates, which capture cannot touch.
    view.addEventListener('pointerup', (event) => {
      dragging = false;
      if (dragged) return; // a pan that ends over a node is a pan, not a click on it
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit && hit.closest('[data-id]');
      const node = target && byId.get(target.getAttribute('data-id'));
      if (node?.href) location.assign(node.href);
    });
    view.addEventListener('pointercancel', () => { dragging = false; });

    view.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = view.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      // The point under the cursor stays under the cursor: without adjusting the origin too, every
      // scroll tick re-centres on the viewport's corner instead of on what the reader is pointing
      // at, which is the one thing a zoom under a cursor is supposed to feel like it does.
      const before = { x: (mx - originX) / scale, y: (my - originY) / scale };
      scale = clampScale(scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
      originX = mx - before.x * scale;
      originY = my - before.y * scale;
      apply();
    }, { passive: false });

    const zoomBy = (factor) => { scale = clampScale(scale * factor); apply(); };
    const button = (label, text, onClick) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'holdrim-button'; b.setAttribute('aria-label', label);
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    };
    const controls = document.createElement('div');
    controls.className = 'home-graph__controls';
    controls.append(
      button(i18n.zoomIn ?? 'Zoom in', '+', () => zoomBy(1.25)),
      button(i18n.zoomOut ?? 'Zoom out', '−', () => zoomBy(0.8)),
      button(i18n.reset ?? 'Reset view', '⟲', resetView),
    );

    container.replaceChildren(view, controls);
  }

  fetchGraph().then(draw).catch((e) => {
    // Switched off, not thrown: a graph that cannot load is one report on a page full of others,
    // and the reader loses nothing else by seeing it say so instead of a blank box.
    console.warn('[holdrim] the graph could not load:', e);
    showStatus('failed');
  });
}
