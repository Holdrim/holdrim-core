import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restamp } from '../cli/validation.ts';

const ROOT = new URL('../../', import.meta.url).pathname;

/** A throwaway copy of the hello world, with an approvals registry we control. */
function project(t, registry) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-restamp-'));
  cpSync(join(ROOT, 'examples', 'hello-world'), dir, { recursive: true });
  writeFileSync(join(dir, 'approvals.json'), JSON.stringify(registry));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pageOf = (dir) => readFileSync(join(dir, 'pages', 'A01.html'), 'utf8');

test('writes the fingerprint FROM THE REGISTRY, not the one computed now', async (t) => {
  // The whole point. A block whose text changed after the ✓ must be stamped with the OLD
  // fingerprint, so the browser paints it 🟡. Stamping the current text would be a silent
  // re-approval — the command meant to reveal the drift would erase it instead.
  const dir = project(t, { 'A01.1.1': { file: 'A01.html', fingerprint: 'ffffffffffffffff', date: '2026-01-01' } });
  await restamp(dir);
  assert.match(pageOf(dir), /data-id="A01\.1\.1"[^>]*data-validated-fingerprint="ffffffffffffffff"/,
    'stamped what the registry recorded');
  assert.doesNotMatch(pageOf(dir), /data-validated-fingerprint="(?!ffffffffffffffff)/,
    'no block got a freshly computed fingerprint');
});

test('does not touch a block that already carries the mark', async (t) => {
  const dir = project(t, { 'A01.1.1': { file: 'A01.html', fingerprint: 'aaaaaaaaaaaaaaaa', date: '2026-01-01' } });
  await restamp(dir);
  const once = pageOf(dir);
  await restamp(dir);                       // idempotent: running twice changes nothing
  assert.equal(pageOf(dir), once);
  assert.equal((once.match(/data-validated-fingerprint/g) ?? []).length, 1);
});

test('carries over what the block depended on, when the registry recorded it', async (t) => {
  const dir = project(t, {
    'A01.1.1': { file: 'A01.html', fingerprint: 'bbbbbbbbbbbbbbbb', date: '2026-01-01', dependsOn: { 'A02.1.1': 'cccccccccccccccc' } },
  });
  await restamp(dir);
  assert.match(pageOf(dir), /data-depended-on="[^"]*A02\.1\.1/, 'without this there is no 🔴 in the browser');
});

test('an entry with no recorded fingerprint is skipped, not invented', async (t) => {
  const dir = project(t, { 'A01.1.1': { file: 'A01.html', date: '2026-01-01' } });
  assert.equal(await restamp(dir), 0);
  assert.doesNotMatch(pageOf(dir), /data-validated-fingerprint/);
});
