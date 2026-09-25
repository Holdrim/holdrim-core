/**
 * What "the same e-mail" means, and what can even be one — moved out of `engine/api/users.ts` into
 * this core module so `engine/core/roles.js` (`HOLDRIM_LOCKS`) can ask the SAME question without
 * pulling in `users.ts`'s `node:crypto` import (round 2 of #29's review, findings 2 and 6). This
 * file is what proves the shared function itself, once, instead of trusting the two re-exports —
 * `engine/tests/users.test.js` for `users.ts`'s side of it — to agree by construction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, isEmailAddress, MAX_EMAIL_LENGTH } from '../core/email.js';

test('normalizeEmail trims and lower-cases, and nothing else', () => {
  assert.equal(normalizeEmail('  Ana@Example.ORG  '), 'ana@example.org');
  assert.equal(normalizeEmail('ana@example.org'), 'ana@example.org', 'already normal is a no-op');
  assert.equal(normalizeEmail(''), '');
});

/**
 * Two mutations, each of which drops HALF of what "the same e-mail" has to mean: skipping the trim
 * leaves a padded address a different key from the same one typed without the space; skipping the
 * case fold leaves `Ana@` and `ana@` two different lock-holders. Both are named here so a change to
 * either half of the definition is caught by name, not folded into one assertion that only proves
 * the two happen to agree on ONE example.
 */
test('mutation: dropping the trim, or dropping the case fold, both change the answer', () => {
  const noTrim = (e) => String(e ?? '').toLowerCase();
  const noCaseFold = (e) => String(e ?? '').trim();
  assert.notEqual(noTrim('  ana@example.org  '), normalizeEmail('  ana@example.org  '));
  assert.notEqual(noCaseFold('ANA@example.org'), normalizeEmail('ANA@example.org'));
});

test('isEmailAddress: the empty field and the obvious typo, nothing more exotic', () => {
  assert.equal(isEmailAddress('someone@example.org'), true);
  assert.equal(isEmailAddress('  Someone@Example.ORG  '), true, 'checked after trimming');
  assert.equal(isEmailAddress(''), false);
  assert.equal(isEmailAddress('a name with spaces'), false, 'a name typed into the e-mail box');
  assert.equal(isEmailAddress('@example.org'), false, 'nothing before the @');
  assert.equal(isEmailAddress('someone@'), false, 'nothing after it');
  assert.equal(isEmailAddress('a@b@c'), false, 'two of them is not an address');
  assert.equal(isEmailAddress('a'.repeat(MAX_EMAIL_LENGTH) + '@example.org'), false, 'past RFC 5321');
});

/**
 * Round 3 of #29's review, finding 6: the check above proves something WELL past the limit is
 * refused, which a `>` that should have been `>=` — or the wrong number entirely — would still pass.
 * This pins the boundary itself, against the literal `320` RFC 5321 sets, not against
 * `MAX_EMAIL_LENGTH` — asserting a fixture built FROM the constant against the constant itself would
 * pass whatever the constant said, catching neither mutant this is aimed at: a `320` → `321` mutant
 * moves the fixture's own length right along with it, and the test would still see its own moved
 * boundary land exactly where it looks.
 */
test('isEmailAddress: exactly 320 characters is accepted, 321 is refused', () => {
  const domain = '@example.org';
  const at320 = 'a'.repeat(320 - domain.length) + domain;
  assert.equal(at320.length, 320, 'the fixture itself must sit exactly on the boundary');
  assert.equal(isEmailAddress(at320), true, 'exactly 320 is still a real address');
  assert.equal(isEmailAddress(`a${at320}`), false, 'one character past it, 321, is refused');
});
