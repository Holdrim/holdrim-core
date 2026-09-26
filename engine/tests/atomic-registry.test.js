/**
 * `saveRegistry` writes approvals.json atomically (holdrim#150): a temp file beside it, fsynced, then
 * renamed over the real name. Before this, a plain `writeFileSync` truncated the real file the moment
 * the write started — a process killed mid-write left every owner ✓ it ever recorded gone until
 * somebody recovered it from git. A reader now sees the old file or the new one, never a partial one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveRegistry, loadRegistry } from '../cli/validation.ts';

/** A throwaway project whose registry (`r.json`) already holds `previous`. */
function project(t, previous) {
  const tmp = mkdtempSync(join(tmpdir(), 'holdrim-atomic-registry-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'holdrim.json'), JSON.stringify({ content: { folders: [], registry: 'r.json' } }));
  writeFileSync(join(tmp, 'r.json'), JSON.stringify(previous, null, 1) + '\n');
  return tmp;
}

test('a write interrupted before the rename leaves the previous registry intact, with no temp file left', (t) => {
  const tmp = project(t, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });
  const boom = () => { throw new Error('killed between the write and the rename'); };

  assert.throws(() => saveRegistry(tmp, { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' },
    b: { file: 'p/X02.html', date: '2026-02-02', fingerprint: 'new' } }, boom),
    { message: 'killed between the write and the rename' });

  // Still the OLD registry, and still valid JSON — not truncated, not half the new one.
  assert.deepEqual(loadRegistry(tmp), { a: { file: 'p/X01.html', date: '2026-01-01', fingerprint: 'old' } });

  // Nothing named after the registry is left behind for the next run, or a person, to trip over.
  const leftover = readdirSync(tmp).filter((name) => name !== 'holdrim.json' && name !== 'r.json');
  assert.deepEqual(leftover, [], `left files behind: ${leftover.join(', ')}`);
});

test('with nothing interrupting it, the new registry lands under the real name', (t) => {
  const tmp = project(t, {});
  saveRegistry(tmp, { z: { file: 'p/X01.html', date: '2026-03-03', fingerprint: 'zzz' } });
  assert.deepEqual(loadRegistry(tmp), { z: { file: 'p/X01.html', date: '2026-03-03', fingerprint: 'zzz' } });
  assert.deepEqual(readdirSync(tmp).sort(), ['holdrim.json', 'r.json']);
});
