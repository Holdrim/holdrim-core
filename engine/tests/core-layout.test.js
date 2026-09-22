/**
 * The core stays code a browser can load as it is served.
 *
 * `engine/core/` is the one code the server, the CLI and the panel share: the panel imports
 * `fingerprint.js` straight from the server, so the fingerprint a reviewer's browser computes and
 * the one the CLI computes come from the same file. That only holds while the core is plain
 * JavaScript with nothing the browser cannot resolve. A `.ts` there, or a `node:` import reached
 * from the panel, would break the panel on its first import — and `npm test` would stay green,
 * because Node resolves both happily. CONTRIBUTING states the rule; this is what holds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CORE = join(ROOT, 'engine', 'core');
const WEB = join(ROOT, 'engine', 'web');

/** Every specifier a file imports, static or dynamic. */
function importsOf(text) {
  const found = [];
  for (const [, spec] of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.push(spec);
  for (const [, spec] of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(spec);
  for (const [, spec] of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push(spec);
  return found;
}

/** The core file a panel specifier points at, or null when it points elsewhere. */
function coreFileOf(spec) {
  return /^(?:\.\.\/core\/|\/engine\/core\/)([\w-]+\.js)$/.exec(spec)?.[1] ?? null;
}

test('the core is JavaScript, every file of it', () => {
  const other = readdirSync(CORE).filter((f) => !f.endsWith('.js'));
  assert.deepEqual(other, [], 'a browser strips no types: the core cannot hold TypeScript');
});

test('the core imports only itself and node:', () => {
  const outside = [];
  for (const file of readdirSync(CORE)) {
    for (const spec of importsOf(readFileSync(join(CORE, file), 'utf8'))) {
      if (!/^\.\/[\w-]+\.js$/.test(spec) && !spec.startsWith('node:')) outside.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(outside, []);
});

test('what the panel loads from the core, and everything that pulls in, imports no node:', () => {
  // The panel's own sources, not the bundle: the bundle is built from these and keeps the core
  // external, so the browser still fetches the same files.
  const sources = [
    ...readdirSync(WEB).filter((f) => f.endsWith('.js') && f !== 'panel-react.js'),
    ...readdirSync(join(WEB, 'src')).filter((f) => /\.jsx?$/.test(f)).map((f) => join('src', f)),
  ];
  const queue = sources
    .flatMap((f) => importsOf(readFileSync(join(WEB, f), 'utf8')))
    .map(coreFileOf).filter(Boolean);
  assert.ok(queue.includes('fingerprint.js'), 'the panel no longer imports the fingerprint — this test reads the wrong files');

  const seen = new Set();
  const offenders = [];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(readFileSync(join(CORE, file), 'utf8'))) {
      if (spec.startsWith('node:')) offenders.push(`${file}: ${spec}`);
      else if (spec.startsWith('./')) queue.push(spec.slice(2));
    }
  }
  assert.deepEqual(offenders, [], 'the browser cannot resolve node: — the panel would fail on import');
});
