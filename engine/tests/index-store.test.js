/**
 * The index stores where each dependency lands, not just that it exists.
 *
 * A `severityOf` tested cell by cell and called by nobody is a function, not a pipeline. These
 * tests are the wiring: they prove the matrix reaches the database, that the loud pairs can
 * be asked for by name, and that a database written before the column existed does not poison the
 * next run.
 *
 * ⚠️ The severity written at index time is the MATRIX ALONE. There is no earlier text on disk, so
 * `signalsOf` has nothing to compare and the three signals of stage 3b are absent by design. The
 * test named "the stored severity is the matrix alone" exists so that nobody later reads a silent
 * pair as "the engine looked at the edit and shrugged".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Index } from '../api/index-store.ts';
import { severityOf } from '../core/impact.js';

/** A block with everything the index demands, so each test only writes what it is about. */
const block = (id, kind, dependsOn = []) => ({
  id, page: 'D01', kind, file: 'D01.html', code: null, numbered: true,
  fingerprint: `fp-${id}`, text: id, dependsOn, missing: [],
});

const open = () => new Index(':memory:');

/** node:sqlite hands back null-prototype rows, and deepEqual is strict about the prototype. */
const rows = (list) => list.map((r) => ({ ...r }));

test('a dependency is stored with the severity of the two kinds', () => {
  const idx = open();
  // `config` is binding, `text` is normal: the matrix says a person. The pair is written as
  // "D01.2 depends on D01.1", so the one that CHANGED is D01.1 — the config.
  idx.rebuild([block('D01.1', 'config'), block('D01.2', 'text', ['D01.1'])]);
  assert.deepEqual(rows(idx.needsAPerson()), [
    { block: 'D01.2', dependsOn: 'D01.1', kind: 'text', dependsOnKind: 'config' },
  ]);
  idx.close();
});

test('the direction is not symmetric: who depends on whom decides the level', () => {
  const idx = open();
  // Same two kinds, opposite direction. A decision (binding, normal) changing under a paragraph
  // (substantive, normal) is a person's business: binding × normal. A paragraph changing under a
  // decision is the agent's: substantive × normal. Reversing the arguments of `severityOf` swaps
  // the two rows below.
  // ⚠️ The pair has to be one whose two matrix cells DIFFER. A subtitle and a contract land on
  // `agent` in both directions, so a version built on them would let the swap it claims to catch
  // pass unnoticed.
  idx.rebuild([
    block('D01.1', 'decision'), block('D01.2', 'text', ['D01.1']),
    block('D01.3', 'text'), block('D01.4', 'decision', ['D01.3']),
  ]);
  assert.deepEqual(rows(idx.needsAPerson()), [
    { block: 'D01.2', dependsOn: 'D01.1', kind: 'text', dependsOnKind: 'decision' },
  ]);
  assert.deepEqual(rows(idx.bySeverity()), [{ severity: 'person', count: 1 }, { severity: 'agent', count: 1 }]);
  idx.close();
});

test('the stored severity is the matrix alone, with no signals from the edit', () => {
  const idx = open();
  idx.rebuild([block('D01.1', 'contract'), block('D01.2', 'rule', ['D01.1'])]);
  // binding × brittle is the loudest cell there is, and the index has no "before" text to soften
  // or sharpen it. What is stored has to equal the bare matrix call, signals omitted.
  assert.equal(severityOf('contract', 'rule'), 'person');
  assert.equal(idx.needsAPerson().length, 1);
  idx.close();
});

test('a broken dependency is weighed as an unknown kind, not skipped', () => {
  const idx = open();
  // D01.9 does not exist. Dropping the pair would hide it; treating it as cosmetic would silence
  // it. substantive × brittle = person, and the query says the other side is unknown.
  idx.rebuild([block('D01.1', 'rule', ['D01.9'])]);
  assert.deepEqual(rows(idx.needsAPerson()), [
    { block: 'D01.1', dependsOn: 'D01.9', kind: 'rule', dependsOnKind: null },
  ]);
  assert.deepEqual(rows(idx.brokenDependencies()), [{ block: 'D01.1', dependsOn: 'D01.9' }]);
  idx.close();
});

test('the tally counts every pair once, loudest level first', () => {
  const idx = open();
  idx.rebuild([
    block('D01.1', 'colors'),
    block('D01.2', 'subtitle', ['D01.1']),                    // cosmetic × robust  → silent
    block('D01.3', 'contract', ['D01.1']),                    // cosmetic × brittle → agent
    block('D01.4', 'config'),
    block('D01.5', 'text', ['D01.4', 'D01.1']),               // binding × normal   → person
  ]);
  assert.deepEqual(rows(idx.bySeverity()), [
    { severity: 'person', count: 1 },
    { severity: 'agent', count: 1 },
    { severity: 'silent', count: 2 },
  ]);
  idx.close();
});

test('a rebuild rewrites the severities instead of leaving the old ones behind', () => {
  const idx = open();
  idx.rebuild([block('D01.1', 'config'), block('D01.2', 'text', ['D01.1'])]);
  assert.equal(idx.needsAPerson().length, 1);
  // The same pair, with the source demoted to a subtitle. A rebuild that only inserted would keep
  // the `person` row through INSERT OR IGNORE and the level would never come down again.
  idx.rebuild([block('D01.1', 'subtitle'), block('D01.2', 'text', ['D01.1'])]);
  assert.deepEqual(rows(idx.needsAPerson()), []);
  assert.deepEqual(rows(idx.bySeverity()), [{ severity: 'silent', count: 1 }]);
  idx.close();
});

/**
 * The metadata of the index itself: the commit the content was on, and when it was built.
 *
 * ⚠️ Storing it is all these prove. Nothing here diffs anything against git — that is the next
 * piece, and it needs this one to have somewhere to start from.
 */

test('an index that was never built has no metadata at all', () => {
  const idx = open();
  // null and `{ commit: null }` are different answers and the calling code will have to tell them
  // apart: "never built" versus "built from content that is not in a repository".
  assert.equal(idx.builtFrom(), null);
  idx.close();
});

test('the commit is stored once for the whole index, not once per block', () => {
  const idx = open();
  const sha = 'a'.repeat(40);
  idx.rebuild([block('D01.1', 'config'), block('D01.2', 'text', ['D01.1'])], sha);

  const meta = idx.builtFrom();
  assert.equal(meta.commit, sha);
  assert.match(meta.at, /^\d{4}-\d{2}-\d{2}T/);
  // Two blocks went in, and the answer is a single object rather than a row per block: the commit
  // is a property of the index, and two rows could never honestly disagree about it.
  assert.equal(idx.byKind().reduce((sum, k) => sum + k.count, 0), 2);
  idx.close();
});

test('an index built outside a repository stores no commit and still holds everything else', () => {
  const idx = open();
  // The default is null because content is not always in a repository. It has to produce an index
  // that is merely less useful, never an index that failed to be built.
  idx.rebuild([block('D01.1', 'config'), block('D01.2', 'text', ['D01.1'])]);

  const meta = idx.builtFrom();
  assert.equal(meta.commit, null);
  assert.match(meta.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(idx.needsAPerson().length, 1);
  idx.close();
});

test('a rebuild replaces the metadata instead of stacking a second row', () => {
  const idx = open();
  idx.rebuild([block('D01.1', 'config')], 'a'.repeat(40));
  idx.rebuild([block('D01.1', 'config')], 'b'.repeat(40));
  // An insert that did not clear the table first would hit the CHECK on the single row, and the
  // index would keep claiming a tree it was not built from.
  assert.equal(idx.builtFrom().commit, 'b'.repeat(40));
  idx.close();
});

test('reindexing a plain folder clears the commit an earlier repository left behind', () => {
  const idx = open();
  idx.rebuild([block('D01.1', 'config')], 'a'.repeat(40));
  // The same database, now fed content with no commit. Keeping the old SHA would be the worst of
  // the three outcomes: the git layer would diff against a tree that has nothing to do with what
  // was just indexed, and conclude that almost nothing needs reparsing.
  idx.rebuild([block('D01.1', 'config')], null);
  assert.equal(idx.builtFrom().commit, null);
  idx.close();
});
