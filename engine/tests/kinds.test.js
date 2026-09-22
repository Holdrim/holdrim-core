/**
 * Content kinds. Two things are proved here: that inference gets it right on documentation that
 * already exists (otherwise the method would open by demanding a rewrite), and that each kind
 * demands what is its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, whatIsMissing, KINDS, catalogue, LAYERS, layerOf } from '../core/kinds.js';

const t = (o) => ({ attributes: {}, classes: [], tag: 'div', html: '', text: '', ...o });

test('a declared kind wins', () => {
  assert.equal(kindOf(t({ attributes: { 'data-kind': 'diagram' }, html: '<p>x</p>' })), 'diagram');
});

test('a made-up kind falls back instead of breaking', () => {
  // Getting the kind name wrong must not take down the page of whoever is writing. The lint
  // reports it; the page still opens.
  assert.equal(kindOf(t({ attributes: { 'data-kind': 'invented' } })), 'text');
});

test('inference: existing documentation gets kinds without being rewritten', () => {
  assert.equal(kindOf(t({ attributes: { 'data-code': '0.title' } })), 'title');
  assert.equal(kindOf(t({ attributes: { 'data-code': '1.sub' } })), 'subtitle');
  assert.equal(kindOf(t({ classes: ['section-lead'] })), 'subtitle');
  assert.equal(kindOf(t({ html: '<pre><code class="mermaid">flowchart</code></pre>' })), 'diagram');
  assert.equal(kindOf(t({ html: '<table><tr><th>a</th></tr></table>' })), 'table');
  assert.equal(kindOf(t({ html: '<img src="x.png" alt="y">' })), 'image');
  assert.equal(kindOf(t({ html: '<ul><li>a</li><li>b</li></ul>' })), 'list');
  assert.equal(kindOf(t({ classes: ['box--info'] })), 'box');
  assert.equal(kindOf(t({ html: '<p>an ordinary paragraph</p>' })), 'text');
});

test('an image without alt is reported — it is the only part of it under the lock', () => {
  // Text INSIDE an image does not enter the fingerprint: swapping the figure does not change the
  // block's fingerprint. That is why alt is not only accessibility — it is what makes the image
  // reviewable at all.
  assert.deepEqual(whatIsMissing('image', t({ html: '<img src="a.png">' })).length, 1);
  assert.deepEqual(whatIsMissing('image', t({ html: '<img src="a.png" alt="the sign-in flow">' })), []);
});

test('a diagram as an image is refused', () => {
  assert.match(whatIsMissing('diagram', t({ html: '<img src="flow.png" alt="flow">' }))[0], /Mermaid/);
  assert.deepEqual(whatIsMissing('diagram', t({ html: '<pre><code>flowchart TD</code></pre>' })), []);
});

test('a table without a header is reported', () => {
  assert.equal(whatIsMissing('table', t({ html: '<table><tr><td>a</td></tr></table>' })).length, 1);
  assert.deepEqual(whatIsMissing('table', t({ html: '<table><tr><th>a</th></tr></table>' })), []);
});

test('a decision with no owner and no deadline is not pending, it is lost', () => {
  assert.equal(whatIsMissing('decision', t({})).length, 2);
  assert.deepEqual(whatIsMissing('decision', t({ attributes: { 'data-owner': 'ana', 'data-deadline': '2026-10-01' } })), []);
});

test('a palette with no colour value is reported', () => {
  assert.equal(whatIsMissing('colors', t({ text: 'primary blue and grey' })).length, 1);
  assert.deepEqual(whatIsMissing('colors', t({ text: 'primary blue #2E6E5B' })), []);
});

test('a one-item list is a paragraph in bad clothing', () => {
  assert.equal(whatIsMissing('list', t({ html: '<ul><li>only one</li></ul>' })).length, 1);
  assert.deepEqual(whatIsMissing('list', t({ html: '<ul><li>one</li><li>two</li></ul>' })), []);
});

test('an over-long heading is a paragraph in disguise', () => {
  assert.equal(whatIsMissing('title', t({ text: 'x'.repeat(81) })).length, 1);
  assert.deepEqual(whatIsMissing('title', t({ text: 'Who uses it, and for whom' })), []);
});

test('every kind in the catalogue has a name and a description — that is what people read to choose', () => {
  for (const [id, kind] of Object.entries(KINDS)) {
    assert.ok(kind.name, `${id} has no name`);
    assert.ok(kind.description.length > 40, `${id} description too short to help anyone`);
    assert.equal(typeof kind.numbered, 'boolean', `${id} must say whether it shows a number`);
  }
  assert.ok(catalogue().length >= 12, 'the catalogue has to cover what documentation is made of');
});

test('every kind declares a layer, and it is one of LAYERS', () => {
  for (const [id, kind] of Object.entries(KINDS)) {
    assert.ok(LAYERS.includes(kind.layer), `${id} has no valid layer`);
  }
});

test('exactly config, contract, model and rule are Fundamental', () => {
  const fundamental = Object.entries(KINDS)
    .filter(([, kind]) => kind.layer === 'fundamental')
    .map(([id]) => id)
    .sort();
  assert.deepEqual(fundamental, ['config', 'contract', 'model', 'rule']);
});

test('decision is binding but Application: a decision is a placeholder for a blueprint fact, not one', () => {
  // The whole reason `layer` is declared instead of computed from `gravity === 'binding'`. See the
  // comment above `KINDS` in engine/core/kinds.js and docs/LAYERS.md, section 2.
  assert.equal(KINDS.decision.gravity, 'binding');
  assert.equal(KINDS.decision.layer, 'application');
});

test('layerOf returns null for a kind that does not exist, not a default', () => {
  assert.equal(layerOf('invented'), null);
  assert.equal(layerOf('rule'), 'fundamental');
});
