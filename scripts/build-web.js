/** Keep Mermaid's many diagram loaders in one local chunk to avoid shipping dozens of assets. */
import { build } from 'esbuild';
import { readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

const web = 'engine/web';
const vendor = await build({
  entryPoints: ['mermaid'], bundle: true, format: 'esm', minify: true, target: 'es2022',
  write: false,
});
if (vendor.outputFiles.length !== 1) throw new Error('Mermaid vendor build must be one module');

const panel = await build({
  entryPoints: [`${web}/src/entry.jsx`], bundle: true, splitting: true, format: 'esm',
  jsx: 'automatic', minify: true, target: 'es2022', outdir: web,
  entryNames: 'panel-react', chunkNames: 'generated/mermaid-[hash]', metafile: true,
  external: ['/engine/core/fingerprint.js'],
  plugins: [{
    name: 'local-mermaid-vendor',
    setup(bundle) {
      bundle.onResolve({ filter: /^mermaid$/ }, () => ({ path: 'mermaid', namespace: 'vendor' }));
      bundle.onLoad({ filter: /.*/, namespace: 'vendor' }, () => ({
        contents: vendor.outputFiles[0].text, loader: 'js',
      }));
    },
  }],
});

// The hash changes when a renderer version or our settings change. Leave no obsolete modules for
// a stale page or a source-language scan to pick up on the next build.
const current = new Set(Object.keys(panel.metafile.outputs).map((path) => basename(path)));
const generated = join(web, 'generated');
for (const file of readdirSync(generated)) {
  if (/^mermaid-[A-Z0-9]+\.js$/.test(file) && !current.has(file)) unlinkSync(join(generated, file));
}
