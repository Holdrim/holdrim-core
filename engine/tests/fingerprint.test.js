/**
 * The fingerprint of an ELEMENT, which is the half that only runs in the browser and the easiest
 * to leave untested: the review UI drawn on top of a block must not count, or every release of the
 * panel would turn every approval stale.
 *
 * linkedom stands in for the browser. It is already a dependency of the indexer, so the test costs
 * no new package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { fingerprintOfElement, fingerprintOfText, textOfElement } from '../core/fingerprint.js';

const element = (html) => parseHTML(`<html><body>${html}</body></html>`).document.querySelector('body > *');

test('the review UI does not enter the fingerprint', async () => {
  const bare = element('<p>The deadline is 24 hours.</p>');
  const decorated = element('<p>The deadline is 24 hours.'
    + '<span data-review-ui><button>✓ approve</button><span>D01.1.1</span></span></p>');
  assert.equal(textOfElement(decorated), 'The deadline is 24 hours.');
  assert.equal(await fingerprintOfElement(decorated), await fingerprintOfElement(bare));
});

test('the element and its text agree, so the snapshot shows what the fingerprint saw', async () => {
  const el = element('<p>Hello   <b>world</b></p>');
  assert.equal(await fingerprintOfElement(el), await fingerprintOfText('Hello world'));
  // The snapshot is the SAME text the fingerprint considered, before normalisation: the history
  // has to show the words that were approved, not a different reading of them.
  assert.equal(textOfElement(el), 'Hello   world');
});

test('the element is not mutated by being fingerprinted', async () => {
  const el = element('<p>text<span data-review-ui>ui</span></p>');
  await fingerprintOfElement(el);
  assert.ok(el.querySelector('[data-review-ui]'), 'the UI is removed from a copy, never from the page');
});
