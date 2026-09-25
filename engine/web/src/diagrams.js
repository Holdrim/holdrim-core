import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
  // Flowcharts override the top-level default; without this SVG foreignObject survives.
  flowchart: { htmlLabels: false },
  suppressErrorRendering: true });

/**
 * Keep the source in the document and put the drawing beside it. The copy must be review UI:
 * without that marker, the next fingerprint includes SVG labels that were never in the approved
 * text, and a renderer upgrade could invalidate approvals without changing the source.
 */
export async function renderDiagrams(blocks) {
  let index = 0;
  for (const block of blocks) {
    for (const code of block.el.querySelectorAll('pre code.mermaid')) {
      if (code.closest('[data-id][data-code]') !== block.el) continue;
      try {
        const { svg } = await mermaid.render(`holdrim-diagram-${index++}`, code.textContent ?? '');
        const drawing = document.createElement('div');
        drawing.className = 'rv-diagram';
        drawing.setAttribute('data-review-ui', '');
        drawing.innerHTML = svg;
        code.closest('pre').after(drawing);
      } catch (error) {
        // A malformed diagram leaves the original source readable and cannot switch off the panel.
        console.warn('[holdrim] diagram source could not be rendered:', error);
      }
    }
  }
}
