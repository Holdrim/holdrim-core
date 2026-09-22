/**
 * Where a change lands. Two things are proved here: that the matrix says what `docs/IMPACT.md`
 * says — every cell of it, because a matrix nobody checked cell by cell is a matrix with one
 * wrong cell — and that the signals read from the edit itself only ever make it louder.
 *
 * The last test is the one that will fail for somebody who never read this file: it walks every
 * kind and demands the three weights. That is how a kind added next year gets caught before it
 * silently weighs nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalsOf, severityOf, raise, SEVERITIES } from '../core/impact.js';
import { KINDS, GRAVITIES, SENSITIVITIES, whatIsMissing } from '../core/kinds.js';

/** No signals at all: the matrix on its own. */
const quiet = { whitespaceOnly: false, numberChanged: false, negationChanged: false };

const t = (o) => ({ attributes: {}, classes: [], tag: 'div', html: '', text: '', ...o });

test('the matrix: cosmetic barely moves anything', () => {
  // subtitle is cosmetic; image and colors are robust; contract is brittle.
  assert.equal(severityOf('subtitle', 'image', quiet), 'silent');      // cosmetic × robust
  assert.equal(severityOf('subtitle', 'text', quiet), 'silent');       // cosmetic × normal
  assert.equal(severityOf('subtitle', 'contract', quiet), 'agent');    // cosmetic × brittle
});

test('the matrix: substantive reaches whoever is listening', () => {
  assert.equal(severityOf('text', 'rationale', quiet), 'silent');      // substantive × robust
  assert.equal(severityOf('text', 'list', quiet), 'agent');            // substantive × normal
  assert.equal(severityOf('text', 'model', quiet), 'person');          // substantive × brittle
});

test('the matrix: binding is never silent', () => {
  assert.equal(severityOf('config', 'colors', quiet), 'agent');        // binding × robust
  assert.equal(severityOf('config', 'text', quiet), 'person');         // binding × normal
  assert.equal(severityOf('config', 'rule', quiet), 'person');         // binding × brittle
});

test('an unknown kind is weighed as the middle of the road, on both sides', () => {
  // A typo in data-kind must not silence a change, and must not put every typo in front of a
  // person either. substantive × normal = agent, the same as text against text.
  assert.equal(severityOf('invented', 'text', quiet), 'agent');
  assert.equal(severityOf('text', 'invented', quiet), 'agent');
  assert.equal(severityOf('invented', 'invented', quiet), 'agent');
});

test('whitespace only: silent even from the loudest cell in the table', () => {
  // This is the one rule that lowers, and it is allowed to because it is not a judgement about
  // meaning: the visible text did not change at all. binding × brittle is as loud as it gets.
  const signals = signalsOf('the deadline is 24 hours', '  the deadline   is\n24 hours  ');
  assert.equal(signals.whitespaceOnly, true);
  assert.equal(severityOf('contract', 'rule', quiet), 'person');
  assert.equal(severityOf('contract', 'rule', signals), 'silent');
});

test('a number that moved is never cosmetic — it raises a silent cell to the agent', () => {
  const signals = signalsOf('the deadline is 24 hours', 'the deadline is 48 hours');
  assert.equal(signals.numberChanged, true);
  assert.equal(signals.whitespaceOnly, false);
  assert.equal(severityOf('subtitle', 'text', quiet), 'silent');       // the matrix would shrug
  assert.equal(severityOf('subtitle', 'text', signals), 'agent');      // the number does not
});

test('a negation appearing is never cosmetic either', () => {
  const signals = signalsOf('the alert fires', 'the alert does not fire');
  assert.equal(signals.negationChanged, true);
  assert.equal(severityOf('subtitle', 'text', signals), 'agent');
});

test('a negation vanishing counts the same as one appearing', () => {
  assert.equal(signalsOf('the alert never fires', 'the alert fires').negationChanged, true);
});

test('"no longer" is counted once, not twice for the "no" inside it', () => {
  // Counted twice, swapping "not" for "no longer" would look like two negations arriving where
  // one left, which is true but for the wrong reason — and the wrong reason breaks on the next
  // word somebody adds to the list.
  assert.equal(signalsOf('the alert does not fire', 'the alert no longer fires').negationChanged,
    false);
});

test('the same numbers in another order are the same numbers', () => {
  // Rewriting the sentence is not changing the rule. Flagging this is the noise that gets the
  // whole check switched off.
  const signals = signalsOf('24 hours to answer, 3 attempts', '3 attempts, 24 hours to answer');
  assert.equal(signals.numberChanged, false);
  assert.equal(signals.whitespaceOnly, false);
});

test('a number added where there was none counts', () => {
  assert.equal(signalsOf('answer quickly', 'answer within 24 hours').numberChanged, true);
  assert.equal(signalsOf('24 hours', '24 hours and 24 hours').numberChanged, true);
});

test('the step never goes past a person, from any cell', () => {
  const loud = { whitespaceOnly: false, numberChanged: true, negationChanged: true };
  assert.equal(severityOf('config', 'text', loud), 'person');   // already person, stays person
  assert.equal(raise('person'), 'person');
  assert.equal(raise(raise(raise('silent'))), 'person');
  for (const kind of Object.keys(KINDS)) {
    for (const other of Object.keys(KINDS)) {
      assert.ok(SEVERITIES.includes(severityOf(kind, other, loud)), `${kind} → ${other}`);
    }
  }
});

test('every kind carries its three weights — including whichever one you just added', () => {
  for (const [id, kind] of Object.entries(KINDS)) {
    assert.ok(GRAVITIES.includes(kind.gravity), `${id} has no valid gravity: ${kind.gravity}`);
    assert.ok(SENSITIVITIES.includes(kind.sensitivity),
      `${id} has no valid sensitivity: ${kind.sensitivity}`);
    assert.ok(Array.isArray(kind.entails), `${id} must say what it entails, even if nothing`);
    for (const work of kind.entails) {
      assert.equal(typeof work, 'string', `${id} entails something that is not a sentence`);
      assert.ok(work.length > 3, `${id} entails "${work}", which tells nobody anything`);
    }
  }
});

test('the kinds that entail work say so, and the rest say nothing', () => {
  assert.deepEqual(KINDS.model.entails, ['a migration']);
  assert.deepEqual(KINDS.config.entails, ['a deploy']);
  assert.equal(KINDS.contract.entails.length, 2);
  assert.match(KINDS.rule.entails[0], /tests/);
  assert.deepEqual(KINDS.text.entails, []);
  assert.deepEqual(KINDS.colors.entails, []);
});

test('a rule with no data-proof is a rule nobody proved', () => {
  // The whole point of the kind: it knows which test defends it. Without that it is a paragraph
  // with a strong opinion.
  assert.equal(whatIsMissing('rule', t({ text: 'an answer is owed within 24 hours' })).length, 1);
  assert.match(whatIsMissing('rule', t({}))[0], /data-proof/);
  assert.deepEqual(
    whatIsMissing('rule', t({ attributes: { 'data-proof': 'tests/deadline.test.js::within 24h' } })),
    [],
  );
});
